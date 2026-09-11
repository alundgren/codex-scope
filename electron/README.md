# Electron development

The viewer runs independently with synthetic data and no collector or
credentials. It opens five seed events in a fresh temporary SQLite recording,
starts in Live, and generates one new synthetic event each second. Selecting a
row holds its neighborhood and payload offset while capture continues. The Live
label resumes following. Clear requires two separate activations within three
seconds and starts an empty recording with a new input connection.

Search, session/hook filters and full journal scrubbing remain disabled. The
journal pin marks the selected visible row. Clicking neighboring rows provides
bounded paging. Copy JSON preserves the original accepted text, whitespace,
unknown fields and UTF-8 bytes. No recording is reopened after an application
restart, and there is no replay or recovery of missed events.

## Clean Linux checkout

Tested with Node 24.21.0, npm 11.19.0, Ubuntu 26.04.1 x64 and Xvfb. Electron
44.3.0 embeds Node 24.20.0 and SQLite 3.53.4. Playwright 1.63.0 is used only for
development validation. Linux needs Electron's shared libraries, including
NSS, ATK, X11, GBM, ALSA and CUPS, plus Xvfb and xauth. Check
`ldd node_modules/electron/dist/electron` for missing libraries after installing.
No Electron commands or dependencies are installed in `linux/`.

```bash
cd electron
npm ci
npx install-electron
npx playwright install ffmpeg
```

The installer verifies the Electron archive against the package checksums. On
hosts that restrict unprivileged user namespaces, configure the supplied
sandbox helper after each fresh runtime installation:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

The app and tests keep sandboxing and GPU acceleration enabled. Playwright
sets `chromiumSandbox: true` explicitly.

```bash
npm run build
xvfb-run -a -s '-screen 0 1600x1000x24' npm test
xvfb-run -a npm start
```

On a desktop with a display, use `npm start`. Use `npm start -- --fixtures-only`
to keep the initial recording finite while exercising inspection. The
`--history-test` switch exposes fault injection only to the Electron main-process
debugger and accepts `--scope-test-root` for an isolated owner directory. It
adds no renderer data injection or filesystem API. These switches are for automated development checks.

## Build and validation

`npm run build` copies local application sources and synthetic fixtures into
`dist/app`, runnable with `node_modules/.bin/electron dist/app`. There is no
runtime package dependency, embedded server, formatter, framework or extra
OS process. One bounded Node worker owns SQLite and ingestion. Tests and
Playwright's FFmpeg binary are excluded from the bundle.

`npm test` runs the adapter checks and actual Electron integration tests after
a build. Tests use isolated private owner directories and synthetic data.
They cover original-byte retention/copy, accepted and oversized payloads,
sandbox/IPC restrictions, custom scrollbar inputs, resize, held arrivals,
queue/rate bounds, real SQLite write/full errors, simulated low disk headroom,
eviction, delayed Clear work, timed keyboard confirmation, cleanup failure,
second instances, hide/minimize, force kill/relaunch and normal close.

Capture the unchanged visual reference separately:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/reference.mjs
```

Run measurements separately from recordings or other Electron tests:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' npm run measure:history
xvfb-run -a -s '-screen 0 1600x1000x24' npm run measure -- baseline
```

Results go under ignored `measurements/`. See [history validation](../docs/electron-history-validation.md)
for budgets, measurements and evidence, and [initial inspector validation](../docs/electron-validation.md)
for the original empty-window comparison. Linux synthetic checks do not
establish real Codex compatibility or macOS performance, energy use, sleep,
native lifecycle or setup.

## Ownership and limits

`history.cjs` is the main-process broker. It caps frame bytes, rate, queue count,
queue bytes and requests before passing work to `history-worker.cjs`. The worker
owns accepted text, metadata, local event order, SQLite statements, bounded
transactions, oldest-row eviction and file cleanup. It returns at most five
summaries and one selected payload. No list of every retained ID or payload
enters either UI thread. The renderer replaces only its latest pending request
and rejects older recording generations.

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
old synthetic input timer, clears pending batches and the view, closes/deletes
the old database, and only then creates a new connection. Late query replies
cannot replace the current view. A failed deletion leaves the previous files
isolated and inaccessible to inspection. Hiding or minimizing keeps capture
running and suppresses presentation updates. Status messages allow only one unacknowledged notification per recipient; background throttling stays on.

The sandboxed preload exposes only status subscription, bounded inspection,
copying and Clear. Main validates the window, top-level frame, exact local URL
and request arguments. There is no generic SQL/filesystem/clipboard access,
credential exposure or remote content. One original payload text node remains
complete and navigable, without pretty-print expansion. One clipboard write may
remain pending; its two-second timeout does not release the native-write slot
until the operation settles.
