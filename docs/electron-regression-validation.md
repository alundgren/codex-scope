# Integrated Electron regression validation

The independent viewer checks run the production `dist/app` in actual Electron
under Linux Xvfb. They use deterministic synthetic fixtures and a bounded fake
collector. The standard suite needs no Linux application, account hook, private
configuration, trust change or proxy. The real collector smoke remains a
separate optional command.

## Reproduce from source

See [Electron prerequisites](../electron/README.md#clean-linux-checkout) for the
pinned runtime, shared libraries and sandbox-helper setup. The test display also
needs `openbox` and `xprop`, normally installed on Ubuntu with
`sudo apt-get install --no-install-recommends openbox x11-utils`. From a fresh source
checkout:

```bash
cd electron
npm ci
npx install-electron
npx playwright install ffmpeg
# Only where restricted user namespaces require the supplied sandbox helper:
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
setsid --wait xvfb-run -a -s '-screen 0 1600x1000x24' npm run validate:visual
setsid --wait xvfb-run -a -s '-screen 0 1600x1000x24' npm run validate:resources
npm run check:resources
npm run check:resources -- --prove-failure
```

The Electron test and resource commands start Openbox on their supplied Xvfb
display using a temporary explicit configuration. They refuse to replace an
existing window manager, wait for its X11 readiness marker, and terminate only
the manager they spawned. The external window manager is excluded from app
resource totals and is never shipped. Run these commands on an unused Xvfb
display.

Run the visual and resource commands sequentially with no other Electron test,
recording or measurement workload. Both commands rebuild `dist/app`. The visual
command runs unit checks and the existing Playwright Electron suite, captures
the unchanged mockup, and writes `validation/visual/manifest.json` plus named
screenshots and recordings. It also retains the Playwright JSON report. A test
failure exits nonzero and keeps available artifacts. An automated pass requires
human inspection of the recordings before it establishes visual acceptance.

The resource command runs three fresh empty-window/app trials. To reproduce a
single trial, append `-- --runs=1`. It writes
`measurements/regression/report.json`; `report.partial.json` records the active
phase and completed phases even when execution fails. `--calibrate` records
measurements without accepting the performance thresholds. Fixed application
bounds and correctness assertions remain enforced. Calibration is for reviewing
new evidence, not for silently updating the checked-in thresholds.

`check:resources` reevaluates an existing report and exits nonzero for missing
phases, unavailable required memory measurements or exceeded thresholds.
`--prove-failure` changes one reported RSS measurement in memory to one byte over
the ceiling and verifies rejection. It does not rewrite the report or allocate
excess memory. The synthetic workload separately proves real input dropping,
lease release and recovery under burst and stalled-consumer conditions.

All cleanup targets only the launched app, its fake server and its private
`mkdtemp` owner root. It never scans for or kills other worktrees' processes.
Signal interruption writes a partial report with the signal and exits with its
signal status. The earlier feature measurement exits of 143 remain unexplained;
they are not evidence of a particular process cleanup failure.

Linux PSS access can be restricted for sandboxed children. The existing sampler
first reads `/proc` directly, then tries `sudo -n` for a Python reader that reads
only aggregate `smaps_rollup` counters. It never reads process memory contents.
If that reader is unavailable, RSS still appears, PSS is null and the complete
resource check fails explicitly. The app remains sandboxed. Configure this
measurement capability on the validation machine or report PSS as blocked.

For configured collector mode, use the private placeholder configuration in
[Electron development](../electron/README.md#collector-connection). To run the
landed collector with isolated synthetic ingestion:

```bash
setsid --wait xvfb-run -a -s '-screen 0 1600x1000x24' npm run test:collector
```

That optional command needs Python and the independent Linux collector files.
It is outside both standard validation commands and never imports Linux code.

## Measurement definitions

The report records OS/kernel, CPU model/count, installed RAM, available RAM,
host Node/npm, embedded Electron/Node/Chromium/V8/SQLite, GPU configuration,
application bytes and runtime bytes. The empty window and app use equal content
size, sandboxing, context isolation and background throttling. Filesystem caches
stay warm. These are fresh processes, not cold-machine startup tests.

| Metric | Definition |
| --- | --- |
| Summed RSS | Resident pages from `/proc` for the Electron process group and all descendants, sampled with 250 ms waits plus reader overhead. Shared pages are counted more than once. |
| Steady RSS | Median RSS in the final third of a phase's samples. |
| PSS | One aggregate endpoint snapshot that apportions shared pages, never a peak. |
| CPU | User and system ticks divided by actual monotonic sample duration. 100% means one full core. Reported by process role as well as app total. Children created and exited between samples may be missed. |
| Startup | Driver launch through ready app, Connected for configured input, and two completed animation frames. |
| Visible result latency | Input start through completed journal update, matching selected row/payload/slider, successful result and following animation frame. Search includes its 180 ms debounce. Empty results require no selected row. |
| Timer delay | Maximum extra delay beyond a 20 ms diagnostic timer in main and renderer. The timers run only in active measured phases, not idle or hidden phases. |
| Disk | Worker maximum of every recording file, including owner marker and rollback journal during transactions. An independent phase-end directory count corroborates it. SQLite uses in-memory temporary work under its heap cap. |
| Pending work | Main broker's current/peak queue count, bytes and requests; transport frame/chunk maximum, one processing slot and request/retry state. Worker threads remain included in their owning process's memory/CPU. |
| Drops | Viewer storage/rate/queue totals, transport rate disconnections and fake-server refusals are separate. Counters reset with Clear/restart. Unobserved losses remain unknown; offered minus retained is not called a known-drop count. |

Xvfb, Openbox, Playwright, the Node driver, the fake server and aggregate-memory reader
are excluded from app totals. Recording never runs during measurement. No heap
number is presented as total application memory.

The combined workload starts empty, seeds the five fixtures, reads a maximum
payload at a nonzero offset during 120 arrivals, grows through 1,000 inputs to
the 10,000-row limit and navigates at both sizes. It combines rapid filters and
pointer moves with capture, then feeds three 300-event maximum-payload cycles.
Each maximum payload is 61,440 accepted bytes. Small inputs contain full session
IDs, literal regex punctuation and alternating matches. Remote timestamps are
fixed and reverse with generated indexes, so local order is tested separately.
The report records each phase's offered count, pacing, elapsed duration,
written frame bytes and server refusals rather than claiming the nominal rate
was achieved exactly.

Later phases measure hidden/minimized capture with a DOM mutation observer and a native `isMinimized()` check,
100 ms storage delay, a 2,000-event immediate burst, a 6,500 ms stalled event,
real SQLite read-only and full errors, simulated low free space, recovery,
settled idle, failed cleanup and fresh restart. Phase completion uses a debugger-only request for the worker's current processing
slot and response buffer, together with main queue/request counts. Coalesced UI
status can be stale while a chunk is still processing and is not a completion
signal. The delayed phase also requires all sixty events accepted and at least
six seconds elapsed before removing the 100 ms per-event fault. Diagnostic
requests add bounded work to the measured process. No fault installs a growing
work queue. The stall verifies that heartbeat renewal stops; the burst verifies
refusal or rate disconnection. Restart and normal close check owned files.

## Scenario coverage

Every row in the [handoff acceptance table](mockups/event-journal-v2-notes.md)
has a check in the existing suite. All recordings below come from the changed
actual app with synthetic data. Reference files are explicitly named reference.

| Handoff scenario | Automated check and recording |
| --- | --- |
| Start with fixtures | `inspector.spec.mjs`, inspector walkthrough; title, single view title, control set, neutral Live and no event numbers/subheadings. |
| Scrub in both directions | `navigation.spec.mjs`, scrubber walkthrough; pointer, emulated touch, wheel, rows, all arrows, Page keys, Home and End. |
| Select newest versus Live | Navigation scrubber walkthrough; newest remains held until the separate Live endpoint. |
| Receive while inspecting | History, filters and transport walkthroughs; selected ID, neighboring rows, original maximum text and nonzero offset persist; only matching arrivals count. Resource heldCapture and hidden/minimized phases repeat these bounds. |
| Filter rapidly during delayed queries | Navigation queries and late-target walkthroughs; obsolete filters, payloads and counts do not replace current results. Resource captureAndRapidInput combines capture and rapid inputs. |
| Session and several hooks | Navigation filters and narrow walkthroughs; full-ID collisions, paged long identifiers, multiple hooks, no matches and Reset. |
| Long/hostile accepted text | Inspector walkthrough, long metadata and oversized recordings; markup stays text, complete 61,440 bytes and unknown fields survive copy, 4,000-level JSON is not recursively formatted. |
| Every payload scroll input | Inspector walkthrough; custom thumb/track, wheel, emulated touch, keys, resize and hidden native scrollbar. Desktop and narrow screenshots share the selected patch with the reference. |
| Unlock Clear once | History walkthrough; monotonic expiry, Escape, hiding and reduced motion relock without deletion. |
| Confirm Clear | History walkthrough; two separate activations, expired reactivation, held keyboard-repeat rejection and in-flight/empty disabling. |
| Clear during pending work | History late-work, navigation queries and transport walkthroughs; stale generation input, rows, payloads and counts cannot repopulate cleared history. |
| Connection loss and restoration | Transport, authentication, conflict and stalled walkthroughs; held reading survives reconnect, known totals remain separate from unknown gaps, counter reset is replacement, no replay. |
| Evict, time out or fill storage | History, narrow, scrubber, failed-navigation and late-target walkthroughs; clear notices, retained selection identity, responsive recovery and bounded queries. Resource phases add repeated eviction, full/read-only/headroom errors and fixed queue limits. |
| Close, hide, minimize, crash | Lifecycle, crash-recovery, cleanup-failure/recovery and worker-exit/restart recordings; private ownership, second instance, unrelated-file preservation, ordinary deletion and abandoned-recording removal. Linux only. |

macOS native visuals, real touch/trackpad hardware, sleep, occlusion, native
clipboard, energy and resource behavior remain unverified. Signing and updates,
real Codex sessions, cross-account capture and private proxy operation remain
later refinement. Synthetic Linux acceptance does not establish those claims.

## Runtime and application inventory

The build copies 14 application source files, one synthetic fixture file and a
small package manifest. Every copied source file has an active role: main/IPC,
preload isolation, HTTP connection/transport/framing, original-text admission,
SQLite ownership, search, renderer/filter/scrollbar behavior and local HTML/CSS.
The fixture file is needed for independent synthetic mode. Build scripts,
Playwright, FFmpeg, screenshots, recordings and reports stay outside `dist/app`.
No remote font, icon library, formatter, framework, embedded server or runtime
package dependency is added.

The Electron runtime supplies main, renderer, GPU, utility, zygote and sandbox
helper processes. Main owns one bounded worker thread for SQLite, parsing,
search and transport; its cost is included in main's RSS/PSS/CPU. The fake
collector lives in the external validation driver. The report includes the
complete development dependency tree and separates the stock runtime archive
contents from application bytes. No signed distribution or installer is claimed.

The app now disables its unused default menu before ready, and the empty
baseline does the same. This avoids constructing an unused startup menu. There
is no new presentation timer or polling in the application. Existing status
updates coalesce and stop at hidden/minimized windows; the combined check
asserts zero DOM mutations while accepted counts continue increasing.

Current primary guidance was checked for
[Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance),
[process memory](https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo),
[process metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
and [page visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility).
It supports measuring every process, avoiding unnecessary startup work,
keeping blocking work away from UI threads and pausing hidden presentation.
The Linux PSS definition and measurements here must not be applied to macOS
compressed memory or energy use.


The first combined attempt under bare Xvfb caught a gap in earlier validation:
`minimize()` left `isMinimized()` false and emitted no minimize event. Openbox
provides the missing window-manager operation. Under this Linux automation,
Electron can report `isMinimized()` true while the page visibility API still
says visible. The app's main-process window-state checks suppress presentation
in that case; the regression check observes actual DOM mutations and capture
counts. This does not establish macOS occlusion or energy behavior.

On the validation VM, an unrelated `apt upgrade` already held the package-manager
lock. It was left untouched. The following unprivileged package extraction
provided Openbox 3.6.1 and x11-utils 7.7 without changing the system installation.
This is an alternative prerequisite setup, not an application dependency:

```bash
desktop_tools="$(mktemp -d)"
(
  cd "$desktop_tools"
  apt-get download openbox x11-utils libobrender32 libobt2 \
    libstartup-notification0 libxcb-util1 libpangoxft-1.0-0 libxft2 libimlib2t64
  for archive in ./*.deb; do dpkg-deb -x "$archive" extracted; done
)
mkdir "$desktop_tools/bin"
cat > "$desktop_tools/bin/openbox" <<'SH'
#!/bin/sh
desktop_tools="$(dirname "$(dirname "$(realpath "$0")")")"
export LD_LIBRARY_PATH="$desktop_tools/extracted/usr/lib/x86_64-linux-gnu"
export XDG_DATA_DIRS="$desktop_tools/extracted/usr/share:/usr/share"
exec "$desktop_tools/extracted/usr/bin/openbox" "$@"
SH
chmod +x "$desktop_tools/bin/openbox"
ln -s ../extracted/usr/bin/xprop "$desktop_tools/bin/xprop"
export PATH="$desktop_tools/bin:$PATH"
```

The wrapper changes library/data lookup only for Openbox, not Electron. On
another distribution or architecture, prefer its normal package installation
and use `ldd` to resolve its own prerequisites. Remove the temporary tools
directory after all validation commands finish; each command separately removes
its temporary window-manager configuration and terminates its own manager.
