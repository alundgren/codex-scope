use super::host::{self, LIMIT, Result};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use std::fmt;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub const OWNER: &str = "_codex_scope";
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

struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = Unique;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON with unique object keys")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut result = Map::new();
                while let Some((key, Unique(value))) = map.next_entry::<String, Unique>()? {
                    if result.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate configuration key"));
                    }
                }
                Ok(Unique(Value::Object(result)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut result = Vec::new();
                while let Some(Unique(v)) = seq.next_element()? {
                    result.push(v);
                }
                Ok(Unique(Value::Array(result)))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::String(value.into())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::String(value)))
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Bool(value)))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(value)))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(value)))
            }
            fn visit_none<E: de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}
pub fn parse_json(data: &[u8]) -> Result<Value> {
    if data.len() > LIMIT {
        return Err("Configuration exceeds the 4 MiB size limit".into());
    }
    serde_json::from_slice::<Unique>(data)
        .map(|v| v.0)
        .map_err(|_| {
            "Malformed JSON or duplicate configuration keys; preserve configuration".into()
        })
}
pub fn serialize(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut data =
        serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode configuration".to_owned())?;
    data.push(b'\n');
    if data.len() > LIMIT {
        return Err("Resulting configuration exceeds the 4 MiB size limit".into());
    }
    Ok(data)
}
pub fn read_config(path: &Path) -> Result<(Option<Vec<u8>>, Value)> {
    let raw = host::read_private(path, true)?;
    let config = match &raw {
        Some(bytes) => parse_json(bytes)?,
        None => json!({}),
    };
    if !config.is_object() {
        return Err("Invalid hook configuration".into());
    }
    if let Some(hooks) = config.get("hooks") {
        let hooks = hooks.as_object().ok_or("Invalid hook configuration")?;
        for groups in hooks.values() {
            if !groups
                .as_array()
                .is_some_and(|groups| groups.iter().all(Value::is_object))
            {
                return Err("Invalid hook groups".into());
            }
        }
    }
    Ok((raw, config))
}
pub fn has_label(config: &Value, identity: &str) -> bool {
    let label = format!("codex-scope {identity}");
    config
        .get("hooks")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|h| h.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|g| g.get("hooks").and_then(Value::as_array))
        .flatten()
        .any(|hook| hook.get("statusMessage").and_then(Value::as_str) == Some(&label))
}
pub fn merge(
    config: &Value,
    observer: Option<&Path>,
    socket: Option<&Path>,
    uninstall: bool,
    identity: Option<&str>,
) -> Result<Value> {
    let mut result = config.clone();
    let record = result.get(OWNER).cloned();
    let identity = if let Some(record) = &record {
        if record.get("version") != Some(&json!(1))
            || !record.get("entries").is_some_and(Value::is_object)
            || !record.get("identity").is_some_and(Value::is_string)
        {
            return Err("Unrecognized ownership record; preserve configuration".into());
        }
        let mut owned = vec![record["entries"].as_object().unwrap()];
        if let Some(previous) = record.get("previous") {
            for item in previous
                .as_array()
                .ok_or("Invalid previous hook ownership")?
            {
                owned.push(item.as_object().ok_or("Invalid previous hook ownership")?);
            }
        }
        for entries in owned {
            for (event, group) in entries {
                if let Some(groups) = result
                    .get_mut("hooks")
                    .and_then(Value::as_object_mut)
                    .and_then(|h| h.get_mut(event))
                    .and_then(Value::as_array_mut)
                {
                    let matches = groups
                        .iter()
                        .enumerate()
                        .filter(|(_, candidate)| *candidate == group)
                        .map(|(i, _)| i)
                        .collect::<Vec<_>>();
                    if matches.len() == 1 {
                        groups.remove(matches[0]);
                    }
                    if groups.is_empty() {
                        result["hooks"].as_object_mut().unwrap().remove(event);
                    }
                }
            }
        }
        result
            .as_object_mut()
            .ok_or("Invalid hook configuration")?
            .remove(OWNER);
        record["identity"].as_str().unwrap().to_owned()
    } else {
        match identity {
            Some(value) => value.to_owned(),
            None => host::random_hex(16)?,
        }
    };
    if uninstall {
        return Ok(result);
    }
    let observer = observer.ok_or("Observer executable is required")?;
    let socket = socket.ok_or("Observer socket is required")?;
    let command = format!(
        "{{ {} {}; }} >/dev/null 2>&1 || :",
        host::shell_quote(&observer.to_string_lossy()),
        host::shell_quote(&socket.to_string_lossy())
    );
    let mut entries = Map::new();
    let hooks = result
        .as_object_mut()
        .ok_or("Invalid hook configuration")?
        .entry("hooks")
        .or_insert(json!({}))
        .as_object_mut()
        .ok_or("Invalid hook configuration")?;
    for event in EVENTS {
        let group = json!({"hooks": [{"type": "command", "command": command, "timeout": 1, "statusMessage": format!("codex-scope {identity}")}]});
        let groups = hooks
            .entry(event)
            .or_insert(json!([]))
            .as_array_mut()
            .ok_or("Invalid hook groups")?;
        if record.is_some()
            && groups
                .iter()
                .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                .flatten()
                .any(|h| h.get("statusMessage") == Some(&json!(format!("codex-scope {identity}"))))
        {
            continue;
        }
        groups.push(group.clone());
        entries.insert(event.into(), group);
    }
    result[OWNER] = json!({"version": 1, "identity": identity, "entries": entries});
    Ok(result)
}
pub fn update(
    directory: &Path,
    observer: Option<&Path>,
    socket: Option<&Path>,
    uninstall: bool,
    identity: Option<&str>,
) -> Result<bool> {
    // Parents may be selected paths, so never follow a replaced parent directory.
    for parent in directory.ancestors() {
        if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Refusing a symlink configuration directory".into());
        }
    }
    host::mkdir_private(directory)?;
    let info = directory.metadata().map_err(host::io_error)?;
    if info.uid() != host::uid() || info.mode() & 0o022 != 0 {
        return Err(
            "Configuration directory must be owned by this account and not writable by others"
                .into(),
        );
    }
    let _lock = host::lock(&directory.join(".codex-scope.lock"))?;
    update_locked(
        directory,
        observer,
        socket,
        uninstall,
        identity,
        &host::atomic_write,
    )
}
fn update_locked(
    directory: &Path,
    observer: Option<&Path>,
    socket: Option<&Path>,
    uninstall: bool,
    identity: Option<&str>,
    write: &dyn Fn(&Path, &[u8]) -> Result<()>,
) -> Result<bool> {
    let path = directory.join("hooks.json");
    let (before, mut config) = read_config(&path)?;
    let ownership_path = directory.join("codex-scope-owned.json");
    let (_, record) = read_config(&ownership_path)?;
    if config.get(OWNER).is_some() {
        return Err("Unexpected ownership metadata in hooks.json".into());
    }
    let owns = record.as_object().is_some_and(|o| !o.is_empty());
    if owns {
        config[OWNER] = record.clone();
    }
    if uninstall && !owns {
        return Ok(false);
    }
    let mut result = merge(&config, observer, socket, uninstall, identity)?;
    if result == config {
        return Ok(false);
    }
    let new_record = result.as_object_mut().unwrap().remove(OWNER);
    let data = serialize(&result)?;
    if let Some(new_record) = &new_record {
        let mut journal = new_record.clone();
        if owns {
            let mut previous = record
                .get("previous")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            previous.push(record["entries"].clone());
            journal["previous"] = json!(previous);
        }
        write(&ownership_path, &serialize(&journal)?)?;
    }
    if read_config(&path)?.0 != before {
        return Err("Configuration changed during edit; retry after other edits finish".into());
    }
    write(&path, &data)?;
    if let Some(new_record) = new_record {
        write(&ownership_path, &serialize(&new_record)?)?;
    } else {
        fs::remove_file(&ownership_path).map_err(host::io_error)?;
        host::sync_dir(directory)?;
    }
    Ok(true)
}
pub fn rehearsal(hooks: &Value, observer: &Path) -> Result<()> {
    let temporary = host::Temporary::new("scope-rehearsal")?;
    let root = &temporary.0;
    host::atomic_write(&root.join("hooks.json"), &serialize(hooks)?)?;
    update(
        root,
        Some(observer),
        Some(&root.join("absent.sock")),
        false,
        None,
    )?;
    update(root, None, None, true, None)?;
    let mut expected = hooks.clone();
    expected
        .as_object_mut()
        .ok_or("Invalid hooks")?
        .entry("hooks")
        .or_insert(json!({}));
    if read_config(&root.join("hooks.json"))?.1 != expected {
        return Err("Automatic install/uninstall rehearsal did not preserve existing hooks".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/setup/hooks.rs"]
mod tests;
