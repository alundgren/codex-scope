# Linux capture development

The observer, collector, installer and management tools are native Rust programs.
They build and test independently of Electron. Source builds need the pinned
Rust toolchain, a C compiler and a system linker. Installed binaries need the matching Linux
system libraries, with no Python, Bun, Node or Rust runtime installation.
Start with [install.md](install.md) for guided installation.

From the repository root, with Bun and Vite+ development tooling installed:

```sh
vp run build:linux
vp run test:linux
vp run check:linux
vp run probe:linux
vp run measure:linux
```

Cargo alone is sufficient for Linux development:

```sh
cargo build --manifest-path linux/Cargo.toml --release
cargo test --manifest-path linux/Cargo.toml
linux/target/release/codex-scope probe
cargo run --release --manifest-path linux/Cargo.toml --example observer_measurements
cargo run --release --manifest-path linux/Cargo.toml --example runtime_measurements
```

The probe creates an isolated temporary Codex configuration and asks the installed
app-server to list its registrations. It verifies registration and untrusted
status, not real event emission or policy behavior. It leaves account hooks and
trust unchanged. Real-session coverage, policy coexistence and private proxy
checks remain in [the plan](../plan.md).

## Local synthetic run

From the repository root, create an ignored private test token and start the
collector. Token creation refuses existing files and never prints the token.

```sh
mkdir -m 700 -p runtime
linux/target/release/codex-scope token --token-file runtime/viewer.token
linux/target/release/codex-scope collector --runtime-dir runtime/collector --token-file runtime/viewer.token
```

In another terminal:

```sh
linux/target/release/codex-scope viewer --endpoint http://127.0.0.1:4319 --token-file runtime/viewer.token --seconds 10
```

While that client is connected, send a synthetic event from a third terminal:

```sh
linux/target/release/codex-scope-observer runtime/collector/ingest.sock < protocol/fixtures/pre-tool-use.json
```

The diagnostic client prints counts, never payloads. It records nothing. Stop
the collector with Ctrl+C. Its runtime directory contains only a lock and socket
while running. A restarted collector removes a stale socket only after acquiring
the collector lock.

## Explicit hook installation

Run `linux/target/release/codex-scope setup` for guided installation and use its
installed management command to inspect, verify or remove the installation.
The flow asks before reading configuration and before making changes. It adds
its own handlers without wrapping another hook command or changing hook trust.
Review the exact entries in Codex `/hooks` and start a new session for testing.

Handler output is redirected and failures are normalized to exit zero, including
when the observer executable has been removed. Ownership records identify exact
entries so removal preserves edited or duplicate entries and unrelated settings.
Configuration writes are atomic and recorded durably for interrupted recovery.
Do not edit configuration concurrently with setup. Other editors do not use its
lock, so a short comparison-to-replacement interval remains. Unknown fields are
preserved; JSON formatting is normalized. Symlink files, duplicate JSON keys,
oversized configuration and directories writable by others are refused.

## Runtime limits

| Resource | Default |
| --- | --- |
| Observer payload | 61440 bytes, one datagram |
| Observer timer | 20 ms after entering the executable |
| Codex handler timeout | 1 second as an additional fallback |
| Collector accepted parsing rate | 200 datagrams per second while connected |
| Collector socket reads | At most 400 datagrams per second, including disconnected or invalid traffic |
| Queue | At most 64 frames and 1 MiB of encoded frames |
| Frame | At most 393216 bytes, including newline |
| Pending send | One frame, 1-second write deadline |
| HTTP connections | At most 8 active clients |
| HTTP request headers | 4096 bytes, 2-second read deadline |
| Stream health messages | Approximately once per second |
| Viewer heartbeat | Every 2 seconds, expires after 6 seconds |
| Kernel socket buffers requested | Receive 128 KiB; TCP send 32 KiB |

Linux may adjust kernel buffers. Kernel datagram queue limits also apply.
The event loop reads at most 32 datagrams per callback to let other work run.
It suspends socket reads when the per-second ingress budget is exhausted;
further kernel losses remain unknown rather than requiring busy draining.
There is no observer acknowledgment and no retry. Drop counters cannot cover
events the collector never receives. Scheduling delays, process launch, the
shell, and the Codex runtime are outside the observer's internal timer; it is
not a hard end-to-end latency guarantee.

The stream API and synthetic fixtures live in [protocol/](../protocol/README.md).
The synthetic client can also check a configured private HTTPS proxy without
Electron. It is a diagnostic client, not a production viewer implementation.

## Git session labels

The collector reads additional host metadata beyond hook input. For an absolute
`cwd` supplied by an accepted hook event, it runs `/usr/bin/git -C <cwd>
rev-parse --path-format=absolute --git-common-dir` and `symbolic-ref --quiet
--short HEAD`. These read-only queries identify the repository directory and
branch, including linked worktrees and unborn branches. The repository name
comes from the common Git directory, not a remote URL. Detached HEAD and failed
branch queries report an unavailable branch. Git missing at `/usr/bin/git`,
non-repository directories, inaccessible paths, and lookup failures leave the
viewer with its working-directory or session-ID fallback.

This is an explicit exception to observing only hook input. No transcript,
environment variable, remote URL, working-file content, or other hook command's
output is collected. Git's stdout is private metadata; stderr is discarded.
Child processes use a fixed environment, disable global/system Git configuration
and optional locks, and never run a shell. Git may read repository-local
configuration as part of resolving the repository. The observer remains a single
nonblocking datagram send and never starts Git or waits for a lookup.

One lazily started worker has a 256 KiB stack, one pending lookup and no backlog.
It starts at most four lookups per second across all directories and refreshes a
cached directory no more than once per second, only in response to events while
a viewer is connected. Its cache holds at most 32 directory/results, including
negative results, with 4,096-byte directory paths, 4,096-byte output per command,
and 512-byte repository/branch names. Each lookup gives its two sequential Git
commands one shared 100 ms deadline. Output overflow or timeout kills the child;
the worker reaps it before accepting another lookup. A child stuck in kernel I/O
can occupy this one worker, but cannot cause replacement workers or queued work.
Each child has a 128 MiB address-space ceiling and receives SIGKILL if its
parent worker exits. No event waits for the worker.

Completed metadata accompanies a later event from that directory. Renames are
therefore eventually visible during continued capture, not guaranteed immediately
after the rename. A session with no later events cannot receive a new label.
Cached metadata carries its observation time and may also be reused on a new
connection; it is not recovered event history. Nothing is written to disk by the
lookup worker. Cache entries and unfinished work are not persisted.

The commands use Git's documented [common directory resolution](https://git-scm.com/docs/git-rev-parse)
and [symbolic branch reference](https://git-scm.com/docs/git-symbolic-ref).
