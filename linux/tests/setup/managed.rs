use super::*;
use std::cell::{Cell, RefCell};
use std::os::unix::fs::symlink;
use std::time::Duration;

struct FakeHost {
    unit: PathBuf,
    state: RefCell<String>,
    routes: RefCell<Value>,
    dropins: Cell<bool>,
    fail_route_after: Cell<bool>,
    calls: RefCell<Vec<Vec<String>>>,
}
impl Host for FakeHost {
    fn command(&self, args: &[String], _: Duration) -> Result<String> {
        self.calls.borrow_mut().push(args.to_vec());
        if args.first().is_some_and(|s| s == "systemctl") {
            if args.iter().any(|s| s == "--property=DropInPaths") {
                return Ok(if self.dropins.get() {
                    "/synthetic/override.conf"
                } else {
                    ""
                }
                .into());
            }
            if args.iter().any(|s| s == "--property=FragmentPath") {
                return Ok(if self.unit.exists() {
                    self.unit.to_string_lossy().into_owned()
                } else {
                    String::new()
                });
            }
            if args.iter().any(|s| s == "--property=ActiveState") {
                return Ok(self.state.borrow().clone());
            }
            if args.iter().any(|s| s == "disable" || s == "stop") {
                *self.state.borrow_mut() = "inactive".into();
            }
            if args.iter().any(|s| s == "start") {
                *self.state.borrow_mut() = "active".into();
            }
            return Ok(String::new());
        }
        if args == ["tailscale", "serve", "status", "--json"] {
            return Ok(self.routes.borrow().to_string());
        }
        if args.first().is_some_and(|s| s == "tailscale") {
            let port = args
                .iter()
                .find_map(|s| s.strip_prefix("--https="))
                .unwrap();
            let key = format!("machine.example.ts.net:{port}");
            let mut routes = self.routes.borrow_mut();
            if args.last().is_some_and(|s| s == "off") {
                routes["TCP"].as_object_mut().unwrap().remove(port);
                routes["Web"].as_object_mut().unwrap().remove(&key);
            }
            if self.fail_route_after.get() {
                return Err("synthetic command connection lost".into());
            }
            return Ok(String::new());
        }
        Err("Unexpected fixture command".into())
    }
}
#[test]
fn upgrade_preserves_configuration_and_remains_removable() {
    let mut f = Fixture::new(true);
    let config = fs::read(f.job.record.config.join("hooks.json")).unwrap();
    let token = fs::read(f.job.record.data.join("viewer.token")).unwrap();
    let routes = f.host.routes.borrow().clone();
    assert!(
        super::super::upgrade::apply(&mut f.job, &f.host, b"new-runtime", b"new-observer", || Ok(
            ()
        ))
        .unwrap()
    );
    let mut restored = Installation::load(&f.job.registry, &f.root.0).unwrap();
    assert_eq!(
        fs::read(restored.record.config.join("hooks.json")).unwrap(),
        config
    );
    assert_eq!(
        fs::read(restored.record.data.join("viewer.token")).unwrap(),
        token
    );
    assert_eq!(*f.host.routes.borrow(), routes);
    assert!(
        restored
            .matches(&restored.record.app.join("codex-scope"))
            .unwrap()
    );
    f.host.calls.borrow_mut().clear();
    assert!(
        !super::super::upgrade::apply(
            &mut restored,
            &f.host,
            b"new-runtime",
            b"new-observer",
            || panic!("No restart expected")
        )
        .unwrap()
    );
    assert!(
        !f.host
            .calls
            .borrow()
            .iter()
            .any(|args| args.iter().any(|a| a == "stop" || a == "start"))
    );
    assert!(restored.rollback(&f.host).unwrap().is_empty());
    restored.purge().unwrap();
}

#[test]
fn failed_upgrade_restores_previous_executables_and_record() {
    let mut f = Fixture::new(false);
    let before = fs::read(f.job.registry.join("installation.json")).unwrap();
    let error =
        super::super::upgrade::apply(&mut f.job, &f.host, b"bad-runtime", b"new-observer", || {
            Err("Endpoint failed".into())
        })
        .unwrap_err();
    assert!(error.contains("Previous executables restored"));
    assert_eq!(
        fs::read(f.job.record.app.join("codex-scope")).unwrap(),
        b"native-runtime"
    );
    assert_eq!(
        fs::read(f.job.registry.join("codex-scope")).unwrap(),
        b"native-recovery"
    );
    assert_eq!(
        fs::read(f.job.registry.join("installation.json")).unwrap(),
        before
    );
    assert_eq!(*f.host.state.borrow(), "active");
}

#[test]
fn upgrade_refuses_edited_executables_before_stopping() {
    let mut f = Fixture::new(false);
    fs::write(f.job.record.app.join("codex-scope-observer"), b"user-edit").unwrap();
    assert!(
        super::super::upgrade::apply(&mut f.job, &f.host, b"new", b"new", || Ok(()))
            .unwrap_err()
            .contains("Edited executable")
    );
    assert!(f.host.calls.borrow().is_empty());
    assert_eq!(f.job.record.phase, "installed");
}

#[test]
fn interrupted_upgrade_recovers_after_each_replacement() {
    for replaced in 0..=3 {
        let mut f = Fixture::new(false);
        let paths = [
            f.job.record.app.join("codex-scope"),
            f.job.record.app.join("codex-scope-observer"),
            f.job.registry.join("codex-scope"),
        ];
        let old = std::array::from_fn(|index| {
            let bytes = fs::read(&paths[index]).unwrap();
            host::atomic_write(
                &f.job.registry.join(format!("upgrade-{index}.backup")),
                &bytes,
            )
            .unwrap();
            digest(&bytes)
        });
        f.job.record.upgrade = Some(super::super::upgrade::Pending {
            old,
            new: std::array::from_fn(|_| digest(b"replacement")),
        });
        f.job.record.phase = "upgrading".into();
        f.job.save().unwrap();
        for path in paths.iter().take(replaced) {
            host::atomic_write_mode(path, b"replacement", 0o700).unwrap();
        }
        let mut reloaded = Installation::load(&f.job.registry, &f.root.0).unwrap();
        super::super::upgrade::recover(&mut reloaded, &f.host).unwrap();
        assert_eq!(reloaded.record.phase, "installed");
        assert!(reloaded.record.upgrade.is_none());
        assert_eq!(fs::read(&paths[0]).unwrap(), b"native-runtime");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"native-observer");
        assert_eq!(fs::read(&paths[2]).unwrap(), b"native-recovery");
    }
}

#[test]
fn committed_upgrade_cleanup_resumes_without_restarting() {
    let mut f = Fixture::new(false);
    let paths = [
        f.job.record.app.join("codex-scope"),
        f.job.record.app.join("codex-scope-observer"),
        f.job.registry.join("codex-scope"),
    ];
    let old = std::array::from_fn(|index| {
        let bytes = fs::read(&paths[index]).unwrap();
        if index != 0 {
            host::atomic_write(
                &f.job.registry.join(format!("upgrade-{index}.backup")),
                &bytes,
            )
            .unwrap();
        }
        digest(&bytes)
    });
    f.job.record.upgrade = Some(super::super::upgrade::Pending {
        old: old.clone(),
        new: old,
    });
    f.job.save().unwrap();
    let mut reloaded = Installation::load(&f.job.registry, &f.root.0).unwrap();
    super::super::upgrade::recover(&mut reloaded, &f.host).unwrap();
    assert!(f.host.calls.borrow().is_empty());
    assert!(reloaded.record.upgrade.is_none());
    assert!(!reloaded.registry.join("upgrade-1.backup").exists());
}
struct Fixture {
    root: host::Temporary,
    job: Installation,
    host: FakeHost,
    config_text: Vec<u8>,
    original: Value,
}
impl Fixture {
    fn new(remote: bool) -> Self {
        let root = host::Temporary::new("scope-managed-test").unwrap();
        let home = &root.0;
        let registry = home.join(".local/state/codex-scope-installer");
        let config = home.join(".codex");
        host::mkdir_private(&registry).unwrap();
        host::mkdir_private(&config).unwrap();
        let config_text = b"[features]\nexample = true\n".to_vec();
        fs::write(config.join("config.toml"), &config_text).unwrap();
        let original = json!({"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "exit 2"}]}]}});
        fs::write(
            config.join("hooks.json"),
            hooks::serialize(&original).unwrap(),
        )
        .unwrap();
        let app = home.join(".local/share/codex-scope");
        let data = home.join(".local/state/codex-scope");
        let unit = home.join(".config/systemd/user").join(SERVICE);
        let record = Record {
            version: 1,
            identity: "0123456789abcdef0123456789abcdef".into(),
            phase: "installing".into(),
            config,
            hooks_existed: true,
            app,
            runtime: data.join("collector"),
            data,
            unit: unit.clone(),
            endpoint: if remote {
                "https://machine.example.ts.net:8443"
            } else {
                "http://127.0.0.1:4319"
            }
            .into(),
            dns: remote.then(|| "machine.example.ts.net".into()),
            port: 4319,
            https_port: remote.then_some(8443),
            files: BTreeMap::new(),
            directories: BTreeMap::new(),
            permissions: BTreeMap::new(),
            recovery: BTreeMap::from([
                ("codex-scope".into(), digest(b"native-recovery")),
                ("manage.sh".into(), digest(b"launcher")),
            ]),
            hooks_intent: false,
            hook_ownership: Value::Null,
            service_intent: false,
            route_intent: false,
            route: Value::Null,
            upgrade: None,
        };
        for (name, bytes) in [
            ("codex-scope", b"native-recovery".as_slice()),
            ("manage.sh", b"launcher"),
        ] {
            fs::write(registry.join(name), bytes).unwrap();
            fs::set_permissions(registry.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut job = Installation { registry, record };
        job.save().unwrap();
        let (app, data, runtime) = (
            job.record.app.clone(),
            job.record.data.clone(),
            job.record.runtime.clone(),
        );
        job.directory(&app).unwrap();
        job.file(&app.join("codex-scope"), b"native-runtime", 0o700, false)
            .unwrap();
        job.file(
            &app.join("codex-scope-observer"),
            b"native-observer",
            0o700,
            false,
        )
        .unwrap();
        job.directory(&data).unwrap();
        job.directory(&data.join("backup")).unwrap();
        job.directory(&runtime).unwrap();
        job.file(&data.join("viewer.token"), b"private-token", 0o600, true)
            .unwrap();
        job.file(&data.join("backup/config.toml"), &config_text, 0o600, true)
            .unwrap();
        job.record.hook_ownership = hooks::merge(
            &original,
            Some(&app.join("codex-scope-observer")),
            Some(&runtime.join("ingest.sock")),
            false,
            Some(&job.record.identity),
        )
        .unwrap()[hooks::OWNER]
            .clone();
        job.record.hooks_intent = true;
        job.save().unwrap();
        hooks::update(
            &job.record.config,
            Some(&app.join("codex-scope-observer")),
            Some(&runtime.join("ingest.sock")),
            false,
            Some(&job.record.identity),
        )
        .unwrap();
        job.directory(unit.parent().unwrap()).unwrap();
        job.file(&unit, b"native-service", 0o600, false).unwrap();
        job.record.service_intent = true;
        let mut routes = host::expected_listener("machine.example.ts.net", 443, 9999);
        if remote {
            job.record.route = host::expected_listener("machine.example.ts.net", 8443, 4319);
            job.record.route_intent = true;
            for group in ["TCP", "Web"] {
                routes[group]
                    .as_object_mut()
                    .unwrap()
                    .extend(job.record.route[group].as_object().unwrap().clone());
            }
        }
        job.record.phase = "installed".into();
        job.save().unwrap();
        let host = FakeHost {
            unit,
            state: RefCell::new("active".into()),
            routes: RefCell::new(routes),
            dropins: Cell::new(false),
            fail_route_after: Cell::new(false),
            calls: RefCell::new(Vec::new()),
        };
        Self {
            root,
            job,
            host,
            config_text,
            original,
        }
    }
    fn assert_restored(&self) {
        assert_eq!(
            hooks::read_config(&self.job.record.config.join("hooks.json"))
                .unwrap()
                .1,
            self.original
        );
        assert_eq!(
            fs::read(self.job.record.config.join("config.toml")).unwrap(),
            self.config_text
        );
        assert!(
            !self
                .job
                .record
                .config
                .join("codex-scope-owned.json")
                .exists()
        );
        assert!(!self.job.record.app.exists());
        assert!(!self.job.record.unit.exists());
        assert_eq!(self.host.state.borrow().as_str(), "inactive");
    }
}
#[test]
fn install_record_load_uninstall_idempotence_and_retained_credentials() {
    let mut f = Fixture::new(false);
    let reloaded = Installation::load(&f.job.registry, &f.root.0).unwrap();
    assert_eq!(reloaded.record.phase, "installed");
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    f.assert_restored();
    assert!(f.job.record.data.join("viewer.token").exists());
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    f.job.purge_retained().unwrap();
    assert!(!f.job.record.data.exists());
    f.job.purge().unwrap();
    assert!(!f.job.registry.exists());
}
#[test]
fn uninstall_preserves_other_routes() {
    let mut f = Fixture::new(true);
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    assert_eq!(
        *f.host.routes.borrow(),
        host::expected_listener("machine.example.ts.net", 443, 9999)
    );
    f.assert_restored();
}
#[test]
fn changed_listener_with_extra_route_is_preserved() {
    let mut f = Fixture::new(true);
    f.host.routes.borrow_mut()["Web"]["machine.example.ts.net:8443"]["Handlers"]["/other"] =
        json!({"Proxy":"http://127.0.0.1:1234"});
    let before = f.host.routes.borrow().clone();
    let problems = f.job.rollback(&f.host).unwrap();
    assert!(problems.iter().any(|p| p.contains("listener was edited")));
    assert_eq!(*f.host.routes.borrow(), before);
}
#[test]
fn partial_route_removal_can_be_retried_from_journal() {
    let mut f = Fixture::new(true);
    f.host.fail_route_after.set(true);
    assert!(!f.job.rollback(&f.host).unwrap().is_empty());
    assert!(f.job.record.route_intent);
    f.host.fail_route_after.set(false);
    let mut restored = Installation::load(&f.job.registry, &f.root.0).unwrap();
    assert!(restored.rollback(&f.host).unwrap().is_empty());
    assert!(!restored.record.route_intent);
}
#[test]
fn edited_service_and_dropins_preserve_executable_dependencies() {
    for dropin in [false, true] {
        let mut f = Fixture::new(false);
        if dropin {
            f.host.dropins.set(true);
        } else {
            fs::write(&f.job.record.unit, b"user edit").unwrap();
        }
        let problems = f.job.rollback(&f.host).unwrap();
        assert!(problems.iter().any(|p| p.contains(if dropin {
            "overrides"
        } else {
            "Service file was edited"
        })));
        assert_eq!(f.host.state.borrow().as_str(), "active");
        assert!(f.job.record.app.join("codex-scope").exists());
    }
}
#[test]
fn edited_and_duplicate_hooks_preserve_observer_dependencies() {
    for duplicate in [false, true] {
        let mut f = Fixture::new(false);
        let mut hooks = hooks::read_config(&f.job.record.config.join("hooks.json"))
            .unwrap()
            .1;
        if duplicate {
            let group = hooks["hooks"]["Stop"][0].clone();
            hooks["hooks"]["Stop"].as_array_mut().unwrap().push(group);
        } else {
            hooks["hooks"]["Stop"][0]["hooks"][0]["command"] = json!("true");
        }
        fs::write(
            f.job.record.config.join("hooks.json"),
            hooks::serialize(&hooks).unwrap(),
        )
        .unwrap();
        let problems = f.job.rollback(&f.host).unwrap();
        assert!(problems.iter().any(|p| p.contains("hooks remain")));
        assert!(f.job.record.app.join("codex-scope-observer").exists());
    }
}
#[test]
fn changed_hook_ownership_cannot_claim_unrelated_hook() {
    let mut f = Fixture::new(false);
    let mut record = f.job.record.hook_ownership.clone();
    record["entries"]["PreToolUse"] = f.original["hooks"]["PreToolUse"][0].clone();
    fs::write(
        f.job.record.config.join("codex-scope-owned.json"),
        hooks::serialize(&record).unwrap(),
    )
    .unwrap();
    assert!(
        f.job
            .rollback(&f.host)
            .unwrap()
            .iter()
            .any(|p| p.contains("ownership changed"))
    );
    let remaining = hooks::read_config(&f.job.record.config.join("hooks.json"))
        .unwrap()
        .1;
    assert!(
        remaining["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .contains(&f.original["hooks"]["PreToolUse"][0])
    );
}
#[test]
fn unrelated_config_edits_survive_uninstall() {
    let mut f = Fixture::new(false);
    let mut config = f.config_text.clone();
    config.extend_from_slice(b"[other]\nkeep = true\n");
    fs::write(f.job.record.config.join("config.toml"), &config).unwrap();
    let mut hooks = hooks::read_config(&f.job.record.config.join("hooks.json"))
        .unwrap()
        .1;
    hooks["extra"] = json!("keep");
    fs::write(
        f.job.record.config.join("hooks.json"),
        hooks::serialize(&hooks).unwrap(),
    )
    .unwrap();
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    assert_eq!(
        fs::read(f.job.record.config.join("config.toml")).unwrap(),
        config
    );
    let mut expected = f.original;
    expected["extra"] = json!("keep");
    assert_eq!(
        hooks::read_config(&f.job.record.config.join("hooks.json"))
            .unwrap()
            .1,
        expected
    );
}
#[test]
fn changed_permissions_are_preserved_and_unchanged_permissions_restored() {
    for changed in [false, true] {
        let mut f = Fixture::new(false);
        let config = f.job.record.config.clone();
        let mode = Permission {
            before: 0o770,
            after: 0o750,
            inode: config.metadata().unwrap().ino(),
        };
        fs::set_permissions(
            &config,
            fs::Permissions::from_mode(if changed { 0o700 } else { 0o750 }),
        )
        .unwrap();
        f.job.record.permissions.insert(config.clone(), mode);
        f.job.save().unwrap();
        let problems = f.job.rollback(&f.host).unwrap();
        assert_eq!(
            config.metadata().unwrap().mode() & 0o7777,
            if changed { 0o700 } else { 0o770 }
        );
        assert_eq!(
            problems
                .iter()
                .any(|p| p.contains("permissions were edited")),
            changed
        );
    }
}
#[test]
fn replaced_app_directory_preserves_external_files() {
    let mut f = Fixture::new(false);
    let moved = f.root.0.join("moved");
    fs::rename(&f.job.record.app, &moved).unwrap();
    symlink(&moved, &f.job.record.app).unwrap();
    assert!(!f.job.rollback(&f.host).unwrap().is_empty());
    assert!(moved.join("codex-scope").exists());
}
#[test]
fn unrecorded_and_edited_owned_files_are_preserved() {
    for owned in [false, true] {
        let mut f = Fixture::new(false);
        let path = f
            .job
            .record
            .app
            .join(if owned { "codex-scope" } else { "user-file" });
        fs::write(&path, b"keep").unwrap();
        assert!(!f.job.rollback(&f.host).unwrap().is_empty());
        assert_eq!(fs::read(path).unwrap(), b"keep");
    }
}
#[test]
fn additional_service_enablement_is_preserved() {
    let mut f = Fixture::new(false);
    let link = f
        .job
        .record
        .unit
        .parent()
        .unwrap()
        .join("other.target.wants")
        .join(SERVICE);
    host::mkdir_private(link.parent().unwrap()).unwrap();
    symlink(&f.job.record.unit, &link).unwrap();
    assert!(
        f.job
            .rollback(&f.host)
            .unwrap()
            .iter()
            .any(|p| p.contains("Additional service enablement"))
    );
    assert!(link.is_symlink());
    assert!(f.job.record.app.join("codex-scope-observer").exists());
}
#[test]
fn edited_recovery_tools_are_not_purged() {
    let mut f = Fixture::new(false);
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    fs::write(f.job.registry.join("codex-scope"), b"edited").unwrap();
    assert!(f.job.purge().unwrap_err().contains("Edited recovery tools"));
    assert!(f.job.record.data.join("viewer.token").exists());
    assert!(f.job.registry.join("manage.sh").exists());
}
#[test]
fn manipulated_record_paths_are_rejected_before_cleanup() {
    for key in ["unit", "runtime", "app", "endpoint", "identity"] {
        let f = Fixture::new(false);
        let mut record = serde_json::to_value(&f.job.record).unwrap();
        record[key] = json!("/tmp/outside");
        fs::write(
            f.job.registry.join("installation.json"),
            hooks::serialize(&record).unwrap(),
        )
        .unwrap();
        assert!(Installation::load(&f.job.registry, &f.root.0).is_err());
        assert!(f.job.record.app.join("codex-scope").exists());
    }
}
#[test]
fn missing_ownership_only_succeeds_if_labelled_hooks_are_absent() {
    let mut f = Fixture::new(false);
    fs::remove_file(f.job.record.config.join("codex-scope-owned.json")).unwrap();
    assert!(
        f.job
            .rollback(&f.host)
            .unwrap()
            .iter()
            .any(|p| p.contains("hooks remain"))
    );
    fs::write(
        f.job.record.config.join("hooks.json"),
        hooks::serialize(&f.original).unwrap(),
    )
    .unwrap();
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
}

#[test]
fn hooks_file_created_by_install_is_removed_when_empty() {
    let mut f = Fixture::new(false);
    let path = f.job.record.config.join("hooks.json");
    let mut config = hooks::read_config(&path).unwrap().1;
    config["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    fs::write(&path, hooks::serialize(&config).unwrap()).unwrap();
    f.job.record.hooks_existed = false;
    f.job.save().unwrap();
    assert!(f.job.rollback(&f.host).unwrap().is_empty());
    assert!(!path.exists());
}

#[test]
fn ambiguous_directory_creation_intent_is_preserved_for_recovery() {
    let mut f = Fixture::new(false);
    f.job
        .record
        .directories
        .insert(f.job.record.app.clone(), None);
    f.job.save().unwrap();
    let problems = f.job.rollback(&f.host).unwrap();
    assert!(
        problems
            .iter()
            .any(|p| p.contains("Directory identity changed"))
    );
    assert!(f.job.record.app.exists());
}

#[test]
fn directory_limit_keeps_interrupted_install_record_recoverable() {
    let mut f = Fixture::new(false);
    let mut path = f.job.record.app.clone();
    for _ in 0..70 {
        path.push("d");
    }
    assert!(
        f.job
            .directory(&path)
            .unwrap_err()
            .contains("too many directories")
    );
    let mut reloaded = Installation::load(&f.job.registry, &f.root.0).unwrap();
    assert!(reloaded.rollback(&f.host).unwrap().is_empty());
    assert!(!reloaded.record.app.exists());
}

#[test]
fn changed_service_enablement_parent_preserves_external_link_and_running_files() {
    let mut f = Fixture::new(false);
    let external = f.root.0.join("external-enablement");
    host::mkdir_private(&external).unwrap();
    let external_link = external.join(SERVICE);
    symlink(&f.job.record.unit, &external_link).unwrap();
    symlink(
        &external,
        f.job
            .record
            .unit
            .parent()
            .unwrap()
            .join("default.target.wants"),
    )
    .unwrap();
    let problems = f.job.rollback(&f.host).unwrap();
    assert!(
        problems
            .iter()
            .any(|p| p.contains("Symlink parent preserved"))
    );
    assert!(external_link.is_symlink());
    assert_eq!(f.host.state.borrow().as_str(), "active");
    assert!(f.job.record.app.join("codex-scope").exists());
}
