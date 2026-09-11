"""Merge observers into hooks.json without changing Codex trust."""

import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import shlex
import stat
import tempfile
import uuid

from .contract import EVENTS

OWNER = "_codex_scope"
MAX_CONFIG = 4 * 1024 * 1024


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate configuration key")
        result[key] = value
    return result


def read_config(path):
    if path.is_symlink():
        raise ValueError("refusing a symlink configuration")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None, {}
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("configuration must be a regular file owned by this account")
        raw = stream.read(MAX_CONFIG + 1)
    if len(raw) > MAX_CONFIG:
        raise ValueError("configuration exceeds size limit")
    config = json.loads(raw, object_pairs_hook=unique_keys)
    if not isinstance(config, dict) or not isinstance(config.get("hooks", {}), dict):
        raise ValueError("invalid hook configuration")
    for groups in config.get("hooks", {}).values():
        if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
            raise ValueError("invalid hook groups")
    return raw, config


def merge(config, observer, socket_path, uninstall=False, identity=None):
    result = copy.deepcopy(config)
    record = result.get(OWNER)
    if record is not None:
        if (not isinstance(record, dict) or record.get("version") != 1
                or not isinstance(record.get("entries"), dict)):
            raise ValueError("unrecognized ownership record; preserve configuration")
        owned = list(record["entries"].items())
        for previous in record.get("previous", []):
            owned.extend(previous.items())
        for event, group in owned:
            groups = result.get("hooks", {}).get(event, [])
            matches = [i for i, candidate in enumerate(groups) if candidate == group]
            # Duplicates make exact ownership ambiguous. Preserve all of them.
            if len(matches) == 1:
                groups.pop(matches[0])
            if not groups and event in result.get("hooks", {}):
                del result["hooks"][event]
        del result[OWNER]
    if uninstall:
        return result
    command = (
        f"{{ {shlex.quote(str(observer))} {shlex.quote(str(socket_path))}; }} "
        ">/dev/null 2>&1 || :"
    )
    # A per-install label prevents claiming an identical pre-existing command.
    identity = record.get("identity") if record else identity or uuid.uuid4().hex
    entries = {}
    for event in EVENTS:
        group = {"hooks": [{"type": "command", "command": command,
                            "timeout": 1, "statusMessage": f"codex-scope {identity}"}]}
        groups = result.setdefault("hooks", {}).setdefault(event, [])
        # Do not add a second observer when an owned entry was edited in place.
        if record and any(any(h.get("statusMessage") == f"codex-scope {identity}"
                             for h in g.get("hooks", []) if isinstance(h, dict))
                          for g in groups):
            continue
        groups.append(group)
        entries[event] = group
    result[OWNER] = {"version": 1, "identity": identity, "entries": entries}
    return result


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".codex-scope-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        dir_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def serialize(value):
    data = (json.dumps(value, indent=2, ensure_ascii=True) + "\n").encode()
    if len(data) > MAX_CONFIG:
        raise ValueError("resulting configuration exceeds size limit")
    return data


def update(config_dir, observer=None, socket_path=None, uninstall=False, identity=None):
    directory = Path(config_dir).absolute()
    if directory.is_symlink():
        raise ValueError("refusing a symlink configuration directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_uid != os.getuid() or stat.S_IMODE(directory.stat().st_mode) & 0o022:
        raise ValueError("configuration directory must be owned by this account and not writable by others")
    lock_fd = os.open(directory / ".codex-scope.lock",
                      os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("invalid configuration lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "hooks.json"
        before, config = read_config(path)
        ownership_path = directory / "codex-scope-owned.json"
        _, record = read_config(ownership_path)
        if OWNER in config:
            raise ValueError("unexpected ownership metadata in hooks.json")
        if record:
            config[OWNER] = record
        if uninstall and not record:
            return False
        result = merge(config, observer, socket_path, uninstall, identity)
        if config == result:
            return False
        new_record = result.pop(OWNER, None)
        data = serialize(result)
        if new_record:
            journal = copy.deepcopy(new_record)
            if record:
                journal["previous"] = record.get("previous", []) + [record["entries"]]
            # Preserve both ownership sets until the config replacement is durable.
            atomic_write(ownership_path, serialize(journal))
        if read_config(path)[0] != before:
            raise ValueError("configuration changed during edit; retry after other edits finish")
        atomic_write(path, data)
        if new_record:
            atomic_write(ownership_path, serialize(new_record))
        else:
            ownership_path.unlink()
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--config-dir", required=True, type=Path)
    parser.add_argument("--observer", type=Path)
    parser.add_argument("--socket", type=Path)
    args = parser.parse_args()
    if args.action == "install":
        if not args.observer or not args.socket:
            parser.error("install requires --observer and --socket")
        args.observer = args.observer.resolve()
        args.socket = args.socket.absolute()
        if not args.observer.is_file() or not os.access(args.observer, os.X_OK):
            parser.error("observer must be an executable file")
        if len(os.fsencode(args.socket)) >= 108:
            parser.error("socket path is too long")
        try:
            import shutil
            from .probe import compatible
            codex = shutil.which("codex")
            if not codex:
                raise ValueError("Codex is not installed")
            compatible(codex, args.observer)
        except (OSError, ValueError, TimeoutError):
            parser.error("Codex compatibility probe failed; no installation performed")
    try:
        changed = update(args.config_dir, args.observer, args.socket, args.action == "uninstall")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Configuration unchanged or update incomplete: {type(error).__name__}.\n")
    print("Configuration updated." if changed else "No configuration change needed.")
    if args.action == "install":
        print("Trust is unchanged. Review these hooks in Codex /hooks before use.")


if __name__ == "__main__":
    main()
