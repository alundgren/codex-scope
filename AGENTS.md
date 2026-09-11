# Project principles

Codex Scope is a best-effort inspector. Preserve normal Codex behavior first,
keep host and Mac resource use bounded second, and retain events third.
Losing events is acceptable; blocking Codex or exhausting the user's laptop
is not.

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
- A frozen history view must stay responsive and preserve the reader's event
  and payload position while capture continues. Visual effects, formatting,
  and update frequency must yield to that requirement.
- Apply limits before accepting or expanding expensive input. Preserve the
  original bytes of accepted payloads; drop oversized events rather than
  silently truncating them and presenting them as complete. Rendering and
  copying accepted data must also respect resource limits.
- Disk history is temporary and bounded. Include database sidecars and
  temporary work in the budget. Cleanup and eviction must not cause long UI
  stalls or compete indefinitely with capture. When cleanup cannot keep up,
  drop incoming data and explain the limitation.
- No offline recording or recovery of missed events. Reconnection must not
  create a replay backlog. Distinguish known drops from gaps whose loss count
  is unknown, and never imply that missing history can be recovered.
- Choose numeric limits from measurements, not guesses or the size of demo
  fixtures. Validate idle use, sustained capture, bursts, large accepted
  payloads, rapid search and scrubbing, and resource pressure on macOS. Report
  total app memory, CPU, responsiveness, and failure behavior with the tested
  workload. Browser or Linux checks alone do not establish Mac performance.
- Do not add UX subheadings unless the repository owner explicitly requests
  them. This applies to screens, dialogs, mockups, and user-facing explanatory
  copy. Do not imitate a subheading with styled text to bypass the rule. A
  single view title and necessary control labels are allowed. Follow `ux.md`
  for the selected experience; convenience or a generic design convention is
  not permission to add subheadings.
- Keep Linux and Electron dependencies, build commands, and tests independent.
  Electron development must work with synthetic data without a collector.
  Neither application imports the other's implementation. Keep shared
  protocol material limited to the wire contract and shared fixtures.

Keep this file about principles. Record implementation details and measured
budgets in the relevant application documentation, `docs/architecture.md`,
and `ux.md`. Record progress in `plan.md`. Preserve concurrent Linux and UI
work when reconciling changes to shared documents.
