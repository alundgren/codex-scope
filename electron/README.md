# Electron development

The viewer opens idle with capture stopped. Functions provides searchable navigation to the event journal, session analyzer, PR review entry and Settings. PR review opens one pinned GitHub PR in the full-window notebook. Source and supplied PNG evidence remain temporary. Feedback prepares editable author and agent handoffs in the same review thread, supports manual editing after failure, and supports explicit previewed top-level PR comments through local gh. See [PR review](../docs/pr-review.md) for retrieval, omissions and bounds. Start capture opens the collector's version 1 live stream after connection settings are valid. Stop capture closes input work and keeps retained events and active analysis available. Tool navigation preserves each task's state. It also runs
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
prerequisites with `sudo apt-get install --no-install-recommends xvfb xauth openbox x11-utils`. Check
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

On a desktop with a display, use `vp run start`. Normal startup opens no stream, generates no events and starts no analysis. `vp run start --synthetic` selects it explicitly. Use `vp run start --fixtures-only`
to keep the initial recording finite while exercising inspection. The
`--history-test` switch exposes fault injection only to the Electron main-process
debugger and accepts `--scope-test-root` for an isolated owner directory. It
adds no renderer data injection or filesystem API. These switches are for automated development checks.

`vp run measure:capture` measures idle launch, sustained input, a burst, Stop and quit without video or screenshots under the documented Xvfb desktop. It samples all app process-group members and descendants and verifies that stopped capture opens no new requests.

## Collector connection

On macOS, the native application and Edit menus provide standard editing shortcuts,
including Cmd+V for pairing links. The app uses Electron's built-in
[menu roles](https://www.electronjs.org/docs/latest/tutorial/menus) so editing
commands act on the focused control without renderer clipboard access.

Use Settings to enter an HTTPS collector origin and token. A Linux pairing URL such as `https://host:port/?token=secret` fills both fields. The URL field discards the query after extraction; the token field stays masked and clears after save. Duplicate or unknown query parameters, empty tokens and malformed links are rejected.

Connection and model settings write one app-owned `preferences.json` under the application user data directory. The document contains the origin, token and separate diagnosis/review model and effort choices, is limited to 4096 bytes, and is replaced atomically with mode `0600`. One private temporary file of at most 4096 bytes is reused after interrupted saves. Only one settings save may run at a time. A save that exceeds the 2500 ms reply deadline remains owned until the worker finishes; Settings shows it as pending and prevents retries from overlapping the private temporary file. Completion updates the form with the actual success or failure. Stop capture remains available while a save is pending. Failed validation or saving leaves the previous settings and capture state intact. Saving successfully stops capture and retains history; Start capture is explicit. Saved tokens never return through read IPC or logs. The renderer only holds a token supplied by the user until saving.

For external configuration import, create a private JSON file outside Git with two fields:

```json
{ "endpoint": "https://collector.example.net", "tokenFile": "/absolute/private/viewer.token" }
```

The configuration and token must be regular files owned by the current account,
readable only by that account. Use mode `0600`; symlinks are rejected. The config
is limited to 4096 bytes and the token to 256 ASCII bearer characters plus a
terminal newline. Imported token values never enter a command line or renderer.
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
Scope never writes imported configuration or token files. A command-line file overrides the saved connection at launch. Settings explains this override; saving applies the replacement for the current launch, while the command-line file wins again on the next launch. Model and effort selection stays in Settings and never starts a turn on its own. Both pairs begin empty. Legacy settings retain the connection but discard the old prefilled model because they did not record an explicit choice. Save settings persists new explicit choices, including when no collector connection is configured.

Authentication, version, endpoint and certificate failures stop retrying. Correct the connection in Settings, save and Start capture to recover. Transient failures use one
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
The output in `dist/app` runs through `vp run start`. The application has no runtime package dependency, embedded server, formatter or framework. Explicit session analysis or PR review starts one bounded Codex CLI process group. They do not run concurrently. Electron keeps its embedded Node.js and Chromium runtime, including `node:sqlite`; Bun manages development dependencies and does not run application code. One bounded Node worker owns SQLite and ingestion. Tests and
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

## Local model catalog

Open a model picker or choose Refresh models in Settings to ask the installed `codex app-server` for its catalog. Scope sends `initialize`, `initialized` and cursor-paged `model/list` requests with `includeHidden: true`, then ends the discovery process. It never starts a thread or turn for discovery. Hidden models stay visible and selectable. The CLI's default model and effort are ignored. A returned model does not prove account access; execution errors remain explicit. Empty catalogs, stale choices, unsupported efforts and incomplete reads keep input intact and offer refresh or reselection.

Diagnosis and handoff preparation reread the catalog immediately before restricted `codex exec --ephemeral` execution. Both use the explicitly selected model and effort recorded on that analysis run. Model discovery cannot enable tools or project access. PR review validates the saved selection against the catalog before starting its temporary review thread.

One discovery can run at a time, without a queue. Navigation away from Settings, Cancel discovery and app shutdown cancel its process group. Discovery and analysis do not run CLI processes concurrently. The catalog is held only in memory and is never recovered after closing Scope. A private `catalog/work` directory holds temporary files and logs only while discovery runs, with an ownership marker preventing reuse while an earlier process remains alive. Codex keeps ownership of its existing authentication, configuration and SQLite state. Scope does not copy that state, change its location, read its contents or include its existing disk footprint in the app temporary-storage budget. Initialization may maintain that CLI-owned state through normal CLI behavior; Scope sends no thread, conversation or configuration-write requests.

| Catalog resource              | Limit and behavior                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Duration                      | 5 seconds from process launch; cancellation kills the process group                                                       |
| Output                        | 512 KiB stdout, 32 KiB discarded stderr, checked before buffering                                                         |
| Pagination                    | 16 pages of requested size 32, at most 256 models, repeated cursors fail incomplete                                       |
| Fields                        | Model identifiers 128 characters, 32 efforts per model, effort 64 characters, cursor 1,024 bytes                          |
| Process and temporary storage | Existing CLI limits: 8 processes, 512 MiB summed RSS, 30 seconds CPU, 16 MiB / 64 temporary entries; sampled every 500 ms |

Limits accommodate measured installed-CLI catalog reads and the bounded maximum-catalog fixture. The catalog process retains the inherited CPU limit and disables core dumps. Its private temporary directory is sampled, but the analysis executor's per-file size limit is not imposed on the CLI's existing SQLite files. Exceeding any limit marks the result incomplete and permits explicit retry. Raw child output never appears in logs or IPC errors.

After building, run `xvfb-run -a -s '-screen 0 1600x1000x24' vp exec node scripts/desktop.ts vp exec node scripts/measure-catalog.ts` from `electron` without concurrent tests or recording. Add `--real` for installed-CLI discovery with existing authentication and no model turn. The fixture run measures maximum catalogs, output/page pressure, cancellation and recovery. Reports include all app processes and descendants, temporary bytes, frame delay and quit time under ignored `measurements/`. Linux measurements do not establish macOS behavior.

## PR notebook validation

`vp exec node scripts/measure-review.ts` measures the large-PR working set, on-demand source reads, maximum accepted PNG evidence, cancellation, output pressure and recovery without recording. Run inside the documented fresh Xvfb/Openbox desktop after building. `test/review.spec.ts` records the notebook interaction and failure/recovery walkthrough. The [PR review guide](../docs/pr-review.md) maintains the evidence limits.

Temporary PR conversation checks use `vp test run test/review-session.test.ts test/review-tools.test.ts` and the sandboxed `test/review-conversation.spec.ts` desktop walkthrough. Resource reproduction is separate from visual execution:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' vp exec node scripts/desktop.ts vp exec node scripts/measure-review-session.ts
```

This exercises 110 fixture turns, twenty-entry presentation, concurrent capture, diagnosis busy handling, a bounded large source result, conversation capacity and quit cleanup. Reports stay under ignored `measurements/`. `scripts/measure-review-live.ts` is an explicit, optional live check that uses installed Codex authentication, `gpt-6-astra` with low effort and public repository source. It starts real model turns and measures their whole-app cost, so it is excluded from routine tests. Neither command proves macOS performance or native lifecycle behavior.

Review prompt editing uses a separate private `review-prompts.json` with only
explicit overrides. Its 128 KiB document and one 128 KiB atomic temporary file
are separate from the 4 KiB connection/model document. Prompt saves preserve
capture and other settings. See [review prompt behavior and limits](../docs/pr-review.md#review-prompts).
