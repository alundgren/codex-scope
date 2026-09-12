# Electron development

The viewer accepts the collector's version 1 live stream. It also runs
independently with synthetic data and no collector or credentials. In synthetic
mode, it opens five seed events in a fresh temporary SQLite recording,
starts in Live, and generates one new synthetic event each second. Selecting a
row holds its neighborhood and payload offset while capture continues. The Live
label resumes following. Clear requires two separate activations within three
seconds and starts an empty recording with a new input connection.

Search matches literal text, ignoring case, across full accepted payloads and
metadata. The session dropdown uses complete IDs; hook choices allow several
selections. Both controls page their choices without retaining the full list.
The vertical slider provides one logical stop per match and a separate Live
endpoint. Pointer, touch, wheel, arrows, Page keys, Home and End navigate history.
Arrivals preserve held rows, payload and scroll offset, and count only matches.
A gesture freezes its matching count and retained upper bound until release.
Eviction ends an unusable gesture with an explanation. Copy JSON preserves the original accepted text, whitespace,
unknown fields and UTF-8 bytes. No recording is reopened after an application
restart, and there is no replay or recovery of missed events.

## Clean Linux checkout

Commands below use the pinned workspace `vp` command from `node_modules/.bin`. Add that directory to your development shell PATH, or invoke it by its relative path.

Runtime and development versions are pinned in `.node-version`,
`rust-toolchain.toml`, the package manifests and `bun.lock` at the repository
root. Playwright is used only for development validation. Linux needs Electron's shared libraries, including
NSS, ATK, X11, GBM, ALSA and CUPS, plus Xvfb and xauth. The combined
validation and Electron test commands also need Openbox and `xprop` from
`x11-utils` to test actual minimization. On Ubuntu, install those development
prerequisites with `sudo apt-get install --no-install-recommends openbox x11-utils`. Check
`ldd "$(node -p 'require("electron")')"` for missing libraries after installing.
No Electron commands or dependencies are installed in `linux/`.

```bash
bun install --frozen-lockfile
cd electron
../node_modules/.bin/vp run setup
```

The installer verifies the Electron archive against the package checksums. On
hosts that restrict unprivileged user namespaces, configure the supplied
sandbox helper after each fresh runtime installation:

```bash
electron_sandbox="$(node -p 'require("node:path").join(require("node:path").dirname(require("electron")), "chrome-sandbox")')"
sudo chown root:root "$electron_sandbox"
sudo chmod 4755 "$electron_sandbox"
```

The app and tests keep sandboxing and GPU acceleration enabled. Playwright
sets `chromiumSandbox: true` explicitly.

```bash
vp run build
xvfb-run -a -s '-screen 0 1600x1000x24' vp run test
xvfb-run -a vp run start
```

On a desktop with a display, use `vp run start`. With no connection settings,
startup uses synthetic mode. `vp run start --synthetic` selects it explicitly. Use `vp run start --fixtures-only`
to keep the initial recording finite while exercising inspection. The
`--history-test` switch exposes fault injection only to the Electron main-process
debugger and accepts `--scope-test-root` for an isolated owner directory. It
adds no renderer data injection or filesystem API. These switches are for automated development checks.

## Collector connection

Create a private JSON configuration outside Git with two fields:

```json
{ "endpoint": "https://collector.example.net", "tokenFile": "/absolute/private/viewer.token" }
```

The configuration and token must be regular files owned by the current account,
readable only by that account. Use mode `0600`; symlinks are rejected. The config
is limited to 4096 bytes and the token to 256 ASCII bearer characters plus a
terminal newline. The token value never enters a command line or renderer.
The default configuration is `connection.json` in Electron's application user
data directory, separate from temporary recordings. To use another private file:

```bash
vp run start --connection-config=/absolute/private/connection.json
```

The endpoint is an origin only, optionally followed by `/`. Credentials, paths,
queries, fragments, redirects and invalid TLS certificates are rejected. Only
literal loopback IPs may use HTTP for same-host testing. `localhost` is not a
plaintext exception because its name resolution is external to the URL.
The repository ignores `electron/connection.local.json` and `electron/token.local`
for local development, but app settings should normally remain outside the clone.
Restart after editing settings or token files. Authentication, version, endpoint
and certificate failures stop retrying until restart. Transient failures use one
retry timer with backoff from 500 ms to 8 seconds. Existing history remains
available, and a held selection stays in place through reconnect.

The status area reports the latest collector process-lifetime totals and their
reasons. It replaces those totals on each health message and clears them until
a new connection supplies its first report. Local storage drops remain separate.
Coverage before connection and across every gap is unknown; no missing event
can be recovered. Clear stops the old stream and heartbeat, invalidates delayed
work and starts a new recording and connection only after successful cleanup.

## Build and validation

`vp run build` compiles TypeScript with Vite+ Pack and bundles the renderer with Vite+.
The output in `dist/app` runs through `vp run start`. The application has no runtime package dependency, embedded server, formatter or framework. Explicit session analysis starts one bounded transient Codex CLI process group. Electron keeps its embedded Node.js and Chromium runtime, including `node:sqlite`; Bun manages development dependencies and does not run application code. One bounded Node worker owns SQLite and ingestion. Tests and
Playwright's FFmpeg binary are excluded from the bundle. Production bundles are minified. Main and worker code emit ESM `.mjs`; the sandboxed preload emits `.cjs`. Only compiled app files and synthetic fixtures enter `dist/app`.

`vp run check` runs Vite+ formatting, lint, and strict TypeScript checks. `vp run dev` builds and starts Electron with synthetic data; rerun it after edits. Unit tests run through Vite+ Vitest on Node, and desktop scenarios use Playwright with actual Electron.

`vp run test` runs unit and fake-server transport checks, builds the production bundle, and runs actual Electron integration tests. Tests use isolated private owner directories and synthetic data.
Search tests also cover literal punctuation, matches outside previews, full-ID
collisions, several hooks, cancellation during SQLite execution, timed queries,
stale filter/target replies, paging choices and gesture eviction.
Transport tests cover each byte split, bytewise UTF-8, strict hello/field limits,
original bytes, invalid TLS, status failures, heartbeat deadlines, stalled
processing, bounded retries, collector restarts and delayed Clear. OpenSSL is a
development test prerequisite for the generated self-signed certificate check.
They also cover original-byte retention/copy, accepted and oversized payloads,
sandbox/IPC restrictions, custom scrollbar inputs, resize, held arrivals,
queue/rate bounds, real SQLite write/full errors, simulated low disk headroom,
eviction, delayed Clear work, timed keyboard confirmation, cleanup failure,
second instances, hide/minimize, force kill/relaunch and normal close.

The real collector check is a separate command and is never part of `vp run test`.
It needs this clone's Rust collector binary built from the repository root with `cargo build --manifest-path linux/Cargo.toml --bins`, starts isolated
loopback configuration, sends one synthetic datagram and removes the temporary
files. It does not install hooks, change trust or configure a proxy:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' vp run test:collector
```

Run the complete visual workflow, including the unchanged reference and an artifact manifest:

```bash
setsid --wait xvfb-run -a -s '-screen 0 1600x1000x24' vp run validate:visual
```

Run the integrated resource workflow separately from recordings or other Electron tests:

```bash
setsid --wait xvfb-run -a -s '-screen 0 1600x1000x24' vp run validate:resources
vp run check:resources
vp run check:resources --prove-failure
```

The resource command builds the app and runs three empty-window/app trials,
including bounded capture, search, repeated eviction, hidden/minimized capture,
bursts, stalled storage and failure/recovery. Append `--runs=1` for a single
trial. Reports go under ignored `measurements/regression/`. Missing required
metrics or exceeded checked-in thresholds return failure. Visual artifacts go
under ignored `../.artifacts/visual/electron-report/`; inspect the screenshots and recordings.
The acceptance scenarios are described in the [UI reference](../docs/mockups/event-journal-v2-notes.md#electron-build-handoff)
and implemented in `test/`. Publish run summaries in the PR and attach evidence
there using GitHub attachments only. Keep generated output out of Git.

The focused `measure:history`, `measure:navigation`, `measure:transport` and
`measure -- baseline` commands are available for investigations. Linux synthetic
checks do not establish real Codex compatibility or macOS performance, energy
use, sleep, native lifecycle or setup.

## Resource metrics

Run resource trials independently of screenshots, video and other app workloads.
The workflow compares fresh app and empty-window processes with equal window
size, sandboxing and background throttling. Filesystem caches remain warm, so
startup measures process launch rather than cold-machine startup. Reports include
the workload, runtime versions and machine configuration needed to assess results.

| Metric        | Definition                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summed RSS    | All Electron process-group members and descendants, sampled with 250 ms waits plus reader overhead. Shared pages count more than once. Worker threads are included in their owning process. |
| Steady RSS    | Median RSS in the final third of a workload's samples.                                                                                                                                      |
| PSS           | Aggregate endpoint snapshot that apportions shared pages. It is not a peak measurement.                                                                                                     |
| CPU           | User and system ticks divided by actual monotonic sample duration. 100% means one full core. Sampling can miss short-lived processes and peaks.                                             |
| Startup       | Driver launch through readiness, connection readiness for configured input, and two completed animation frames.                                                                             |
| Input latency | Input start through completed selection, matching payload and slider, and the following animation frame. Search includes the 180 ms debounce.                                               |
| Timer delay   | Maximum extra delay beyond a 20 ms diagnostic timer in main and renderer during active workloads.                                                                                           |
| Disk          | Worker maximum across all recording files inside transactions, including rollback journal and owner marker, corroborated by an endpoint directory scan.                                     |
| Pending work  | Broker queue count/bytes and requests, transport buffers, and the single processing operation.                                                                                              |
| Drops         | Storage/rate/queue counters, transport rate disconnects and fake-server refusals remain separate. Unobserved losses remain unknown.                                                         |

Xvfb, Openbox, the driver, fake collector and metric reader are excluded from app
totals. Native Linux `/proc` access is required for resource measurements.
The checked ceilings and required workloads are maintained in
[`scripts/resource-thresholds.ts`](scripts/resource-thresholds.ts). They are
regression checks, not portable performance guarantees. Recalibration requires
new measurements and review in the PR; `--calibrate` collects results without
accepting the ceilings and does not rewrite them. Missing metrics, incomplete
workloads and exceeded ceilings fail `check:resources`.

## Ownership and limits

| Resource            | Limit and behavior                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted data       | 61,440 payload bytes and 393,216 encoded frame bytes. Oversized events are dropped whole.                                                                                  |
| Synthetic intake    | 32 queued frames / 1 MiB, batches of four frames / 512 KiB, 256 events/s and 2 MiB/s with 32-event / 512 KiB burst credit.                                                 |
| Worker requests     | Four outstanding requests, with one slot reserved for Clear/close. Timeouts retain their slot until reply or worker exit.                                                  |
| Presentation        | Five summaries, one selected payload, one unacknowledged status per recipient and at most five updates/s; hidden presentation stops.                                       |
| Retention           | 10,000 rows and 8 MiB accounted bytes, including payloads, labels, previews and row overhead. Evict at most 64 rows per input batch; drop input if more cleanup is needed. |
| Disk                | 16 MiB database, 33 MiB total recording files, and 34 MiB free headroom before writes. Account for sidecars and owner files.                                               |
| Memory              | 2 MiB SQLite cache and 8 MiB SQLite heap. Worker V8 old/young heaps are limited to 32/8 MiB with a 4 MiB stack. These are parts of total app memory.                       |
| Deadlines           | 2,500 ms worker requests, 1,500 ms cleanup and 2,750 ms quit. Cleanup scans at most 32 root entries and five files per owned directory.                                    |
| Live transport      | One stream, one heartbeat, one retry timer and one event awaiting storage. Fixed frame buffer and 64 KiB response high-water mark.                                         |
| Transport rates     | 2 MiB/s with 512 KiB burst credit; 512 frames/s with 512-frame burst credit. Excess closes the connection with unknown loss.                                               |
| Transport deadlines | 2,500 ms response/hello and 1,500 ms heartbeat response. Heartbeat every 2,000 ms, stopped after 4,000 ms without processed input or 2,000 ms waiting for storage.         |

The finite seed-file loader in `src/recording.ts` accepts at most 16 events and
256 KiB of original payloads, reading at most 1,966,080 encoded source bytes.
These input limits are separate from retained SQLite history.

`history.ts` is the main-process broker. It caps frame bytes, rate, queue count,
queue bytes and requests before passing work to `history-worker.ts`. The worker
owns the authenticated transport, accepted text, metadata, local event order, SQLite statements, bounded
transactions, oldest-row eviction and file cleanup. It returns at most five
summaries and one selected payload. No list of every retained ID or payload
enters either UI thread. The renderer replaces only its latest pending request
and rejects older recording generations, filter identities and requested targets.
`search.ts` runs literal matching inside SQLite through a JavaScript function,
using the same predicate for accepted-arrival counts. It checks a shared
cancellation value and a 250 ms deadline while SQLite visits rows. Rank queries
scan at most the fixed retained history and return bounded results. There is no
whole-recording ID index or result array. Summary paging uses stable local IDs;
coarse slider positions use a measured, deadline-limited SQL offset.
Session and hook indexes live inside the existing database/page/disk budgets.
Choice pages have at most 32 values and 128 KiB of combined ID/label text.
Session labels use the latest retained nonempty context for the exact full ID.
The context is at most 160 display characters, accounted in retained bytes and
indexed inside the existing disk budget. There is no separate session cache
that grows after events are evicted. Filter input allows
512 search characters, 32 selected hooks and 128 KiB total filter bytes.

The SQLite file has a physical page limit, a small cache, disabled memory
mapping, and TRUNCATE rollback journaling. The disk budget includes a full
rollback journal, and free-space checks reserve headroom. Freed pages are
reused; capture never runs full compaction. Synchronization is disabled because
abandoned recordings are deleted, never recovered. A crash can leave an invalid
database, which startup cleanup removes without opening it. Live write failures
remain errors and drop incoming events.

One Electron instance owns the recording directory. The private `recordings`
directory sits below application user data, separate from settings and browser
state. Each recording has its own private directory and owner marker. Cleanup
recognizes only owned names and expected regular files, never follows symlinks,
never recursively deletes unknown contents, and has a bounded scan and deadline.
Failure stops new recording creation and reports that old files remain. Restart
retries cleanup. Quit has a deadline and emits only a fixed cleanup-error message
if deletion fails. Ordinary deletion is not forensic erasure.

Clear updates a shared generation before old work can start another transaction, stops the
old input stream, heartbeat or synthetic timer, clears pending batches and the view, closes/deletes
the old database, and only then creates a new connection. Late query replies
cannot replace the current view. A failed deletion leaves the previous files
isolated and inaccessible to inspection. Hiding or minimizing keeps capture
running and suppresses presentation updates. Status messages allow only one unacknowledged notification per recipient; background throttling stays on.

The sandboxed preload exposes only status subscription, bounded inspection and
filtered navigation, cancellation, paged filter choices, copying and Clear. Main validates the window, top-level frame, exact local URL
and request arguments. There is no generic SQL/filesystem/clipboard access,
credential exposure or remote content. One original payload text node remains
complete and navigable, without pretty-print expansion. One clipboard write may
remain pending; its two-second timeout does not release the native-write slot
until the operation settles.

The desktop session control allows more room for branch text; the narrow toolbar
continues to wrap below search.

The session dropdown displays the last observed repository and branch with a
short session-ID suffix. The full ID remains the filter value and appears in
the inspector. Optional collector Git metadata takes precedence over a label
derived from `cwd`; T3 worktree paths retain the project and worktree directory
names. Without either source the full session ID remains visible. Labels refresh
when opening the dropdown, without moving the selected event or payload offset.
Metadata is display-only and never changes Copy JSON. An older collector still
works using `cwd` or ID labels. Working-directory fallback is not verified Git
metadata. Git labels can lag behind branch changes as described in the
[collector documentation](../linux/README.md#git-session-labels).

## Session analyzer

Choose **Analyze session** in the viewer to inspect one retained session through
Results, Search trail, Agent routing and Recommendations. Select the analysis
model before running Codex. Switching views reuses the selected run and focused
call. See [session analysis](../docs/session-analysis.md) for CLI requirements,
evidence definitions, resource limits, temporary state and capture limitations.
