"""Bounded live-only collector with account-local datagram ingestion."""

import argparse
import asyncio
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hmac
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import time
import uuid

from .contract import EVENTS, MAX_COUNTER, MAX_FRAME, MAX_PAYLOAD, encode


@dataclass(frozen=True)
class Limits:
    queue_count: int = 64
    queue_bytes: int = 1024 * 1024
    events_per_second: int = 200
    datagrams_per_second: int = 400
    http_clients: int = 8
    header_bytes: int = 4096
    request_timeout: float = 2
    write_timeout: float = 1
    heartbeat_interval: float = 1
    heartbeat_expiry: float = 6


class Viewer:
    def __init__(self, writer):
        self.id = str(uuid.uuid4())
        self.writer = writer
        self.sequence = 0
        self.last_ack = time.monotonic()
        self.queue = deque()
        self.bytes = 0
        self.ready = asyncio.Event()
        self.active = True


class Collector:
    def __init__(self, runtime_dir, token, limits=Limits()):
        if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
            raise ValueError("token must contain 64 lowercase hexadecimal characters")
        self.runtime_dir = Path(runtime_dir).absolute()
        self.token = token
        self.limits = limits
        self.viewer = None
        self.clients = set()
        self.tasks = set()
        self.drops = dict.fromkeys(("no_viewer", "invalid", "oversized", "rate", "queue", "disconnect"), 0)
        self.rate_start = time.monotonic()
        self.rate_count = 0
        self.ingress_start = time.monotonic()
        self.ingress_count = 0
        self.ingress_resume = None
        self.ingress = None
        self.server = None
        self.lock = None
        self.socket_identity = None
        self.stopping = False

    def count(self, reason, number=1):
        self.drops[reason] = min(MAX_COUNTER, self.drops[reason] + number)

    async def start(self, port=0):
        directory = self.runtime_dir
        if directory.is_symlink():
            raise ValueError("runtime directory must not be a symlink")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("runtime directory must be account-owned with mode 0700")
        fd = os.open(directory / "collector.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.lock = os.fdopen(fd, "a")
        try:
            if not stat.S_ISREG(os.fstat(self.lock.fileno()).st_mode):
                raise ValueError("collector lock must be a regular file")
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = directory / "ingest.sock"
            if len(os.fsencode(path)) >= 108:
                raise ValueError("socket path is too long")
            if path.exists() or path.is_symlink():
                existing = path.lstat()
                if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                    raise ValueError("refusing to replace non-owned socket path")
                path.unlink()
            self.ingress = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_NONBLOCK)
            self.ingress.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 128 * 1024)
            self.ingress.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            self.ingress.bind(str(path))
            os.chmod(path, 0o600)
            self.socket_identity = path.stat().st_ino
            asyncio.get_running_loop().add_reader(self.ingress.fileno(), self.receive)
            self.server = await asyncio.start_server(self.accept, "127.0.0.1", port,
                                                     limit=self.limits.header_bytes, backlog=8)
        except BaseException:
            await self.close()
            raise
        return self.server.sockets[0].getsockname()[1]

    def receive(self, discard=False):
        # Yield between batches so traffic cannot starve heartbeat handling.
        for _ in range(32):
            now = time.monotonic()
            if now - self.ingress_start >= 1:
                self.ingress_start, self.ingress_count = now, 0
            if self.ingress_count >= self.limits.datagrams_per_second:
                if self.ingress_resume is None:
                    loop = asyncio.get_running_loop()
                    loop.remove_reader(self.ingress.fileno())
                    self.ingress_resume = loop.call_later(max(0, 1 - (now - self.ingress_start)),
                                                         self.resume_ingress)
                return False
            try:
                raw, ancillary, flags, _ = self.ingress.recvmsg(MAX_PAYLOAD + 1, socket.CMSG_SPACE(12))
            except BlockingIOError:
                return True
            self.ingress_count += 1
            credentials = [struct.unpack("3i", data[:12]) for level, kind, data in ancillary
                           if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) >= 12]
            if flags & socket.MSG_CTRUNC or not credentials or credentials[0][1] != os.getuid():
                self.count("invalid")
                continue
            if flags & socket.MSG_TRUNC or len(raw) > MAX_PAYLOAD:
                self.count("oversized")
                continue
            self.ingest(raw, discard)
        return False

    def resume_ingress(self):
        self.ingress_resume = None
        if self.ingress is not None and not self.stopping:
            asyncio.get_running_loop().add_reader(self.ingress.fileno(), self.receive)

    def ingest(self, raw, discard=False):
        viewer = self.viewer
        now = time.monotonic()
        if viewer and now - viewer.last_ack >= self.limits.heartbeat_expiry:
            self.disconnect(viewer)
            viewer = None
        if discard or viewer is None:
            self.count("no_viewer")
            return
        if now - self.rate_start >= 1:
            self.rate_start, self.rate_count = now, 0
        self.rate_count = min(self.limits.events_per_second + 1, self.rate_count + 1)
        if self.rate_count > self.limits.events_per_second:
            self.count("rate")
            return
        if len(raw) > MAX_PAYLOAD:
            self.count("oversized")
            return
        try:
            text = raw.decode("utf-8")
            payload = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(payload, dict) or payload.get("hook_event_name") not in EVENTS:
                raise ValueError()
            for field in ("session_id", "tool_name"):
                if field in payload and payload[field] is not None and not isinstance(payload[field], str):
                    raise ValueError()
            # Reject unpaired Unicode surrogates while preserving the original text.
            json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (ValueError, UnicodeError, RecursionError):
            self.count("invalid")
            return
        if viewer.sequence == MAX_COUNTER:
            self.disconnect(viewer)
            return
        viewer.sequence += 1
        message = encode({"type": "event", "connection_id": viewer.id,
                          "sequence": viewer.sequence,
                          "received_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                          "hook_type": payload["hook_event_name"],
                          "session_id": payload.get("session_id"), "tool_name": payload.get("tool_name"),
                          "payload_bytes": len(raw), "payload": text})
        if (len(message) > MAX_FRAME or len(viewer.queue) >= self.limits.queue_count
                or viewer.bytes + len(message) > self.limits.queue_bytes):
            self.count("queue")
            return
        viewer.queue.append(message)
        viewer.bytes += len(message)
        viewer.ready.set()

    def disconnect(self, viewer):
        if not viewer.active:
            return
        viewer.active = False
        self.count("disconnect", len(viewer.queue))
        viewer.queue.clear()
        viewer.bytes = 0
        viewer.ready.set()
        viewer.writer.transport.abort()
        if self.viewer is viewer:
            self.viewer = None

    def accept(self, reader, writer):
        if self.stopping or len(self.clients) >= self.limits.http_clients:
            writer.transport.abort()
            return
        self.clients.add(writer)
        task = asyncio.create_task(self.handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def send(self, writer, data):
        writer.write(data)
        await asyncio.wait_for(writer.drain(), self.limits.write_timeout)

    async def response(self, writer, status):
        await self.send(writer, f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())

    async def handle(self, reader, writer):
        owned_viewer = None
        writer.transport.set_write_buffer_limits(high=32768, low=8192)
        writer.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32768)
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), self.limits.request_timeout)
            if len(header) > self.limits.header_bytes:
                await self.response(writer, "431 Request Header Fields Too Large")
                return
            lines = header.decode("ascii").split("\r\n")
            method, path, version = lines[0].split(" ")
            headers = {}
            for line in lines[1:-2]:
                key, value = line.split(":", 1)
                key = key.lower()
                if key in headers or key.strip() != key:
                    raise ValueError()
                headers[key] = value.strip()
            if version != "HTTP/1.1" or "transfer-encoding" in headers:
                raise ValueError()
            if not hmac.compare_digest(headers.get("authorization", ""), "Bearer " + self.token):
                await self.response(writer, "401 Unauthorized")
                return
            if headers.get("content-length", "0") != "0":
                raise ValueError()
            if method == "POST" and path == "/v1/heartbeat":
                viewer = self.viewer
                if viewer and time.monotonic() - viewer.last_ack >= self.limits.heartbeat_expiry:
                    self.disconnect(viewer)
                    viewer = None
                if not viewer or headers.get("x-connection-id") != viewer.id:
                    await self.response(writer, "409 Conflict")
                else:
                    viewer.last_ack = time.monotonic()
                    await self.response(writer, "204 No Content")
            elif method == "GET" and path == "/v1/stream":
                if self.viewer:
                    if time.monotonic() - self.viewer.last_ack >= self.limits.heartbeat_expiry:
                        self.disconnect(self.viewer)
                    else:
                        await self.response(writer, "409 Conflict")
                        return
                # Empty the bounded kernel backlog before opening a new recording.
                if not self.receive(discard=True):
                    await self.response(writer, "503 Service Unavailable")
                    return
                owned_viewer = Viewer(writer)
                self.viewer = owned_viewer
                await self.send(writer, b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"
                                b"Cache-Control: no-store\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n")
                await self.stream(reader, owned_viewer)
            else:
                await self.response(writer, "404 Not Found")
        except (ValueError, UnicodeError, asyncio.LimitOverrunError):
            try:
                await self.response(writer, "400 Bad Request")
            except (OSError, TimeoutError):
                pass
        except (OSError, TimeoutError, asyncio.IncompleteReadError):
            pass
        finally:
            if owned_viewer:
                self.disconnect(owned_viewer)
            writer.transport.abort()
            self.clients.discard(writer)

    async def stream(self, reader, viewer):
        await self.send(viewer.writer, encode({"type": "hello", "protocol_version": 1,
                         "connection_id": viewer.id, "max_payload_bytes": MAX_PAYLOAD,
                         "max_frame_bytes": MAX_FRAME,
                         "heartbeat_interval_ms": 2000,
                         "heartbeat_expiry_ms": int(self.limits.heartbeat_expiry * 1000),
                         "loss_before_connection": "unknown"}))
        next_health = 0
        while viewer.active:
            now = time.monotonic()
            if reader.at_eof() or now - viewer.last_ack >= self.limits.heartbeat_expiry:
                return
            if now >= next_health:
                await self.send(viewer.writer, encode({"type": "health", "connection_id": viewer.id,
                                  "known_drops": self.drops.copy(), "loss_outside_collector": "unknown"}))
                next_health = now + self.limits.heartbeat_interval
            if viewer.queue:
                message = viewer.queue.popleft()
                viewer.bytes -= len(message)
                # Only one frame can be pending in addition to the bounded queue.
                await self.send(viewer.writer, message)
                await asyncio.sleep(0)
            else:
                viewer.ready.clear()
                try:
                    await asyncio.wait_for(viewer.ready.wait(), self.limits.heartbeat_interval)
                except TimeoutError:
                    pass

    async def close(self):
        self.stopping = True
        if self.ingress_resume:
            self.ingress_resume.cancel()
            self.ingress_resume = None
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.viewer:
            self.disconnect(self.viewer)
        for writer in tuple(self.clients):
            writer.transport.abort()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.ingress:
            asyncio.get_running_loop().remove_reader(self.ingress.fileno())
            self.ingress.close()
            self.ingress = None
        path = self.runtime_dir / "ingest.sock"
        if self.socket_identity and path.exists() and path.lstat().st_ino == self.socket_identity:
            path.unlink()
        if self.lock:
            self.lock.close()
            self.lock = None


def read_token(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size not in (64, 65)
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise ValueError("token file must be private and account-owned")
        return stream.read(66).decode("ascii").strip()


async def run(args):
    collector = Collector(args.runtime_dir, read_token(args.token_file))
    stop = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signum, stop.set)
    try:
        port = await collector.start(args.port)
        print(f"Collector listening on loopback port {port}.", flush=True)
        await stop.wait()
    finally:
        await collector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=4318)
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except (OSError, ValueError):
        parser.exit(1, "Collector could not start. Check private paths, token format, and port availability.\n")


if __name__ == "__main__":
    main()
