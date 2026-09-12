//! Best-effort Git labels. No event or observer waits for this worker.
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Read,
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    time::{Duration, Instant},
};

const PATH_BYTES: usize = 4096;
const OUTPUT_BYTES: usize = 4096;
const CACHE_COUNT: usize = 32;
const LOOKUP_INTERVAL: Duration = Duration::from_millis(250);
const REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const LOOKUP_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
pub struct Metadata {
    pub repo: String,
    pub branch: Option<String>,
    pub observed_at: String,
}
struct Entry {
    cwd: String,
    value: Option<Metadata>,
    checked: Instant,
}
struct Worker {
    send: SyncSender<String>,
    receive: Receiver<Entry>,
    pending: bool,
}
#[derive(Default)]
pub struct GitMetadata {
    worker: Option<Worker>,
    disabled: bool,
    cache: VecDeque<Entry>,
    started: Option<Instant>,
}
impl GitMetadata {
    pub fn observe(&mut self, cwd: &str) -> Option<Metadata> {
        if cwd.len() > PATH_BYTES || !Path::new(cwd).is_absolute() || cwd.contains('\0') {
            return None;
        }
        if let Some(worker) = &mut self.worker
            && let Ok(entry) = worker.receive.try_recv()
        {
            worker.pending = false;
            self.cache.retain(|existing| existing.cwd != entry.cwd);
            if self.cache.len() == CACHE_COUNT {
                self.cache.pop_front();
            }
            self.cache.push_back(entry);
        }
        let entry = self.cache.iter().find(|entry| entry.cwd == cwd);
        let value = entry.and_then(|entry| entry.value.clone());
        let now = Instant::now();
        if self.disabled
            || entry.is_some_and(|entry| now.duration_since(entry.checked) < REFRESH_INTERVAL)
            || self
                .started
                .is_some_and(|started| now.duration_since(started) < LOOKUP_INTERVAL)
        {
            return value;
        }
        if self.worker.is_none() {
            let (send, jobs) = mpsc::sync_channel::<String>(1);
            let (results, receive) = mpsc::sync_channel(1);
            let spawned = std::thread::Builder::new()
                .name("git-labels".into())
                .stack_size(256 * 1024)
                .spawn(move || {
                    while let Ok(cwd) = jobs.recv() {
                        let value = lookup(&cwd);
                        if results
                            .send(Entry {
                                cwd,
                                value,
                                checked: Instant::now(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            if spawned.is_err() {
                self.disabled = true;
                return value;
            }
            self.worker = Some(Worker {
                send,
                receive,
                pending: false,
            });
        }
        let worker = self.worker.as_mut().unwrap();
        if !worker.pending && worker.send.try_send(cwd.to_owned()).is_ok() {
            worker.pending = true;
            self.started = Some(now);
        }
        value
    }
}
fn git(cwd: &str, args: &[&str], deadline: Instant) -> Option<String> {
    if Instant::now() >= deadline {
        return None;
    }
    let mut command = Command::new("/usr/bin/git");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-C", cwd])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let parent = std::process::id();
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                || libc::getppid() != parent as libc::pid_t
            {
                return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
            }
            let limit = libc::rlimit {
                rlim_cur: 128 * 1024 * 1024,
                rlim_max: 128 * 1024 * 1024,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    if unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    let mut bytes = Vec::new();
    let result = loop {
        let mut buffer = [0; 512];
        match stdout.read(&mut buffer) {
            Ok(size) => {
                if bytes.len() + size > OUTPUT_BYTES {
                    break None;
                }
                bytes.extend_from_slice(&buffer[..size]);
                if size == 0 {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            break status
                                .success()
                                .then(|| String::from_utf8(bytes).ok())
                                .flatten();
                        }
                        Err(_) => break None,
                        _ => {}
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    let _ = child.kill();
    let _ = child.wait();
    result.map(|value| value.trim_end_matches('\n').to_owned())
}
fn lookup(cwd: &str) -> Option<Metadata> {
    let deadline = Instant::now() + LOOKUP_TIMEOUT;
    let common = git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline,
    )?;
    let common = Path::new(&common);
    let root = if common.file_name()? == ".git" {
        common.parent()?
    } else {
        common
    };
    let repo = root.file_name()?.to_str()?.to_owned();
    let branch = git(
        cwd,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        deadline,
    );
    if repo.is_empty()
        || repo.len() > 512
        || branch
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 512)
    {
        return None;
    }
    Some(Metadata {
        repo,
        branch,
        observed_at: crate::contract::timestamp(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn run(root: &Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    }
    #[test]
    fn linked_worktree_uses_repository_name_and_tracks_branch_rename() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("example-repo");
        fs::create_dir(&repo).unwrap();
        run(&repo, &["init", "-b", "main"]);
        assert_eq!(
            lookup(repo.to_str().unwrap()).unwrap().branch.as_deref(),
            Some("main")
        );
        run(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        let worktree = directory.path().join("random-worktree");
        run(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "temporary",
                worktree.to_str().unwrap(),
            ],
        );
        let before = lookup(worktree.to_str().unwrap()).unwrap();
        assert_eq!(before.repo, "example-repo");
        assert_eq!(before.branch.as_deref(), Some("temporary"));
        run(&worktree, &["branch", "-m", "identify-sessions"]);
        assert_eq!(
            lookup(worktree.to_str().unwrap())
                .unwrap()
                .branch
                .as_deref(),
            Some("identify-sessions")
        );
        run(&worktree, &["checkout", "--detach"]);
        assert!(lookup(worktree.to_str().unwrap()).unwrap().branch.is_none());
        assert!(lookup(directory.path().to_str().unwrap()).is_none());
    }
    #[test]
    fn blocked_git_and_excess_output_do_not_escape_limits() {
        let directory = tempfile::tempdir().unwrap();
        run(directory.path(), &["init", "-b", "main"]);
        let fifo_path = directory.path().join("blocked-config");
        let fifo = std::ffi::CString::new(fifo_path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let config = directory.path().join(".git/config");
        let original = fs::read_to_string(&config).unwrap();
        fs::write(
            &config,
            format!("{original}\n[include]\npath={}\n", fifo_path.display()),
        )
        .unwrap();
        let start = Instant::now();
        assert!(lookup(directory.path().to_str().unwrap()).is_none());
        assert!(start.elapsed() >= LOOKUP_TIMEOUT);
        assert!(start.elapsed() < Duration::from_millis(500));
        eprintln!("blocked Git elapsed: {:?}", start.elapsed());
        fs::write(&config, original).unwrap();
        run(directory.path(), &["init", "-b", "main"]);
        run(
            directory.path(),
            &["config", "test.output", &"x".repeat(OUTPUT_BYTES + 1)],
        );
        assert!(
            git(
                directory.path().to_str().unwrap(),
                &["config", "--get", "test.output"],
                Instant::now() + LOOKUP_TIMEOUT
            )
            .is_none()
        );
        let start = Instant::now();
        for _ in 0..50 {
            assert!(lookup(directory.path().to_str().unwrap()).is_some());
        }
        eprintln!("50 Git lookups elapsed: {:?}", start.elapsed());
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) },
            0
        );
        eprintln!("Git child peak RSS KiB: {}", usage.ru_maxrss);
    }
    #[test]
    fn intake_never_waits_and_cache_is_bounded() {
        let root = tempfile::tempdir().unwrap();
        run(root.path(), &["init", "-b", "main"]);
        let mut labels = GitMetadata::default();
        let cwd = root.path().to_str().unwrap();
        assert!(labels.observe(cwd).is_none());
        let deadline = Instant::now() + Duration::from_secs(2);
        while labels.observe(cwd).is_none() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let start = Instant::now();
        for _ in 0..10000 {
            assert!(labels.observe(cwd).is_some());
        }
        eprintln!("10000 cached observations: {:?}", start.elapsed());
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(labels.observe("relative").is_none());
        assert!(
            labels
                .observe(&format!("/{}", "x".repeat(PATH_BYTES)))
                .is_none()
        );
        for index in 0..40 {
            labels.started = None;
            let path = format!("{cwd}/missing-{index}");
            labels.observe(&path);
            let deadline = Instant::now() + Duration::from_secs(2);
            while labels.worker.as_ref().unwrap().pending {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
                labels.observe(&path);
            }
            assert!(labels.cache.len() <= CACHE_COUNT);
        }
    }
}
