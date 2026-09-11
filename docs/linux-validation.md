# Linux validation

These results were measured on 2026-09-11 using Linux x86_64, Python 3.14.4,
GCC 15.2.0, and Codex CLI 0.153.4. Tests use synthetic inputs and temporary
directories. No account hooks were installed and no hook trust was changed.

## Compatibility

`make -C linux probe` starts the installed Codex app-server with an isolated
configuration and asks it to list the generated registrations. It recognized
all twelve below, with zero warnings or errors, and reported every handler as
untrusted. This also verifies that Codex accepts the generated hook file while
ownership metadata remains in a separate file.

| Registration | Recognized | Actual event emission |
| --- | --- | --- |
| SessionStart | Yes | Not tested |
| SessionEnd | Yes | Not tested |
| UserPromptSubmit | Yes | Not tested |
| PreToolUse | Yes | Not tested |
| PermissionRequest | Yes | Not tested |
| PostToolUse | Yes | Not tested |
| PreCompact | Yes | Not tested |
| PostCompact | Yes | Not tested |
| SubagentStart | Yes | Not tested |
| SubagentStop | Yes | Not tested |
| Stop | Yes | Not tested |
| Interrupt | Yes | Not tested |

The [official hook reference](https://learn.chatgpt.com/docs/hooks) documents
that silent exit zero is neutral and non-managed hooks require trust. The
observer tests verify its own silence and exit status. They do not prove how
all Codex clients behave or how an existing denying hook interacts with the
observer. Real-session policy coexistence, tool coverage, and latency remain
release gates in `plan.md`.

## Automated checks

`make -C linux test` passes 33 tests covering:

- Exact observer bytes and payload limit, absent and full receiver, invalid
  socket path, open stdin deadline, concurrent failures, and closed output pipes.
- Idempotent install/uninstall, unchanged denying-hook configuration, edited
  and duplicate entry preservation, removed executable behavior, malformed
  configuration and symlink refusal, interrupted ownership updates, and
  concurrent edits detected before configuration replacement.
- Authenticated observer-to-viewer delivery, second viewer rejection, viewer
  route isolation, heartbeat renewal and expiry, disconnects and reconnects,
  stale kernel backlog, malformed and oversized input, event ordering across
  concurrent sessions, queue/rate limits, slow readers, idle request limits,
  collector restart, private token files, malformed HTTP requests, and socket
  read suspension and recovery under ingress pressure.
- The synthetic viewer receives events without recording or logging payloads.

These tests do not exercise another OS account attempting to send datagrams.
The collector checks kernel-supplied sender credentials and filesystem
permissions; a cross-account integration check remains outstanding.

## Observer latency

`make -C linux benchmark` measures 200 fresh subprocesses per case with a
small synthetic payload preloaded into stdin before launch. Times include
Python's process-launch and output-pipe handling overhead. The receiver consumes each successful delivery; the full
receiver case stops consuming and fills its kernel queue.

| Case | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| `/bin/true` baseline | 2.308 | 4.370 | 9.212 |
| Python startup with `-S` | 21.370 | 28.582 | 65.700 |
| Observer, receiver absent | 1.838 | 3.150 | 3.811 |
| Observer, delivery succeeds | 2.179 | 3.589 | 6.012 |
| Observer, receiver fills | 3.217 | 10.589 | 30.589 |

This supports choosing a compiled C observer rather than starting Python for
each event. It is not a promise of a fixed latency or a measured Codex turn
overhead. Scheduling noise is visible even in the empty-process baseline.
The observer arms a 20 ms timer on entry and returns zero on expiry. The shell,
runtime launch, and OS scheduling remain outside that internal budget.

## Collector overload

`make -C linux load-check` feeds 10000 synthetic 60039-byte events directly to
the ingestion function in bursts of 100, with a 10 ms pause between bursts,
while a loopback client drains the stream. This separates collector pressure
from kernel datagram losses and observer startup. It is a short synthetic
profile, not a sustained production capacity claim.

| Measurement | Result |
| --- | ---: |
| Elapsed time | 1.802 seconds |
| Received events | 61 |
| Rate drops | 9600 |
| Queue drops | 339 |
| Peak queued frames | 17 |
| Peak queued bytes | 1024573 |
| Peak traced Python allocations during load | 1435337 bytes |
| Whole test process peak RSS | 28224 KiB |
| Test process CPU time | 0.696 seconds |

The queue stayed below 64 frames and 1 MiB. The process includes the client
and measurement tooling; RSS is not an isolated collector-only measurement.
The automated slow-reader test separately verifies that write pressure closes
the stream rather than growing pending writes. Exact results vary with load.

## Outstanding validation

- Real Codex sessions with capture available, absent, full, and removed;
  existing denying hooks; tool coverage; actual trust and session lifecycle.
- End-to-end latency under real hook invocation and representative concurrency.
- Private HTTPS proxy operation and route isolation through Tailscale Serve.
- Cross-account ingestion rejection and longer isolated collector CPU/RSS runs.
- Mac integration, responsiveness, resource budgets, and temporary-history
  lifecycle, owned by Electron work.

The Linux code can be exercised independently now. Full capture acceptance
remains incomplete until the relevant outstanding checks pass.

## Guided setup validation

The guided installer adds isolated transaction tests, actual Codex registration
checks, a generated-unit parser check, and a temporary systemd service delivery
check. [Terminal recordings and screenshots](validation/linux-install/README.md)
cover prompts, cancellation, recovery, and conservative removal. That record
distinguishes real subprocess checks from simulated host-service, approval, and
Tailscale operations. The guided flow itself has not yet been run end to end
against a live account and private HTTPS proxy.
