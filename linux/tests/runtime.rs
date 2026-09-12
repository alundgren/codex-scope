use codex_scope::{
    collector::{Collector, Limits},
    contract::{MAX_FRAME, MAX_PAYLOAD},
    token, viewer,
};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::TcpStream,
    os::{
        fd::AsRawFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixDatagram, UnixStream},
        },
    },
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYLOAD: &[u8] = b" {\"hook_event_name\":\"PreToolUse\",\"session_id\":\"synthetic\",\"tool_name\":\"Bash\",\"extra\":42}\n";

struct Running {
    directory: tempfile::TempDir,
    port: u16,
    stop: UnixStream,
    worker: Option<thread::JoinHandle<()>>,
}
impl Running {
    fn new(limits: Limits) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("scope-runtime-")
            .tempdir()
            .unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let collector = Collector::bind(directory.path(), TOKEN.into(), 0, limits).unwrap();
        let port = collector.port().unwrap();
        let (stop, shutdown) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || collector.run(shutdown).unwrap());
        Self {
            directory,
            port,
            stop,
            worker: Some(worker),
        }
    }
    fn observe(&self, raw: &[u8]) {
        UnixDatagram::unbound()
            .unwrap()
            .send_to(raw, self.directory.path().join("ingest.sock"))
            .unwrap();
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        extra: &str,
    ) -> (u16, BufReader<TcpStream>) {
        let mut socket = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(socket, "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n{extra}\r\n").unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let status = line.split(' ').nth(1).unwrap().parse().unwrap();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        (status, reader)
    }
    fn stream(&self) -> (BufReader<TcpStream>, Value) {
        let (status, mut reader) = self.request("GET", "/v1/stream", TOKEN, "");
        assert_eq!(status, 200);
        let hello = frame(&mut reader);
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["loss_before_connection"], "unknown");
        (reader, hello)
    }
    fn shutdown(&mut self) {
        self.stop.write_all(b"x").unwrap();
        self.worker.take().unwrap().join().unwrap();
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if self.worker.is_some() {
            self.shutdown();
        }
    }
}
fn frame(reader: &mut impl BufRead) -> Value {
    let mut bytes = Vec::new();
    reader
        .take(MAX_FRAME as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .unwrap();
    assert!(!bytes.is_empty() && bytes.len() <= MAX_FRAME);
    serde_json::from_slice(&bytes).unwrap()
}
fn event(reader: &mut impl BufRead) -> Value {
    for _ in 0..10 {
        let value = frame(reader);
        if value["type"] == "event" {
            return value;
        }
    }
    panic!("no event received");
}
fn health(reader: &mut impl BufRead) -> Value {
    for _ in 0..1000 {
        let value = frame(reader);
        if value["type"] == "health" {
            return value;
        }
    }
    panic!("no health received");
}

#[test]
fn exact_payload_and_account_socket_credentials() {
    let run = Running::new(Limits::default());
    let (mut reader, hello) = run.stream();
    run.observe(PAYLOAD);
    let delivered = event(&mut reader);
    assert_eq!(delivered["payload"].as_str().unwrap().as_bytes(), PAYLOAD);
    assert_eq!(delivered["payload_bytes"], PAYLOAD.len());
    assert_eq!(delivered["sequence"], 1);
    assert_eq!(delivered["connection_id"], hello["connection_id"]);
    assert_eq!(delivered["tool_name"], "Bash");
    assert_eq!(
        fs::metadata(run.directory.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(run.directory.path().join("ingest.sock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn auth_routes_and_malformed_headers() {
    let run = Running::new(Limits::default());
    assert_eq!(run.request("GET", "/v1/stream", "wrong", "").0, 401);
    for extra in [
        "Content-Length: 1\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Authorization: Bearer duplicate\r\n",
        " Bad: header\r\n",
    ] {
        assert_eq!(run.request("GET", "/v1/stream", TOKEN, extra).0, 400);
    }
    let (_reader, _) = run.stream();
    assert_eq!(run.request("GET", "/v1/stream", TOKEN, "").0, 409);
    assert_eq!(run.request("POST", "/ingest", TOKEN, "").0, 404);
    assert_eq!(
        run.request("GET", &format!("/v1/stream?token={TOKEN}"), TOKEN, "")
            .0,
        404
    );
}
#[test]
fn heartbeat_renewal_and_expiry() {
    let run = Running::new(Limits {
        heartbeat_expiry: Duration::from_millis(250),
        heartbeat_interval: Duration::from_millis(20),
        ..Limits::default()
    });
    let (_reader, hello) = run.stream();
    let extra = format!(
        "X-Connection-Id: {}\r\n",
        hello["connection_id"].as_str().unwrap()
    );
    for _ in 0..3 {
        thread::sleep(Duration::from_millis(100));
        assert_eq!(run.request("POST", "/v1/heartbeat", TOKEN, &extra).0, 204);
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(run.request("POST", "/v1/heartbeat", TOKEN, &extra).0, 409);
    let (_, new) = run.stream();
    assert_ne!(hello["connection_id"], new["connection_id"]);
}
#[test]
fn reconnect_and_restart_do_not_replay_or_write_events() {
    let mut run = Running::new(Limits::default());
    run.observe(PAYLOAD);
    let (mut reader, hello) = run.stream();
    run.observe(PAYLOAD);
    assert_eq!(event(&mut reader)["sequence"], 1);
    drop(reader);
    thread::sleep(Duration::from_millis(30));
    run.observe(b"{\"hook_event_name\":\"Stop\",\"marker\":\"lost\"}");
    let (mut reader, new) = run.stream();
    assert_ne!(hello["connection_id"], new["connection_id"]);
    run.observe(PAYLOAD);
    let delivered = event(&mut reader);
    assert_eq!(delivered["sequence"], 1);
    assert_eq!(delivered["payload"].as_str().unwrap().as_bytes(), PAYLOAD);
    run.shutdown();
    let files: Vec<_> = fs::read_dir(run.directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(files, ["collector.lock"]);
    let restarted =
        Collector::bind(run.directory.path(), TOKEN.into(), 0, Limits::default()).unwrap();
    drop(restarted);
}
#[test]
fn exclusive_lock_preserves_running_socket() {
    let run = Running::new(Limits::default());
    assert!(Collector::bind(run.directory.path(), TOKEN.into(), 0, Limits::default()).is_err());
    let (mut reader, _) = run.stream();
    run.observe(PAYLOAD);
    assert_eq!(event(&mut reader)["sequence"], 1);
}
#[test]
fn strict_validation_and_maximum_original_bytes() {
    let run = Running::new(Limits {
        heartbeat_interval: Duration::from_millis(50),
        ..Limits::default()
    });
    let (mut reader, _) = run.stream();
    for raw in [
        b"not json".as_slice(),
        b"[]",
        b"{}",
        b"\xff",
        b"{\"hook_event_name\":\"Stop\",\"x\":NaN}",
        b"{\"hook_event_name\":\"Stop\",\"x\":1e999}",
        b"{\"hook_event_name\":\"Stop\",\"x\":\"\\ud800\"}",
        b"{\"hook_event_name\":\"Stop\",\"session_id\":4}",
    ] {
        run.observe(raw);
    }
    run.observe(&vec![b'x'; MAX_PAYLOAD + 1]);
    let prefix = b"{\"hook_event_name\":\"Stop\",\"text\":\"";
    let mut raw = prefix.to_vec();
    raw.resize(MAX_PAYLOAD - 2, b'x');
    raw.extend(b"\"}");
    run.observe(&raw);
    assert_eq!(
        event(&mut reader)["payload"].as_str().unwrap().as_bytes(),
        raw
    );
    let drops = health(&mut reader)["known_drops"].clone();
    assert_eq!(drops["invalid"], 8);
    assert_eq!(drops["oversized"], 1);
}
#[test]
fn concurrent_sessions_share_recording_order() {
    let run = Running::new(Limits::default());
    let (mut reader, _) = run.stream();
    thread::scope(|scope| {
        for index in 0..8 {
            let run = &run;
            scope.spawn(move || {
                run.observe(
                    format!("{{\"hook_event_name\":\"Stop\",\"session_id\":\"{index}\"}}")
                        .as_bytes(),
                )
            });
        }
    });
    let mut sessions = std::collections::BTreeSet::new();
    for sequence in 1..=8 {
        let message = event(&mut reader);
        assert_eq!(message["sequence"], sequence);
        sessions.insert(message["session_id"].as_str().unwrap().to_owned());
    }
    assert_eq!(sessions.len(), 8);
}
#[test]
fn idle_clients_are_capped_and_expire() {
    let run = Running::new(Limits {
        http_clients: 2,
        request_timeout: Duration::from_millis(80),
        ..Limits::default()
    });
    let mut connections: Vec<_> = (0..5)
        .map(|_| TcpStream::connect(("127.0.0.1", run.port)).unwrap())
        .collect();
    thread::sleep(Duration::from_millis(150));
    for connection in &mut connections {
        connection
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        assert_eq!(connection.read(&mut [0]).unwrap(), 0);
    }
    run.stream();
}
#[test]
fn saturated_ingress_refuses_stale_recording_then_recovers() {
    let run = Running::new(Limits {
        datagrams_per_second: 2,
        ..Limits::default()
    });
    for _ in 0..3 {
        run.observe(PAYLOAD);
    }
    thread::sleep(Duration::from_millis(30));
    assert_eq!(run.request("GET", "/v1/stream", TOKEN, "").0, 503);
    thread::sleep(Duration::from_millis(1050));
    let (mut reader, _) = run.stream();
    run.observe(PAYLOAD);
    assert_eq!(event(&mut reader)["sequence"], 1);
}
#[test]
fn stalled_viewer_is_closed_under_write_pressure() {
    let run = Running::new(Limits {
        write_timeout: Duration::from_millis(50),
        heartbeat_expiry: Duration::from_secs(2),
        ..Limits::default()
    });
    use std::os::fd::FromRawFd;
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    assert!(fd >= 0);
    let mut socket = unsafe { TcpStream::from_raw_fd(fd) };
    let receive_buffer = 4096i32;
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_port = run.port.to_be();
    address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
    unsafe {
        assert_eq!(
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                (&receive_buffer as *const i32).cast(),
                4
            ),
            0
        );
        assert_eq!(
            libc::connect(
                socket.as_raw_fd(),
                (&address as *const libc::sockaddr_in).cast(),
                std::mem::size_of_val(&address) as libc::socklen_t
            ),
            0
        );
    }
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        socket,
        "GET /v1/stream HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(socket);
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
    }
    assert_eq!(frame(&mut reader)["type"], "hello");
    let large = format!(
        "{{\"hook_event_name\":\"Stop\",\"text\":\"{}\"}}",
        "x".repeat(60_000)
    );
    for _ in 0..50 {
        run.observe(large.as_bytes());
        thread::sleep(Duration::from_millis(2));
    }
    thread::sleep(Duration::from_millis(120));
    let deadline = Instant::now() + Duration::from_millis(700);
    loop {
        let (status, mut next) = run.request("GET", "/v1/stream", TOKEN, "");
        if status == 200 {
            assert_eq!(frame(&mut next)["protocol_version"], 1);
            break;
        }
        assert_eq!(status, 409);
        assert!(
            Instant::now() < deadline,
            "stalled viewer outlived its write deadline"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn synthetic_viewer_and_endpoint_check() {
    let run = Running::new(Limits {
        heartbeat_interval: Duration::from_millis(20),
        ..Limits::default()
    });
    let endpoint = format!("http://127.0.0.1:{}", run.port);
    viewer::check_endpoint(&endpoint).unwrap();
    let ready = AtomicBool::new(false);
    thread::scope(|scope| {
        let checked = scope.spawn(|| {
            viewer::inspect(
                &endpoint,
                TOKEN,
                0.15,
                viewer::InspectOptions {
                    ready: Some(&ready),
                    match_text: Some("synthetic"),
                    ..Default::default()
                },
            )
            .unwrap()
        });
        let start = Instant::now();
        while !ready.load(Ordering::Acquire) {
            assert!(start.elapsed() < Duration::from_secs(1));
            thread::sleep(Duration::from_millis(2));
        }
        run.observe(PAYLOAD);
        let result = checked.join().unwrap();
        assert_eq!(result["events"], 1);
        assert_eq!(result["matching_events"], 1);
        assert_eq!(result["payload_bytes"], PAYLOAD.len());
    });
    for invalid in [
        "http://example.com",
        "https://name:secret@example.com",
        "https://example.com/path",
        "https://example.com?token=secret",
        "https://example.com/#fragment",
    ] {
        assert!(viewer::endpoint_origin(invalid).is_err());
    }
}
#[test]
fn private_tokens_reject_symlinks_modes_fifos_and_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("token");
    token::create(&path).unwrap();
    assert!(token::valid(&token::read(&path).unwrap()));
    let old = fs::read(&path).unwrap();
    assert!(token::create(&path).is_err());
    assert_eq!(old, fs::read(&path).unwrap());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(token::read(&path).is_err());
    let link = temp.path().join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(token::read(&link).is_err());
    let fifo =
        std::ffi::CString::new(temp.path().join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    unsafe {
        assert_eq!(libc::mkfifo(fifo.as_ptr(), 0o600), 0);
    }
    assert!(token::read(Path::new(fifo.to_str().unwrap())).is_err());
}

fn observer(path: &Path, raw: &[u8]) {
    let mut source = tempfile::tempfile().unwrap();
    source.write_all(raw).unwrap();
    source.seek(SeekFrom::Start(0)).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_codex-scope-observer"))
        .arg(path)
        .stdin(source)
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
}
#[test]
fn observer_preserves_bytes_and_rejects_empty_oversized() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("in.sock");
    let receiver = UnixDatagram::bind(&path).unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    for raw in [PAYLOAD.to_vec(), vec![b'x'; MAX_PAYLOAD]] {
        observer(&path, &raw);
        let mut actual = vec![0; MAX_PAYLOAD + 1];
        let count = receiver.recv(&mut actual).unwrap();
        assert_eq!(&actual[..count], raw);
    }
    observer(&path, b"");
    observer(&path, &vec![b'x'; MAX_PAYLOAD + 1]);
    assert!(receiver.recv(&mut [0]).is_err());
}
#[test]
fn observer_full_kernel_queue_is_measured_and_never_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("in.sock");
    let receiver = UnixDatagram::bind(&path).unwrap();
    receiver.set_nonblocking(true).unwrap();
    let sender = UnixDatagram::unbound().unwrap();
    sender.set_nonblocking(true).unwrap();
    let mut enqueued = 0;
    loop {
        let filling = UnixDatagram::unbound().unwrap();
        filling.set_nonblocking(true).unwrap();
        match filling.send_to(PAYLOAD, &path) {
            Ok(_) => enqueued += 1,
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                break;
            }
        }
        assert!(enqueued < 10_000, "kernel queue did not reach its limit");
    }
    let started = Instant::now();
    for _ in 0..10 {
        observer(&path, PAYLOAD);
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        sender.send_to(PAYLOAD, &path).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let mut drained = 0;
    while receiver.recv(&mut [0; 512]).is_ok() {
        drained += 1;
    }
    assert_eq!(drained, enqueued);
}
#[test]
fn observer_deadline_and_neutral_failures() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("absent");
    observer(&path, PAYLOAD);
    observer(Path::new(&format!("/{}", "x".repeat(200))), PAYLOAD);
    fs::write(&path, "not a socket").unwrap();
    observer(&path, PAYLOAD);
    let mut child = Command::new(env!("CARGO_BIN_EXE_codex-scope-observer"))
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    assert!(child.wait().unwrap().success());
    assert!(started.elapsed() < Duration::from_millis(500));
    let output = child.wait_with_output().unwrap();
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    thread::scope(|scope| {
        for _ in 0..16 {
            let path = &path;
            scope.spawn(move || observer(path, PAYLOAD));
        }
    });
}
