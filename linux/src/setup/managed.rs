use super::hooks;
use super::host::{self, Host, Result, SERVICE};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedFile {
    pub hash: String,
    pub mode: u32,
    pub retain: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permission {
    pub before: u32,
    pub after: u32,
    pub inode: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub identity: String,
    pub phase: String,
    pub config: PathBuf,
    pub hooks_existed: bool,
    pub app: PathBuf,
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub unit: PathBuf,
    pub endpoint: String,
    pub dns: Option<String>,
    pub port: u16,
    pub https_port: Option<u16>,
    pub files: BTreeMap<PathBuf, OwnedFile>,
    pub directories: BTreeMap<PathBuf, Option<u64>>,
    pub permissions: BTreeMap<PathBuf, Permission>,
    pub recovery: BTreeMap<String, String>,
    #[serde(default)]
    pub hooks_intent: bool,
    #[serde(default)]
    pub hook_ownership: Value,
    #[serde(default)]
    pub service_intent: bool,
    #[serde(default)]
    pub route_intent: bool,
    #[serde(default)]
    pub route: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgrade: Option<super::upgrade::Pending>,
}
pub struct Installation {
    pub registry: PathBuf,
    pub record: Record,
}
impl Installation {
    pub fn load(registry: &Path, home: &Path) -> Result<Self> {
        let raw = host::read_private(&registry.join("installation.json"), false)?
            .ok_or("Missing installation record")?;
        let record: Record = serde_json::from_value(hooks::parse_json(&raw)?).map_err(|_| {
            "Invalid installation record; preserve it for manual recovery".to_owned()
        })?;
        let invalid = || "Invalid installation record; preserve it for manual recovery".to_owned();
        if record.version != 1
            || ![
                "installing",
                "installed",
                "removing",
                "removed",
                "needs_cleanup",
                "upgrading",
            ]
            .contains(&record.phase.as_str())
            || record.files.len() > 128
            || record.directories.len() > 64
            || record.permissions.len() > 64
            || record.identity.len() != 32
            || !record.identity.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        if record.phase == "upgrading" && record.upgrade.is_none() {
            return Err(invalid());
        }
        if let Some(pending) = &record.upgrade
            && (!["upgrading", "installed"].contains(&record.phase.as_str())
                || pending
                    .old
                    .iter()
                    .chain(&pending.new)
                    .any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            return Err(invalid());
        }
        for path in [&record.config, &record.app, &record.data, &record.runtime] {
            host::private_path(path, home, false, true)?;
        }
        if record.runtime != record.data.join("collector")
            || record.unit != home.join(".config/systemd/user").join(SERVICE)
        {
            return Err(invalid());
        }
        for (index, path) in [&record.config, &record.app, &record.data, registry]
            .iter()
            .enumerate()
        {
            for other in [&record.config, &record.app, &record.data, registry]
                .iter()
                .skip(index + 1)
            {
                if path.starts_with(other) || other.starts_with(path) {
                    return Err(invalid());
                }
            }
        }
        for (path, entry) in &record.files {
            if path != &record.unit
                && !path.starts_with(&record.app)
                && !path.starts_with(&record.data)
            {
                return Err(invalid());
            }
            if path
                .components()
                .any(|c| c == std::path::Component::ParentDir)
                || entry.hash.len() != 64
                || ![0o600, 0o700].contains(&entry.mode)
            {
                return Err(invalid());
            }
        }
        for path in record.directories.keys() {
            if !path.starts_with(home)
                || path == home
                || !(path.starts_with(&record.app)
                    || path.starts_with(&record.data)
                    || record.app.starts_with(path)
                    || record.data.starts_with(path)
                    || record.unit.parent().unwrap().starts_with(path))
                || path
                    .components()
                    .any(|c| c == std::path::Component::ParentDir)
            {
                return Err(invalid());
            }
        }
        for (path, change) in &record.permissions {
            host::private_path(&path.join("scope-validation"), home, false, true)?;
            if ![
                &record.config,
                &record.app,
                &record.data,
                record.unit.parent().unwrap(),
            ]
            .iter()
            .any(|chosen| chosen.starts_with(path))
                || change.before > 0o7777
                || change.after != change.before & !0o022
            {
                return Err(invalid());
            }
        }
        if record.port < 1024
            || record
                .https_port
                .is_some_and(|p| p < 1024 || p == record.port)
        {
            return Err(invalid());
        }
        let endpoint = match (&record.dns, record.https_port) {
            (Some(dns), Some(port)) if super::flow::valid_dns(dns) => {
                format!("https://{dns}:{port}")
            }
            (None, None) => format!("http://127.0.0.1:{}", record.port),
            _ => return Err(invalid()),
        };
        if endpoint != record.endpoint
            || record.recovery.len() != 2
            || !record.recovery.contains_key("codex-scope")
            || !record.recovery.contains_key("manage.sh")
        {
            return Err(invalid());
        }
        if record.route_intent
            && record.route
                != host::expected_listener(
                    record.dns.as_deref().ok_or_else(invalid)?,
                    record.https_port.ok_or_else(invalid)?,
                    record.port,
                )
        {
            return Err(invalid());
        }
        if record.hooks_intent {
            let expected = hooks::merge(
                &json!({}),
                Some(&record.app.join("codex-scope-observer")),
                Some(&record.runtime.join("ingest.sock")),
                false,
                Some(&record.identity),
            )?;
            if record.hook_ownership != expected[hooks::OWNER] {
                return Err(invalid());
            }
        }
        Ok(Self {
            registry: registry.into(),
            record,
        })
    }
    pub fn save(&self) -> Result<()> {
        host::atomic_write(
            &self.registry.join("installation.json"),
            &hooks::serialize(&self.record)?,
        )
    }
    pub fn directory(&mut self, path: &Path) -> Result<()> {
        if fs::symlink_metadata(path).is_ok() {
            return Err(format!(
                "Refusing to overwrite existing directory: {}",
                path.display()
            ));
        }
        let parent = path.parent().ok_or("Directory has no parent")?;
        if !parent.exists() {
            self.directory(parent)?;
        }
        if self.record.directories.len() >= 64 {
            return Err("Installation needs too many directories; choose shorter paths".into());
        }
        self.record.directories.insert(path.into(), None);
        self.save()?;
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(host::io_error)?;
        host::sync_dir(parent)?;
        self.record.directories.insert(
            path.into(),
            Some(path.metadata().map_err(host::io_error)?.ino()),
        );
        self.save()
    }
    pub fn file(&mut self, path: &Path, data: &[u8], mode: u32, retain: bool) -> Result<()> {
        if self.record.files.len() >= 128 {
            return Err("Too many installer-owned files".into());
        }
        self.record.files.insert(
            path.into(),
            OwnedFile {
                hash: digest(data),
                mode,
                retain,
            },
        );
        self.save()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(host::io_error)?;
        file.write_all(data).map_err(host::io_error)?;
        file.sync_all().map_err(host::io_error)?;
        host::sync_dir(path.parent().ok_or("File has no parent")?)
    }
    pub fn check_parents(&self, path: &Path) -> Result<()> {
        for parent in path.ancestors().skip(1) {
            if let Ok(info) = fs::symlink_metadata(parent) {
                if info.file_type().is_symlink() {
                    return Err(format!("Symlink parent preserved: {}", parent.display()));
                }
                if self
                    .record
                    .directories
                    .get(parent)
                    .is_some_and(|inode| inode.is_some_and(|inode| info.ino() != inode))
                {
                    return Err(format!(
                        "Directory identity changed; preserved: {}",
                        parent.display()
                    ));
                }
            }
        }
        Ok(())
    }
    pub fn matches(&self, path: &Path) -> Result<bool> {
        self.check_parents(path)?;
        let Some(entry) = self.record.files.get(path) else {
            return Ok(false);
        };
        let Some(data) = host::read_bounded(path, true, host::BINARY_LIMIT)? else {
            return Ok(false);
        };
        Ok(digest(&data) == entry.hash
            && fs::symlink_metadata(path).map_err(host::io_error)?.mode() & 0o7777 == entry.mode)
    }
    pub fn unit_owned(&self, host: &dyn Host) -> Result<bool> {
        if fs::symlink_metadata(&self.record.unit).is_err() {
            return Ok(false);
        }
        if !self.matches(&self.record.unit)? {
            return Err(format!(
                "Service file was edited; preserved: {}",
                self.record.unit.display()
            ));
        }
        let dropins = host::systemctl(
            host,
            &["show", SERVICE, "--property=DropInPaths", "--value"],
        )?;
        let fragment = host::systemctl(
            host,
            &["show", SERVICE, "--property=FragmentPath", "--value"],
        )?;
        if !dropins.trim().is_empty()
            || !["", &self.record.unit.to_string_lossy()].contains(&fragment.trim())
        {
            return Err("Service overrides or another service definition exist; preserved".into());
        }
        Ok(true)
    }
    fn remove_route(&mut self, host: &dyn Host) -> Result<()> {
        if !self.record.route_intent {
            return Ok(());
        }
        let port = self
            .record
            .https_port
            .ok_or("Missing recorded HTTPS port")?;
        let current = host::listener(&host::serve_config(host)?, port)?;
        if current != json!({}) {
            if current != self.record.route {
                return Err("Tailscale listener was edited; preserved".into());
            }
            host::command(
                host,
                &["tailscale", "serve", &format!("--https={port}"), "off"],
            )?;
            if host::listener(&host::serve_config(host)?, port)? != json!({}) {
                return Err("Tailscale listener removal was not confirmed".into());
            }
        }
        self.record.route_intent = false;
        self.save()
    }
    fn stop_service(&mut self, host: &dyn Host) -> Result<()> {
        if !self.record.service_intent && fs::symlink_metadata(&self.record.unit).is_err() {
            return Ok(());
        }
        if !self.unit_owned(host)? {
            return Err(
                "Service file is missing; cannot establish ownership of the running service".into(),
            );
        }
        let unit_directory = self.record.unit.parent().unwrap();
        let link = unit_directory.join("default.target.wants").join(SERVICE);
        self.check_parents(&link)?;
        for entry in enablement(unit_directory)? {
            if entry != link {
                return Err("Additional service enablement exists; preserved".into());
            }
        }
        if fs::symlink_metadata(&link).is_ok()
            && (!link.is_symlink()
                || fs::canonicalize(&link).map_err(host::io_error)? != self.record.unit)
        {
            return Err("Service enablement was changed; preserved".into());
        }
        host::systemctl(host, &["disable", "--now", SERVICE])?;
        let state = host::systemctl(
            host,
            &["show", SERVICE, "--property=ActiveState", "--value"],
        )?;
        if !["inactive", "failed"].contains(&state.trim()) {
            return Err("Collector stop could not be confirmed".into());
        }
        self.record.service_intent = false;
        self.save()
    }
    fn remove_hooks(&mut self) -> Result<()> {
        if !self.record.hooks_intent {
            return Ok(());
        }
        // Configuration paths must still have the recorded parent identities.
        self.check_parents(&self.record.config.join("hooks.json"))?;
        let (_, ownership) =
            hooks::read_config(&self.record.config.join("codex-scope-owned.json"))?;
        if ownership != json!({}) && ownership != self.record.hook_ownership {
            return Err("Hook ownership changed; preserved hooks and ownership record".into());
        }
        if ownership != json!({}) {
            hooks::update(&self.record.config, None, None, true, None)?;
        }
        let (_, remaining) = hooks::read_config(&self.record.config.join("hooks.json"))?;
        if hooks::has_label(&remaining, &self.record.identity) {
            return Err(
                "Edited or duplicate Scope hooks remain; preserved for manual review".into(),
            );
        }
        if !self.record.hooks_existed && remaining == json!({"hooks": {}}) {
            fs::remove_file(self.record.config.join("hooks.json")).map_err(host::io_error)?;
            host::sync_dir(&self.record.config)?;
        }
        self.record.hooks_intent = false;
        self.save()
    }
    fn remove_file(&self, path: &Path) -> Result<()> {
        if fs::symlink_metadata(path).is_ok() {
            if !self.matches(path)? {
                return Err(format!("Edited file preserved: {}", path.display()));
            }
            fs::remove_file(path).map_err(host::io_error)?;
            host::sync_dir(path.parent().unwrap())?;
        }
        Ok(())
    }
    fn remove_runtime(&self, name: &str) -> Result<()> {
        let path = self.record.runtime.join(name);
        self.check_parents(&path)?;
        let info = match fs::symlink_metadata(&path) {
            Ok(i) => i,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(host::io_error(e)),
        };
        let expected = if name == "ingest.sock" {
            info.file_type().is_socket()
        } else {
            info.is_file()
        };
        if !expected || info.uid() != host::uid() || info.file_type().is_symlink() {
            return Err(format!(
                "Unexpected runtime file preserved: {}",
                path.display()
            ));
        }
        let _lock = if name == "collector.lock" {
            Some(host::lock(&path)?)
        } else {
            None
        };
        fs::remove_file(&path).map_err(host::io_error)?;
        host::sync_dir(path.parent().unwrap())
    }
    fn restore_permission(&self, path: &Path, change: &Permission) -> Result<()> {
        let info = fs::symlink_metadata(path).map_err(host::io_error)?;
        let now = info.mode() & 0o7777;
        if !info.is_dir() || info.file_type().is_symlink() || info.ino() != change.inode {
            return Err(format!(
                "Directory identity changed; permissions preserved: {}",
                path.display()
            ));
        }
        if now == change.after {
            fs::set_permissions(path, fs::Permissions::from_mode(change.before))
                .map_err(host::io_error)?;
        } else if now != change.before {
            return Err(format!(
                "Directory permissions were edited; preserved: {}",
                path.display()
            ));
        }
        Ok(())
    }
    pub fn rollback(&mut self, host: &dyn Host) -> Result<Vec<String>> {
        self.record.phase = "removing".into();
        self.save()?;
        let mut problems = Vec::new();
        let mut attempt = |result: Result<()>| match result {
            Ok(()) => true,
            Err(e) => {
                problems.push(e);
                false
            }
        };
        attempt(self.remove_route(host));
        let service_safe = attempt(self.stop_service(host));
        let hooks_safe = attempt(self.remove_hooks());
        if service_safe && hooks_safe {
            for (path, entry) in &self.record.files {
                if !entry.retain {
                    attempt(self.remove_file(path));
                }
            }
            attempt(host::systemctl(host, &["daemon-reload"]).map(|_| ()));
            for name in ["collector.lock", "ingest.sock"] {
                attempt(self.remove_runtime(name));
            }
            for (path, inode) in self.directories_deepest() {
                if let Ok(info) = fs::symlink_metadata(path) {
                    if info.file_type().is_symlink() || Some(info.ino()) != *inode {
                        attempt(Err(format!(
                            "Directory identity changed; preserved: {}",
                            path.display()
                        )));
                    } else if fs::remove_dir(path).is_err() && path.starts_with(&self.record.app) {
                        attempt(Err(format!(
                            "Application directory contains retained files: {}",
                            path.display()
                        )));
                    }
                }
            }
            let mut permissions = self.record.permissions.iter().collect::<Vec<_>>();
            permissions.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
            for (path, change) in permissions {
                attempt(self.restore_permission(path, change));
            }
        }
        self.record.phase = if problems.is_empty() {
            "removed"
        } else {
            "needs_cleanup"
        }
        .into();
        self.save()?;
        Ok(problems)
    }
    fn directories_deepest(&self) -> Vec<(&PathBuf, &Option<u64>)> {
        let mut entries = self.record.directories.iter().collect::<Vec<_>>();
        entries.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
        entries
    }
    pub fn purge_retained(&self) -> Result<()> {
        if self.record.phase != "removed" {
            return Err("Complete uninstall before deleting retained files".into());
        }
        // Check every retained file before deleting any of them.
        for (path, entry) in &self.record.files {
            if entry.retain && fs::symlink_metadata(path).is_ok() && !self.matches(path)? {
                return Err(format!(
                    "Retained file was edited; preserved: {}",
                    path.display()
                ));
            }
        }
        for (path, entry) in &self.record.files {
            if entry.retain {
                self.remove_file(path)?;
            }
        }
        for (path, inode) in self.directories_deepest() {
            if fs::symlink_metadata(path)
                .is_ok_and(|i| i.is_dir() && !i.file_type().is_symlink() && Some(i.ino()) == *inode)
            {
                let _ = fs::remove_dir(path);
            }
        }
        self.save()
    }
    pub fn purge(&self) -> Result<()> {
        if self.record.phase != "removed" {
            return Err("Complete uninstall before deleting recovery tools".into());
        }
        let mut names = fs::read_dir(&self.registry)
            .map_err(host::io_error)?
            .map(|p| p.map(|p| p.file_name()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(host::io_error)?;
        names.sort();
        if names != ["codex-scope", "installation.json", "manage.sh"].map(std::ffi::OsString::from)
        {
            return Err("Unexpected recovery files exist; preserved the recovery directory".into());
        }
        for (name, expected) in &self.record.recovery {
            let path = self.registry.join(name);
            let bytes = host::read_bounded(&path, false, host::BINARY_LIMIT)?
                .ok_or("Recovery tool missing")?;
            if digest(&bytes) != *expected
                || path.metadata().map_err(host::io_error)?.mode() & 0o7777 != 0o700
            {
                return Err("Edited recovery tools were preserved".into());
            }
        }
        self.purge_retained()?;
        for name in ["manage.sh", "codex-scope", "installation.json"] {
            fs::remove_file(self.registry.join(name)).map_err(host::io_error)?;
        }
        fs::remove_dir(&self.registry).map_err(host::io_error)?;
        host::sync_dir(self.registry.parent().unwrap())
    }
}
pub fn enablement(directory: &Path) -> Result<Vec<PathBuf>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(directory).map_err(host::io_error)? {
        let path = entry.map_err(host::io_error)?.path();
        if path.file_name().is_some_and(|n| {
            n.to_string_lossy().ends_with(".wants") || n.to_string_lossy().ends_with(".requires")
        }) && fs::symlink_metadata(path.join(SERVICE)).is_ok()
        {
            result.push(path.join(SERVICE));
        }
    }
    Ok(result)
}
#[cfg(test)]
#[path = "../../tests/setup/managed.rs"]
mod tests;
