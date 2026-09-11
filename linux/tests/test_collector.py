import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest

from scope.collector import Collector, Limits, read_token
from scope.contract import MAX_PAYLOAD

TOKEN = "a" * 64
PAYLOAD = b' {"hook_event_name":"PreToolUse","session_id":"synthetic-a","tool_name":"Bash","extra":42}\n'
OBSERVER = Path(__file__).resolve().parents[1] / "build/observer"


class CollectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scope-collector-")
        self.directory = Path(self.temp.name)
        self.collector = Collector(self.directory, TOKEN, Limits(heartbeat_interval=0.03, heartbeat_expiry=2))
        self.port = await self.collector.start()
        self.writers = []

    async def asyncTearDown(self):
        for writer in self.writers:
            writer.close()
        await self.collector.close()
        for writer in self.writers:
            try:
                await writer.wait_closed()
            except OSError:
                pass
        self.temp.cleanup()

    async def request(self, method="GET", path="/v1/stream", token=TOKEN, extra=""):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.writers.append(writer)
        writer.write(f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n{extra}\r\n".encode())
        await writer.drain()
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 1)
        return int(header.split(b" ")[1]), reader, writer

    async def connect_viewer(self):
        status, reader, writer = await self.request()
        self.assertEqual(status, 200)
        hello = json.loads(await asyncio.wait_for(reader.readline(), 1))
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["loss_before_connection"], "unknown")
        return reader, writer, hello["connection_id"]

    async def event(self, reader):
        for _ in range(50):
            message = json.loads(await asyncio.wait_for(reader.readline(), 1))
            if message["type"] == "event":
                return message
        self.fail("no event received")

    async def observe(self, payload=PAYLOAD):
        # Delivery assertions need input ready before the observer's timer starts.
        # The separate observer test deliberately leaves a pipe open to test expiry.
        with tempfile.TemporaryFile() as source:
            source.write(payload)
            source.seek(0)
            process = await asyncio.create_subprocess_exec(OBSERVER, str(self.directory / "ingest.sock"),
                           stdin=source, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await process.communicate()
        self.assertEqual((process.returncode, stdout, stderr), (0, b"", b""))

    async def test_authenticated_delivery_preserves_exact_payload(self):
        reader, _, identity = await self.connect_viewer()
        await self.observe()
        event = await self.event(reader)
        self.assertEqual(event["payload"].encode(), PAYLOAD)
        self.assertEqual(event["payload_bytes"], len(PAYLOAD))
        self.assertEqual(event["connection_id"], identity)
        self.assertEqual(event["sequence"], 1)
        self.assertEqual(event["tool_name"], "Bash")

    async def test_authentication_second_viewer_and_ingestion_route(self):
        self.assertEqual((await self.request(token="wrong"))[0], 401)
        await self.connect_viewer()
        self.assertEqual((await self.request())[0], 409)
        self.assertEqual((await self.request("POST", "/ingest"))[0], 404)
        self.assertEqual((await self.request(path="/v1/stream?token=" + TOKEN))[0], 404)

    async def test_heartbeat_renewal_and_expiry(self):
        self.collector.limits = replace(self.collector.limits, heartbeat_expiry=0.3)
        _, _, identity = await self.connect_viewer()
        for _ in range(3):
            await asyncio.sleep(0.15)
            status, _, _ = await self.request("POST", "/v1/heartbeat", extra=f"X-Connection-Id: {identity}\r\n")
            self.assertEqual(status, 204)
        await asyncio.sleep(0.36)
        self.assertIsNone(self.collector.viewer)
        status, _, _ = await self.request("POST", "/v1/heartbeat", extra=f"X-Connection-Id: {identity}\r\n")
        self.assertEqual(status, 409)

    async def test_disconnect_and_reconnect_do_not_replay(self):
        await self.observe()
        reader, writer, old_identity = await self.connect_viewer()
        await self.observe()
        await self.event(reader)
        writer.close()
        await writer.wait_closed()
        await asyncio.sleep(0.08)
        self.assertIsNone(self.collector.viewer)
        await self.observe(b'{"hook_event_name":"Stop","marker":"lost"}')
        new_reader, _, identity = await self.connect_viewer()
        self.assertNotEqual(identity, old_identity)
        await self.observe()
        event = await self.event(new_reader)
        self.assertEqual(event["sequence"], 1)
        self.assertEqual(event["payload"].encode(), PAYLOAD)
        self.assertGreaterEqual(self.collector.drops["no_viewer"], 2)

    async def test_pending_kernel_events_are_not_replayed(self):
        sender = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sender.sendto(PAYLOAD, str(self.directory / "ingest.sock"))
        finally:
            sender.close()
        reader, _, _ = await self.connect_viewer()
        await self.observe(b'{"hook_event_name":"Stop","marker":"new"}')
        self.assertEqual((await self.event(reader))["hook_type"], "Stop")

    async def test_malformed_oversized_and_unicode_input(self):
        reader, _, _ = await self.connect_viewer()
        for payload in (b"not json", b"[]", b'{}', b'\xff', b'{"hook_event_name":"Stop","x":NaN}',
                        b'{"hook_event_name":"Stop","x":"\\ud800"}',
                        b'{"hook_event_name":"Stop","session_id":4}', b"[" * 10000,
                        b'{"hook_event_name":"Stop","x":1e999}'):
            self.collector.ingest(payload)
        sender = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sender.sendto(b"x" * (MAX_PAYLOAD + 1), str(self.directory / "ingest.sock"))
        finally:
            sender.close()
        await self.observe()
        self.assertEqual((await self.event(reader))["payload"].encode(), PAYLOAD)
        self.assertEqual(self.collector.drops["invalid"], 9)
        self.assertEqual(self.collector.drops["oversized"], 1)

    async def test_queue_count_bytes_rate_and_disconnect_limits(self):
        await self.connect_viewer()
        self.collector.limits = replace(self.collector.limits, queue_count=2, queue_bytes=1024,
                                        events_per_second=10)
        viewer = self.collector.viewer
        for _ in range(1000):
            self.collector.ingest(PAYLOAD)
        self.assertLessEqual(len(viewer.queue), 2)
        self.assertLessEqual(viewer.bytes, 1024)
        self.assertGreater(self.collector.drops["queue"], 0)
        self.assertEqual(self.collector.drops["rate"], 990)
        queued = len(viewer.queue)
        self.collector.disconnect(viewer)
        self.assertEqual(viewer.bytes, 0)
        self.assertEqual(len(viewer.queue), 0)
        self.assertEqual(self.collector.drops["disconnect"], queued)

    async def test_concurrent_sessions_have_one_recording_order(self):
        reader, _, _ = await self.connect_viewer()
        def send(index):
            sender = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            try:
                sender.sendto(json.dumps({"hook_event_name": "Stop", "session_id": str(index)}).encode(),
                              str(self.directory / "ingest.sock"))
            finally:
                sender.close()
        await asyncio.gather(*(asyncio.to_thread(send, i) for i in range(8)))
        events = [await self.event(reader) for _ in range(8)]
        self.assertEqual([event["sequence"] for event in events], list(range(1, 9)))
        self.assertEqual({event["session_id"] for event in events}, {str(i) for i in range(8)})

    async def test_idle_http_clients_are_bounded_and_expire(self):
        self.collector.limits = replace(self.collector.limits, http_clients=2, request_timeout=0.1)
        for _ in range(5):
            _, writer = await asyncio.open_connection("127.0.0.1", self.port)
            self.writers.append(writer)
        self.assertLessEqual(len(self.collector.clients), 2)
        await asyncio.sleep(0.15)
        self.assertEqual(len(self.collector.clients), 0)

    async def test_slow_reader_is_disconnected_with_bounded_queue(self):
        self.collector.limits = replace(self.collector.limits, heartbeat_expiry=2, write_timeout=0.05)
        reader, _, _ = await self.connect_viewer()
        reader._transport.pause_reading()
        large = json.dumps({"hook_event_name": "Stop", "text": "x" * 60000}).encode()
        for _ in range(20):
            for _ in range(10):
                self.collector.ingest(large)
            await asyncio.sleep(0.01)
            if self.collector.viewer is None:
                break
            self.assertLessEqual(self.collector.viewer.bytes, self.collector.limits.queue_bytes)
        await asyncio.sleep(0.1)
        self.assertIsNone(self.collector.viewer)

    async def test_restart_has_no_event_files_or_old_data(self):
        await self.observe()
        await self.collector.close()
        self.assertEqual({p.name for p in self.directory.iterdir()}, {"collector.lock"})
        self.collector = Collector(self.directory, TOKEN)
        self.port = await self.collector.start()
        reader, _, _ = await self.connect_viewer()
        await self.observe()
        self.assertEqual((await self.event(reader))["sequence"], 1)
        self.assertEqual(self.collector.drops["no_viewer"], 0)

    async def test_second_collector_cannot_remove_first_socket(self):
        second = Collector(self.directory, TOKEN)
        with self.assertRaises(BlockingIOError):
            await second.start()
        reader, _, _ = await self.connect_viewer()
        await self.observe()
        self.assertEqual((await self.event(reader))["sequence"], 1)

    async def test_synthetic_viewer_reads_without_recording(self):
        from scope.viewer import inspect
        self.collector.limits = replace(self.collector.limits, heartbeat_expiry=6)
        task = asyncio.create_task(asyncio.to_thread(inspect, f"http://127.0.0.1:{self.port}", TOKEN, 0.2))
        for _ in range(100):
            if self.collector.viewer:
                break
            await asyncio.sleep(0.005)
        await self.observe()
        result = await task
        self.assertEqual(result["events"], 1)
        self.assertEqual(result["payload_bytes"], len(PAYLOAD))
        self.assertEqual({p.name for p in self.directory.iterdir()}, {"collector.lock", "ingest.sock"})

    async def test_socket_read_budget_suspends_work_and_recovers(self):
        self.collector.limits = replace(self.collector.limits, datagrams_per_second=2)
        await self.observe()
        await self.observe()
        await self.observe()
        self.assertEqual(self.collector.ingress_count, 2)
        self.assertIsNotNone(self.collector.ingress_resume)
        self.assertEqual((await self.request())[0], 503)
        await asyncio.sleep(1.05)
        self.assertIsNone(self.collector.ingress_resume)
        self.assertEqual(self.collector.drops["no_viewer"], 3)

    async def test_malformed_requests_do_not_claim_viewer(self):
        for extra in ("Content-Length: 1\r\n", "Transfer-Encoding: chunked\r\n",
                      "Authorization: Bearer duplicate\r\n"):
            self.assertEqual((await self.request(extra=extra))[0], 400)
        self.assertIsNone(self.collector.viewer)


class TokenTests(unittest.TestCase):
    def test_private_token_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text(TOKEN)
            path.chmod(0o600)
            self.assertEqual(read_token(path), TOKEN)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                read_token(path)
            with self.assertRaises(ValueError):
                Collector(directory, "short")
