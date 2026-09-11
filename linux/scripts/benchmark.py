"""Synthetic process latency measurements, not real Codex turn latency."""

import json
from pathlib import Path
import platform
import socket
import statistics
import subprocess
import sys
import tempfile
import time

OBSERVER = Path(__file__).resolve().parents[1] / "build/observer"


def measure(command, receiver=None, samples=200):
    durations = []
    with tempfile.TemporaryFile() as source:
        source.write(b'{"hook_event_name":"Stop","session_id":"synthetic"}')
        for _ in range(samples):
            source.seek(0)
            start = time.perf_counter_ns()
            result = subprocess.run(command, stdin=source, capture_output=True, timeout=1)
            durations.append((time.perf_counter_ns() - start) / 1e6)
            if result.returncode or result.stdout or result.stderr:
                raise RuntimeError("observer was not silent and neutral")
            if receiver:
                receiver.recv(65536)
    durations.sort()
    return {"samples": samples, "median_ms": round(statistics.median(durations), 3),
            "p95_ms": round(durations[int(samples * .95) - 1], 3), "max_ms": round(max(durations), 3)}


def main():
    with tempfile.TemporaryDirectory(prefix="scope-bench-") as temporary:
        path = str(Path(temporary) / "ingest.sock")
        report = {"python": platform.python_version(),
                  "true_baseline": measure(["/bin/true"]),
                  "python_startup": measure([sys.executable, "-S", "-c", "pass"]),
                  "observer_absent": measure([str(OBSERVER), path])}
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as receiver:
            receiver.bind(path)
            receiver.settimeout(1)
            report["observer_delivered"] = measure([str(OBSERVER), path], receiver)
            report["observer_full"] = measure([str(OBSERVER), path])
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
