use super::hooks::{self, EVENTS};
use super::host::{self, Result};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn hooks_list(codex: &Path, home: &Path, workspace: &Path) -> Result<Value> {
    let mut command = Command::new(codex);
    command
        .args(["app-server", "--stdio"])
        .current_dir(workspace)
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut process = host::spawn(&mut command)?;
    let mut input = process.0.stdin.take().ok_or("Codex input unavailable")?;
    let mut output = process.0.stdout.take().ok_or("Codex output unavailable")?;
    host::nonblocking(input.as_raw_fd())?;
    host::nonblocking(output.as_raw_fd())?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut pending = Vec::new();
    let mut total = 0;
    let mut send = |message: &Value| -> Result<()> {
        let mut bytes =
            serde_json::to_vec(message).map_err(|_| "Cannot encode inspection request")?;
        bytes.push(b'\n');
        let mut written = 0;
        while written < bytes.len() {
            host::check_cancelled()?;
            if Instant::now() >= deadline {
                return Err("Codex hook inspection timed out".into());
            }
            match input.write(&bytes[written..]) {
                Ok(0) => return Err("Codex closed before hook inspection".into()),
                Ok(n) => written += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return Err("Codex closed before hook inspection".into()),
            }
        }
        Ok(())
    };
    let mut receive = |number: u64| -> Result<Value> {
        for _ in 0..64 {
            let line = loop {
                if let Some(index) = pending.iter().position(|b| *b == b'\n') {
                    let line = pending.drain(..=index).collect::<Vec<_>>();
                    break line;
                }
                host::read_ready(output.as_raw_fd(), deadline)?;
                let mut buffer = [0; 65536];
                match output.read(&mut buffer) {
                    Ok(0) => return Err("Codex closed before answering hooks/list".into()),
                    Ok(n) => {
                        total += n;
                        if total > host::LIMIT {
                            return Err(
                                "Codex hook inspection exceeded the 4 MiB output limit".into()
                            );
                        }
                        pending.extend_from_slice(&buffer[..n]);
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => return Err("Codex hook inspection output failed".into()),
                }
            };
            let response =
                hooks::parse_json(&line).map_err(|_| "Codex returned unsupported hook metadata")?;
            if response.get("id").and_then(Value::as_u64) == Some(number) {
                if response.get("error").is_some() {
                    return Err(
                        "Codex rejected hook inspection; check its configuration and MCP setup"
                            .into(),
                    );
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or("Codex returned unsupported hook metadata".into());
            }
        }
        Err("Codex sent too many notifications during hook inspection".into())
    };
    send(
        &json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "codex_scope_probe", "version": "1"}, "capabilities": {"experimentalApi": true}}}),
    )?;
    receive(1)?;
    send(&json!({"method": "initialized"}))?;
    send(&json!({"id": 2, "method": "hooks/list", "params": {"cwds": [workspace]}}))?;
    receive(2)
}
pub fn registrations(result: &Value) -> Result<&[Value]> {
    let invalid = "Cannot verify Codex hook registrations without warnings or errors";
    let entries = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or(invalid)?;
    if entries.len() != 1 {
        return Err(invalid.into());
    }
    for key in ["errors", "warnings"] {
        if entries[0]
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.as_array().is_some_and(Vec::is_empty))
        {
            return Err(invalid.into());
        }
    }
    entries[0]
        .get("hooks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(invalid.into())
}
pub fn check_entries(
    hooks: &[Value],
    identity: &str,
    trusted: bool,
    command: Option<&str>,
) -> Result<()> {
    let label = format!("codex-scope {identity}");
    let owned = hooks
        .iter()
        .filter(|h| h.get("statusMessage").and_then(Value::as_str) == Some(&label))
        .collect::<Vec<_>>();
    let mut expected = EVENTS
        .iter()
        .map(|e| format!("{}{}", e[..1].to_lowercase(), &e[1..]))
        .collect::<Vec<_>>();
    let mut found = owned
        .iter()
        .map(|h| {
            h.get("eventName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect::<Vec<_>>();
    expected.sort();
    found.sort();
    if found != expected
        || owned.iter().any(|h| {
            h.get("handlerType") != Some(&json!("command"))
                || h.get("timeoutSec") != Some(&json!(1))
                || h.get("async") != Some(&json!(false))
                || h.get("enabled") != Some(&json!(true))
        })
    {
        return Err("Codex did not recognize all twelve enabled synchronous observers".into());
    }
    if command.is_some_and(|command| {
        owned
            .iter()
            .any(|h| h.get("command").and_then(Value::as_str) != Some(command))
    }) {
        return Err("Observer commands changed during approval; preserve them for review".into());
    }
    let state = if trusted { "trusted" } else { "untrusted" };
    if owned
        .iter()
        .any(|h| h.get("trustStatus").and_then(Value::as_str) != Some(state))
    {
        return Err(if trusted {
            "Hook trust could not be verified"
        } else {
            "Isolated hooks unexpectedly have trust"
        }
        .into());
    }
    Ok(())
}
pub fn compatible(codex: &Path, observer: &Path) -> Result<Value> {
    let temporary = host::Temporary::new("scope-probe")?;
    let home = temporary.0.join("codex");
    let workspace = temporary.0.join("workspace");
    host::mkdir_private(&workspace)?;
    hooks::update(
        &home,
        Some(observer),
        Some(&temporary.0.join("absent.sock")),
        false,
        None,
    )?;
    host::atomic_write(
        &home.join("config.toml"),
        b"[analytics]\nenabled = false\n[feedback]\nenabled = false\n",
    )?;
    let (_, record) = hooks::read_config(&home.join("codex-scope-owned.json"))?;
    let result = hooks_list(codex, &home, &workspace)?;
    check_entries(
        registrations(&result)?,
        record["identity"].as_str().ok_or("Missing hook identity")?,
        false,
        None,
    )?;
    Ok(result)
}
