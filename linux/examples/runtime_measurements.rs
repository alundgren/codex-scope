//! Isolated collector-process CPU and memory with synthetic workloads.
use codex_scope::viewer::{self, InspectOptions};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::net::UnixDatagram,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn usage(pid: u32) -> (f64, u64, u64, u64) {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let (_, fields) = stat.rsplit_once(") ").unwrap();
    let fields: Vec<_> = fields.split_whitespace().collect();
    let ticks = fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap();
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let value = |key: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    (
        ticks as f64 / unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64,
        value("VmRSS:"),
        value("VmHWM:"),
        value("Threads:"),
    )
}
fn profile(name: &str, with_viewer: bool, burst: bool) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let runtime = directory.path().join("runtime");
    let token_file = directory.path().join("token");
    codex_scope::token::create(&token_file).unwrap();
    let token = codex_scope::token::read(&token_file).unwrap();
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("codex-scope");
    let mut child = ChildGuard(
        Command::new(binary)
            .args(["collector", "--runtime-dir"])
            .arg(&runtime)
            .arg("--token-file")
            .arg(&token_file)
            .args(["--port", "0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port: u16 = line
        .split_whitespace()
        .last()
        .unwrap()
        .trim_end_matches('.')
        .parse()
        .unwrap();
    let endpoint = format!("http://127.0.0.1:{port}");
    let ready = AtomicBool::new(false);
    let finish = AtomicBool::new(false);
    let payload = format!(
        "{{\"hook_event_name\":\"Stop\",\"text\":\"{}\"}}",
        "x".repeat(60_000)
    );
    let sender = UnixDatagram::unbound().unwrap();
    sender.set_nonblocking(true).unwrap();
    let result = thread::scope(|scope| {
        let consumer = with_viewer.then(|| {
            scope.spawn(|| {
                viewer::inspect(
                    &endpoint,
                    &token,
                    30.0,
                    InspectOptions {
                        ready: Some(&ready),
                        finish: Some(&finish),
                        ..Default::default()
                    },
                )
            })
        });
        if with_viewer {
            let waiting = Instant::now();
            while !ready.load(Ordering::Acquire) {
                assert!(waiting.elapsed() < Duration::from_secs(5));
                thread::sleep(Duration::from_millis(2));
            }
        }
        let before = usage(child.0.id());
        let started = Instant::now();
        let mut sent = 0;
        let mut kernel_rejected = 0;
        let mut peak_rss = before.1;
        let count = if burst {
            10_000
        } else if name == "sustained_large_payloads" {
            500
        } else {
            0
        };
        for index in 0..count {
            match sender.send_to(payload.as_bytes(), runtime.join("ingest.sock")) {
                Ok(_) => sent += 1,
                Err(error) => {
                    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                    kernel_rejected += 1;
                }
            }
            if index % 50 == 0 {
                peak_rss = peak_rss.max(usage(child.0.id()).1);
            }
            if !burst {
                thread::sleep(Duration::from_millis(10));
            }
        }
        let duration = if burst {
            Duration::from_secs(3)
        } else {
            Duration::from_secs(5)
        };
        while started.elapsed() < duration {
            thread::sleep(Duration::from_millis(50));
            peak_rss = peak_rss.max(usage(child.0.id()).1);
        }
        let after = usage(child.0.id());
        finish.store(true, Ordering::Release);
        let summary = consumer.map(|consumer| consumer.join().unwrap().unwrap());
        json!({"profile":name, "elapsed_seconds":started.elapsed().as_secs_f64(), "attempted_events":count, "kernel_accepted":sent,
            "kernel_rejected":kernel_rejected, "payload_bytes_each":payload.len(), "collector_cpu_seconds":after.0-before.0,
            "collector_initial_rss_kib":before.1, "collector_final_rss_kib":after.1, "collector_peak_rss_kib":peak_rss.max(after.2),
            "collector_threads":after.3, "viewer_summary":summary})
    });
    unsafe {
        libc::kill(child.0.id() as libc::pid_t, libc::SIGTERM);
    }
    assert!(child.0.wait().unwrap().success());
    let files: Vec<_> = fs::read_dir(runtime)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, ["collector.lock"]);
    result
}
fn main() {
    let values = [
        profile("idle_without_viewer", false, false),
        profile("idle_with_viewer", true, false),
        profile("sustained_large_payloads", true, false),
        profile("burst_large_payloads", true, true),
    ];
    println!("{}", serde_json::to_string_pretty(&json!({"environment":"Linux synthetic data; collector process measured separately from client and producer", "profiles":values})).unwrap());
}
