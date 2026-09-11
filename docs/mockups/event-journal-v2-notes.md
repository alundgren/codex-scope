# Electron build handoff

Build the selected [Event journal prototype](event-journal-v2.html) using the behavior in [ux.md](../../ux.md). The HTML is self-contained and can be opened directly in a browser. It requires no install, running collector, or external assets. The window title is Codex Scope. Live uses quiet warm colors and retains its existing navigation behavior. This is the sole UI build target.

The prototype and this document are UI deliverables only. The first [Electron implementation](../../electron/README.md) now supports a finite fixture recording, original-text inspection and copying, and the custom payload scrollbar. [Linux Electron validation](../electron-validation.md) records actual-app evidence separately from this prototype. No macOS runtime, database, real hook compatibility or live network behavior is established by either the browser demo or this synthetic slice. Demo controls outside the window are not application controls.

The parallel Linux handoff establishes these ownership boundaries. Preserve them when implementing or resolving branch conflicts.

| Location | Responsibility |
| --- | --- |
| `linux/` | Linux agent owns observer, collector, installation tools, dependencies, commands, and tests. |
| `electron/` | UI implementation owns the Mac app, dependencies, commands, synthetic development mode, and tests. |
| `protocol/` | Linux agent authors the initial wire contract and shared synthetic fixtures. Keep it small and free of application implementation logic. |
| `AGENTS.md` | Linux agent authors project principles without implementation details. |
| `plan.md` | Linux agent updates Linux progress. Add Electron progress only when actual implementation begins and reconcile concurrent edits. |
| `docs/architecture.md`, `docs/deployment.md` | Linux agent updates tested capture behavior and commands. Coordinate later Electron additions. |
| `ux.md`, `docs/mockups/event-journal-v2*` | Selected UI behavior, reference prototype, and build handoff. |

Linux and Electron must install, build, and test independently. Neither imports the other's implementation. Electron must offer a synthetic-data development mode without a running collector. Use the existing `protocol/` contract and fixtures through a small input adapter; do not establish a competing transport contract from the demo's JavaScript objects.

Implement the renderer around explicit recording state: current recording generation, connection identity and health, filter query identity, Live or history mode, selected local event ID, visible summary neighborhood, payload load identity and scroll offset, retained bounds, and the clear-button deadline. Keep event IDs internal. They provide stable selection and ordering but are not displayed as event numbers. Session filtering is by full session identifier, even when a display label is shorter.

The main process or a worker owns credentials, transport, original payload bytes, and temporary SQLite history. The isolated renderer requests filtered summaries, a selected payload, scrub targets, copying, and clearing through narrow validated IPC. Do not expose generic filesystem access, arbitrary SQL, credentials, or remote payload execution to the renderer. Store settings separately from the disposable recording. Actual IPC method names and numeric resource limits belong to implementation, not this mockup.

Local recording order defines event order. Remote receive metadata is displayed but must not be used as the sole stable ordering key. Have history queries return ordered event summaries, retained bounds, count, and an anchor that can be used for bounded navigation. Backward and forward movement loads around stable IDs. Do not implement one query or DOM node per tick across the entire database.

For a scrub gesture, hold the filtered navigation snapshot and retained endpoints stable until release. Coalesce pointer movements to the latest requested position, cancel obsolete queries, and discard responses whose recording generation, query identity, or target no longer matches. Resolve a coarse position to a matching event through a bounded database query or sparse anchor index. Exact indexing and count strategies should be measured against the retention budget before choosing them. The renderer must not fetch all matching IDs just to calculate a slider value. Sample tick marks at large counts; preserve individual event movement through arrow keys and nearby navigation.

New arrivals during history inspection retain the selected event, visible neighborhood, payload content, and payload scroll offset. Count new matching arrivals without accumulating an unbounded ID array. Their counters belong to the current filter identity. On filter changes, cancel pending navigation, clear the old arrival counter, and apply the new filter to the same retained recording. If a selected event still matches, keep it; otherwise choose the nearest match in recording order. In Live, select the newest match. If no events match, clear selection. End or the Live endpoint explicitly resumes following and resets the counter. A reconnect does not perform that transition for a reader in history.

If eviction removes the selection or a scrub anchor, cancel incompatible work, state what was removed, and resolve the nearest available match within retained bounds. Freeze pointer-to-position mapping during an active gesture, then reconcile retained bounds at its end. If the snapshot becomes unusable during the gesture, end it with an explanation instead of moving the pin to an unrelated event. These database-backed cases are not simulated by the small prototype.

Use layout space to decide how many neighboring entries fit. Keep the journal stationary while the pin controls which events occupy those slots. The prototype shows at most five rows and switches to stacked journal and payload panels below 720px. Those are reference layout values, not reasons to clip primary controls at another desktop window size. Keep the right pane independently scrollable and implement the custom thumb according to `ux.md`. Resizing or receiving a new event must not reset scroll position in the same selected payload.

The inspector must render payload values as text. Copy preserves the original accepted JSON text, including unknown fields. Optional formatting and search highlighting must have measured byte and time limits. For an accepted payload too large for cheap formatting, use a bounded plain-text viewer that can navigate its full contents and copy the original. Do not silently truncate and call the result complete. The byte count describes accepted bytes, not a newly pretty-printed object's size.

Clear confirmation lives in the renderer, but recording deletion must be atomic with respect to incoming batches and queries. On the second activation, invalidate the current recording generation, stop acceptance of old work, and ask the main process to clear and start the next recording. Disable repeat activation while that request is in flight. Report a cleanup failure explicitly. The locked state must survive delayed timers correctly: compare the monotonic deadline at every activation. Keyboard activation follows the same two-step rule. Repeated keydown events while holding a key must not count as an independent confirmation.

The UI mockup intentionally simplifies several implementation concerns. Its fixture objects are generated locally and serialized for display, IDs and filters are held in arrays, text search runs immediately, new arrivals are manually injected, retention is capped at 60 demo events, and ticks represent every event. It lacks SQLite eviction, cancelable database queries, durable settings, real connection setup, and actual cleanup failures. Do not copy those shortcuts into the application's data handling. The demo opens historical inspection; production starts Live. Demo reconnection illustrates a notice but does not test the wire protocol.

Implement in reviewable stages: establish an independently runnable Electron shell with synthetic data; implement journal filtering, scrub navigation, and payload inspection; implement custom scrolling and timed clear confirmation; connect the renderer to bounded local history; then consume the agreed protocol through the transport adapter. Keep the UI runnable with fixtures at every stage. Pin dependencies and document exact commands inside `electron/` once those commands exist and have been tested. Do not document invented launch commands as operational.

| Acceptance check | Required result |
| --- | --- |
| Start with fixtures | Codex Scope title, one Event journal view title, no subheadings or event numbers, session and hook filters, neutral Live state. |
| Scrub in both directions | Pointer, touch, arrows, Page keys, Home, and End navigate matching events; the left journal has no scrollbar. |
| Select the newest event | History stays held until the distinct Live endpoint is selected. |
| Receive while inspecting | Selected event, rows, and payload offset stay fixed; the matching new-event count increases. |
| Filter rapidly while queries are delayed | Only the newest filter result appears; obsolete payloads and counts are discarded. |
| Filter by session and several hooks | History and incoming matches use the same filters; clearing filters restores all retained matches. |
| Inspect long or hostile text | Full accepted text remains navigable and copyable; markup in values is never executed; memory and formatting remain bounded. |
| Scroll payload | Custom thumb, track click, wheel, touch, keyboard, and resize agree on offset; no native scrollbar is visible. |
| Unlock Clear once | Nothing is deleted; it relocks after three seconds, on Escape, and on document hiding. |
| Confirm Clear | A separate activation before expiry clears once. An expired click unlocks again. Holding an activation key does not confirm. |
| Clear while requests are pending | Old rows, payloads, counts, and late incoming batches cannot reappear. |
| Lose and restore the connection | Retained history survives, gap losses remain unknown, no replay is requested, history inspection stays held. |
| Evict, time out, or fill storage | Explain the condition and keep bounded, responsive navigation through available history. |
| Close, hide, minimize, crash | Close quits and cleans up; hide/minimize keep capture; next launch cleans abandoned recordings. Verify on macOS. |

Browser validation of the prototype covered drag and keyboard scrubbing, custom thumb dragging and keyboard scrolling, payload-position preservation during arrivals, session and text filtering, three-second automatic relocking, two-click clearing, recovery after clear, reconnection notices, and desktop and narrow layouts. No browser errors or narrow-window horizontal overflow were observed. These results do not complete production acceptance checks for the collector, SQLite, security isolation, bounded resource use, or macOS lifecycle.
