# Project principles

Codex Scope is a best-effort inspector. Preserve normal Codex behavior first,
keep host and Mac resource use bounded second, and retain events third.
Losing events is acceptable; blocking Codex or exhausting the user's laptop
is not.
Every retained event and pending operation needs a limit on both machines.

- Preserve normal agent behavior before capturing data. Observation must not
  alter decisions, inject context, wrap other hooks, or depend on the viewer
  to finish. Capture failure must remain independent of session success.
- Observe the supplied hook input. The collector may additionally perform
  bounded, read-only Git queries in the hook-supplied working directory to
  identify the repository and branch. Keep this exception explicit in the
  protocol and operating documentation; it must never delay the observer or
  event delivery. Do not collect transcripts, environment variables, remote
  URLs, working-file contents, or the output of other hook commands.
- Keep payloads out of logs and telemetry, and real captures and machine
  configuration out of Git. Recordings must remain private.
- Respect existing configuration and hook trust. Installation must be
  explicit, and removal must preserve unrelated or user-edited entries.
- Treat the Mac viewer as a companion to the user's work. Protect interactive
  responsiveness, memory headroom, CPU availability, and battery life. Prefer
  dropping excess events or evicting old history to growing resource use.
- Bound memory across the whole Electron application, including the main
  process, renderer, workers, database caches, queues, and duplicate payload
  copies. Moving work to another process does not remove its resource cost.
- Memory and pending work must not grow with recording duration or total
  retained event count. Keep only a bounded working set for visible events
  and selected payloads. Navigation, scrubbing, search, and arrival counters
  must not require loading the entire recording into memory.
- Bound CPU work as well as storage. Keep expensive work off the UI thread,
  cancel obsolete work, and coalesce updates during bursts. Avoid continuous
  polling, redraws, or animation when nothing useful has changed. Hidden or
  minimized windows may keep capturing without spending CPU on presentation.
- Filtering or pausing the view must not change capture behavior.
- A frozen history view must stay responsive and preserve the reader's event
  and payload position while capture continues. Visual effects, formatting,
  and update frequency must yield to that requirement.
- Apply limits before accepting or expanding expensive input. Preserve the
  original bytes of accepted payloads, including unknown fields. Drop oversized
  events rather than silently truncating them and presenting them as complete.
  Rendering and copying accepted data must also respect resource limits.
- Disk history is temporary and bounded. Include database sidecars and
  temporary work in the budget. Cleanup and eviction must not cause long UI
  stalls or compete indefinitely with capture. When cleanup cannot keep up,
  drop incoming data and explain the limitation.
- No offline recording, delivery retries, or recovery of missed events,
  including in future releases. Reconnection must not create a replay backlog.
  Distinguish known drops from gaps whose loss count is unknown. Never imply
  complete coverage or that missing history can be recovered.
- State what validation actually proves. Synthetic checks do not establish
  real-session compatibility, and Linux checks do not establish Mac behavior.
- Choose numeric limits from measurements, not guesses or the size of demo
  fixtures. Validate idle use, sustained capture, bursts, large accepted
  payloads, rapid search and scrubbing, and resource pressure. Report
  total app memory, CPU, responsiveness, and failure behavior with the tested
  workload. Linux VM evidence is sufficient for current development acceptance,
  including actual Electron visual runs under a virtual display. Browser-only
  checks do not replace Electron integration checks. Keep untested macOS
  performance, energy use, and native lifecycle behavior explicitly unverified;
  Linux results do not establish those claims.
- Do not add UX subheadings unless the repository owner explicitly requests
  them. This applies to screens, dialogs, mockups, and user-facing explanatory
  copy. Do not imitate a subheading with styled text to bypass the rule. A
  single view title and necessary control labels are allowed. Follow `ux.md`
  for the selected experience; convenience or a generic design convention is
  not permission to add subheadings.
- After every UX change, run the changed app and inspect it visually with
  Playwright or an equivalent browser or desktop automation tool. Record a
  walkthrough of all important scenarios agreed in the issue, plan, or
  handoff, including relevant failure and recovery states. Inspect the
  recording and screenshots yourself, fix discrepancies, and rerun affected
  scenarios before reporting completion. Automated assertions alone are not
  visual verification.
- Include screenshots in the PR description and link the recorded walkthrough
  with the scenarios covered and the tested environment. When an issue supplies
  a mockup or another visual guide, include labeled side-by-side images of the
  reference and implementation at matching states and comparable window sizes.
  Explain any agreed differences. Evidence must come from the actual changed
  app. If visual execution or recording is blocked, report the blocker and
  incomplete scenarios explicitly; do not claim the UX change is verified.
- Visual verification remains required, including for CLI interaction changes.
  Generate visual evidence under ignored `.artifacts/visual/` and other run
  output under ignored local directories. All attached evidence belongs only
  in GitHub attachments associated with the relevant PR, never in Git files,
  Git blob links, or another hosting service. Put validation summaries, tested
  commits, environments, scenarios, and limitations in the PR. If upload is
  blocked, report the blocker rather than committing evidence as a fallback.
- Keep repository documentation about current behavior, architecture, operating
  instructions, and maintained resource limits. Do not commit development
  journals, completion reports, review narratives, dated validation results,
  command receipts, or generated evidence in any format. Reproduction scripts,
  synthetic fixtures, metric definitions, maintained thresholds, and authored
  design references belong in Git. Review prose for historical run results as
  well as checking the staged file paths with `node scripts/check-evidence.mjs`,
  also run by `vp run check`. Stage intended evidence removals before this check;
  deleting a working copy alone does not remove it from the commit.
- Keep Electron overhead minimal. Justify added runtime dependencies and
  processes with a concrete need and measured cost. Prefer built-in platform
  capabilities, load optional work on demand, and exclude development tools
  and unused assets from the shipped app. Consult current primary-source
  Electron guidance when choosing or changing the runtime architecture;
  record technical rationale and sources in application documentation, with
  measured results in the PR.
- Keep Linux and Electron dependencies, build commands, and tests independent.
  Electron development must work with synthetic data without a collector.
  Neither application imports the other's implementation. Keep shared
  protocol material limited to the wire contract and shared fixtures.

Keep this file about principles and agent test setup. Keep current implementation details and resource
budgets in the relevant application documentation, `docs/architecture.md`, and
`ux.md`. `plan.md` is the sole temporary progress-tracking exception until the
initial plan reaches parity. Preserve its remaining requirements and completion
states; keep attached evidence and detailed run reports out of it. Remove the
plan after parity and move any lasting instructions into the appropriate docs.
Preserve concurrent Linux and UI work when reconciling shared documents.

## Linux test startup and troubleshooting

Prepare the display and Electron sandbox before starting a long suite. Treat
display or sandbox startup errors as environment failures. Run these commands
from the repository root, installing dependencies only when missing:

```bash
bun install --frozen-lockfile
export PATH="$PWD/node_modules/.bin:$PATH"
vp -C electron run setup
```

Use the runtime versions pinned in `.node-version` and the package manifests.
Linux needs Electron's shared libraries, including NSS, ATK, X11, GBM, ALSA and
CUPS. Install missing desktop tools on Ubuntu with
`sudo apt-get install --no-install-recommends xvfb xauth openbox x11-utils`.
Check the tools, then enter the Electron directory for all remaining commands:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
command -v Xvfb xvfb-run xauth openbox xprop
cd electron
```

Check `ldd "$(node -p 'require("electron")')"` for missing shared libraries.
On hosts that restrict unprivileged user namespaces, configure the downloaded
sandbox helper after each fresh Electron installation:

```bash
electron_sandbox="$(node -p 'require("node:path").join(require("node:path").dirname(require("electron")), "chrome-sandbox")')"
sudo chown root:root "$electron_sandbox"
sudo chmod 4755 "$electron_sandbox"
```

The app and tests keep sandboxing and GPU acceleration enabled. Playwright sets
`chromiumSandbox: true` explicitly.

Use a fresh display for each test invocation. `scripts/desktop.ts` starts and
stops Openbox itself and rejects a display that already has a window manager.
Do not start Openbox manually or reuse a desktop session for these commands.
Run one Electron scenario first to catch launch failures before the full suite:

```bash
vp run build
xvfb-run -a -s '-screen 0 1600x1000x24' vp exec node scripts/desktop.ts vp exec playwright test test/inspector.spec.ts --workers=1 --max-failures=1 --grep 'security boundaries'
xvfb-run -a -s '-screen 0 1600x1000x24' vp run test
```

- `Run a validation command inside the documented xvfb-run display`, a missing
  X server, or an unset `DISPLAY` means the command needs the `xvfb-run` wrapper.
  Merely assigning `DISPLAY` does not start Xvfb.
- If Xvfb or xauth is missing, install the prerequisites above. Use `-a` to
  select an available display; do not remove another process's X lock files.
- `Isolated Openbox did not become ready` requires checking `openbox` and
  `xprop`. An existing-window-manager error requires a fresh Xvfb invocation.
- A `chrome-sandbox` error saying the helper must be owned by root with mode
  `4755` requires the `chown` and `chmod` commands above. A downloaded Electron
  helper can be owned by the installing user; repeat the setup after replacing
  the runtime. If container policy prevents that setup or still rejects sandbox
  startup, report the exact error and the integration-validation blocker.
  Do not change `chromiumSandbox: true`, add `--no-sandbox`, or apply a sandbox
  disabling environment override to obtain a passing suite. The tests check
  sandbox behavior, so a run with sandboxing disabled cannot validate it.

Once Electron launches and a test reaches its assertions, investigate assertion
or timing failures separately from display and sandbox setup. Keep unit checks
available through `vp run test:unit` while resolving desktop startup failures.
