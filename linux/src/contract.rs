use serde_json::{Value, json};

pub const EVENTS: [&str; 12] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
];
pub const MAX_PAYLOAD: usize = 61_440;
pub const MAX_FRAME: usize = 384 * 1024;
pub const MAX_COUNTER: u64 = (1 << 53) - 1;

pub fn encode(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("JSON values serialize");
    bytes.push(b'\n');
    bytes
}

pub fn event(raw: &[u8], connection_id: &str, sequence: u64) -> Option<Vec<u8>> {
    if raw.len() > MAX_PAYLOAD {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    let payload: Value = serde_json::from_str(text).ok()?;
    let payload = payload.as_object()?;
    let hook = payload.get("hook_event_name")?.as_str()?;
    if !EVENTS.contains(&hook) {
        return None;
    }
    for name in ["session_id", "tool_name"] {
        if let Some(value) = payload.get(name)
            && !value.is_null()
            && !value.is_string()
        {
            return None;
        }
    }
    Some(encode(&json!({
        "type": "event", "connection_id": connection_id, "sequence": sequence,
        "received_at": timestamp(), "hook_type": hook,
        "session_id": payload.get("session_id"), "tool_name": payload.get("tool_name"),
        "payload_bytes": raw.len(), "payload": text,
    })))
}

fn timestamp() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs() as libc::time_t;
    let mut utc = unsafe { std::mem::zeroed::<libc::tm>() };
    unsafe {
        libc::gmtime_r(&seconds, &mut utc);
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}+00:00",
        utc.tm_year + 1900,
        utc.tm_mon + 1,
        utc.tm_mday,
        utc.tm_hour,
        utc.tm_min,
        utc.tm_sec,
        elapsed.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_and_strict_validation() {
        let raw = " {\"hook_event_name\":\"Stop\",\"unknown\":\"☃\"}\n";
        let framed: Value =
            serde_json::from_slice(&event(raw.as_bytes(), "id", 1).unwrap()).unwrap();
        assert_eq!(framed["payload"], raw);
        assert_eq!(framed["payload_bytes"], raw.len());
        for raw in [
            b"[]".as_slice(),
            b"{}",
            b"\xff",
            b"[",
            b"{\"hook_event_name\":\"Stop\",\"x\":NaN}",
            b"{\"hook_event_name\":\"Stop\",\"x\":1e999}",
            b"{\"hook_event_name\":\"Stop\",\"x\":\"\\ud800\"}",
            b"{\"hook_event_name\":\"Stop\",\"session_id\":4}",
        ] {
            assert!(event(raw, "id", 1).is_none());
        }
        assert!(event(&vec![b'['; MAX_PAYLOAD], "id", 1).is_none());
    }
}
