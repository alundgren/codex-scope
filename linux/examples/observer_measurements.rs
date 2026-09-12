//! Synthetic process startup latency. Run after building the release binaries.
use serde_json::{Value, json};
use std::{
    io::{Seek, SeekFrom, Write},
    os::unix::net::UnixDatagram,
    path::Path,
    process::Command,
    time::Instant,
};
fn measure(command: &Path, argument: Option<&Path>, receiver: Option<&UnixDatagram>) -> Value {
    let mut input = tempfile::tempfile().unwrap();
    input
        .write_all(b"{\"hook_event_name\":\"Stop\",\"session_id\":\"synthetic\"}")
        .unwrap();
    let mut milliseconds = Vec::new();
    for _ in 0..200 {
        input.seek(SeekFrom::Start(0)).unwrap();
        let mut run = Command::new(command);
        if let Some(argument) = argument {
            run.arg(argument);
        }
        let started = Instant::now();
        let output = run.stdin(input.try_clone().unwrap()).output().unwrap();
        milliseconds.push(started.elapsed().as_secs_f64() * 1000.0);
        assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
        if let Some(receiver) = receiver {
            receiver.recv(&mut [0u8; 65_536]).unwrap();
        }
    }
    milliseconds.sort_by(f64::total_cmp);
    json!({"samples":milliseconds.len(), "median_ms":milliseconds[100], "p95_ms":milliseconds[189], "max_ms":milliseconds[199]})
}
fn main() {
    let observer = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("codex-scope-observer");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ingest.sock");
    let baseline = measure(Path::new("/bin/true"), None, None);
    let absent = measure(&observer, Some(&path), None);
    let receiver = UnixDatagram::bind(&path).unwrap();
    receiver
        .set_read_timeout(Some(std::time::Duration::from_secs(1)))
        .unwrap();
    let delivered = measure(&observer, Some(&path), Some(&receiver));
    let sender = UnixDatagram::unbound().unwrap();
    sender.set_nonblocking(true).unwrap();
    let mut filled = 0;
    loop {
        let filling = UnixDatagram::unbound().unwrap();
        filling.set_nonblocking(true).unwrap();
        match filling.send_to(&[0u8; 1024], &path) {
            Ok(_) => filled += 1,
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                break;
            }
        }
        assert!(filled < 10_000);
    }
    let full = measure(&observer, Some(&path), None);
    assert_eq!(
        sender.send_to(&[0u8; 1024], &path).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    println!("{}", serde_json::to_string_pretty(&json!({"environment":"Linux synthetic process measurements", "true_baseline":baseline,
        "observer_absent":absent, "observer_delivered":delivered, "observer_full":full, "kernel_queue_saturation_confirmed":true,
        "datagrams_before_eagain":filled, "observer_binary_bytes":observer.metadata().unwrap().len()})).unwrap());
}
