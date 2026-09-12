use crate::{
    contract::{self, MAX_COUNTER, MAX_FRAME, MAX_PAYLOAD},
    token,
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    net::{TcpListener, TcpStream},
    os::{
        fd::{AsRawFd, RawFd},
        unix::{
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixDatagram, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct Limits {
    pub queue_count: usize,
    pub queue_bytes: usize,
    pub events_per_second: usize,
    pub datagrams_per_second: usize,
    pub http_clients: usize,
    pub header_bytes: usize,
    pub request_timeout: Duration,
    pub write_timeout: Duration,
    pub heartbeat_interval: Duration,
    pub heartbeat_expiry: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            queue_count: 64,
            queue_bytes: 1024 * 1024,
            events_per_second: 200,
            datagrams_per_second: 400,
            http_clients: 8,
            header_bytes: 4096,
            request_timeout: Duration::from_secs(2),
            write_timeout: Duration::from_secs(1),
            heartbeat_interval: Duration::from_secs(1),
            heartbeat_expiry: Duration::from_secs(6),
        }
    }
}

#[derive(Default, Clone, Debug, Serialize)]
pub struct Drops {
    pub no_viewer: u64,
    pub invalid: u64,
    pub oversized: u64,
    pub rate: u64,
    pub queue: u64,
    pub disconnect: u64,
}
fn count(value: &mut u64, number: usize) {
    *value = value.saturating_add(number as u64).min(MAX_COUNTER);
}

struct Output {
    bytes: Vec<u8>,
    offset: usize,
    started: Instant,
}
impl Output {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            offset: 0,
            started: Instant::now(),
        }
    }
}
struct Client {
    socket: TcpStream,
    header: Vec<u8>,
    started: Instant,
    reading: bool,
    streaming: bool,
    output: Option<Output>,
}
struct Viewer {
    client: usize,
    id: String,
    sequence: u64,
    last_ack: Instant,
    next_health: Instant,
    queue: VecDeque<Vec<u8>>,
    bytes: usize,
}

pub struct Collector {
    limits: Limits,
    git: crate::git_metadata::GitMetadata,
    drops: Drops,
    ingress: UnixDatagram,
    listener: TcpListener,
    _lock: File,
    socket_path: PathBuf,
    socket_inode: u64,
    clients: Vec<Option<Client>>,
    viewer: Option<Viewer>,
    token: String,
    ingress_start: Instant,
    ingress_count: usize,
    rate_start: Instant,
    rate_count: usize,
}

impl Collector {
    pub fn bind(directory: &Path, token: String, port: u16, limits: Limits) -> io::Result<Self> {
        if !token::valid(&token) {
            return Err(io::Error::other("invalid token format"));
        }
        let directory = std::path::absolute(directory)?;
        if directory
            .symlink_metadata()
            .is_ok_and(|info| info.file_type().is_symlink())
        {
            return Err(io::Error::other("runtime directory must not be a symlink"));
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let info = directory.metadata()?;
        if info.uid() != unsafe { libc::getuid() } || info.mode() & 0o777 != 0o700 {
            return Err(io::Error::other(
                "runtime directory must be account-owned with mode 0700",
            ));
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join("collector.lock"))?;
        if !lock.metadata()?.is_file() {
            return Err(io::Error::other("collector lock must be a regular file"));
        }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let socket_path = directory.join("ingest.sock");
        if let Ok(existing) = socket_path.symlink_metadata() {
            if !existing.file_type().is_socket() || existing.uid() != unsafe { libc::getuid() } {
                return Err(io::Error::other(
                    "refusing to replace non-owned socket path",
                ));
            }
            fs::remove_file(&socket_path)?;
        }
        // Bind TCP first so startup errors cannot leave an ingestion socket behind.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
        listener.set_nonblocking(true)?;
        if unsafe { libc::listen(listener.as_raw_fd(), 8) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let ingress = UnixDatagram::unbound()?;
        ingress.set_nonblocking(true)?;
        socket_option(ingress.as_raw_fd(), libc::SO_RCVBUF, 128 * 1024)?;
        socket_option(ingress.as_raw_fd(), libc::SO_PASSCRED, 1)?;
        // UnixDatagram::bind creates another fd; retain the configured fd with bind(2).
        bind_unix(ingress.as_raw_fd(), &socket_path)?;
        let socket_inode = socket_path.symlink_metadata()?.ino();
        let result = Self {
            limits: limits.clone(),
            git: crate::git_metadata::GitMetadata::default(),
            drops: Drops::default(),
            ingress,
            listener,
            _lock: lock,
            socket_path,
            socket_inode,
            clients: (0..limits.http_clients).map(|_| None).collect(),
            viewer: None,
            token,
            ingress_start: Instant::now(),
            ingress_count: 0,
            rate_start: Instant::now(),
            rate_count: 0,
        };
        fs::set_permissions(&result.socket_path, fs::Permissions::from_mode(0o600))?;
        Ok(result)
    }

    pub fn port(&self) -> io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub fn run(mut self, shutdown: UnixStream) -> io::Result<()> {
        loop {
            self.expire();
            self.prepare_output();
            let now = Instant::now();
            let ingress_enabled = self.ingress_count < self.limits.datagrams_per_second
                || now.duration_since(self.ingress_start) >= Duration::from_secs(1);
            let mut polling = Vec::with_capacity(3 + self.clients.len());
            polling.push(libc::pollfd {
                fd: shutdown.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            });
            polling.push(libc::pollfd {
                fd: self.listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            });
            polling.push(libc::pollfd {
                fd: if ingress_enabled {
                    self.ingress.as_raw_fd()
                } else {
                    -1
                },
                events: libc::POLLIN,
                revents: 0,
            });
            for client in &self.clients {
                polling.push(match client {
                    Some(client) => libc::pollfd {
                        fd: client.socket.as_raw_fd(),
                        events: libc::POLLIN
                            | if client.output.is_some() {
                                libc::POLLOUT
                            } else {
                                0
                            },
                        revents: 0,
                    },
                    None => libc::pollfd {
                        fd: -1,
                        events: 0,
                        revents: 0,
                    },
                });
            }
            let timeout = self.timeout(now, ingress_enabled);
            let ready =
                unsafe { libc::poll(polling.as_mut_ptr(), polling.len() as libc::nfds_t, timeout) };
            if ready < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(io::Error::last_os_error());
            }
            if polling[0].revents != 0 {
                return Ok(());
            }
            if polling[2].revents & libc::POLLIN != 0 {
                self.receive(false);
            }
            // Existing clients run before accepts so a busy listener cannot starve leases.
            for index in 0..self.clients.len() {
                let events = polling[index + 3].revents;
                if events & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    self.disconnect(index);
                    continue;
                }
                if events & libc::POLLIN != 0 {
                    self.read_client(index);
                }
                if events & libc::POLLOUT != 0 {
                    self.write_client(index);
                }
            }
            if polling[1].revents & libc::POLLIN != 0 {
                self.accept()?;
            }
        }
    }

    fn accept(&mut self) -> io::Result<()> {
        for _ in 0..8 {
            let (socket, _) = match self.listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            };
            let Some(index) = self.clients.iter().position(Option::is_none) else {
                continue;
            };
            socket.set_nonblocking(true)?;
            socket_option(socket.as_raw_fd(), libc::SO_SNDBUF, 32_768)?;
            self.clients[index] = Some(Client {
                socket,
                header: Vec::with_capacity(self.limits.header_bytes + 1),
                started: Instant::now(),
                reading: true,
                streaming: false,
                output: None,
            });
        }
        Ok(())
    }

    fn timeout(&self, now: Instant, ingress_enabled: bool) -> i32 {
        let mut deadline = if ingress_enabled {
            None
        } else {
            Some(self.ingress_start + Duration::from_secs(1))
        };
        let mut include = |value| {
            deadline = Some(deadline.map_or(value, |current: Instant| current.min(value)));
        };
        if let Some(viewer) = &self.viewer {
            include(viewer.last_ack + self.limits.heartbeat_expiry);
            if self.clients[viewer.client]
                .as_ref()
                .is_some_and(|client| client.output.is_none())
            {
                include(viewer.next_health);
            }
        }
        for client in self.clients.iter().flatten() {
            if client.reading {
                include(client.started + self.limits.request_timeout);
            }
            if let Some(output) = &client.output {
                include(output.started + self.limits.write_timeout);
            }
        }
        deadline.map_or(-1, |deadline| {
            deadline
                .saturating_duration_since(now)
                .as_millis()
                .saturating_add(1)
                .min(i32::MAX as u128) as i32
        })
    }

    fn expire(&mut self) {
        let now = Instant::now();
        if let Some(viewer) = &self.viewer
            && now.duration_since(viewer.last_ack) >= self.limits.heartbeat_expiry
        {
            self.disconnect(viewer.client);
        }
        for index in 0..self.clients.len() {
            if self.clients[index].as_ref().is_some_and(|client| {
                (client.reading
                    && now.duration_since(client.started) >= self.limits.request_timeout)
                    || client.output.as_ref().is_some_and(|output| {
                        now.duration_since(output.started) >= self.limits.write_timeout
                    })
            }) {
                self.disconnect(index);
            }
        }
    }

    fn disconnect(&mut self, index: usize) {
        if self
            .viewer
            .as_ref()
            .is_some_and(|viewer| viewer.client == index)
            && let Some(viewer) = self.viewer.take()
        {
            count(&mut self.drops.disconnect, viewer.queue.len());
        }
        if let Some(client) = self.clients[index].take() {
            let _ = client.socket.shutdown(std::net::Shutdown::Both);
        }
    }

    fn receive(&mut self, discard: bool) -> bool {
        let mut raw = [0u8; MAX_PAYLOAD + 1];
        for _ in 0..32 {
            let now = Instant::now();
            if now.duration_since(self.ingress_start) >= Duration::from_secs(1) {
                self.ingress_start = now;
                self.ingress_count = 0;
            }
            if self.ingress_count >= self.limits.datagrams_per_second {
                return false;
            }
            let received = receive_datagram(self.ingress.as_raw_fd(), &mut raw);
            let (size, flags, uid) = match received {
                Ok(value) => value,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return true,
                Err(_) => return false,
            };
            self.ingress_count += 1;
            if flags & libc::MSG_CTRUNC != 0 || uid != Some(unsafe { libc::getuid() }) {
                count(&mut self.drops.invalid, 1);
                continue;
            }
            if flags & libc::MSG_TRUNC != 0 || size > MAX_PAYLOAD {
                count(&mut self.drops.oversized, 1);
                continue;
            }
            self.ingest(&raw[..size], discard);
        }
        false
    }

    fn ingest(&mut self, raw: &[u8], discard: bool) {
        let now = Instant::now();
        if let Some(viewer) = &self.viewer
            && now.duration_since(viewer.last_ack) >= self.limits.heartbeat_expiry
        {
            self.disconnect(viewer.client);
        }
        let Some(viewer) = self.viewer.as_mut().filter(|_| !discard) else {
            count(&mut self.drops.no_viewer, 1);
            return;
        };
        if now.duration_since(self.rate_start) >= Duration::from_secs(1) {
            self.rate_start = now;
            self.rate_count = 0;
        }
        self.rate_count = self
            .rate_count
            .saturating_add(1)
            .min(self.limits.events_per_second + 1);
        if self.rate_count > self.limits.events_per_second {
            count(&mut self.drops.rate, 1);
            return;
        }
        if raw.len() > MAX_PAYLOAD {
            count(&mut self.drops.oversized, 1);
            return;
        }
        if viewer.sequence == MAX_COUNTER {
            let index = viewer.client;
            self.disconnect(index);
            return;
        }
        let Some(frame) =
            contract::event_with_git(raw, &viewer.id, viewer.sequence + 1, &mut |cwd| {
                self.git.observe(cwd)
            })
        else {
            count(&mut self.drops.invalid, 1);
            return;
        };
        viewer.sequence += 1;
        if frame.len() > MAX_FRAME
            || viewer.queue.len() >= self.limits.queue_count
            || viewer.bytes + frame.len() > self.limits.queue_bytes
        {
            count(&mut self.drops.queue, 1);
            return;
        }
        viewer.bytes += frame.len();
        viewer.queue.push_back(frame);
    }

    fn read_client(&mut self, index: usize) {
        let Some(client) = &mut self.clients[index] else {
            return;
        };
        let mut input = [0u8; 4097];
        let remaining = if client.reading {
            (self.limits.header_bytes + 1)
                .saturating_sub(client.header.len())
                .min(input.len())
        } else {
            1
        };
        match client.socket.read(&mut input[..remaining]) {
            Ok(0) => {
                self.disconnect(index);
                return;
            }
            Ok(size) if client.reading => client.header.extend_from_slice(&input[..size]),
            Ok(_) => {
                self.disconnect(index);
                return;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
            Err(_) => {
                self.disconnect(index);
                return;
            }
        }
        if client.header.len() > self.limits.header_bytes {
            self.response(index, "431 Request Header Fields Too Large");
            return;
        }
        if !client.header.windows(4).any(|part| part == b"\r\n\r\n") {
            return;
        }
        let header = std::mem::take(&mut client.header);
        client.reading = false;
        let Some(request) = Request::parse(&header) else {
            self.response(index, "400 Bad Request");
            return;
        };
        if !constant_equal(
            request.authorization.as_bytes(),
            format!("Bearer {}", self.token).as_bytes(),
        ) {
            self.response(index, "401 Unauthorized");
            return;
        }
        self.expire();
        if self.clients[index].is_none() {
            return;
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/v1/heartbeat") => {
                if let Some(viewer) = self
                    .viewer
                    .as_mut()
                    .filter(|viewer| viewer.id == request.connection_id)
                {
                    viewer.last_ack = Instant::now();
                    self.response(index, "204 No Content");
                } else {
                    self.response(index, "409 Conflict");
                }
            }
            ("GET", "/v1/stream") => {
                if self.viewer.is_some() {
                    self.response(index, "409 Conflict");
                    return;
                }
                if !self.receive(true) {
                    self.response(index, "503 Service Unavailable");
                    return;
                }
                let Ok(id) = token::connection_id() else {
                    self.response(index, "503 Service Unavailable");
                    return;
                };
                let hello = contract::encode(
                    &json!({"type":"hello", "protocol_version":1, "connection_id":id,
                    "max_payload_bytes":MAX_PAYLOAD, "max_frame_bytes":MAX_FRAME, "heartbeat_interval_ms":2000,
                    "heartbeat_expiry_ms":self.limits.heartbeat_expiry.as_millis() as u64, "loss_before_connection":"unknown"}),
                );
                let mut bytes = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-store\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n".to_vec();
                bytes.extend(hello);
                let client = self.clients[index].as_mut().unwrap();
                client.streaming = true;
                client.output = Some(Output::new(bytes));
                self.viewer = Some(Viewer {
                    client: index,
                    id,
                    sequence: 0,
                    last_ack: Instant::now(),
                    next_health: Instant::now(),
                    queue: VecDeque::new(),
                    bytes: 0,
                });
            }
            _ => self.response(index, "404 Not Found"),
        }
    }

    fn response(&mut self, index: usize, status: &str) {
        if let Some(client) = &mut self.clients[index] {
            client.reading = false;
            client.header.clear();
            client.output = Some(Output::new(
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .into_bytes(),
            ));
        }
    }

    fn prepare_output(&mut self) {
        let Some(viewer) = &mut self.viewer else {
            return;
        };
        let Some(client) = &mut self.clients[viewer.client] else {
            return;
        };
        if client.output.is_some() {
            return;
        }
        let now = Instant::now();
        let bytes = if now >= viewer.next_health {
            viewer.next_health = now + self.limits.heartbeat_interval;
            Some(contract::encode(
                &json!({"type":"health", "connection_id":viewer.id, "known_drops":self.drops, "loss_outside_collector":"unknown"}),
            ))
        } else {
            viewer.queue.pop_front().inspect(|frame| {
                viewer.bytes -= frame.len();
            })
        };
        client.output = bytes.map(Output::new);
    }

    fn write_client(&mut self, index: usize) {
        let Some(client) = &mut self.clients[index] else {
            return;
        };
        let Some(output) = &mut client.output else {
            return;
        };
        match client.socket.write(&output.bytes[output.offset..]) {
            Ok(0) => self.disconnect(index),
            Ok(size) => {
                output.offset += size;
                if output.offset == output.bytes.len() {
                    if client.streaming {
                        client.output = None;
                    } else {
                        self.disconnect(index);
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(_) => self.disconnect(index),
        }
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        if self
            .socket_path
            .symlink_metadata()
            .is_ok_and(|info| info.ino() == self.socket_inode && info.file_type().is_socket())
        {
            let _ = fs::remove_file(&self.socket_path);
        }
    }
}

fn socket_option(fd: RawFd, option: i32, value: i32) -> io::Result<()> {
    if unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            (&value as *const i32).cast(),
            size_of::<i32>() as libc::socklen_t,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn bind_unix(fd: RawFd, path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { zeroed() };
    if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(io::Error::other("socket path is too long"));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    unsafe {
        std::ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            address.sun_path.as_mut_ptr().cast(),
            bytes.len(),
        );
        if libc::bind(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        ) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn receive_datagram(fd: RawFd, bytes: &mut [u8]) -> io::Result<(usize, i32, Option<libc::uid_t>)> {
    // usize storage gives cmsghdr its required alignment on each Linux target.
    let mut ancillary = [0usize; 16];
    let mut iovec = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = size_of_val(&ancillary);
    let size = unsafe { libc::recvmsg(fd, &mut message, libc::MSG_DONTWAIT) };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut uid = None;
    unsafe {
        let mut control = libc::CMSG_FIRSTHDR(&message);
        while !control.is_null() {
            if (*control).cmsg_level == libc::SOL_SOCKET
                && (*control).cmsg_type == libc::SCM_CREDENTIALS
                && (*control).cmsg_len >= libc::CMSG_LEN(size_of::<libc::ucred>() as u32) as usize
            {
                uid = Some(
                    std::ptr::read_unaligned(libc::CMSG_DATA(control).cast::<libc::ucred>()).uid,
                );
            }
            control = libc::CMSG_NXTHDR(&message, control);
        }
    }
    Ok((size as usize, message.msg_flags, uid))
}

struct Request {
    method: String,
    path: String,
    authorization: String,
    connection_id: String,
}
impl Request {
    fn parse(bytes: &[u8]) -> Option<Self> {
        if !bytes.is_ascii() {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let (header, remaining) = text.split_once("\r\n\r\n")?;
        if !remaining.is_empty() {
            return None;
        }
        let mut lines = header.split("\r\n");
        let mut request = lines.next()?.split(' ');
        let method = request.next()?.to_owned();
        let path = request.next()?.to_owned();
        if request.next()? != "HTTP/1.1" || request.next().is_some() {
            return None;
        }
        let mut headers = std::collections::BTreeMap::new();
        for line in lines {
            let (key, value) = line.split_once(':')?;
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
                || value.bytes().any(|byte| byte < 32 && byte != b'\t')
            {
                return None;
            }
            if headers
                .insert(key.to_ascii_lowercase(), value.trim().to_owned())
                .is_some()
            {
                return None;
            }
        }
        if headers.contains_key("transfer-encoding")
            || headers
                .get("content-length")
                .is_some_and(|length| length != "0")
        {
            return None;
        }
        Some(Self {
            method,
            path,
            authorization: headers.remove("authorization").unwrap_or_default(),
            connection_id: headers.remove("x-connection-id").unwrap_or_default(),
        })
    }
}
fn constant_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for (index, byte) in right.iter().enumerate() {
        difference |= (left.get(index).copied().unwrap_or(0) ^ byte) as usize;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attached(limits: Limits) -> (tempfile::TempDir, Collector, TcpStream) {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut collector = Collector::bind(directory.path(), "a".repeat(64), 0, limits).unwrap();
        let client = TcpStream::connect(("127.0.0.1", collector.port().unwrap())).unwrap();
        collector.accept().unwrap();
        collector.viewer = Some(Viewer {
            client: 0,
            id: "test".into(),
            sequence: 0,
            last_ack: Instant::now(),
            next_health: Instant::now() + Duration::from_secs(1),
            queue: VecDeque::new(),
            bytes: 0,
        });
        (directory, collector, client)
    }
    #[test]
    fn git_labels_arrive_on_later_events_without_changing_payloads() {
        let (_directory, mut collector, _client) = attached(Limits::default());
        let repo = tempfile::tempdir().unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-b", "temporary"])
                .arg(repo.path())
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let raw = serde_json::to_vec(
            &json!({"hook_event_name":"Stop", "session_id":"same-session", "cwd":repo.path()}),
        )
        .unwrap();
        collector.ingest(&raw, false);
        let first: serde_json::Value = serde_json::from_slice(
            &collector
                .viewer
                .as_mut()
                .unwrap()
                .queue
                .pop_front()
                .unwrap(),
        )
        .unwrap();
        assert!(first["git"].is_null());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            std::thread::sleep(Duration::from_millis(20));
            collector.ingest(&raw, false);
            let frame: serde_json::Value = serde_json::from_slice(
                &collector
                    .viewer
                    .as_mut()
                    .unwrap()
                    .queue
                    .pop_front()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(frame["payload"].as_str().unwrap().as_bytes(), raw);
            if frame["git"]["branch"] == "temporary" {
                break;
            }
            assert!(Instant::now() < deadline);
        }
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(repo.path())
                .args(["branch", "-m", "renamed"])
                .status()
                .unwrap()
                .success()
        );
        loop {
            std::thread::sleep(Duration::from_millis(20));
            collector.ingest(&raw, false);
            let frame: serde_json::Value = serde_json::from_slice(
                &collector
                    .viewer
                    .as_mut()
                    .unwrap()
                    .queue
                    .pop_front()
                    .unwrap(),
            )
            .unwrap();
            if frame["git"]["branch"] == "renamed" {
                break;
            }
            assert!(Instant::now() < deadline);
        }
    }
    #[test]
    fn queue_count_byte_rate_and_disconnect_bounds() {
        let (_directory, mut collector, _client) = attached(Limits {
            queue_count: 2,
            queue_bytes: 1024,
            events_per_second: 10,
            ..Limits::default()
        });
        for _ in 0..1000 {
            collector.ingest(b"{\"hook_event_name\":\"Stop\"}", false);
        }
        let viewer = collector.viewer.as_ref().unwrap();
        assert!(viewer.queue.len() <= 2);
        assert!(viewer.bytes <= 1024);
        assert!(collector.drops.queue > 0);
        assert_eq!(collector.drops.rate, 990);
        let queued = viewer.queue.len();
        collector.disconnect(0);
        assert!(collector.viewer.is_none());
        assert_eq!(collector.drops.disconnect, queued as u64);
    }
    #[test]
    fn frame_escaping_and_safe_counter_exhaustion() {
        let (_directory, mut collector, _client) = attached(Limits::default());
        let mut raw = b"{\"hook_event_name\":\"Stop\",\"x\":\"".to_vec();
        while raw.len() + 8 < MAX_PAYLOAD {
            raw.extend(b"\\u0000");
        }
        raw.extend(b"\"}");
        collector.ingest(&raw, false);
        let viewer = collector.viewer.as_mut().unwrap();
        assert!(viewer.bytes <= MAX_FRAME);
        viewer.sequence = MAX_COUNTER;
        collector.ingest(b"{\"hook_event_name\":\"Stop\"}", false);
        assert!(collector.viewer.is_none());
        let mut count_value = MAX_COUNTER - 1;
        count(&mut count_value, 5);
        assert_eq!(count_value, MAX_COUNTER);
    }
    #[test]
    fn kernel_backlog_is_discarded_before_new_viewer() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut collector =
            Collector::bind(directory.path(), "a".repeat(64), 0, Limits::default()).unwrap();
        let sender = UnixDatagram::unbound().unwrap();
        for _ in 0..5 {
            sender
                .send_to(
                    b"{\"hook_event_name\":\"Stop\"}",
                    directory.path().join("ingest.sock"),
                )
                .unwrap();
        }
        assert!(collector.receive(true));
        assert_eq!(collector.drops.no_viewer, 5);
        assert!(collector.viewer.is_none());
    }
    #[test]
    fn credentials_are_provided_by_kernel() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let collector =
            Collector::bind(directory.path(), "a".repeat(64), 0, Limits::default()).unwrap();
        UnixDatagram::unbound()
            .unwrap()
            .send_to(b"test", directory.path().join("ingest.sock"))
            .unwrap();
        let (size, flags, uid) =
            receive_datagram(collector.ingress.as_raw_fd(), &mut [0; 10]).unwrap();
        assert_eq!(size, 4);
        assert_eq!(flags & libc::MSG_CTRUNC, 0);
        assert_eq!(uid, Some(unsafe { libc::getuid() }));
    }
    #[test]
    fn unsafe_runtime_paths_are_refused() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("private");
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Collector::bind(&path, "a".repeat(64), 0, Limits::default()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(path.join("ingest.sock"), "user file").unwrap();
        assert!(Collector::bind(&path, "a".repeat(64), 0, Limits::default()).is_err());
        assert_eq!(
            fs::read_to_string(path.join("ingest.sock")).unwrap(),
            "user file"
        );
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(path, &link).unwrap();
        assert!(Collector::bind(&link, "a".repeat(64), 0, Limits::default()).is_err());
    }
}
