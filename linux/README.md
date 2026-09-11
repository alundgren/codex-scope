# Linux capture development

The observer and collector build and run independently of Electron. There are
no third-party Python packages. Use Linux, a C11 compiler, Make, and Python
3.11 or later. The tested environment uses Python 3.14.4, pinned in
`.python-version`, GCC 15.2.0, and Codex CLI 0.153.4. Other Codex versions need
new compatibility evidence; the installer refuses them.

From the repository root:

```sh
make -C linux
make -C linux test
make -C linux probe
make -C linux benchmark
make -C linux load-check
```

The probe creates a temporary isolated Codex configuration, calls the installed
app-server's `hooks/list`, and deletes the temporary files. It does not change
the account's hooks or trust. It verifies registration and untrusted status,
not real event emission or policy behavior.

See [validation](../docs/linux-validation.md) for measured results and remaining
checks. Production capture acceptance remains pending real-session checks.

## Local synthetic run

Run these commands from `linux/`. Paths below are ignored local test files,
not deployment defaults. The token command refuses to overwrite an existing
file and never prints the token.

```sh
mkdir -m 700 -p ../runtime
python3 -m scope.token ../runtime/viewer.token
python3 -m scope.collector --runtime-dir ../runtime/collector --token-file ../runtime/viewer.token
```

In another terminal, also from `linux/`:

```sh
python3 -m scope.viewer --endpoint http://127.0.0.1:4318 --token-file ../runtime/viewer.token --seconds 10
```

While that client is connected, send a synthetic event from a third terminal:

```sh
./build/observer ../runtime/collector/ingest.sock < ../protocol/fixtures/pre-tool-use.json
```

The client prints counts, never payloads. It records nothing. Stop the collector
with Ctrl+C. The runtime directory contains only its lock and socket while
running; no event files are created. A crash can leave a stale socket, which a
new collector removes only after acquiring the account-local collector lock.

## Explicit hook installation

These commands are implemented and tested against isolated configuration.
They have not been run against this account's actual Codex installation.
Complete the real-session checks in `plan.md` before relying on capture.

Use absolute paths when installing. Substitute the intended account's Codex
configuration directory, a stable compiled observer path, and its collector
socket path:

```sh
python3 -m scope.install install --config-dir /absolute/codex-config --observer /absolute/observer --socket /absolute/runtime/ingest.sock
python3 -m scope.install uninstall --config-dir /absolute/codex-config
```

Installation adds handlers to `hooks.json` without changing inline hooks in
`config.toml`. Codex may warn when both representations exist in one layer;
they remain additive. The installer leaves trust unchanged. Review the exact
entries in Codex `/hooks`. Use a new session for validation; hot-reload behavior
has not been tested.

The installer quotes observer and socket paths, redirects its own handler's
output, and normalizes failures to exit zero. This also covers a removed
observer binary. It never wraps or rewrites another hook's command. Missing
binary behavior within a real Codex session still needs validation.

`codex-scope-owned.json` records exact owned groups. Configuration replacement
is atomic, with a durable ownership journal so interrupted edits can be
recovered by rerunning install or uninstall. Unchanged owned entries are
removed; edited or duplicate entries remain. The installer serializes its own
writers and detects changes made before its final configuration replacement.
Do not edit `hooks.json` concurrently: other editors do not use its lock, and
there is a short comparison-to-replacement interval. Unknown config fields
and unrelated entries survive; JSON formatting is normalized. Symlink files,
duplicate keys, oversized configuration, and directories writable by others
are refused.

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
