use crate::contract::{MAX_COUNTER, MAX_FRAME, MAX_PAYLOAD};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct InspectOptions<'a> {
    pub ready: Option<&'a AtomicBool>,
    pub finish: Option<&'a AtomicBool>,
    pub match_text: Option<&'a str>,
}

pub fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    if endpoint.len() > 4096 {
        return Err("endpoint is too long".into());
    }
    let url = url::Url::parse(endpoint).map_err(|_| "invalid endpoint")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "endpoint must be an origin without credentials, path, query, or fragment".into(),
        );
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("use HTTPS, or HTTP on loopback for local tests".into());
    }
    if url.host_str().is_none() {
        return Err("endpoint requires a hostname".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(3))
        .timeout_write(Duration::from_secs(3))
        .max_idle_connections(0)
        .build()
}

pub fn check_endpoint(endpoint: &str) -> Result<(), String> {
    let endpoint = endpoint_origin(endpoint)?;
    match agent()
        .get(&format!("{endpoint}/v1/stream"))
        .timeout(Duration::from_secs(5))
        .call()
    {
        Err(ureq::Error::Status(401, _)) => Ok(()),
        _ => Err("endpoint did not return the expected unauthenticated HTTP 401 response".into()),
    }
}

pub fn inspect(
    endpoint: &str,
    token: &str,
    seconds: f64,
    options: InspectOptions<'_>,
) -> Result<Value, String> {
    if !seconds.is_finite() || seconds <= 0.0 || seconds > 3600.0 || !crate::token::valid(token) {
        return Err("invalid viewer duration or token".into());
    }
    let endpoint = endpoint_origin(endpoint)?;
    let authorization = format!("Bearer {token}");
    let response = agent()
        .get(&format!("{endpoint}/v1/stream"))
        .set("Authorization", &authorization)
        .timeout(Duration::from_secs_f64(seconds + 6.0))
        .call()
        .map_err(|_| "stream connection or authentication failed")?;
    if response.status() != 200 {
        return Err("stream did not return HTTP 200".into());
    }
    let mut reader = BufReader::with_capacity(8192, response.into_reader());
    let hello = read_frame(&mut reader)?;
    if hello["type"] != "hello"
        || hello["protocol_version"] != 1
        || hello["max_payload_bytes"] != MAX_PAYLOAD
        || hello["max_frame_bytes"] != MAX_FRAME
    {
        return Err("unsupported stream protocol".into());
    }
    let identity = hello["connection_id"]
        .as_str()
        .filter(|id| id.len() <= 128)
        .ok_or("missing connection ID")?
        .to_owned();
    let stop = (Mutex::new(false), Condvar::new());
    let failed = AtomicBool::new(false);
    let progress = Mutex::new(Instant::now());
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let agent = agent();
            loop {
                let state = stop.0.lock().unwrap();
                let (state, _) = stop
                    .1
                    .wait_timeout_while(state, Duration::from_secs(2), |stopped| !*stopped)
                    .unwrap();
                if *state {
                    return;
                }
                drop(state);
                if progress.lock().unwrap().elapsed() >= Duration::from_secs(3) {
                    failed.store(true, Ordering::Release);
                    return;
                }
                let renewed = agent
                    .post(&format!("{endpoint}/v1/heartbeat"))
                    .set("Authorization", &authorization)
                    .set("X-Connection-Id", &identity)
                    .timeout(Duration::from_secs(3))
                    .send_bytes(&[]);
                if !renewed.is_ok_and(|response| response.status() == 204) {
                    failed.store(true, Ordering::Release);
                    return;
                }
            }
        });
        let result = (|| {
            if let Some(ready) = options.ready {
                ready.store(true, Ordering::Release);
            }
            let mut summary =
                json!({"events":0, "payload_bytes":0, "loss_outside_collector":"unknown"});
            if options.match_text.is_some() {
                summary["matching_events"] = json!(0);
            }
            let deadline = Instant::now() + Duration::from_secs_f64(seconds);
            let mut sequence = 0;
            while Instant::now() < deadline
                && !options
                    .finish
                    .is_some_and(|finish| finish.load(Ordering::Acquire))
            {
                if failed.load(Ordering::Acquire) {
                    return Err("heartbeat failed".into());
                }
                let message = read_frame(&mut reader)?;
                *progress.lock().unwrap() = Instant::now();
                if message["connection_id"] != identity {
                    return Err("connection identity changed within stream".into());
                }
                match message["type"].as_str() {
                    Some("event") => {
                        let next = message["sequence"]
                            .as_u64()
                            .filter(|next| *next > sequence && *next <= MAX_COUNTER)
                            .ok_or("events arrived out of order")?;
                        sequence = next;
                        let payload = message["payload"].as_str().ok_or("missing payload")?;
                        if payload.len() > MAX_PAYLOAD
                            || message["payload_bytes"].as_u64() != Some(payload.len() as u64)
                        {
                            return Err("payload byte count mismatch".into());
                        }
                        summary["events"] = json!(summary["events"].as_u64().unwrap() + 1);
                        summary["payload_bytes"] = json!(
                            summary["payload_bytes"].as_u64().unwrap() + payload.len() as u64
                        );
                        if options
                            .match_text
                            .is_some_and(|text| payload.contains(text))
                        {
                            summary["matching_events"] =
                                json!(summary["matching_events"].as_u64().unwrap() + 1);
                        }
                    }
                    Some("health") => {
                        // Keep only the fixed counters, never arbitrary server fields.
                        let mut drops = json!({});
                        for key in [
                            "no_viewer",
                            "invalid",
                            "oversized",
                            "rate",
                            "queue",
                            "disconnect",
                        ] {
                            drops[key] = json!(
                                message["known_drops"][key]
                                    .as_u64()
                                    .filter(|value| *value <= MAX_COUNTER)
                                    .ok_or("invalid drop counter")?
                            );
                        }
                        summary["known_drops"] = drops;
                    }
                    _ => (),
                }
            }
            Ok(summary)
        })();
        *stop.0.lock().unwrap() = true;
        stop.1.notify_all();
        result
    })
}

fn read_frame(reader: &mut impl BufRead) -> Result<Value, String> {
    read_frame_until(reader, Instant::now() + Duration::from_secs(3))
}

fn read_frame_until(reader: &mut impl BufRead, deadline: Instant) -> Result<Value, String> {
    let mut frame = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err("stream frame deadline expired".into());
        }
        let available = reader.fill_buf().map_err(|_| "stream read failed")?;
        if available.is_empty() || Instant::now() >= deadline {
            return Err("stream closed or frame deadline expired".into());
        }
        let ending = available.iter().position(|byte| *byte == b'\n');
        let size = ending.map_or(available.len(), |index| index + 1);
        if frame.len() + size > MAX_FRAME {
            return Err("stream frame exceeded limit".into());
        }
        frame.extend_from_slice(&available[..size]);
        reader.consume(size);
        if ending.is_some() {
            return serde_json::from_slice(&frame).map_err(|_| "invalid stream JSON".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_are_incremental_bounded_and_complete() {
        let input = b"{\"type\":\"health\"}\n{\"type\":\"event\"}\n";
        let mut reader = BufReader::with_capacity(3, input.as_slice());
        assert_eq!(read_frame(&mut reader).unwrap()["type"], "health");
        assert_eq!(read_frame(&mut reader).unwrap()["type"], "event");
        assert!(read_frame(&mut reader).is_err());
        assert!(read_frame(&mut b"{\"x\":1}".as_slice()).is_err());
        let oversized = vec![b'x'; MAX_FRAME + 1];
        let mut remaining = oversized.as_slice();
        assert!(read_frame(&mut remaining).is_err());
        assert_eq!(remaining.len(), MAX_FRAME + 1);
    }
    #[test]
    fn slow_unfinished_frames_have_an_absolute_deadline() {
        struct Drip;
        impl std::io::Read for Drip {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(2));
                buffer[0] = b' ';
                Ok(1)
            }
        }
        let started = Instant::now();
        let mut reader = BufReader::with_capacity(1, Drip);
        assert!(read_frame_until(&mut reader, started + Duration::from_millis(10)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
