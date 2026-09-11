# Build plan

Temporary implementation checklist. The design is agreed; no application code exists yet. Work through these steps in order, keeping each change runnable or independently verifiable. Move lasting decisions into the architecture, deployment, and UX documents as they are implemented. Delete this file once the build is complete and its useful information lives in those documents.

## Fixed requirements

- Codex must continue normally when collection fails. No hook decisions, context injection, command wrapping, remote waits, or observer retries.
- Resource limits take priority over data retention on both machines. Drop events rather than grow queues, memory, or disk without bounds.
- No offline recording in any release. Disconnects and sleep may lose events permanently.
- One Linux capture host and one Mac Electron viewer; concurrent Codex sessions share the stream.
- Original accepted hook input only. No transcript or environment collection. Oversized events are dropped, not stored as misleading partial records.
- Temporary bounded SQLite on the Mac. Normal close deletes it; next startup cleans up abandoned app-owned files after crashes.
- Frozen history navigation with filters and full inspection. Capture continues while browsing. No historical playback.
- Generic public documentation, synthetic fixtures, MIT license. No private infrastructure values, telemetry, or raw-event logs.

## 1. Prove capture compatibility and failure behavior

- [ ] Establish a small local development layout and reproducible dependency tooling. Choose the observer runtime by measured startup cost and deployment simplicity. Pin selected versions and document commands as they become real.
- [ ] Build synthetic hook fixtures and a compatibility probe for the installed Codex runtime. Verify all supported event registrations, tool coverage, trust, and neutral return behavior. Record tested versions and clients without private machine details.
- [ ] Implement the minimal observer and a local test receiver. Cap input bytes and processing time; make one local handoff, then exit without stdout or decisions. Avoid detached subprocesses and retries.
- [ ] Implement explicit account-level install and uninstall with atomic configuration edits, exact ownership, idempotence, and preservation of unrelated or edited hooks. Do not automatically trust hooks.
- [ ] Verify absent receiver, full receiver, malformed and oversized input, timeout, broken pipe, concurrent invocations, and existing hook coexistence. Test an existing denying hook to prove the observer does not override it.
- [ ] Measure baseline and observed hook latency under normal load and receiver failure. Record the observer's startup and delivery budgets and the limits of the claim. Test removed installation and absent collector paths too.

Done when a real supported Codex session has the same policy and output behavior with capture working and failing, and measured overhead stays within the published budget. No capture feature proceeds by weakening this requirement.

## 2. Build the Linux collector and connection

- [ ] Keep observer ingestion local to the intended account and separate from the viewer API. Bind the viewer API to loopback and require a token outside URLs and logs.
- [ ] Choose and document a simple live stream protocol. Support one viewer, connection identities, event sequence numbers, heartbeat expiry, and explicit rejection of a second viewer.
- [ ] Bound ingress rate, message size, queue bytes and count, pending writes, and connection lifetime checks. Drop without a viewer, drop under pressure, and discard the queue on disconnect. Create no event files.
- [ ] Emit only bounded health and known-drop counters. Never log payloads or claim exact counts for intervals the service could not observe.
- [ ] Test slow and dead viewers, reconnects, invalid credentials, excess traffic, collector restart, and event ordering from concurrent sessions. Verify ingestion cannot be reached through the viewer route.

Done when a synthetic client can observe live events through a private proxy, but cannot retrieve events generated while disconnected, and collector resources remain bounded under overload.

## 3. Build the Mac app and temporary history

- [ ] Add Electron with a development command that opens the app from a clone. Keep bundled UI isolated from Node, with narrow IPC and text-only payload rendering. Pin a supported runtime and SQLite integration tested together.
- [ ] Put connection and credentials outside the renderer. Run database writes and searches off the UI thread. Limit pending batches and UI notifications.
- [ ] Store original accepted payloads and the small envelope defined in the architecture. Define stable recording IDs and connection identities; do not order solely by remote timestamps.
- [ ] Choose and measure SQLite size, cache, journal, transaction, queue, and disk-headroom limits. Budget sidecars too. Evict oldest rows in small batches and reuse space without full compaction during capture. Reject more input if cleanup cannot keep pace.
- [ ] Implement one app instance, private recording directories, clear-history generation changes, normal-close deletion, and startup cleanup restricted to abandoned owned files. Keep settings separate from recordings.
- [ ] Test disk-full and write failures, history eviction, burst traffic, renderer responsiveness, sleep, force quit, relaunch, normal close, and cleanup failure. Verify stale pending events cannot reappear after Clear.

Done when the app receives and queries synthetic events on macOS, respects measured resource budgets, and removes owned recording files through the documented lifecycle. A Linux-only result cannot complete this step.

## 4. Implement filtering and frozen history

- [ ] Build the Event journal and payload inspector using [ux.md](ux.md), the [agreed prototype](docs/mockups/event-journal-v2.html), and the [Electron build handoff](docs/mockups/event-journal-v2-notes.md). Make the layout work at practical laptop window sizes.
- [ ] Keep roughly 500 summaries loaded and virtualize rendering. Load payloads on selection; bound formatting and expansion work.
- [ ] Add the session dropdown, multi-select hook filtering, and literal free-text search over retained payloads and metadata. Debounce, cancel, and time-limit queries; keep search and capture independent.
- [ ] Add stable backward and forward paging through the left journal pin, a new matching-event count, and the pin's Live endpoint. Freeze following during inspection or scrubbing while capture continues; keep the journal free of scrollbars.
- [ ] Add the custom payload scrollbar and the two-click Clear lock with its three-second confirmation window. Keep the journal and payload visible together without subheadings, event numbers, or back and timestamp-jump buttons.
- [ ] Show connection status separately from viewing mode. Handle gaps, oldest retained time, evicted selection, empty results, and resource pressure without moving the current view unexpectedly.
- [ ] Test concurrent arrival while browsing, rapid filter changes, large JSON, matches outside previews, eviction while paused, old query responses after Clear, keyboard use, and reconnection while in history.

Done when retained events can be explored in both directions without unbounded loading, and the Live endpoint follows only the currently connected stream.

## 5. Validate and document the usable first version

- [ ] Run a clean Linux capture setup and a clean Mac development setup connected through Tailscale Serve. Document actual commands, prerequisite versions, token creation, Codex trust, route isolation, and uninstall.
- [ ] Record a synthetic load profile and measured observer latency, collector and Mac memory, CPU behavior, UI responsiveness, and total recording disk use. Choose conservative defaults from those results and test exceeding them.
- [ ] Verify real Codex sessions with existing hooks, collector absence, Mac close, Mac sleep, connection loss, slow viewer, history limit, and storage failure. Confirm lost events never trigger replay or remote waits in the observer.
- [ ] Update README status and compatibility claims only after the relevant checks pass. Keep the mockup marked as design until replaced with a synthetic-data screenshot. Keep SVGs consistent with final architecture.
- [ ] Review the complete code and experience against the agreed priorities. Inspect tracked files for credentials, real captures, endpoints, account-specific paths, and unrelated machine configuration.
- [ ] Move lasting instructions and measured budgets into permanent docs, then remove this temporary plan.

Done when a fresh clone can launch the Linux collector and Mac viewer using the documented development workflow, and all required failure and resource checks have evidence. Signed builds and auto-update infrastructure are not required.
