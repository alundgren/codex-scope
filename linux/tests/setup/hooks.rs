use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::{Command, Stdio};
fn fixture() -> (host::Temporary, Value) {
    let temp = host::Temporary::new("scope-install-test").unwrap();
    let original = json!({"description": "keep", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "exit 2"}]}]}});
    host::atomic_write(&temp.0.join("hooks.json"), &serialize(&original).unwrap()).unwrap();
    (temp, original)
}
fn install(root: &Path) -> Result<bool> {
    update(
        root,
        Some(Path::new("/absent observer'file")),
        Some(Path::new("/tmp/synthetic.sock")),
        false,
        None,
    )
}
#[test]
fn install_uninstall_is_idempotent_and_preserves_unrelated_hooks() {
    let (temp, original) = fixture();
    assert!(install(&temp.0).unwrap());
    let first = fs::read(temp.0.join("hooks.json")).unwrap();
    assert!(!install(&temp.0).unwrap());
    assert_eq!(fs::read(temp.0.join("hooks.json")).unwrap(), first);
    assert_eq!(
        read_config(&temp.0.join("codex-scope-owned.json"))
            .unwrap()
            .1["entries"]
            .as_object()
            .unwrap()
            .len(),
        EVENTS.len()
    );
    assert!(update(&temp.0, None, None, true, None).unwrap());
    assert_eq!(read_config(&temp.0.join("hooks.json")).unwrap().1, original);
    assert!(!update(&temp.0, None, None, true, None).unwrap());
}
#[test]
fn edited_owned_hook_survives_reinstall_and_uninstall() {
    let (temp, original) = fixture();
    install(&temp.0).unwrap();
    let mut config = read_config(&temp.0.join("hooks.json")).unwrap().1;
    config["hooks"]["Stop"][0]["hooks"][0]["command"] = json!("echo user-edit");
    let edited = config["hooks"]["Stop"][0].clone();
    host::atomic_write(&temp.0.join("hooks.json"), &serialize(&config).unwrap()).unwrap();
    install(&temp.0).unwrap();
    update(&temp.0, None, None, true, None).unwrap();
    let result = read_config(&temp.0.join("hooks.json")).unwrap().1;
    assert_eq!(result["hooks"]["Stop"], json!([edited]));
    assert_eq!(
        result["hooks"]["PreToolUse"],
        original["hooks"]["PreToolUse"]
    );
}
#[test]
fn duplicate_owned_hooks_are_preserved() {
    let (_, original) = fixture();
    let mut result = merge(
        &original,
        Some(Path::new("/observer")),
        Some(Path::new("/socket")),
        false,
        None,
    )
    .unwrap();
    let group = result["hooks"]["Stop"][0].clone();
    result["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(group.clone());
    assert_eq!(
        merge(&result, None, None, true, None).unwrap()["hooks"]["Stop"],
        json!([group, group])
    );
}
#[test]
fn missing_observer_command_remains_silent_success() {
    let (temp, _) = fixture();
    install(&temp.0).unwrap();
    let config = read_config(&temp.0.join("hooks.json")).unwrap().1;
    let command = config["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let result = Command::new("/bin/sh")
        .args(["-c", command])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(result.stdout.is_empty() && result.stderr.is_empty());
}
#[test]
fn malformed_and_duplicate_keys_are_rejected_without_changes() {
    let (temp, _) = fixture();
    for raw in [
        b"{invalid".as_slice(),
        br#"{"hooks": {}, "hooks": {}}"#,
        br#"{"hooks":{"Stop":[{"hooks":[],"hooks":[]}]}}"#,
        br#"{"hooks":{"Stop":1}}"#,
    ] {
        fs::write(temp.0.join("hooks.json"), raw).unwrap();
        assert!(install(&temp.0).is_err());
        assert_eq!(fs::read(temp.0.join("hooks.json")).unwrap(), raw);
    }
}
#[test]
fn symlink_and_fifo_configuration_are_rejected() {
    let (temp, _) = fixture();
    let target = temp.0.join("other.json");
    fs::write(&target, b"{}").unwrap();
    fs::remove_file(temp.0.join("hooks.json")).unwrap();
    symlink(&target, temp.0.join("hooks.json")).unwrap();
    assert!(install(&temp.0).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"{}");
    fs::remove_file(temp.0.join("hooks.json")).unwrap();
    let path = std::ffi::CString::new(temp.0.join("hooks.json").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert!(install(&temp.0).is_err());
}
#[test]
fn installation_never_creates_trust_records() {
    let (temp, _) = fixture();
    install(&temp.0).unwrap();
    let mut names = fs::read_dir(&temp.0)
        .unwrap()
        .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        [".codex-scope.lock", "codex-scope-owned.json", "hooks.json"]
    );
}
#[test]
fn interrupted_ownership_journal_recovers_original_config() {
    let (temp, original) = fixture();
    install(&temp.0).unwrap();
    let before = fs::read(temp.0.join("hooks.json")).unwrap();
    let write = |path: &Path, data: &[u8]| {
        if path.file_name().unwrap() == "hooks.json" {
            Err("synthetic disk failure".into())
        } else {
            host::atomic_write(path, data)
        }
    };
    assert!(
        update_locked(
            &temp.0,
            Some(Path::new("/new-observer")),
            Some(Path::new("/new-socket")),
            false,
            None,
            &write
        )
        .is_err()
    );
    assert_eq!(fs::read(temp.0.join("hooks.json")).unwrap(), before);
    update(&temp.0, None, None, true, None).unwrap();
    assert_eq!(read_config(&temp.0.join("hooks.json")).unwrap().1, original);
}
#[test]
fn concurrent_edit_before_replacement_is_preserved() {
    let (temp, _) = fixture();
    let other = json!({"description": "concurrent edit", "hooks": {}});
    let write = |path: &Path, data: &[u8]| {
        host::atomic_write(path, data)?;
        if path.file_name().unwrap() == "codex-scope-owned.json" {
            host::atomic_write(&temp.0.join("hooks.json"), &serialize(&other)?)?;
        }
        Ok(())
    };
    assert!(
        update_locked(
            &temp.0,
            Some(Path::new("/observer")),
            Some(Path::new("/socket")),
            false,
            None,
            &write
        )
        .is_err()
    );
    assert_eq!(read_config(&temp.0.join("hooks.json")).unwrap().1, other);
}
#[test]
fn writable_configuration_and_locked_operation_are_rejected() {
    let (temp, _) = fixture();
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o770)).unwrap();
    assert!(install(&temp.0).is_err());
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o700)).unwrap();
    let _lock = host::lock(&temp.0.join(".codex-scope.lock")).unwrap();
    assert!(install(&temp.0).is_err());
}
