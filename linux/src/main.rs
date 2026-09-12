use codex_scope::{
    collector::{Collector, Limits},
    installer, token, viewer,
};
use std::{
    io::{self, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::Path,
    sync::atomic::{AtomicI32, Ordering},
};
static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);
extern "C" fn stop(_: libc::c_int) {
    let fd = SIGNAL_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        unsafe {
            libc::write(fd, b"x".as_ptr().cast(), 1);
        }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage().into());
    };
    if matches!(command, "setup" | "manage" | "probe") {
        return installer::run(args);
    }
    if matches!(command, "--help" | "-h" | "help") {
        println!("{}", usage());
        return Ok(());
    }
    let allowed: &[&str] = match command {
        "collector" => &["--runtime-dir", "--token-file", "--port"],
        "token" => &["--token-file"],
        "viewer" => &["--endpoint", "--token-file", "--seconds"],
        _ => return Err(usage().into()),
    };
    let mut options = std::collections::BTreeMap::new();
    for pair in args[1..].chunks(2) {
        if pair.len() != 2
            || !allowed.contains(&pair[0].as_str())
            || options.insert(pair[0].as_str(), pair[1].as_str()).is_some()
        {
            return Err(usage().into());
        }
    }
    let required = |name| {
        options
            .get(name)
            .copied()
            .ok_or_else(|| format!("Missing {name}."))
    };
    let path = Path::new(required("--token-file")?);
    match command {
        "token" => {
            token::create(path)
                .map_err(|_| "Could not create token file; existing files are never replaced.")?;
            println!("Private token file created.");
        }
        "collector" => {
            let port = options
                .get("--port")
                .copied()
                .unwrap_or("4319")
                .parse::<u16>()
                .map_err(|_| "Port must be between 0 and 65535.")?;
            let token = token::read(path)
                .map_err(|_| "Collector could not start. Check private paths and token format.")?;
            let collector = Collector::bind(Path::new(required("--runtime-dir")?), token, port, Limits::default()).map_err(|error| match error.raw_os_error() {
                Some(libc::EADDRINUSE) => format!("Collector port {port} is already in use. Choose another --port."),
                Some(libc::EAGAIN) => "Another collector owns this runtime directory. Stop it or choose another directory.".into(),
                _ => "Collector could not start. Check runtime and token file ownership and permissions.".into(),
            })?;
            let (shutdown, signal_writer) =
                UnixStream::pair().map_err(|_| "Could not prepare collector shutdown.")?;
            signal_writer
                .set_nonblocking(true)
                .map_err(|_| "Could not prepare collector shutdown.")?;
            SIGNAL_FD.store(signal_writer.as_raw_fd(), Ordering::Relaxed);
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = stop as *const () as usize;
                libc::sigemptyset(&mut action.sa_mask);
                for signal in [libc::SIGTERM, libc::SIGINT] {
                    if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                        return Err("Could not prepare collector shutdown.".into());
                    }
                }
            }
            println!(
                "Collector listening on loopback port {}.",
                collector
                    .port()
                    .map_err(|_| "Could not read collector port.")?
            );
            io::stdout()
                .flush()
                .map_err(|_| "Could not report collector startup.")?;
            let result: Result<(), String> = collector
                .run(shutdown)
                .map_err(|_| "Collector stopped after a socket error.".into());
            SIGNAL_FD.store(-1, Ordering::Relaxed);
            result?;
        }
        "viewer" => {
            let token = token::read(path)
                .map_err(|_| "Viewer check failed: private token file is invalid.")?;
            let seconds = options
                .get("--seconds")
                .copied()
                .unwrap_or("10")
                .parse::<f64>()
                .map_err(|_| "Seconds must be positive and no more than 3600.")?;
            let summary = viewer::inspect(
                required("--endpoint")?,
                &token,
                seconds,
                viewer::InspectOptions::default(),
            )
            .map_err(|_| "Viewer check failed: connection, authentication, or protocol error.")?;
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
        }
        _ => unreachable!(),
    }
    Ok(())
}
fn usage() -> &'static str {
    "Usage: codex-scope setup | manage | probe\n       codex-scope collector --runtime-dir PATH --token-file PATH [--port 4319]\n       codex-scope token --token-file PATH\n       codex-scope viewer --endpoint URL --token-file PATH [--seconds 10]"
}
