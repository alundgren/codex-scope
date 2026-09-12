# Rust and TypeScript port validation

The port replaces the Linux Python and C implementation with two Rust
executables. Electron application code, tests and development scripts use
strict TypeScript. Bun manages JavaScript dependencies and Vite+ provides the
repository commands. Cargo remains usable independently for Linux development.
Electron retains its embedded Node runtime and `node:sqlite` worker.

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
vp run check
vp run build
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp run test
vp run probe:linux
vp run measure:linux
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp run test:collector
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp -C electron run validate:visual
setsid --wait xvfb-run -a -s "-screen 0 1600x1000x24" vp -C electron run validate:resources -- --runs=1
vp -C electron run check:resources
vp -C electron run check:resources -- --prove-failure
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
changed during validation.

## Native Linux results

All 63 Rust tests pass, covering 48 library tests and 15 runtime integration
tests. Formatting and all-target Clippy checks pass with warnings denied. The
isolated Codex probe recognizes all twelve hooks as untrusted. A uniquely named
temporary systemd user service delivered a synthetic event, stopped cleanly and
left the observer able to exit successfully with its receiver absent.

The observer measurements launch 200 fresh processes per case. They include
process creation and waiting, with input already available on stdin.

| Case | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| `/bin/true` baseline | 0.973 | 1.770 | 3.350 |
| Receiver absent | 1.332 | 1.683 | 2.443 |
| Event delivered | 1.587 | 2.161 | 3.852 |
| Receiver confirmed full | 1.346 | 2.365 | 6.451 |

The full-receiver case accepted 513 datagrams before EAGAIN and reconfirmed
saturation before testing observer launches. Fresh sending sockets avoid
mistaking one sender's buffer limit for a full receiver. These are synthetic
process measurements, not a bound on real Codex hook latency.

The collector uses one thread in all measured profiles. RSS and CPU below cover
only the collector process, excluding kernel socket buffers, producer and client.
Idle and sustained workloads run for about five seconds; the burst observation
runs for about three seconds. The JSON report's elapsed time also includes the
final diagnostic viewer wait.

| Workload | Delivered | Peak RSS KiB | Collector CPU seconds |
| --- | ---: | ---: | ---: |
| Idle without viewer | 0 | 3028 | Below 0.01 s resolution |
| Idle with viewer | 0 | 3312 | Below 0.01 s resolution |
| 500 events of 60036 bytes at 100/s | 500 | 3408 | 0.24 |
| Burst of 10000 events of 60036 bytes | 23 | 4560 | 0.02 |

In the burst, the producer observed 9760 kernel send rejections. The collector
received 240 datagrams, delivered 23, and counted 177 queue drops and 40 rate
drops. Production observers do not acknowledge delivery, so collector counters
cannot count those kernel losses. Every profile ended with only the collector
lock file remaining, with no event files. These short profiles do not establish
long-duration production behavior or cross-account rejection.

Raw numeric reports are retained in [observer measurements](evidence/port-observer.json)
and [collector measurements](evidence/port-collector.json). No earlier Python
memory or throughput comparison is claimed because its measurement included
different processes.

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
