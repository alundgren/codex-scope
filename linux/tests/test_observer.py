import concurrent.futures
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

from scope.contract import MAX_PAYLOAD

OBSERVER = Path(__file__).resolve().parents[1] / "build/observer"


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scope-observer-")
        self.path = Path(self.temp.name) / "in.sock"
        self.addCleanup(self.temp.cleanup)

    def receiver(self):
        receiver = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        receiver.bind(str(self.path))
        receiver.settimeout(0.1)
        self.addCleanup(receiver.close)
        return receiver

    def run_observer(self, data=b'{"synthetic":true}', path=None):
        with tempfile.TemporaryFile() as source:
            source.write(data)
            source.seek(0)
            result = subprocess.run([OBSERVER, str(path or self.path)], stdin=source,
                                    capture_output=True, timeout=1)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
        return result

    def test_exact_bytes_and_boundary(self):
        receiver = self.receiver()
        for data in (b' { "synthetic": true }\n', b"x" * MAX_PAYLOAD):
            self.run_observer(data)
            self.assertEqual(receiver.recv(MAX_PAYLOAD + 1), data)

    def test_absent_receiver_and_invalid_path(self):
        self.run_observer()
        self.run_observer(path="/" + "x" * 200)
        self.path.write_text("not a socket")
        self.run_observer()

    def test_oversized_and_empty_are_not_sent(self):
        receiver = self.receiver()
        self.run_observer(b"x" * (MAX_PAYLOAD + 1))
        self.run_observer(b"")
        with self.assertRaises(TimeoutError):
            receiver.recv(MAX_PAYLOAD)

    def test_full_receiver_does_not_wait(self):
        self.receiver()
        for _ in range(30):
            self.run_observer()

    def test_open_stdin_has_deadline(self):
        process = subprocess.Popen([OBSERVER, str(self.path)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        started = time.monotonic()
        try:
            self.assertEqual(process.wait(timeout=1), 0)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(process.stdout.read(), b"")
            self.assertEqual(process.stderr.read(), b"")
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_concurrent_failures_remain_silent(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(lambda _: self.run_observer(), range(64)))

    def test_closed_output_pipes(self):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        try:
            result = subprocess.run([OBSERVER, str(self.path)], input=b"{}",
                                    stdout=write_fd, stderr=write_fd, timeout=1)
            self.assertEqual(result.returncode, 0)
        finally:
            os.close(write_fd)
