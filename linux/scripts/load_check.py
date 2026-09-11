"""Measure bounded collector queues under a synthetic overload profile."""

import asyncio
import json
from pathlib import Path
import resource
import sys
import tempfile
import time
import tracemalloc

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scope.collector import Collector
from scope.contract import MAX_FRAME


async def main():
    with tempfile.TemporaryDirectory(prefix="scope-load-") as temporary:
        collector = Collector(Path(temporary), "a" * 64)
        port = await collector.start()
        reader, writer = await asyncio.open_connection("127.0.0.1", port, limit=MAX_FRAME)
        writer.write(b"GET /v1/stream HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer " + b"a" * 64 + b"\r\n\r\n")
        await writer.drain()
        await reader.readuntil(b"\r\n\r\n")
        await reader.readline()
        received = 0
        async def consume():
            nonlocal received
            while line := await reader.readline():
                if json.loads(line).get("type") == "event":
                    received += 1
        consumer = asyncio.create_task(consume())
        raw = json.dumps({"hook_event_name": "Stop", "text": "x" * 60000}).encode()
        tracemalloc.start()
        usage_before = resource.getrusage(resource.RUSAGE_SELF)
        started = time.monotonic()
        peak_queue = peak_bytes = 0
        try:
            # Feed the ingestion function directly so this measures collector
            # pressure, separately from kernel datagram loss and observer startup.
            for _ in range(100):
                for _ in range(100):
                    collector.ingest(raw)
                peak_queue = max(peak_queue, len(collector.viewer.queue))
                peak_bytes = max(peak_bytes, collector.viewer.bytes)
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.1)
            _, peak_allocations = tracemalloc.get_traced_memory()
            usage_after = resource.getrusage(resource.RUSAGE_SELF)
            report = {"attempted_events": 10000, "payload_bytes_each": len(raw),
                      "elapsed_seconds": round(time.monotonic() - started, 3), "received_events": received,
                      "peak_queue_count": peak_queue, "peak_queue_bytes": peak_bytes,
                      "peak_traced_bytes": peak_allocations,
                      "process_peak_rss_kib": usage_after.ru_maxrss,
                      "cpu_seconds": round(usage_after.ru_utime + usage_after.ru_stime
                                           - usage_before.ru_utime - usage_before.ru_stime, 3),
                      "known_drops": collector.drops.copy()}
            assert peak_queue <= collector.limits.queue_count
            assert peak_bytes <= collector.limits.queue_bytes
            assert collector.drops["rate"] > 0 and collector.drops["queue"] > 0
            print(json.dumps(report, indent=2))
        finally:
            tracemalloc.stop()
            writer.close()
            await writer.wait_closed()
            await collector.close()
            await consumer


if __name__ == "__main__":
    asyncio.run(main())
