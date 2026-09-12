# Electron runtime rationale

The viewer uses local HTML/CSS/TypeScript, Electron's embedded Node runtime,
and built-in SQLite in one bounded worker thread. This document records the
technical rationale and primary-source references for those choices.

- Use a supported stable Electron release and pin the version used for validation. Electron 43 improved startup through snapshots, cached bytecode and less blocking IPC. Electron 44 includes further initialization and IPC improvements. Recheck release notes at implementation time rather than copying an old starter template. Sources: https://www.electronjs.org/blog/electron-43-0 and https://www.electronjs.org/blog/electron-44-0
- Electron 44 adds built-in window-state persistence and changes clipboard APIs to asynchronous operations. Check these APIs before adding packages for the same jobs, and use documentation for the pinned version. Source: https://www.electronjs.org/blog/electron-44-0
- Profile startup, dependency loading and actual interactions. Avoid unnecessary runtime packages, polyfills, startup work and synchronous main-process I/O or IPC. Bundle shipped code; load optional formatting only when needed. Source: https://www.electronjs.org/docs/latest/tutorial/performance
- Keep the existing prototype's plain HTML/CSS/JavaScript approach unless implementation evidence justifies a framework. Avoid an embedded HTTP server, extra renderer windows, UI kits, full editor packages and process-per-task designs without a demonstrated need. These are project recommendations, not blanket Electron requirements.
- A bounded database worker may be justified to keep synchronous SQLite work off the main and renderer threads. Compare built-in node:sqlite with native alternatives using the exact Node version embedded in the chosen Electron release. DatabaseSync executes synchronously; newer Node documentation does not prove availability or stability in Electron's embedded version. Sources: https://nodejs.org/api/sqlite.html and https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- Keep backgroundThrottling enabled and stop presentation work when hidden or minimized. Continue bounded capture outside renderer timers. macOS also reports fully occluded windows as hidden. Source: https://www.electronjs.org/docs/latest/api/browser-window#page-visibility
- Keep sandboxing and context isolation, with Node integration disabled in the renderer. Narrow preload methods and validated IPC preserve security while keeping payload access explicit. Do not disable security boundaries to chase lower overhead. Source: https://www.electronjs.org/docs/latest/tutorial/security
- Measure the complete app process group, including GPU and utility processes, and reconcile measurements with macOS tools. Electron warns that residentSet is unavailable on macOS and private memory is more representative of pre-compression use. Record metric definitions; do not present one renderer heap as total app memory. Sources: https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo and https://www.electronjs.org/docs/latest/api/structures/process-metric
- Playwright supports Electron launch, screenshots and video recording, but its Electron support remains experimental. Prove compatibility with the pinned runtime early. Desktop capture is an acceptable fallback for native dialogs and window behavior. Source: https://playwright.dev/docs/api/class-electron

The owner accepts Linux VM evidence for current delivery. Compare an empty Electron app with the implemented viewer on the same VM. Use a production bundle where possible; packaging is not a new distribution requirement. Record runtime and application bytes separately, cold startup, all-process memory and CPU, and interaction latency with workload and machine details. VM results do not establish Mac memory, energy, GPU, sleep, or native window behavior. Cover idle, sustained arrivals, bursts, maximum accepted payloads, frozen reading, rapid search/scrubbing, hidden/minimized capture, disk cleanup and memory pressure. Establish numeric budgets from these measurements, not this research note. Collect performance runs separately from recorded visual runs so capture overhead does not become app overhead.

Electron documents Xvfb for headless Linux execution. Use the actual app with Playwright Electron automation or equivalent capture to record scenarios and screenshots. Run resource measurements separately from video capture. Source: https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci

The [wire contract](../protocol/README.md) defines HTTP NDJSON version 1 and a
separate heartbeat request. Incremental HTTP response parsing uses Node's
built-in APIs and requires no WebSocket package.

## Temporary history runtime decision

The exact [Node 24.20.0 SQLite documentation](https://github.com/nodejs/node/blob/v24.20.0/doc/api/sqlite.md)
confirms synchronous database calls, the zero-wait busy timeout, and defensive
mode. All recording SQLite access, payload parsing, file accounting and deletion therefore
run in one worker thread. Neither UI thread opens a database.

[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) also provides a
synchronous API and worker support, but adds a native package and platform
binaries without providing a needed capability here. [SQLite WASM persistence](https://sqlite.org/wasm/doc/tip/persistence.md)
adds a WASM runtime and filesystem integration. Built-in SQLite meets the
required temporary-file and bounded-query operations, so neither alternative
is included. This comparison concerns required capabilities, not an unmeasured
performance ranking.

[Electron's performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)
supports moving CPU-heavy work away from the main process thread. One worker
thread adds a bounded V8 heap in the main process, with no extra OS process
for history. Optional [session analysis](session-analysis.md) uses the local
Codex CLI in a separate, bounded process group so the viewer can cancel it and
enforce time, output, memory and temporary-file limits. It starts only on request.
[SQLite's pragma documentation](https://sqlite.org/pragma.html) says journal size
limits apply after commit or checkpoint. The recording therefore budgets a full
rollback journal alongside the capped database, uses TRUNCATE journaling, and
measures the journal before commit. Deleted pages are reused without VACUUM. Synchronization is disabled because a crashed recording is discarded on restart; this accepts loss or corruption of that disposable database after a crash.
No persistent WAL backlog or temporary sort file is needed by nearby queries.
