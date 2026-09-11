# Build plan

Temporary implementation checklist. Linux code and synthetic tests are implemented under issue #1; real-session acceptance remains pending. Electron work proceeds independently. Move lasting decisions into the architecture, deployment, and UX documents as they are implemented. Delete this file once the build is complete and its useful information lives in those documents.

## Current work

- [x] Separate `linux/`, reserved `electron/`, and shared `protocol/` tooling and fixtures; add principles-only root `AGENTS.md`.
- [x] Implement Linux observer, collector, isolated installer, and synthetic viewer.
- [x] Run Linux synthetic failure tests, installed-runtime registration probe, startup benchmark, and short overload check. Evidence and limitations are in `docs/linux-validation.md`.
- [x] Complete independent Plan, technical, and CLI review. Fix the input-timing test race and numeric-overflow validation finding; reviewer independently confirms all 33 tests pass.
- [ ] Validate real-session policy behavior before approving capture for actual use. This work deliberately does not install account hooks or change trust. Collector tests can run synthetically, but do not complete this acceptance gate.
- [x] Implement the finite Electron fixture inspector for issue #5, with independent pinned tooling, sandboxed local content, neighboring rows, original-text inspection/copy and the custom payload scrollbar. Later deliveries below add filters, scrubbing, Clear, SQLite and live transport.
- [x] Complete issue #5's recorded Electron tests, visual inspection, clean-checkout validation and measured empty-window comparison. Evidence and Linux-only limits are in `docs/electron-validation.md`.
- [x] Complete issue #5's independent Plan, technical and UX review. The reviewer reported no findings.

## Fixed requirements

- Codex must continue normally when collection fails. No hook decisions, context injection, command wrapping, remote waits, or observer retries.
- Resource limits take priority over data retention on both machines. Drop events rather than grow queues, memory, or disk without bounds.
- No offline recording in any release. Disconnects and sleep may lose events permanently.
- One Linux capture host and one Mac Electron viewer; concurrent Codex sessions share the stream.
- Original accepted hook input only. No transcript or environment collection. Oversized events are dropped, not stored as misleading partial records.
- Temporary bounded SQLite on the Mac. Normal close deletes it; next startup cleans up abandoned app-owned files after crashes.
- Frozen history navigation with filters and full inspection. Capture continues while browsing. No historical playback.
- Generic public documentation, synthetic fixtures, MIT license. No private infrastructure values, telemetry, or raw-event logs.

## Validation environment

The owner accepts Linux VM evidence for current development completion. Run the
actual Electron app under Xvfb with recorded visual scenarios and screenshots,
including side-by-side comparisons with the selected mockup. Measure resource use
on that VM and identify its workload and environment. Browser-only prototype
checks do not replace Electron integration checks. macOS performance, energy use,
native window behavior, sleep, and target-platform setup remain unverified until
later macOS validation. That later validation is not a gate for this delivery.
See [current Electron research](docs/electron-research.md) for sources and the
recommended approach. This changes the validation gate, not the Mac viewer target
or the Linux agent's capture responsibilities.

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

- [x] Add Electron with a development command that opens the finite fixture inspector from a clone. Keep bundled UI isolated from Node, with narrow IPC and text-only payload rendering. Pin and test the runtime independently of Linux.
- [x] Select and validate SQLite integration with the pinned runtime for temporary history.
- [x] Put synthetic input and database work outside the renderer. Run SQLite and payload parsing in one bounded worker. Limit pending batches and acknowledged UI notifications. Literal search and live transport run in that same worker.
- [x] Store original accepted payloads and the small envelope defined in the architecture. Define stable recording IDs and connection identities; do not order solely by remote timestamps.
- [x] Choose and measure SQLite size, cache, journal, transaction, queue, and disk-headroom limits. Budget sidecars too. Evict oldest rows in small batches and reuse space without full compaction during capture. Reject more input if cleanup cannot keep pace.
- [x] Implement one app instance, private recording directories, clear-history generation changes, normal-close deletion, and startup cleanup restricted to abandoned owned files. Keep settings separate from recordings.
- [x] Test actual SQLite full/read-only failures, simulated low disk headroom, selected-event eviction, bounded burst intake, delayed Clear work, cleanup failure, second instances, force kill/relaunch, normal close and hidden/minimized capture in Electron on Linux.
- [ ] Validate macOS sleep, native window lifecycle, energy use and performance. Linux results do not complete these checks.

Electron temporary history is implemented. [History validation](docs/electron-history-validation.md) records the Linux synthetic checks, measured limits, inspected recordings and remaining macOS limits. Filtered navigation and version 1 live transport are implemented below.

## 4. Implement filtering and frozen history

- [x] Build the finite Event journal and payload inspector using [ux.md](ux.md), the [agreed prototype](docs/mockups/event-journal-v2.html), and the [Electron build handoff](docs/mockups/event-journal-v2-notes.md), with desktop and narrow layouts.
- [x] Load at most five visible summaries and one selected payload. Page by local IDs, without a whole-recording cache. Preserve original text with no formatting expansion.
- [x] Add the session dropdown, multi-select hook filtering, and literal free-text search over retained payloads and metadata. Debounce, cancel, and time-limit queries; keep search and capture independent.
- [x] Add stable backward and forward paging through the left journal pin, a new matching-event count, and the pin's Live endpoint. Freeze following during inspection or scrubbing while capture continues; keep the journal free of scrollbars.
- [x] Add the custom payload scrollbar with pointer, wheel, touch and keyboard input. Keep the journal and payload visible together without subheadings, event numbers, or back and timestamp-jump buttons.
- [x] Add the two-click Clear lock with its three-second confirmation window and atomic recording deletion.
- [x] Handle oldest retained time, evicted selection and gestures, empty results, timeout recovery, and resource pressure while preserving held reading. Keep Synthetic data separate from Live/history.
- [x] Add version 1 authenticated transport, connection status, collector lifetime totals and unknown-loss gaps. Keep local drops separate.
- [x] Test concurrent arrivals, full-ID and hook filters, nonzero held offsets, rapid delayed queries, full-payload matches, every scrub input, frozen gesture mapping, eviction, timeout/reset, old replies after Clear, and bounded option paging in actual Electron on Linux.
- [x] Verify held reconnection, payload offsets, counter reset, delayed Clear, heartbeat stalls and hidden/minimized capture in actual Electron on Linux. Run the separate landed-collector smoke with synthetic input and isolated configuration.

[Navigation validation](docs/electron-navigation-validation.md) records query bounds. [Transport validation](docs/electron-transport-validation.md) records the independent fake-server suite, landed-collector smoke, inspected recordings and resource measurements. Private proxy, real-session and macOS checks remain unverified.

Done when retained events can be explored in both directions without unbounded loading, and the Live endpoint follows only the currently connected stream.

## 5. Validate and document the usable first version

- [ ] Run a clean Linux capture setup and a clean Mac development setup connected through Tailscale Serve. Document actual commands, prerequisite versions, token creation, Codex trust, route isolation, and uninstall.
- [ ] Record a synthetic load profile and measured observer latency, collector and Mac memory, CPU behavior, UI responsiveness, and total recording disk use. Choose conservative defaults from those results and test exceeding them.
- [ ] Verify real Codex sessions with existing hooks, collector absence, Mac close, Mac sleep, connection loss, slow viewer, history limit, and storage failure. Confirm lost events never trigger replay or remote waits in the observer.
- [ ] Update README status and compatibility claims only after the relevant checks pass. Keep the mockup marked as design until replaced with a synthetic-data screenshot. Keep SVGs consistent with final architecture.
- [ ] Review the complete code and experience against the agreed priorities. Inspect tracked files for credentials, real captures, endpoints, account-specific paths, and unrelated machine configuration.
- [ ] Move lasting instructions and measured budgets into permanent docs, then remove this temporary plan.

Done when a fresh Linux clone can launch the collector and Electron viewer using their independent documented development workflows, and the required Linux failure, visual, and resource checks have evidence. Keep Mac setup and macOS-only checks explicitly unverified for later validation. Signed builds and auto-update infrastructure are not required.
