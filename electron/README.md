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

Tested with Node 24.21.0, Bun 1.3.14, Ubuntu 26.04.1 x64 and Xvfb. Electron
44.3.0 embeds Node 24.20.0 and SQLite 3.53.4. Playwright 1.63.0 is used only for
development validation. Linux needs Electron's shared libraries, including
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
The output in `dist/app` runs through `vp run start`. The application has no runtime package dependency, embedded server, formatter, framework or extra
OS process. Electron keeps its embedded Node.js and Chromium runtime, including `node:sqlite`; Bun manages development dependencies and does not run application code. One bounded Node worker owns SQLite and ingestion. Tests and
Playwright's FFmpeg binary are excluded from the bundle. Main and worker code emit ESM `.mjs`; the sandboxed preload emits `.cjs`. Only compiled app files and synthetic fixtures enter `dist/app`.

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
See [integrated regression validation](../docs/electron-regression-validation.md)
for metric definitions, machine prerequisites, measured variation, limits and
the complete handoff scenario matrix.

The original per-feature `measure:history`, `measure:navigation`,
`measure:transport` and `measure -- baseline` commands remain available for
focused investigation. [Transport validation](../docs/electron-transport-validation.md),
[search and navigation validation](../docs/electron-navigation-validation.md),
[history validation](../docs/electron-history-validation.md) and
[initial inspector validation](../docs/electron-validation.md) retain their
dated results. Linux synthetic checks do not establish real Codex compatibility
or macOS performance, energy use, sleep, native lifecycle or setup.

## Ownership and limits

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
Choice pages have at most 32 values and 128 KiB of text. Filter input allows
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
