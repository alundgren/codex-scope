"""Synthetic protocol client. Counts events without recording or logging payloads."""

import argparse
import http.client
import json
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

from .collector import read_token
from .contract import MAX_FRAME


def inspect(endpoint, token, seconds):
    url = urlsplit(endpoint)
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("endpoint must be an origin without credentials, path, query, or fragment")
    if url.scheme == "https":
        connection_type = http.client.HTTPSConnection
    elif url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1"):
        connection_type = http.client.HTTPConnection
    else:
        raise ValueError("use HTTPS, or HTTP on loopback for local tests")
    def connection():
        return connection_type(url.hostname, url.port, timeout=3)
    headers = {"Authorization": "Bearer " + token}
    stop = threading.Event()
    failed = threading.Event()
    stream = connection()
    heartbeat = None
    summary = {"events": 0, "payload_bytes": 0, "loss_outside_collector": "unknown"}
    try:
        stream.request("GET", "/v1/stream", headers=headers)
        response = stream.getresponse()
        if response.status != 200:
            raise ValueError(f"stream returned HTTP {response.status}")
        def read():
            line = response.readline(MAX_FRAME + 1)
            if not line or len(line) > MAX_FRAME or not line.endswith(b"\n"):
                raise ValueError("stream closed or frame exceeded limit")
            return json.loads(line)
        hello = read()
        if hello.get("type") != "hello" or hello.get("protocol_version") != 1:
            raise ValueError("unsupported stream protocol")
        identity = hello["connection_id"]
        def renew():
            while not stop.wait(2):
                lease = connection()
                try:
                    lease.request("POST", "/v1/heartbeat", headers={**headers, "X-Connection-Id": identity})
                    result = lease.getresponse()
                    if result.status != 204:
                        failed.set()
                        return
                    result.read(1)
                except (OSError, http.client.HTTPException):
                    failed.set()
                    return
                finally:
                    lease.close()
        heartbeat = threading.Thread(target=renew)
        heartbeat.start()
        deadline = time.monotonic() + seconds
        sequence = 0
        while time.monotonic() < deadline:
            if failed.is_set():
                raise ValueError("heartbeat failed")
            message = read()
            if message.get("connection_id") != identity:
                raise ValueError("connection identity changed within stream")
            if message.get("type") == "event":
                if message["sequence"] <= sequence:
                    raise ValueError("events arrived out of order")
                sequence = message["sequence"]
                if len(message["payload"].encode("utf-8")) != message["payload_bytes"]:
                    raise ValueError("payload byte count mismatch")
                summary["events"] += 1
                summary["payload_bytes"] += message["payload_bytes"]
            elif message.get("type") == "health":
                summary["known_drops"] = message["known_drops"]
        return summary
    finally:
        stop.set()
        stream.close()
        if heartbeat:
            heartbeat.join(timeout=4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=10)
    args = parser.parse_args()
    if not 0 < args.seconds <= 3600:
        parser.error("seconds must be positive and no more than 3600")
    try:
        print(json.dumps(inspect(args.endpoint, read_token(args.token_file), args.seconds), indent=2))
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        parser.exit(1, "Viewer check failed: connection, authentication, or protocol error.\n")


if __name__ == "__main__":
    main()
