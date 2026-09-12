"""Bounded operating-system checks used by guided setup."""

import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import time

LIMIT = 4 * 1024 * 1024


class SetupError(Exception):
    pass


def run(args, timeout=20, allowed=(0,)):
    """Keep command output private, bounded, and out of error messages."""
    process = subprocess.Popen([str(x) for x in args], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    data = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as poll:
            poll.register(process.stdout, selectors.EVENT_READ)
            while poll.get_map():
                if time.monotonic() >= deadline:
                    raise SetupError(f"{Path(args[0]).name} timed out; no command output was logged")
                for key, _ in poll.select(min(0.2, max(0, deadline - time.monotonic()))):
                    part = os.read(key.fileobj.fileno(), 65536)
                    data.extend(part)
                    if len(data) > LIMIT:
                        raise SetupError(f"{Path(args[0]).name} returned too much output")
                    if not part:
                        poll.unregister(key.fileobj)
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if code not in allowed:
            raise SetupError(f"{Path(args[0]).name} failed with exit {code}; check its local configuration and permissions")
        return data.decode("utf-8")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdout.close()


def private_path(value, home, must_exist=False, allow_writable=False):
    path = Path(value).expanduser().absolute()
    if not path.is_relative_to(home) or path == home or '..' in path.parts:
        raise SetupError("Choose a directory below your home directory")
    # Reject interpolation and control characters in service paths and terminal output.
    if any(part != part.strip() for part in path.parts):
        raise SetupError('Directory names cannot begin or end with whitespace')
    if any(ord(c) < 32 or c in '%$\\"\n\r' for c in str(path)):
        raise SetupError("Paths cannot contain control characters, quotes, %, $, or backslashes")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise SetupError(f"Symlink paths are not supported: {parent}")
        if parent.exists():
            info = parent.stat()
            if not stat.S_ISDIR(info.st_mode):
                raise SetupError(f"Expected a directory: {parent}")
            if parent.is_relative_to(home) and info.st_uid != os.getuid():
                raise SetupError(f"Directory belongs to another account: {parent}")
            # The selected Codex directory may need an explicitly approved mode change.
            if parent.is_relative_to(home) and parent != path and info.st_mode & 0o022 and not allow_writable:
                raise SetupError(f"Parent directory is writable by other users: {parent}")
    if must_exist and not path.is_dir():
        raise SetupError(f"Directory does not exist: {path}")
    return path


def read_private(path, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise SetupError(f"Expected an account-owned regular file: {path}")
        data = stream.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise SetupError(f"File exceeds the 4 MiB setup limit: {path}")
        return data


def available(port):
    if not 1024 <= port <= 65535:
        return False
    try:
        with socket.socket() as listener:
            listener.bind(('0.0.0.0', port))
        with socket.socket(socket.AF_INET6) as listener:
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            listener.bind(('::', port))
        return True
    except OSError:
        return False


def choose_port(start, excluded=()):
    for port in range(start, min(start + 100, 65536)):
        if port not in excluded and available(port):
            return port
    raise SetupError("No free port found near the suggested port; choose one manually")


def serve_config():
    value = json.loads(run(['tailscale', 'serve', 'status', '--json']))
    if not isinstance(value, dict):
        raise SetupError("Unrecognized Tailscale Serve configuration")
    return value


def listener(config, port):
    """Compare the complete port, including extra routes and Funnel flags."""
    result = {}
    for key in ('TCP', 'Web', 'AllowFunnel'):
        value = config.get(key, {})
        if not isinstance(value, dict):
            raise SetupError("Unrecognized Tailscale Serve configuration")
        matching = {k: v for k, v in value.items()
                    if k == str(port) or k.endswith(':' + str(port))}
        if matching:
            result[key] = matching
    # Foreground handlers and advertised services have separate lifetimes.
    for key in ('Foreground', 'Services'):
        if config.get(key):
            raise SetupError("Serve foreground handlers or Services need manual setup; no routes changed")
    return result


def expected_listener(dns, https_port, local_port):
    return {'TCP': {str(https_port): {'HTTPS': True}},
            'Web': {f'{dns}:{https_port}': {'Handlers': {
                '/': {'Proxy': f'http://127.0.0.1:{local_port}'}}}}}


def systemctl(*args):
    return run(['systemctl', '--user', *args])
