use super::*;
use std::net::TcpListener;
use std::os::unix::fs::symlink;
#[test]
fn command_timeout_and_output_are_bounded_and_errors_do_not_expose_output() {
    let started = Instant::now();
    let error = host::run_command(
        &["sh".into(), "-c".into(), "sleep 2".into()],
        Duration::from_millis(30),
    )
    .unwrap_err();
    assert!(error.contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        host::run_command(
            &["sh".into(), "-c".into(), "head -c 4194305 /dev/zero".into()],
            Duration::from_secs(5)
        )
        .unwrap_err()
        .contains("4 MiB")
    );
    let error = host::run_command(
        &["sh".into(), "-c".into(), "printf secret; exit 1".into()],
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert!(!error.contains("secret"));
}
#[test]
fn inherited_stdout_does_not_bypass_command_deadline() {
    let started = Instant::now();
    assert!(
        host::run_command(
            &["sh".into(), "-c".into(), "sleep 2 & exit 0".into()],
            Duration::from_millis(30)
        )
        .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}
#[test]
fn paths_reject_symlinks_traversal_unsafe_characters_and_writable_parents() {
    let temp = host::Temporary::new("scope-path-test").unwrap();
    let home = &temp.0;
    symlink(home, home.join("link")).unwrap();
    for path in [
        home.join("link/app"),
        home.join("bad%name"),
        home.join("bad\nname"),
        home.join("bad$name"),
        home.join(" trailing "),
        home.join("../outside"),
        home.parent().unwrap().into(),
    ] {
        assert!(
            host::private_path(&path, home, false, false).is_err(),
            "{}",
            path.display()
        );
    }
    host::mkdir_private(&home.join("writable")).unwrap();
    fs::set_permissions(home.join("writable"), fs::Permissions::from_mode(0o770)).unwrap();
    assert!(host::private_path(&home.join("writable/app"), home, false, false).is_err());
    assert!(host::private_path(&home.join("writable/app"), home, false, true).is_ok());
}
#[test]
fn occupied_port_is_not_available() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(!host::available(socket.local_addr().unwrap().port()));
    assert!(!host::available(80));
}
#[test]
fn listener_comparison_includes_extra_routes_funnel_and_foreground_handlers() {
    let expected = host::expected_listener("machine.example.ts.net", 8443, 4319);
    let mut config = expected.clone();
    config["TCP"]["443"] = json!({"HTTPS":true});
    assert_eq!(host::listener(&config, 8443).unwrap(), expected);
    config["AllowFunnel"] = json!({"machine.example.ts.net:8443":true});
    assert_ne!(host::listener(&config, 8443).unwrap(), expected);
    for key in ["Foreground", "Services"] {
        assert!(host::listener(&json!({key:{"other":{}}}), 8443).is_err());
    }
    assert!(host::listener(&json!({"TCP": []}), 8443).is_err());
}
fn registration_fixture() -> Vec<Value> {
    hooks::EVENTS.iter().map(|event| json!({"eventName":format!("{}{}", event[..1].to_lowercase(), &event[1..]), "statusMessage":"codex-scope test", "handlerType":"command", "timeoutSec":1, "async":false, "enabled":true, "trustStatus":"untrusted", "command":"observer"})).collect()
}
#[test]
fn probe_rejects_missing_events_changed_commands_warnings_and_unexpected_trust() {
    let hooks = registration_fixture();
    probe::check_entries(&hooks, "test", false, Some("observer")).unwrap();
    assert!(probe::check_entries(&hooks[..11], "test", false, None).is_err());
    for (key, value) in [
        ("async", json!(true)),
        ("enabled", json!(false)),
        ("timeoutSec", json!(2)),
        ("trustStatus", json!("trusted")),
        ("command", json!("changed")),
    ] {
        let mut changed = hooks.clone();
        changed[0][key] = value;
        assert!(probe::check_entries(&changed, "test", false, Some("observer")).is_err());
    }
    for result in [
        json!({}),
        json!({"data":[]}),
        json!({"data":[{"hooks":hooks,"warnings":["warning"]}]}),
    ] {
        assert!(probe::registrations(&result).is_err());
    }
}
#[test]
fn invalid_toml_or_existing_ownership_stops_before_modification() {
    let temp = host::Temporary::new("scope-config-test").unwrap();
    for invalid in [b"a=1\na=2\n".as_slice(), b"[invalid"] {
        fs::write(temp.0.join("config.toml"), invalid).unwrap();
        assert!(config_files(&temp.0).is_err());
        assert_eq!(fs::read(temp.0.join("config.toml")).unwrap(), invalid);
    }
    fs::write(temp.0.join("config.toml"), b"model='example'\n").unwrap();
    fs::write(temp.0.join("codex-scope-owned.json"), b"{}").unwrap();
    assert!(config_files(&temp.0).is_err());
}
#[test]
fn install_paths_cannot_overlap_each_other_or_checkout() {
    let paths = [
        Path::new("/home/demo/config"),
        Path::new("/home/demo/config/app"),
    ];
    assert!(ensure_separate(&paths, None).is_err());
    assert!(
        ensure_separate(
            &[Path::new("/home/demo/repo/app")],
            Some(Path::new("/home/demo/repo"))
        )
        .is_err()
    );
    ensure_separate(
        &[
            Path::new("/home/demo/config"),
            Path::new("/home/demo/app"),
            Path::new("/home/demo/data"),
        ],
        Some(Path::new("/home/demo/repo")),
    )
    .unwrap();
}
#[test]
fn unit_commands_depend_on_copied_native_executables() {
    let unit = unit_text(
        Path::new("/home/demo/app"),
        Path::new("/home/demo/data"),
        4319,
    );
    assert!(unit.contains("ExecStart=\"/home/demo/app/codex-scope\" collector"));
    assert!(unit.contains("--runtime-dir \"/home/demo/data/collector\""));
    assert!(!unit.contains("python") && !unit.contains("bun") && !unit.contains("cargo"));
}
#[test]
fn recovery_copy_contains_only_native_binary_and_launcher() {
    let temp = host::Temporary::new("scope-registry-test").unwrap();
    let registry = temp.0.join("recovery");
    let hashes = prepare_registry(&registry, b"binary").unwrap();
    assert_eq!(hashes.len(), 2);
    assert_eq!(fs::read(registry.join("codex-scope")).unwrap(), b"binary");
    assert!(
        std::str::from_utf8(&fs::read(registry.join("manage.sh")).unwrap())
            .unwrap()
            .contains("/codex-scope\" manage")
    );
    assert!(prepare_registry(&registry, b"changed").is_err());
    assert_eq!(fs::read(registry.join("codex-scope")).unwrap(), b"binary");
}

#[test]
fn app_server_probe_bounds_unsolicited_notifications_and_keeps_errors_private() {
    let temp = host::Temporary::new("scope-probe-test").unwrap();
    let script = temp.0.join("codex");
    for (body, expected) in [
        (
            "read line\ni=0\nwhile [ \"$i\" -lt 65 ]; do printf '%s\\n' '{\"method\":\"notice\"}'; i=$((i+1)); done\nsleep 10\n",
            "too many notifications",
        ),
        (
            "read line\nprintf '%s\\n' '{\"id\":1,\"error\":{\"message\":\"private synthetic configuration\"}}'\n",
            "rejected hook inspection",
        ),
    ] {
        fs::write(&script, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let started = Instant::now();
        let error = probe::hooks_list(&script, &temp.0, &temp.0).unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("private synthetic configuration"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[test]
fn oversized_private_config_is_rejected() {
    let temp = host::Temporary::new("scope-size-test").unwrap();
    let path = temp.0.join("config.toml");
    fs::write(&path, vec![b' '; host::LIMIT + 1]).unwrap();
    assert!(
        host::read_private(&path, false)
            .unwrap_err()
            .contains("size limit")
    );
}
