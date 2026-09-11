# Electron development

This is an independently runnable, finite synthetic inspector. It opens five
fixtures, lets you select neighboring events, displays the complete original
JSON text, and copies that text. It does not receive collector traffic or use
credentials. The Linux application is not needed.

Search, filters, Live navigation, Clear, SQLite history, and network input are
deferred. Their reserved controls are disabled. The journal pin marks the
selected visible row and has no navigation action. Select a neighboring row to
move through the finite recording. At narrow widths, three rows remain above
the payload. Copy JSON preserves whitespace, unknown fields, and UTF-8 text.

## Clean Linux checkout

Tested with Node 24.21.0, npm 11.19.0, Ubuntu 26.04.1 x64 and Xvfb. The pinned
runtime is Electron 44.3.0, with Playwright 1.63.0 for development tests. Linux
needs Electron's shared libraries, including NSS, ATK, X11, GBM, ALSA and CUPS,
plus Xvfb and xauth for headless execution. Check `ldd node_modules/electron/dist/electron`
for missing libraries after installing the runtime. No Electron packages or
commands are installed in `linux/`.

```bash
cd electron
npm ci
npx install-electron
npx playwright install ffmpeg
```

Electron's installer verifies its downloaded archive against the package's
checksums. On this Ubuntu VM, unprivileged user namespaces are restricted.
Electron consequently requires the supplied sandbox helper to be owned by root
with mode 4755. Configure that helper after each fresh runtime installation on
such a host:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

The app and tests keep sandboxing enabled. Playwright explicitly sets
`chromiumSandbox: true`, overriding its disabled default. GPU acceleration is
left at Electron's default.

```bash
npm run build
xvfb-run -a -s '-screen 0 1600x1000x24' npm test
xvfb-run -a npm start
```

On a Linux desktop with a display, use `npm start` directly. Closing the window
quits the process. There is no captured history on disk to delete in this slice.
The startup fixture is bundled synthetic source, not an offline recording of
missed events. Electron may create ordinary runtime caches; the application
uses an in-memory browser session and never writes payload history.

## Build and validation

`npm run build` creates `dist/app`, a directory runnable with
`node_modules/.bin/electron dist/app`. It contains only application sources,
fixed fixtures and a minimal manifest. There is no development server,
application package dependency, framework, bundler, editor, database or added
worker process. Distribution packaging, signing and updates remain deferred.

`npm test` runs the Node adapter checks and actual Electron integration tests
against `dist/app`, so build first. The tests require only this directory and
the shared protocol fixture. Playwright's FFmpeg download records synthetic
videos in ignored `test-results/`; it is not shipped. Tests cover exact clipboard
bytes, hostile markup, maximum payloads, deep JSON, oversized rejection,
security settings, foreign IPC senders, bounded concurrent operations, all
scrollbar inputs, resize, narrow layouts, errors and recovery. Error simulations
replace native clipboard methods through the test debugger or alter a temporary
copy of the bundled fixture. There are no production test switches or renderer
APIs for injecting data.

Run the reference capture separately after tests:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/reference.mjs
```

Run resource measurements without video capture or other Electron tests running.
Each command writes a separate JSON result under ignored `measurements/`:

```bash
xvfb-run -a -s '-screen 0 1600x1000x24' npm run measure -- baseline
xvfb-run -a -s '-screen 0 1600x1000x24' npm run measure -- inspector
xvfb-run -a -s '-screen 0 1600x1000x24' npm run measure -- capacity
```

See [Linux validation](../docs/electron-validation.md) for measurements, tested
limits, dependency inventory, screenshots and recorded scenarios. Linux
synthetic checks do not establish real Codex compatibility, macOS performance,
energy use, native window lifecycle, sleep behavior or Mac setup.

## Data and process ownership

The main process reads a single bundled version 1 NDJSON fixture. Its adapter
validates byte counts and metadata against the original JSON, drops invalid or
oversized events whole, and retains a bounded array. This is a finite input
adapter, not a live transport implementation. Unknown payload fields survive.

The sandboxed preload exposes `inspect(id, rows)` and `copyPayload(id)`. Main
validates the sender window, top-level frame, exact application URL and request
arguments. There are no credentials, generic filesystem operations, SQL,
clipboard reads, arbitrary clipboard writes, or raw IPC channels in the
renderer API. An allowlist serves four local UI files through `scope://app`.
CSP, permission denial, request filtering and navigation restrictions prevent
remote content, child windows, frames, webviews and downloads.

The renderer requests at most five summaries and one selected payload, with
one inspection in flight and one replaceable next selection. It writes a
single text node, always in the original form. There is no pretty printer,
syntax highlighter or DOM expansion proportional to JSON nesting. The complete
61,440-byte payload remains navigable through native text layout and the custom
scrollbar. Summary labels may end with an ellipsis; the payload and Copy JSON
never do. Long metadata cannot consume the payload pane.

Only one clipboard write may remain pending. A two-second deadline returns a
visible failure; a stalled native operation retains its slot until it settles.
Retrying therefore cannot accumulate native writes. Successful writes use
Electron 44's asynchronous clipboard API in the main process. No permanent
polling, animation, server, formatter or background worker is added.
