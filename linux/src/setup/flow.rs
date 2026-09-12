use super::hooks;
use super::host::{self, Host, NativeHost, Result, SERVICE};
use super::managed::{self, Installation, Permission, Record};
use super::probe;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

fn input(question: &str) -> Result<String> {
    print!("{question}");
    std::io::stdout().flush().map_err(host::io_error)?;
    let mut data = Vec::new();
    loop {
        host::check_cancelled()?;
        // Polling keeps Ctrl+C cancellable without restarting a blocking read.
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let rc = unsafe { libc::poll(&mut fd, 1, 100) };
        if rc < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(host::io_error(std::io::Error::last_os_error()));
        }
        if rc == 0 {
            continue;
        }
        let mut byte = [0];
        let count = unsafe { libc::read(0, byte.as_mut_ptr().cast(), 1) };
        let read = if count < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(count as usize)
        };
        match read {
            Ok(0) => return Err("Cancelled.".into()),
            Ok(_) if byte[0] == b'\n' => {
                return String::from_utf8(data)
                    .map(|s| s.trim().to_owned())
                    .map_err(|_| "Input must use UTF-8".into());
            }
            Ok(_) => {
                data.push(byte[0]);
                if data.len() > 4096 {
                    return Err("Input exceeds the setup limit".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => (),
            Err(e) => return Err(host::io_error(e)),
        }
    }
}
fn ask(question: &str, default: &str) -> Result<String> {
    let suffix = if default.is_empty() {
        String::new()
    } else {
        format!(" [{default}]")
    };
    let result = input(&format!("{question}{suffix}: "))?;
    Ok(if result.is_empty() {
        default.into()
    } else {
        result
    })
}
fn yes(question: &str) -> Result<bool> {
    loop {
        match input(&format!("{question} [y/N]: "))?
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "n" | "no" => return Ok(false),
            "y" | "yes" => return Ok(true),
            _ => println!("Enter y or n."),
        }
    }
}
fn confirm(question: &str) -> Result<()> {
    if yes(question)? {
        Ok(())
    } else {
        Err("Cancelled.".into())
    }
}
pub fn valid_dns(dns: &str) -> bool {
    !dns.is_empty()
        && dns.len() <= 253
        && dns.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
fn prerequisite(host: &dyn Host, remote: bool) -> Result<Option<String>> {
    if !cfg!(target_os = "linux") || host::uid() == 0 {
        return Err("Run as your normal Linux account, not root or sudo.".into());
    }
    for (name, package) in [
        ("codex", "Codex CLI"),
        ("systemctl", "systemd"),
        ("loginctl", "systemd"),
    ] {
        host::need(name, package)?;
    }
    host::systemctl(host, &["show", "--property=Version", "--value"])?;
    if host::command(
        host,
        &[
            "loginctl",
            "show-user",
            &host::uid().to_string(),
            "--property=Linger",
            "--value",
        ],
    )?
    .trim()
        != "yes"
    {
        return Err(format!(
            "User lingering is disabled. For startup after logout/reboot, run loginctl enable-linger {} with administrator approval, then retry. Setup has not changed this account setting.",
            host::username()?
        ));
    }
    if !remote {
        return Ok(None);
    }
    host::need("tailscale", "Tailscale")?;
    let status =
        hooks::parse_json(host::command(host, &["tailscale", "status", "--json"])?.as_bytes())?;
    let dns = status
        .get("Self")
        .and_then(|v| v.get("DNSName"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end_matches('.');
    if status.get("BackendState").and_then(Value::as_str) != Some("Running")
        || !valid_dns(dns)
        || !status
            .get("CertDomains")
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty())
    {
        return Err("Tailscale must be logged in with HTTPS certificates enabled. Complete Tailscale setup first; no routes were changed.".into());
    }
    Ok(Some(dns.into()))
}
struct ConfigFiles {
    config: Vec<u8>,
    hooks_raw: Option<Vec<u8>>,
    hooks: Value,
}
fn config_files(config: &Path) -> Result<ConfigFiles> {
    let raw =
        host::read_private(&config.join("config.toml"), false)?.ok_or("Missing config.toml")?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| "Codex configuration is malformed; no files changed")?;
    toml::from_str::<toml::Table>(text)
        .map_err(|_| "Codex configuration is malformed or has duplicate keys; no files changed")?;
    let (hooks_raw, hooks) = hooks::read_config(&config.join("hooks.json"))?;
    if fs::symlink_metadata(config.join("codex-scope-owned.json")).is_ok() {
        return Err("An existing Scope hook installation has no guided setup record. Uninstall it with its original installer before continuing.".into());
    }
    Ok(ConfigFiles {
        config: raw,
        hooks_raw,
        hooks,
    })
}
pub fn unit_text(app: &Path, data: &Path, port: u16) -> String {
    format!(
        "[Unit]\nDescription=Codex Scope collector\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=simple\nWorkingDirectory={}\nExecStart=\"{}\" collector --runtime-dir \"{}\" --token-file \"{}\" --port {port}\nUMask=0077\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        app.display(),
        app.join("codex-scope").display(),
        data.join("collector").display(),
        data.join("viewer.token").display()
    )
}
fn port_prompt(label: &str, default: u16) -> Result<u16> {
    let port: u16 = ask(label, &default.to_string())?
        .parse()
        .map_err(|_| "Enter a numeric port from 1024 to 65535")?;
    if !host::available(port) {
        return Err(format!(
            "Port {port} is unavailable. Nothing will be stopped to free it."
        ));
    }
    Ok(port)
}
fn ensure_separate(paths: &[&Path], source: Option<&Path>) -> Result<()> {
    for (index, path) in paths.iter().enumerate() {
        if source.is_some_and(|source| path.starts_with(source) || source.starts_with(path)) {
            return Err("Installation paths must be outside the checkout".into());
        }
        for other in paths.iter().skip(index + 1) {
            if path.starts_with(other) || other.starts_with(path) {
                return Err(
                    "Configuration, application, and data directories must not overlap".into(),
                );
            }
        }
    }
    Ok(())
}
fn checkout(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| path.join("linux/Cargo.toml").is_file() && path.join("AGENTS.md").is_file())
        .map(Path::to_owned)
}
fn wait_http(endpoint: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        host::check_cancelled()?;
        match crate::viewer::check_endpoint(endpoint) {
            Ok(()) => return Ok(()),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
fn live_checks(job: &Installation, host: &dyn Host) -> Result<()> {
    if !job.unit_owned(host)? {
        return Err("Installed service is missing".into());
    }
    let bytes = host::read_private(&job.record.data.join("viewer.token"), false)?
        .ok_or("Private token file is missing")?;
    let token = std::str::from_utf8(&bytes)
        .map_err(|_| "Invalid token file")?
        .trim()
        .to_owned();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid token file".into());
    }
    wait_http(&job.record.endpoint)?;
    let ready = Arc::new(AtomicBool::new(false));
    let finish = Arc::new(AtomicBool::new(false));
    let marker = format!("scope-check-{}", host::random_hex(4)?);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let endpoint = job.record.endpoint.clone();
    let (watch_ready, watch_finish, watch_marker) = (ready.clone(), finish.clone(), marker.clone());
    let watcher = std::thread::spawn(move || {
        let result = crate::viewer::inspect(
            &endpoint,
            &token,
            180.0,
            crate::viewer::InspectOptions {
                ready: Some(&watch_ready),
                finish: Some(&watch_finish),
                match_text: Some(&watch_marker),
            },
        );
        let _ = sender.send(result);
    });
    let interaction = (|| {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !ready.load(Ordering::Relaxed) {
            host::check_cancelled()?;
            if watcher.is_finished() || Instant::now() >= deadline {
                return Err("Diagnostic viewer could not connect. Close any other viewer and check the endpoint.".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        println!("In a fresh session in your usual Codex client, submit:");
        println!("Run printf '{marker}\\n'. Do not modify any files.");
        confirm("Did the task finish normally?")
    })();
    finish.store(true, Ordering::Relaxed);
    let result = receiver.recv_timeout(Duration::from_secs(8));
    if watcher.is_finished() {
        let _ = watcher.join();
    }
    interaction?;
    let result = result.map_err(|_| "Diagnostic viewer did not stop within eight seconds")??;
    if result
        .get("matching_events")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        == 0
    {
        return Err(
            "No matching live event was verified within three minutes. Capture remains unverified."
                .into(),
        );
    }
    println!(
        "Received events: {}; test marker found. Loss outside the collector is unknown.",
        result.get("events").and_then(Value::as_u64).unwrap_or(0)
    );
    if !job.unit_owned(host)? {
        return Err("Service changed during verification".into());
    }
    host::systemctl(host, &["stop", SERVICE])?;
    if host::systemctl(
        host,
        &["show", SERVICE, "--property=ActiveState", "--value"],
    )?
    .trim()
        != "inactive"
    {
        return Err("Collector stop could not be confirmed".into());
    }
    println!(
        "In the same client, submit: Run printf 'scope collector stopped\\n'. Do not modify any files."
    );
    let answer = confirm("Did that task also finish normally?");
    // Cancellation still restarts the previously owned service during verification.
    let cancelled = host::check_cancelled().is_err();
    if cancelled {
        host::signals(true);
    }
    let restart: Result<()> = (|| {
        if job.unit_owned(host)? {
            host::systemctl(host, &["start", SERVICE])?;
        }
        Ok(())
    })();
    if cancelled {
        host::signals(false);
    }
    restart?;
    answer?;
    wait_http(&job.record.endpoint)?;
    println!(
        "Live capture and collector-stop checks passed. UI connectivity and full compatibility are not verified."
    );
    Ok(())
}
fn show(job: &Installation) -> Result<()> {
    println!("Installation state: {}", job.record.phase);
    println!("Endpoint: {}", job.record.endpoint);
    println!(
        "Private token file: {}",
        job.record.data.join("viewer.token").display()
    );
    println!(
        "Manage or uninstall: {}",
        host::shell_quote(&job.registry.join("manage.sh").to_string_lossy())
    );
    if let Some(dns) = &job.record.dns {
        let remote = format!(
            "{}@{dns}:{}",
            host::username()?,
            job.record.data.join("viewer.token").display()
        );
        println!("On your other machine, copy the token over SSH into a private directory:");
        println!("mkdir -p ~/.config/codex-scope && chmod 700 ~/.config/codex-scope");
        println!(
            "scp {} ~/.config/codex-scope/viewer.token",
            host::shell_quote(&remote)
        );
        println!("chmod 600 ~/.config/codex-scope/viewer.token");
    }
    println!(
        "No viewer connected means events are discarded. Only one viewer may connect at a time."
    );
    Ok(())
}
const LAUNCHER: &[u8] =
    b"#!/bin/sh\nset -eu\nexec \"$(dirname -- \"$0\")/codex-scope\" manage \"$@\"\n";
fn prepare_registry(registry: &Path, binary: &[u8]) -> Result<BTreeMap<String, String>> {
    if fs::symlink_metadata(registry).is_ok() {
        return Err("Recovery directory already exists; preserve it for review".into());
    }
    host::mkdir_private(registry)?;
    for (name, bytes) in [("codex-scope", binary), ("manage.sh", LAUNCHER)] {
        host::atomic_write(&registry.join(name), bytes)?;
        fs::set_permissions(registry.join(name), fs::Permissions::from_mode(0o700))
            .map_err(host::io_error)?;
    }
    host::sync_dir(registry)?;
    Ok(BTreeMap::from([
        ("codex-scope".into(), managed::digest(binary)),
        ("manage.sh".into(), managed::digest(LAUNCHER)),
    ]))
}
struct Plan {
    record: Record,
    config_files: ConfigFiles,
    binary: Vec<u8>,
    observer: Vec<u8>,
    serve_before: Value,
}
fn apply(job: &mut Installation, plan: &Plan, host: &dyn Host) -> Result<()> {
    let mut permissions = job.record.permissions.iter().collect::<Vec<_>>();
    permissions.sort_by_key(|(p, _)| p.components().count());
    for (path, change) in permissions {
        let info = fs::symlink_metadata(path).map_err(host::io_error)?;
        if info.file_type().is_symlink()
            || info.ino() != change.inode
            || info.mode() & 0o7777 != change.before
        {
            return Err("Directory permissions changed during setup; stopping".into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(change.after))
            .map_err(host::io_error)?;
    }
    let (app, data, config, runtime, unit) = (
        job.record.app.clone(),
        job.record.data.clone(),
        job.record.config.clone(),
        job.record.runtime.clone(),
        job.record.unit.clone(),
    );
    job.directory(&app)?;
    job.file(&app.join("codex-scope"), &plan.binary, 0o700, false)?;
    job.file(
        &app.join("codex-scope-observer"),
        &plan.observer,
        0o700,
        false,
    )?;
    job.directory(&data)?;
    job.directory(&data.join("backup"))?;
    job.directory(&runtime)?;
    job.file(
        &data.join("backup/config.toml"),
        &plan.config_files.config,
        0o600,
        true,
    )?;
    if let Some(raw) = &plan.config_files.hooks_raw {
        job.file(&data.join("backup/hooks.json"), raw, 0o600, true)?;
    }
    job.file(
        &data.join("viewer.token"),
        format!("{}\n", host::random_hex(32)?).as_bytes(),
        0o600,
        true,
    )?;
    job.record.hook_ownership = hooks::merge(
        &plan.config_files.hooks,
        Some(&app.join("codex-scope-observer")),
        Some(&runtime.join("ingest.sock")),
        false,
        Some(&job.record.identity),
    )?[hooks::OWNER]
        .clone();
    job.record.hooks_intent = true;
    job.save()?;
    hooks::update(
        &config,
        Some(&app.join("codex-scope-observer")),
        Some(&runtime.join("ingest.sock")),
        false,
        Some(&job.record.identity),
    )?;
    if !unit.parent().unwrap().exists() {
        job.directory(unit.parent().unwrap())?;
    }
    job.file(
        &unit,
        unit_text(&app, &data, job.record.port).as_bytes(),
        0o600,
        false,
    )?;
    job.record.service_intent = true;
    job.save()?;
    job.check_parents(
        &unit
            .parent()
            .unwrap()
            .join("default.target.wants")
            .join(SERVICE),
    )?;
    host::systemctl(host, &["daemon-reload"])?;
    host::systemctl(host, &["enable", "--now", SERVICE])?;
    wait_http(&format!("http://127.0.0.1:{}", job.record.port))?;
    if let (Some(dns), Some(https_port)) = (job.record.dns.as_deref(), job.record.https_port) {
        if host::serve_config(host)? != plan.serve_before {
            return Err(
                "Tailscale routes changed during installation; stopping before exposure".into(),
            );
        }
        job.record.route = host::expected_listener(dns, https_port, job.record.port);
        job.record.route_intent = true;
        job.save()?;
        host::command(
            host,
            &[
                "tailscale",
                "serve",
                "--bg",
                &format!("--https={https_port}"),
                &format!("http://127.0.0.1:{}", job.record.port),
            ],
        )?;
        if host::listener(&host::serve_config(host)?, https_port)? != job.record.route {
            return Err("Tailscale did not create the expected private listener".into());
        }
        crate::viewer::check_endpoint(&job.record.endpoint)?;
    }
    Ok(())
}
fn new_install(home: &Path, registry: &Path, host: &dyn Host) -> Result<()> {
    let remote = yes("Use Tailscale to connect from another device?")?;
    let config = host::private_path(
        Path::new(&ask(
            "Codex configuration directory",
            &home.join(".codex").to_string_lossy(),
        )?),
        home,
        true,
        true,
    )?;
    if !fs::symlink_metadata(config.join("config.toml"))
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
    {
        return Err("No regular config.toml found in that directory. Choose your existing Codex configuration.".into());
    }
    confirm("Read Codex config.toml and hooks.json here, and check local services?")?;
    let dns = prerequisite(host, remote)?;
    let config_files = config_files(&config)?;
    let mut app = home.join(".local/share/codex-scope");
    let mut data = home.join(".local/state/codex-scope");
    let mut port = host::choose_port(4319, &[])?;
    let serve_before = if remote {
        host::serve_config(host)?
    } else {
        json!({})
    };
    let mut https_port = if remote {
        Some(host::choose_port(8443, &[port])?)
    } else {
        None
    };
    if let Some(mut https) = https_port {
        while host::listener(&serve_before, https)? != json!({}) {
            https = host::choose_port(
                https.checked_add(1).ok_or("No free Tailscale port found")?,
                &[port],
            )?;
        }
        https_port = Some(https);
    }
    println!(
        "Application: {}\nPrivate data: {}\nLoopback port: {port}",
        app.display(),
        data.display()
    );
    if let Some(https) = https_port {
        println!("Tailscale HTTPS port: {https}");
    }
    if yes("Customize these suggestions?")? {
        app = PathBuf::from(ask("Application directory", &app.to_string_lossy())?);
        data = PathBuf::from(ask("Private data directory", &data.to_string_lossy())?);
        port = port_prompt("Loopback port", port)?;
        if let Some(https) = https_port {
            https_port = Some(port_prompt("Tailscale HTTPS port", https)?);
        }
    }
    app = host::private_path(&app, home, false, true)?;
    data = host::private_path(&data, home, false, true)?;
    let executable = std::env::current_exe().map_err(host::io_error)?;
    let observer = executable
        .parent()
        .ok_or("Executable directory is missing")?
        .join("codex-scope-observer");
    ensure_separate(
        &[&config, &app, &data, registry],
        checkout(&executable).as_deref(),
    )?;
    if fs::symlink_metadata(&app).is_ok() || fs::symlink_metadata(&data).is_ok() {
        return Err("Application or data directory already exists. Choose unused directories; setup will not overwrite them.".into());
    }
    if data.join("collector/ingest.sock").as_os_str().len() >= 108 {
        return Err(
            "Private data path is too long for a Unix socket; choose a shorter directory".into(),
        );
    }
    let unit = home.join(".config/systemd/user").join(SERVICE);
    host::private_path(unit.parent().unwrap(), home, false, true)?;
    host::private_path(
        &unit.parent().unwrap().join("default.target.wants"),
        home,
        false,
        true,
    )?;
    if fs::symlink_metadata(&unit).is_ok()
        || !managed::enablement(unit.parent().unwrap())?.is_empty()
        || host::systemctl(host, &["show", SERVICE, "--property=LoadState", "--value"])?.trim()
            != "not-found"
    {
        return Err("A codex-scope systemd service already exists; preserve it and uninstall it separately first".into());
    }
    if https_port == Some(port) {
        return Err("Chosen Tailscale HTTPS port matches the collector port".into());
    }
    if let Some(https) = https_port {
        let current = host::listener(&serve_before, https)?;
        if current != json!({}) {
            return Err("Chosen Tailscale HTTPS port is already configured".into());
        }
    }
    let mut permissions = BTreeMap::new();
    for chosen in [&config, &app, &data, unit.parent().unwrap()] {
        for path in chosen.ancestors().filter(|p| p.starts_with(home)) {
            if let Ok(info) = fs::symlink_metadata(path) {
                let before = info.mode() & 0o7777;
                if before & 0o022 != 0 && !permissions.contains_key(path) {
                    if permissions.len() >= 64 {
                        return Err(
                            "Installation needs too many permission changes; choose shorter paths"
                                .into(),
                        );
                    }
                    confirm(&format!(
                        "Remove group/other write permission from {} for this installation?",
                        path.display()
                    ))?;
                    permissions.insert(
                        path.into(),
                        Permission {
                            before,
                            after: before & !0o022,
                            inode: info.ino(),
                        },
                    );
                }
            }
        }
    }
    println!(
        "Checking native executables, isolated Codex registrations, and automatic uninstall rehearsal..."
    );
    let binary = host::read_bounded(&executable, false, host::BINARY_LIMIT)?
        .ok_or("Native executable is missing")?;
    let observer_bytes = host::read_bounded(&observer, false, host::BINARY_LIMIT)?
        .ok_or("Native observer is missing; build both Linux executables before setup")?;
    if observer.metadata().map_err(host::io_error)?.mode() & 0o111 == 0 {
        return Err(
            "Native observer is not executable; build both Linux executables before setup".into(),
        );
    }
    let codex = host::need("codex", "Codex CLI")?;
    probe::compatible(&codex, &observer)?;
    hooks::rehearsal(&config_files.hooks, &observer)?;
    let endpoint = if let (Some(dns), Some(https)) = (&dns, https_port) {
        format!("https://{dns}:{https}")
    } else {
        format!("http://127.0.0.1:{port}")
    };
    println!(
        "Application: {}\nPrivate data: {}\nCodex configuration: {}",
        app.display(),
        data.display(),
        config.display()
    );
    println!("Add 12 observer hooks and enable {SERVICE} at startup.");
    println!("Endpoint: {endpoint}. Capture is discarded whenever no viewer is connected.");
    confirm("Apply these changes and run the two interactive tests?")?;
    if host::read_private(&config.join("config.toml"), false)?.as_deref()
        != Some(config_files.config.as_slice())
        || hooks::read_config(&config.join("hooks.json"))?.0 != config_files.hooks_raw
    {
        return Err(
            "Codex configuration changed during setup; retry after other edits finish".into(),
        );
    }
    if !host::available(port)
        || https_port.is_some_and(|p| !host::available(p))
        || (remote && host::serve_config(host)? != serve_before)
    {
        return Err("Port availability or Tailscale configuration changed; retry".into());
    }
    // Service ownership is also checked after the potentially long approval prompt.
    host::private_path(
        &unit.parent().unwrap().join("default.target.wants"),
        home,
        false,
        true,
    )?;
    if fs::symlink_metadata(&unit).is_ok()
        || !managed::enablement(unit.parent().unwrap())?.is_empty()
        || host::systemctl(host, &["show", SERVICE, "--property=LoadState", "--value"])?.trim()
            != "not-found"
    {
        return Err("Service configuration changed during setup; preserve it and retry".into());
    }
    let recovery = prepare_registry(registry, &binary)?;
    let record = Record {
        version: 1,
        identity: host::random_hex(16)?,
        phase: "installing".into(),
        config,
        hooks_existed: config_files.hooks_raw.is_some(),
        app,
        runtime: data.join("collector"),
        data,
        unit,
        endpoint,
        dns,
        port,
        https_port,
        files: BTreeMap::new(),
        directories: BTreeMap::new(),
        permissions,
        recovery,
        hooks_intent: false,
        hook_ownership: Value::Null,
        service_intent: false,
        route_intent: false,
        route: Value::Null,
    };
    let plan = Plan {
        record,
        config_files,
        binary,
        observer: observer_bytes,
        serve_before,
    };
    // The plan owns the initial record; subsequent changes are journaled by the job.
    let mut job = Installation {
        registry: registry.into(),
        record: plan.record.clone(),
    };
    job.save()?;
    let result = (|| {
        apply(&mut job, &plan, host)?;
        println!("In another terminal, run:");
        println!(
            "CODEX_HOME={} codex -C {}",
            host::shell_quote(&job.record.config.to_string_lossy()),
            host::shell_quote(&home.to_string_lossy())
        );
        println!("Open /hooks, approve only the 12 new codex-scope commands, then exit.");
        println!("If another MCP blocks startup, fix it separately; setup will not disable it.");
        confirm("Have you approved those hooks?")?;
        let registrations = probe::hooks_list(&codex, &job.record.config, home)?;
        let expected = job.record.hook_ownership["entries"]["Stop"]["hooks"][0]["command"]
            .as_str()
            .ok_or("Missing expected observer command")?;
        probe::check_entries(
            probe::registrations(&registrations)?,
            &job.record.identity,
            true,
            Some(expected),
        )?;
        live_checks(&job, host)?;
        job.record.phase = "installed".into();
        job.save()?;
        show(&job)
    })();
    if let Err(error) = result {
        println!("\nInstallation did not finish. Undoing the recorded changes...");
        host::signals(true);
        let cleanup = job.rollback(host);
        host::signals(false);
        match cleanup {
            Ok(problems) => {
                for problem in &problems {
                    println!("{problem}");
                }
                println!(
                    "{}",
                    if problems.is_empty() {
                        "Rollback finished. Backups and credentials are retained."
                    } else {
                        "Cleanup is incomplete; review the preserved resources."
                    }
                );
            }
            Err(_) => println!(
                "Cleanup could not finish. The installation record is retained for recovery."
            ),
        }
        println!(
            "To inspect or retry cleanup, run:\n{}",
            host::shell_quote(&registry.join("manage.sh").to_string_lossy())
        );
        return Err(error);
    }
    Ok(())
}
pub fn run(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "codex-scope setup\ncodex-scope manage [inspect|verify|uninstall|purge]\ncodex-scope probe"
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "probe") {
        if args.len() != 1 {
            return Err("Usage: codex-scope probe".into());
        }
        let executable = std::env::current_exe().map_err(host::io_error)?;
        let observer = executable.parent().unwrap().join("codex-scope-observer");
        if !observer.is_file() {
            return Err("Build both Linux executables before probing Codex".into());
        }
        let result = probe::compatible(&host::need("codex", "Codex CLI")?, &observer)?;
        let events = probe::registrations(&result)?
            .iter()
            .filter_map(|h| h.get("eventName"))
            .collect::<Vec<_>>();
        println!("{}", serde_json::to_string_pretty(&json!({"registered_events": events, "all_registrations_recognized": true, "account_configuration_modified": false, "real_event_emission_and_policy_coexistence": "not tested"})).map_err(|_| "Cannot encode probe result")?);
        return Ok(());
    }
    let action =
        match args.first().map(String::as_str) {
            Some("setup") if args.len() == 1 => None,
            Some("manage") if args.len() <= 2 => args.get(1).map(String::as_str),
            _ => return Err(
                "Usage: codex-scope setup or codex-scope manage [inspect|verify|uninstall|purge]"
                    .into(),
            ),
        };
    if action.is_some_and(|a| !["inspect", "verify", "uninstall", "purge"].contains(&a)) {
        return Err("Choose inspect, verify, uninstall, or purge".into());
    }
    unsafe {
        libc::umask(0o077);
    }
    println!("Codex Scope setup");
    if unsafe { libc::isatty(0) } != 1 {
        return Err(
            "Run setup in an interactive terminal; unattended installation is not supported."
                .into(),
        );
    }
    host::signals(false);
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home directory is unavailable")?);
    if !home.is_absolute() {
        return Err("Home directory must be absolute".into());
    }
    let registry = home.join(".local/state/codex-scope-installer");
    host::private_path(&registry, &home, false, false)?;
    let lock_parent = home.join(".local/state");
    host::mkdir_private(&lock_parent)?;
    let _lock = host::lock(&lock_parent.join(".codex-scope-setup.lock"))?;
    let host = NativeHost;
    if registry.exists() {
        if !registry.join("installation.json").exists() {
            return Err(format!(
                "Incomplete recovery directory exists: {}. Preserve and inspect it before retrying.",
                registry.display()
            ));
        }
        confirm("Read the installation record and selected Codex/service configuration?")?;
        let mut job = Installation::load(&registry, &home)?;
        if ["installing", "removing", "needs_cleanup"].contains(&job.record.phase.as_str()) {
            println!(
                "An interrupted installation needs rollback before another install can start."
            );
            confirm("Undo its recorded changes now?")?;
            cleanup(&mut job, &host)?;
            println!("Rollback finished. Backups and credentials are retained.");
            return Ok(());
        }
        let action = match action {
            Some(a) => a.to_owned(),
            None => ask("Choose inspect, verify, uninstall, or purge", "inspect")?,
        };
        match action.as_str() {
            "inspect" => {
                show(&job)?;
                if job.record.phase == "installed" {
                    let state = host::systemctl(
                        &host,
                        &["show", SERVICE, "--property=ActiveState", "--value"],
                    )?;
                    let state = match state.trim() {
                        "active" | "inactive" | "failed" | "activating" | "deactivating"
                        | "reloading" => state.trim(),
                        _ => "unknown",
                    };
                    println!("Service state: {state}");
                }
            }
            "verify" => {
                if job.record.phase != "installed" {
                    return Err("Only a completed installation can be verified".into());
                }
                live_checks(&job, &host)?;
            }
            "uninstall" => {
                confirm("Remove unchanged Scope hooks, service, listener, and application files?")?;
                cleanup(&mut job, &host)?;
                println!(
                    "Uninstall finished. Hook approval records remain inert; existing Codex settings were preserved."
                );
                if yes("Also delete unchanged local token and configuration backups?")? {
                    job.purge_retained()?;
                }
                println!(
                    "Recovery tools and record are retained. To remove them after review:\n{} purge",
                    host::shell_quote(&registry.join("manage.sh").to_string_lossy())
                );
            }
            "purge" => {
                confirm("Delete retained token, backups, and recovery tools after uninstall?")?;
                job.purge()?;
                println!("Retained files removed. A fresh install is now possible.");
            }
            _ => return Err("Choose inspect, verify, uninstall, or purge".into()),
        }
    } else if args.first().is_some_and(|a| a == "manage") {
        return Err("No guided installation record was found".into());
    } else {
        new_install(&home, &registry, &host)?;
    }
    Ok(())
}
fn cleanup(job: &mut Installation, host: &dyn Host) -> Result<()> {
    let problems = job.rollback(host)?;
    for problem in &problems {
        println!("{problem}");
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(
            "Cleanup is incomplete. Review the preserved resources, then run management again."
                .into(),
        )
    }
}
#[cfg(test)]
#[path = "../../tests/setup/flow.rs"]
mod tests;
