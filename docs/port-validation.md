# Rust and TypeScript port validation

The port replaces the Linux Python and C implementation with two Rust
executables. Electron application code, tests and development scripts use
strict TypeScript. Bun manages JavaScript dependencies and Vite+ provides the
repository commands. Cargo remains usable independently for Linux development.
Electron retains its embedded Node runtime and `node:sqlite` worker.

The validated application and tooling source is commit
`ab132147d16cc85b66c90c0904d34605b71801ba`. Later documentation updates record
its results. The final native CLI binary SHA256 is
`db41a9ec36c1fc9166c512277a4c7302fc5a4bba3fa4283413d86ef0d0c4b35c`;
the observer SHA256 is
`2f9a2f35c65113803191e0d1a213eea5dd55fc30e1328f5e5e9a34d41594214b`.

The implementation starts from merged PR #12, revision
`a5f70eb6a0a08c96c93969b2abc28e2a2507290c`. Measurements in the older Linux and
Electron reports describe the previous implementation. They do not establish
performance or compatibility of this port.

## Reproduction

Install the pinned Rust toolchain, Bun and Vite+ development tooling. From the
repository root:

```sh
vp install
vp -C electron run setup
setsid --wait vp run check
vp run build
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp run test
vp run probe:linux
vp run measure:linux
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp run test:collector
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp -C electron run validate:visual
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp -C electron run validate:resources --runs=1
vp -C electron run check:resources
vp -C electron run check:resources --prove-failure
```

Electron validation needs the documented Linux desktop libraries, Xvfb and
Openbox. Its desktop wrapper supplies an isolated window manager. Development
package and runtime versions are pinned in `bun.lock`, `.node-version` and
`rust-toolchain.toml`. Linux dependencies are locked in `linux/Cargo.lock`.

## Tested environment

Linux x86_64 on Ubuntu 26.04.1, kernel 7.0.0-31-generic, glibc 2.43;
Rust and Cargo 1.98.1; Bun 1.3.14; host Node 24.21.0; Vite+ 0.3.1;
TypeScript 7.0.2; Electron 44.3.0 and Playwright 1.63.0. Desktop tests run
under Xvfb with Openbox, sandboxing and software GPU enabled. Electron embeds
Node 24.20.0 and SQLite 3.53.4.

This VM had an unrelated unfinished package upgrade. Openbox and xprop were
extracted into ignored `.artifacts/tools/desktop/` for validation. Its `usr/bin`,
`usr/lib/x86_64-linux-gnu` and `usr/share` were added to PATH, LD_LIBRARY_PATH and
XDG_DATA_DIRS for those commands. A normal development machine can install the
packages described in the Electron README. No existing Scope installation was
changed during validation. Some Vite+ runs in this VM's agent shell ended with
SIGTERM after printing success. Isolated check and collector-smoke commands
returned zero, but the isolated resource command still returned 143 after saving
a complete passing report. The cause was not established. The separate resource
checker and its deliberately failing input check both returned their expected
statuses. Interactive-shell behavior elsewhere was not tested.
Smaller direct and Vite+-wrapped actual Electron launch/close probes returned
zero, and deliberate failures returned seven. They did not reproduce the 143
exit, so no speculative process-cleanup change was made.

## Native Linux results

All 64 Rust tests pass, covering 49 library tests and 15 runtime integration
tests. Formatting and all-target Clippy checks pass with warnings denied. The
isolated Codex probe recognizes all twelve hooks as untrusted. A uniquely named
temporary systemd user service delivered a synthetic event, stopped cleanly and
left the observer able to exit successfully with its receiver absent.

The observer measurements launch 200 fresh processes per case. They include
process creation and waiting, with input already available on stdin.

| Case | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| `/bin/true` baseline | 8.080 | 17.161 | 25.839 |
| Receiver absent | 8.580 | 19.557 | 27.640 |
| Event delivered | 8.092 | 15.900 | 28.598 |
| Receiver confirmed full | 4.202 | 14.554 | 23.469 |

The full-receiver case accepted 513 datagrams before EAGAIN and reconfirmed
saturation before testing observer launches. Fresh sending sockets avoid
mistaking one sender's buffer limit for a full receiver. The earlier repeat measured delivered-observer p95 at 2.161 ms and baseline
p95 at 1.770 ms. The final repeat above was slower even for `/bin/true`; the
unchanged observer binary and changing baseline show why process timing must
not be treated as a fixed hook latency. Both reports are retained. These are
synthetic measurements, not a bound on real Codex hook latency.

The collector uses one thread in all measured profiles. RSS and CPU below cover
only the collector process, excluding kernel socket buffers, producer and client.
Idle and sustained workloads run for about five seconds; the burst observation
runs for about three seconds. The JSON report's elapsed time also includes the
final diagnostic viewer wait.

| Workload | Delivered | Peak RSS KiB | Collector CPU seconds |
| --- | ---: | ---: | ---: |
| Idle without viewer | 0 | 3028 | Below 0.01 s resolution |
| Idle with viewer | 0 | 3244 | Below 0.01 s resolution |
| 500 events of 60036 bytes at 100/s | 500 | 3436 | 0.23 |
| Burst of 10000 events of 60036 bytes | 46 | 4576 | 0.02 |

In the burst, the producer observed 9850 kernel send rejections. The collector
received 150 datagrams, delivered 46, and counted 104 queue drops and zero rate
drops. Production observers do not acknowledge delivery, so collector counters
cannot count those kernel losses. Every profile ended with only the collector
lock file remaining, with no event files. These short profiles do not establish
long-duration production behavior or cross-account rejection.

Raw numeric reports are retained in [observer measurements](evidence/port-observer.json)
and [collector measurements](evidence/port-collector.json). The initial
[observer repeat](evidence/port-observer-initial.json) and
[collector repeat](evidence/port-collector-initial.json) preceded the final
installer-only guard; observer and collector code were unchanged. No earlier Python
memory or throughput comparison is claimed because its measurement included
different processes.

## Electron and collector integration

All 22 unit tests and all 24 actual Electron scenarios pass. The final visual
manifest reports zero skipped, unexpected or flaky scenarios and 139 saved
artifacts. The 8-minute desktop run covers exact payload copy, scrolling,
filtering, scrubbing, held arrivals, eviction, Clear, delayed/stale work,
clipboard/storage/worker failures, reconnects, authentication, lease ownership,
hidden capture and crash/normal-close cleanup. Formatting, lint and strict type
checks pass for the TypeScript application and development tools.

The separate native collector smoke test passes through the actual observer,
Rust collector and Electron app. It verifies exact original event bytes, a live
connection beyond the six-second lease using separate heartbeat requests, and
retained history with an unknown coverage interval after collector shutdown.
It uses isolated loopback configuration and synthetic input, with no hooks,
trust changes or private proxy.

Selected screenshots and recordings are attached to the PR. Reference and
implementation comparisons use 1180 × 760 desktop and 440 × 820 narrow content
sizes. Existing differences are fixture data, truthful capture status/counters,
and the narrow app's allocation of more height to the payload. The port does
not redesign the selected experience. The implementer inspected the screenshots
and sampled walkthroughs; the coordinator also checked desktop/narrow images,
held-disconnection video, native setup and the end-to-end smoke evidence.

## Electron resource trial

One complete regression trial passed all 281 checked values against the existing
limits. The separate checker accepted its report and rejected a deliberate
one-byte RSS regression. The saved [resource report](evidence/port-electron-resources.json)
includes the complete workloads, limits and measurement method. The wrapper exit
status issue described above remains separate from these saved measurements.

The trial covers idle capture, held history, row-limit and maximum-payload
eviction cycles, rapid search and navigation, hidden/minimized capture, bursts,
delayed/stalled storage, disk and cleanup failures, and restart recovery.

| Measurement | Result | Existing limit |
| --- | ---: | ---: |
| Startup | 1147.7 ms | 2000 ms |
| Peak sampled total app RSS | 725.6 MiB | 900 MiB |
| Largest workload steady RSS | 713.9 MiB | 825 MiB |
| Largest workload endpoint PSS | 381.5 MiB | 450 MiB |
| Connected / settled idle CPU | 2.31% / 2.11% of one core | 5% |
| Largest workload mean CPU | 80.6% of one core | 110% |
| Longest search / keyboard response | 570.1 / 248.7 ms | 600 / 500 ms |
| Largest main / renderer delay | 93.1 / 125.9 ms | 250 ms each |
| Peak recording disk use | 8483506 bytes | 33 MiB |
| Application / Electron runtime files | 168317 / 295827900 bytes | 200 KiB / 310 MiB |

Memory includes all eight Electron processes and their worker threads. RSS counts
shared pages more than once; PSS apportions them and was measured only at workload
endpoints. Xvfb, Openbox, the driver, synthetic server and metric reader are excluded.
Sampling can miss brief processes and peaks. Search includes the 180 ms debounce.
The final maximum-payload cycle retained 135 events after accepting 11632 and
evicting 11497. Steady RSS decreased between its first and third cycles.

The empty-window baseline also used eight processes and started in 1922.1 ms.
The trial order and warm filesystem caches do not support a claim that the app
starts faster than an empty window. A single Linux trial does not establish a
distribution across machines, macOS resource use or energy consumption.

## Native setup walkthrough

The recorded native CLI covers nine scenarios: declined configuration access,
missing prerequisites, failed registration probe, missing remote prerequisite,
symlinked service enablement refusal, cancellation, successful install and
removal, preservation of an edited service, and interrupted recovery. Its
34.68-second walkthrough and screenshots are attached to the PR.

The PTY invokes the actual release executable and copied recovery tools. Local
collector, observer, configuration writes and removal are real. Host systemd
responses, Codex registration/approval metadata and Tailscale responses are
simulated in these terminal scenarios. The separate probe and temporary service
check above exercise actual Codex registration and systemd operation. The
walkthrough does not prove live hook approval or a real model session.

Reproduce with `vp exec playwright install chromium`, then `vp run validate:setup`.
This optional evidence command uses the workspace's Node/Playwright tools. Cargo
builds and Rust tests do not depend on that rendering tool. Generated evidence
stays under ignored `.artifacts/visual/native-setup/`.

## Runtime requirements and safety

Source installation needs Rust/Cargo, a C compiler and a linker. The TLS
cryptography dependency compiles native code during the source build. The installed observer and
collector need neither Rust nor a JavaScript runtime. Guided setup also uses
Codex CLI and the account's systemd user service manager. Optional private HTTPS
access uses Tailscale. Native binaries must match the host architecture and
system libraries; this checkout does not provide portable release archives.

Most Linux parsing, queues and configuration logic use Rust's checked memory
access. Small `unsafe` sections call Linux APIs for datagrams, sender credentials,
signals and file locking. Rust does not replace the input limits, protocol
validation, durable ownership records or system-level tests. The observer still
makes one nonblocking datagram attempt and exits silently. Its internal timer
does not include process launch or Codex scheduling.

Bun and Vite+ are development dependencies. The Electron output contains the
compiled application and synthetic fixtures, while Electron supplies Node and
Chromium. The port adds no application runtime package or process to Electron.
TypeScript checks help catch invalid internal calls, but incoming data still
requires runtime validation.

## Scope of evidence

Checks use synthetic data and temporary configuration. They do not establish
real-session hook coverage, interaction with existing denying hooks, private
Tailscale delivery, cross-device connections or macOS performance, energy use
and native lifecycle behavior. No existing account installation is migrated.
