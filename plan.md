# Build plan

Temporary implementation checklist. Linux code and synthetic tests are implemented under issue #1; real-session acceptance remains pending. Electron work proceeds independently. Move lasting decisions into the architecture, deployment, and UX documents as they are implemented. Delete this file once the build is complete and its useful information lives in those documents.

## Current work

- [x] Separate `linux/`, reserved `electron/`, and shared `protocol/` tooling and fixtures; add principles-only root `AGENTS.md`.
- [x] Implement Linux observer, collector, isolated installer, and synthetic viewer.
- [x] Run Linux synthetic failure tests, installed-runtime registration probe, startup benchmark, and short overload check. Evidence and limitations are in `docs/linux-validation.md`.
- [x] Complete independent Plan, technical, and CLI review. Fix the input-timing test race and numeric-overflow validation finding; reviewer independently confirms all 33 tests pass.
- [ ] Validate real-session policy behavior before approving capture for actual use. This work deliberately does not install account hooks or change trust. Collector tests can run synthetically, but do not complete this acceptance gate.

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

- [x] Establish independent Linux development tooling. Choose the observer runtime using startup measurements; record tested tool versions and commands.
- [x] Add synthetic fixtures and an isolated Codex CLI 0.153.4 registration probe. All twelve registrations are recognized and untrusted, without warnings.
- [ ] Verify actual event emission, tool coverage, trust behavior in use, and neutral return behavior in real sessions. Registration recognition alone does not complete compatibility validation.
- [x] Implement the minimal observer and local receiver. Bound input and processing time; make one local handoff, exit silently, and avoid retries or detached delivery.
- [x] Implement explicit install/uninstall with atomic configuration replacement, ownership recovery, idempotence, and preservation of unrelated or edited hooks. Test against isolated configuration without granting trust.
- [x] Test absent/full receivers, malformed/oversized input, open-input timeout, closed output pipes, concurrent failures, and a removed executable. Preserve an existing denying-hook entry in configuration tests.
- [ ] Test a real existing denying hook to prove the observer does not override its decision, including collector absence and removed installation.
- [x] Measure synthetic baseline, observer delivery/failure, and Python startup; document the internal timer and its limits.
- [ ] Measure real hook invocation latency under representative normal load and failure.

Done when a real supported Codex session has the same policy and output behavior with capture working and failing, and measured overhead stays within the published budget. No capture feature proceeds by weakening this requirement.

## 2. Build the Linux collector and connection

- [x] Separate account-private Unix datagram ingestion from the authenticated loopback viewer API.
- [x] Document the NDJSON stream and heartbeat contract, one viewer, connection identities, ordering, and second-viewer rejection.
- [x] Bound parsing rate, messages, queue bytes/count, pending writes, HTTP clients, and deadlines. Drop disconnected/over-capacity events and discard queues on disconnect; create no event files.
- [x] Emit bounded health and known-drop counters with explicit unknown loss coverage.
- [x] Test slow/dead viewers, reconnects, invalid credentials, overload, restart, concurrent session ordering, and HTTP ingestion-route rejection.
- [x] Measure a short synthetic overload profile and verify bounded queue use.
- [ ] Test private HTTPS proxy delivery and route isolation through Tailscale Serve.
- [ ] Verify rejection from another OS account and measure sustained isolated collector CPU/RSS.

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
