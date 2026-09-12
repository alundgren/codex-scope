use super::host::{self, Host, Result, SERVICE};
use super::managed::{Installation, digest};
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub old: [String; 3],
    pub new: [String; 3],
}

fn targets(job: &Installation) -> [PathBuf; 3] {
    [
        job.record.app.join("codex-scope"),
        job.record.app.join("codex-scope-observer"),
        job.registry.join("codex-scope"),
    ]
}
fn backup(job: &Installation, index: usize) -> PathBuf {
    job.registry.join(format!("upgrade-{index}.backup"))
}
fn read(path: &std::path::Path) -> Result<Vec<u8>> {
    host::read_bounded(path, false, host::BINARY_LIMIT)?.ok_or("Upgrade file is missing".into())
}
fn matches(path: &std::path::Path, hash: &str, mode: u32) -> Result<bool> {
    Ok(digest(&read(path)?) == hash
        && fs::symlink_metadata(path).map_err(host::io_error)?.mode() & 0o7777 == mode)
}
fn stop(job: &Installation, host: &dyn Host) -> Result<()> {
    if !job.unit_owned(host)? {
        return Err("Installed service is missing".into());
    }
    host::systemctl(host, &["stop", SERVICE])?;
    let state = host::systemctl(
        host,
        &["show", SERVICE, "--property=ActiveState", "--value"],
    )?;
    if !["inactive", "failed"].contains(&state.trim()) {
        return Err("Collector stop could not be confirmed".into());
    }
    Ok(())
}
fn hashes(job: &mut Installation, values: &[String; 3]) -> Result<()> {
    for (index, path) in targets(job).iter().enumerate().take(2) {
        job.record
            .files
            .get_mut(path)
            .ok_or("Executable ownership is missing")?
            .hash = values[index].clone();
    }
    job.record
        .recovery
        .insert("codex-scope".into(), values[2].clone());
    Ok(())
}
fn finish(job: &mut Installation) -> Result<()> {
    let pending = job
        .record
        .upgrade
        .as_ref()
        .ok_or("Upgrade record is missing")?;
    for index in 0..3 {
        let path = backup(job, index);
        if fs::symlink_metadata(&path).is_ok() {
            if !matches(&path, &pending.old[index], 0o600)? {
                return Err("Edited upgrade backup preserved".into());
            }
            fs::remove_file(path).map_err(host::io_error)?;
        }
    }
    host::sync_dir(&job.registry)?;
    job.record.upgrade = None;
    job.save()
}

pub fn recover(job: &mut Installation, host: &dyn Host) -> Result<()> {
    let pending = job
        .record
        .upgrade
        .clone()
        .ok_or("Upgrade record is missing")?;
    if job.record.phase == "upgrading" {
        // Validate every file before stopping the service or restoring any executable.
        for (index, path) in targets(job).iter().enumerate() {
            job.check_parents(path)?;
            if !matches(path, &pending.old[index], 0o700)?
                && !matches(path, &pending.new[index], 0o700)?
            {
                return Err(format!("Edited executable preserved: {}", path.display()));
            }
            if !matches(&backup(job, index), &pending.old[index], 0o600)? {
                return Err("Edited upgrade backup preserved".into());
            }
        }
        stop(job, host)?;
        for (index, path) in targets(job).iter().enumerate() {
            host::atomic_write_mode(path, &read(&backup(job, index))?, 0o700)?;
        }
        host::systemctl(host, &["start", SERVICE])?;
        hashes(job, &pending.old)?;
        job.record.phase = "installed".into();
        job.save()?;
    }
    finish(job)
}

pub fn apply(
    job: &mut Installation,
    host: &dyn Host,
    binary: &[u8],
    observer: &[u8],
    verify: impl FnOnce() -> Result<()>,
) -> Result<bool> {
    if job.record.phase != "installed" || job.record.upgrade.is_some() {
        return Err("Finish recovery before upgrading".into());
    }
    if binary.len() > host::BINARY_LIMIT || observer.len() > host::BINARY_LIMIT {
        return Err("Upgrade executable exceeds the size limit".into());
    }
    let paths = targets(job);
    let old = [
        job.record
            .files
            .get(&paths[0])
            .ok_or("Executable ownership is missing")?
            .hash
            .clone(),
        job.record
            .files
            .get(&paths[1])
            .ok_or("Observer ownership is missing")?
            .hash
            .clone(),
        job.record
            .recovery
            .get("codex-scope")
            .ok_or("Recovery ownership is missing")?
            .clone(),
    ];
    for (index, path) in paths.iter().enumerate() {
        job.check_parents(path)?;
        if !matches(path, &old[index], 0o700)? {
            return Err(format!("Edited executable preserved: {}", path.display()));
        }
    }
    if !job.unit_owned(host)? {
        return Err("Installed service is missing".into());
    }
    let new = [digest(binary), digest(observer), digest(binary)];
    if old == new {
        return Ok(false);
    }
    for (index, path) in paths.iter().enumerate() {
        let saved = backup(job, index);
        if fs::symlink_metadata(&saved).is_ok() {
            if !matches(&saved, &old[index], 0o600)? {
                return Err("Unexpected upgrade backup preserved".into());
            }
        } else {
            host::atomic_write(&saved, &read(path)?)?;
        }
    }
    job.record.upgrade = Some(Pending {
        old,
        new: new.clone(),
    });
    job.record.phase = "upgrading".into();
    job.save()?;
    let result = (|| {
        stop(job, host)?;
        for (path, bytes) in paths.iter().zip([binary, observer, binary]) {
            host::atomic_write_mode(path, bytes, 0o700)?;
        }
        host::systemctl(host, &["start", SERVICE])?;
        verify()?;
        hashes(job, &new)?;
        job.record.phase = "installed".into();
        job.save()
    })();
    if let Err(error) = result {
        // A failed record commit must still restore the previous executables.
        job.record.phase = "upgrading".into();
        match recover(job, host) {
            Ok(()) => {
                return Err(format!(
                    "Upgrade failed: {error}. Previous executables restored."
                ));
            }
            Err(recovery) => {
                return Err(format!(
                    "Upgrade failed: {error}. Recovery incomplete: {recovery}. Run linux/install.sh again."
                ));
            }
        }
    }
    finish(job)?;
    Ok(true)
}
