use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const LIMIT: usize = 4 * 1024 * 1024;
pub const BINARY_LIMIT: usize = 64 * 1024 * 1024;
pub const SERVICE: &str = "codex-scope.service";
pub type Result<T> = std::result::Result<T, String>;
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

pub fn io_error(error: std::io::Error) -> String {
    format!("Filesystem or process operation failed: {}", error.kind())
}
pub fn uid() -> u32 {
    unsafe { libc::getuid() }
}
pub fn check_cancelled() -> Result<()> {
    if INTERRUPTED.load(Ordering::Relaxed) {
        Err("Cancelled.".into())
    } else {
        Ok(())
    }
}
extern "C" fn interrupted(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
}
pub fn signals(cleanup: bool) {
    INTERRUPTED.store(false, Ordering::Relaxed);
    unsafe {
        let handler = if cleanup {
            libc::SIG_IGN
        } else {
            interrupted as *const () as usize
        };
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

/// Only external service commands are substituted by isolated tests.
pub trait Host {
    fn command(&self, args: &[String], timeout: Duration) -> Result<String>;
}
pub struct NativeHost;
impl Host for NativeHost {
    fn command(&self, args: &[String], timeout: Duration) -> Result<String> {
        run_command(args, timeout)
    }
}
pub fn command(host: &dyn Host, args: &[&str]) -> Result<String> {
    host.command(
        &args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
        Duration::from_secs(20),
    )
}
pub fn systemctl(host: &dyn Host, args: &[&str]) -> Result<String> {
    let mut all = vec!["systemctl", "--user"];
    all.extend_from_slice(args);
    command(host, &all)
}

pub struct ChildGuard(pub Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Descendants can keep stdout open after the immediate child exits.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}
pub fn spawn(command: &mut Command) -> Result<ChildGuard> {
    command.stderr(Stdio::null()).process_group(0);
    Ok(ChildGuard(command.spawn().map_err(io_error)?))
}
pub fn nonblocking(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}
pub fn read_ready(fd: i32, deadline: Instant) -> Result<()> {
    loop {
        check_cancelled()?;
        if Instant::now() >= deadline {
            return Err("Command timed out; no command output was logged".into());
        }
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(100) as i32;
        let rc = unsafe { libc::poll(&mut pollfd, 1, ms) };
        if rc > 0 {
            return Ok(());
        }
        if rc < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(io_error(std::io::Error::last_os_error()));
        }
    }
}
pub fn run_command(args: &[String], timeout: Duration) -> Result<String> {
    let (program, rest) = args.split_first().ok_or("Missing command")?;
    let mut cmd = Command::new(program);
    cmd.args(rest).stdin(Stdio::null()).stdout(Stdio::piped());
    let mut child = spawn(&mut cmd)?;
    let mut stdout = child.0.stdout.take().ok_or("Command output unavailable")?;
    nonblocking(stdout.as_raw_fd())?;
    let deadline = Instant::now() + timeout;
    let mut data = Vec::new();
    let mut buffer = [0_u8; 65536];
    loop {
        read_ready(stdout.as_raw_fd(), deadline)?;
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if data.len() + n > LIMIT {
                    return Err(
                        "Command returned more than 4 MiB; no command output was logged".into(),
                    );
                }
                data.extend_from_slice(&buffer[..n]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(io_error(e)),
        }
    }
    loop {
        check_cancelled()?;
        if Instant::now() >= deadline {
            return Err("Command timed out; no command output was logged".into());
        }
        if let Some(status) = child.0.try_wait().map_err(io_error)? {
            if !status.success() {
                return Err(format!(
                    "{} failed; check its local configuration and permissions",
                    Path::new(program)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
            }
            return String::from_utf8(data)
                .map_err(|_| "Command returned invalid UTF-8; no output was logged".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn private_path(
    value: &Path,
    home: &Path,
    must_exist: bool,
    allow_writable: bool,
) -> Result<PathBuf> {
    let value = value.to_str().ok_or("Paths must use UTF-8")?;
    let path = if value == "~" {
        home.to_owned()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(value)
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    if !path.starts_with(home)
        || path == home
        || path.components().any(|p| p == Component::ParentDir)
    {
        return Err("Choose a directory below your home directory".into());
    }
    if path.components().any(|part| {
        let text = part.as_os_str().to_string_lossy();
        text.trim() != text
    }) || path
        .to_string_lossy()
        .chars()
        .any(|c| c.is_control() || "%$\\\"".contains(c))
    {
        return Err("Paths cannot contain control characters, quotes, %, $, backslashes, or leading/trailing whitespace".into());
    }
    for parent in path.ancestors() {
        match fs::symlink_metadata(parent) {
            Ok(info) => {
                if !info.is_dir() || info.file_type().is_symlink() {
                    return Err(format!(
                        "Expected a directory without symlinks: {}",
                        parent.display()
                    ));
                }
                if parent.starts_with(home) && info.uid() != uid() {
                    return Err(format!(
                        "Directory belongs to another account: {}",
                        parent.display()
                    ));
                }
                if parent.starts_with(home)
                    && parent != path
                    && info.mode() & 0o022 != 0
                    && !allow_writable
                {
                    return Err(format!(
                        "Parent directory is writable by other users: {}",
                        parent.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io_error(e)),
        }
    }
    if must_exist && !path.is_dir() {
        return Err(format!("Directory does not exist: {}", path.display()));
    }
    Ok(path)
}
pub fn read_private(path: &Path, optional: bool) -> Result<Option<Vec<u8>>> {
    read_bounded(path, optional, LIMIT)
}
pub fn read_bounded(path: &Path, optional: bool, limit: usize) -> Result<Option<Vec<u8>>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let file = match file {
        Ok(f) => f,
        Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    let info = file.metadata().map_err(io_error)?;
    if !info.is_file() || info.uid() != uid() {
        return Err(format!(
            "Expected an account-owned regular file: {}",
            path.display()
        ));
    }
    let mut data = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(io_error)?;
    if data.len() > limit {
        return Err(format!("File exceeds setup size limit: {}", path.display()));
    }
    Ok(Some(data))
}
pub fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(io_error)
}
pub fn random_hex(bytes: usize) -> Result<String> {
    let mut data = vec![0; bytes];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut data))
        .map_err(io_error)?;
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    atomic_write_mode(path, data, 0o600)
}
pub fn atomic_write_mode(path: &Path, data: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or("File has no parent directory")?;
    let temporary = parent.join(format!(".codex-scope-{}", random_hex(8)?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)
            .map_err(io_error)?;
        file.write_all(data).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::rename(&temporary, path).map_err(io_error)?;
        sync_dir(parent)
    })();
    let _ = fs::remove_file(temporary);
    result
}
pub fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(io_error)?;
    let info = file.metadata().map_err(io_error)?;
    if !info.is_file() || info.uid() != uid() {
        return Err("Lock is not an account-owned regular file".into());
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Scope operation holds the lock; wait for it to finish".into());
    }
    Ok(file)
}
pub fn mkdir_private(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(io_error)
}
use std::os::unix::fs::DirBuilderExt;
pub struct Temporary(pub PathBuf);
impl Temporary {
    pub fn new(prefix: &str) -> Result<Self> {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", random_hex(12)?));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(io_error)?;
        Ok(Self(path))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn available(port: u16) -> bool {
    if port < 1024 {
        return false;
    }
    let Ok(_v4) = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) else {
        return false;
    };
    let fd = unsafe { libc::socket(libc::AF_INET6, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return false;
    }
    let listener = unsafe { TcpListener::from_raw_fd(fd) };
    let one: libc::c_int = 1;
    let option = unsafe {
        libc::setsockopt(
            fd,
            libc::IPPROTO_IPV6,
            libc::IPV6_V6ONLY,
            (&one as *const libc::c_int).cast(),
            std::mem::size_of_val(&one) as _,
        )
    };
    let address = libc::sockaddr_in6 {
        sin6_family: libc::AF_INET6 as _,
        sin6_port: port.to_be(),
        sin6_flowinfo: 0,
        sin6_addr: libc::in6_addr {
            s6_addr: Ipv6Addr::UNSPECIFIED.octets(),
        },
        sin6_scope_id: 0,
    };
    option == 0
        && unsafe {
            libc::bind(
                listener.as_raw_fd(),
                (&address as *const libc::sockaddr_in6).cast(),
                std::mem::size_of_val(&address) as _,
            )
        } == 0
}
pub fn choose_port(start: u16, excluded: &[u16]) -> Result<u16> {
    (start..=start.saturating_add(99))
        .find(|p| !excluded.contains(p) && available(*p))
        .ok_or("No free port found near the suggested port; choose one manually".into())
}
pub fn serve_config(host: &dyn Host) -> Result<Value> {
    let value = super::hooks::parse_json(
        command(host, &["tailscale", "serve", "status", "--json"])?.as_bytes(),
    )?;
    if !value.is_object() {
        return Err("Unrecognized Tailscale Serve configuration".into());
    }
    Ok(value)
}
pub fn listener(config: &Value, port: u16) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for key in ["TCP", "Web", "AllowFunnel"] {
        if let Some(value) = config.get(key) {
            let map = value
                .as_object()
                .ok_or("Unrecognized Tailscale Serve configuration")?;
            let selected = map
                .iter()
                .filter(|(k, _)| *k == &port.to_string() || k.ends_with(&format!(":{port}")))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>();
            if !selected.is_empty() {
                result.insert(key.into(), Value::Object(selected));
            }
        }
    }
    for key in ["Foreground", "Services"] {
        if config.get(key).is_some_and(|v| {
            !v.is_null() && v != &json!({}) && v != &json!([]) && v != &json!(false)
        }) {
            return Err(
                "Serve foreground handlers or Services need manual setup; no routes changed".into(),
            );
        }
    }
    Ok(Value::Object(result))
}
pub fn expected_listener(dns: &str, https: u16, local: u16) -> Value {
    json!({"TCP": {https.to_string(): {"HTTPS": true}}, "Web": {format!("{dns}:{https}"): {"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{local}")}}}}})
}
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub fn need(name: &str, package: &str) -> Result<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|v| std::env::split_paths(&v).collect::<Vec<_>>())
        .map(|d| d.join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .ok_or_else(|| format!("Missing {name}. Install {package}, then run setup again."))
}
pub fn username() -> Result<String> {
    let mut buffer = vec![0; 65536];
    let mut user: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            uid(),
            &mut user,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if rc != 0 || found.is_null() {
        return Err("Cannot identify the current account".into());
    }
    Ok(unsafe { std::ffi::CStr::from_ptr(user.pw_name) }
        .to_string_lossy()
        .into_owned())
}
