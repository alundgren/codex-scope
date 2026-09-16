# Viewer experience

The task is to find tool calls that produce large responses, filter the retained calls, and inspect their input and output without losing a reading position. The selected design is the [tool call journal prototype](docs/mockups/tool-call-journal.html). It is an authored synthetic reference, not an Electron recording.

The [Electron implementation](electron/README.md) opens with capture stopped. Functions searches Event journal, Analyze session and Settings. Start capture requires valid connection settings; Stop capture retains history and analysis state. Closing the app deletes its temporary history. Hiding or minimizing keeps capture running without presentation updates.

## Event journal

Display PostToolUse calls in a bounded results table. Capture still accepts all supported hook events, independently of journal filters. Newest first orders by local arrival IDs rather than remote timestamps. Largest response orders measured response bytes descending, then newest ID; unknown sizes come last. Show tool, command/input preview, session context and model, response bytes, and received time. Ellipsize long table text and expose the full selected input and identity in inspection.

Use a compact literal payload-and-metadata search and one wide combined filter control. The picker has field choices on the left and searchable paged choices or an input on the right. Sessions, tools, and models allow multiple choices. Match any selected value within each category and all active categories together. Selection uses full identities. Show removable active choices and Reset. Unknown model is an explicit choice. Command prefix matches the exact beginning of the command or cmd string; `rg` does not match `cd project && rg`.

Response size accepts a nonnegative threshold with B, KB, or MB units and means strictly larger than the threshold. Size unknown may be selected alone or alongside the threshold. Byte units use decimal multiples of 1,000. Choices remain paged and searchable even with many distinct values. Bound selected identities, search text, and result bytes; explain when an additional choice cannot be accepted. Search is literal, not regular expressions. Debounce search and cancel obsolete queries. A timeout keeps previous results visibly identified and offers Reset filters.

Session choices show the latest retained repository and branch label plus a short session-ID suffix. Labels use collector Git metadata when available, otherwise the hook working directory, with project/worktree names for T3 paths. Without either, show the full ID. Refresh labels when opening the picker without moving held rows. Labels describe the last observation, so a quiet session can retain an older branch name. The inspector includes the full session ID.

The table starts Live. Clicking a call holds its current rows, order and scroll position and opens a response-first modal overlay that fills the app window. Input and Original JSON are separate tabs. Close and Escape return focus to the row and keep the view held. Resume live explicitly follows incoming calls again. Previous and Next navigate bounded result pages and hold the view. Changing filters or sort rebuilds the displayed set while preserving held mode. Keep the result page bounded; the scrollbar moves within that page, never through a hidden whole-recording list.

The right summary column always reports all retained matches under the current filters, including new arrivals while the table is held. Show matching calls, total known response bytes with a separate unknown-response count, and average response bytes with the measured-call denominator. A missing response does not hide known totals. Empty text is a known zero-byte response. Text responses use UTF-8 byte length; structured responses use their compact JSON representation. These bytes approximate context volume and do not measure billed tokens. Do not show duration until there is a reliable timing source. Count new matching arrivals separately from these live totals.

The overlay displays JSON with two-space indentation and syntax colors for keys, strings, numbers, booleans and null. This includes structured Input and Response values and text containing valid JSON. Other text keeps its original line breaks. Original JSON retains every field, number literal, duplicate key and string escape; only display whitespace changes. Copy JSON preserves the exact captured text, including its original whitespace. Response and Input copy the selected value without display formatting. Formatting uses bounded text nodes and colored spans, never injected HTML. If indentation or token count exceeds the display budget, show the complete unformatted text and explain the formatting limit. The original payload remains available even if a response is missing. The payload scrolls with wheel, touch, keyboard, and the existing custom scrollbar. Keep its offset while capture continues. The scrollbar's thumb represents the visible fraction of content; track clicks, dragging, arrows, Page Up/Down and Home/End remain available. Hide it and remove it from keyboard navigation when content fits.

Connection and viewing mode remain separate. Show Connecting, Connected, Disconnected, Stopped or Synthetic data. Coverage is unknown before the first connection and across gaps. Distinguish collector lifetime drop totals, known local drops, and gaps of unknown size. Reconnection cannot recover missing events or move a held view. Storage pressure drops new input while retained history stays readable. If a selected call is evicted, explain its removal and return to retained matches; never substitute another payload under its identity. Worker failure preserves readable content and disables history mutations until restart.

Clear history is a small red outlined button with a lock. The first activation unlocks it for 3,000 milliseconds and shows Clear? with a receding fill. Only another activation before the monotonic deadline deletes history. Escape, hiding and expiry relock it. Reduced motion suppresses animation without extending the deadline. Disable it for empty or unavailable history. Clear invalidates old rows, selected content, counters, queries and incoming work before creating a new recording. Cleanup failure must not claim successful deletion.

Use Codex Scope as the window title and Event journal as the journal title. Do not add UX subheadings. The table, summary rail and combined picker follow the selected reference. The payload overlay uses the full app window to give long JSON more room. Keep existing capture controls, Functions, and Clear. At narrow widths, put summaries beneath the table. The payload overlay fills the window at every width, keeping Close, tabs and Copy visible. No permanent payload sidebar or timeline scrubber remains.

Use warm paper `#F2EADE`, panels `#EADFCD`, raised areas `#E0D2BD`, fields `#F9F6F0`, borders `#C1AF9A`, primary text `#604939`, secondary text `#66574D`, links `#3D5D71`, accents `#784F26`, and destructive controls `#8F3A2D`. Use visible focus rings, soft corners, system fonts and 400, 500 and 600 weights. Primary control/tool text is 16px; secondary text is 13.5px and compact metadata 12px. Monospace is for inputs, identifiers and payloads. No remote fonts or theme switcher.

## Guided Linux installation

The terminal installer uses one title, plain prompts, and no decorative section
labels. It asks about Tailscale and the Codex configuration directory first,
then requests permission before reading selected configuration. Suggested paths
and available ports appear together; customization is optional. Destructive or
permission-changing prompts default to no. Missing prerequisites stop setup
with the package or account-setting action needed to continue.

The automatic isolated rehearsal requires no manual approval. The live flow
asks for one CLI hook-approval round and two short tasks in the user's usual
Codex client. The first checks delivery with a unique marker; the second checks
normal behavior while the collector is stopped. Success leaves the service
running and prints connection and removal instructions without exposing tokens.
Failures trigger rollback; edited resources are preserved with an explicit
cleanup result. Rerunning the install script detects current state. Existing
installations default to an upgrade choice with explicit confirmation and a
notice about the collector restart and lost events. Upgrades retain connection
settings and hook commands. Inspection, verification, and removal remain available.
Interrupted upgrades offer recovery; removed installations offer retained-file
deletion followed by fresh setup, without requiring a separate management command.

## Session analyzer

The analyzer is one session workspace with Results, Search trail, Agent routing
and Recommendations views. The four [concepts](docs/mockups/session-analyzer.html)
are visual references. Session controls remain in the analyzer; diagnosis model selection lives in Settings. Desktop setup uses compact inline labels and places snapshot
coverage beside the run selector, keeping all setup controls visible. The title,
tabs and filters use less vertical padding to leave more room for findings.
Keep the event journal available with its held reading position.
Use one visible title, Session analyzer, and necessary controls without additional
subheadings. Narrow controls scroll within a bounded area so evidence panes and
the footer remain usable. Keep the connection indicator visible at all widths;
the journal payload overlay uses the full window on narrow screens.

The selected session, analysis run and focused call are shared. Each view keeps
its own search, observed-model filter, sort and scroll state. Switching views
never runs a model.
Changing analysis models can reuse the same bounded evidence snapshot; New
snapshot is explicit. Completed results remain open while another analysis runs. Retrying a failed
or cancelled run selects the new attempt so its outcome is visible.
Missing model and response information stays unknown, model groups do not imply
agent relationships, and all totals describe retained evidence. Show snapshot
omissions, recording-wide drop counts and original-event eviction plainly.

Recommendations are model judgments with linked captured evidence. Keep, dismiss
and undo belong to their analysis run. Copy session handoff explicitly asks the
run's analysis model to turn kept findings into advice for the still-active source
session, then copies the result for the user to paste. Show preparation, allow
cancellation, and preserve the clipboard on failure. This does not apply workflow
changes or send messages automatically. Runs and decisions are bounded and temporary. Explain removal
when an old run is evicted, and clear all analysis state with recording generation
changes. CLI absence, invalid model, unavailable authentication, invalid output,
resource limits and cancellation keep previous evidence readable and offer a
new analysis attempt.

Settings accepts a collector origin or a Linux pairing URL, extracts the token into a masked input, and clears it after saving. Existing tokens are never displayed. Invalid links and failed saves preserve the previous connection and provide a retry path. Successful saves stop capture, preserve retained history and require Start capture to resume. Imported command-line files remain untouched, and the form explains their next-launch override. Moving between tools keeps active task state and reading positions. Operational capture state always restarts off.

Settings provides the diagnosis model and effort. Both start empty, including migration from an older prefilled model. Opening a model picker or Refresh models reads the local CLI catalog without starting a turn. Show every returned identifier and mark hidden entries; retain a missing saved choice visibly as unavailable. Effort choices come only from the selected model, and choosing a different model clears the effort. Discovery errors, cancellation and stale invocation errors preserve selections and other input. Save settings persists explicit choices without requiring collector credentials. Native select controls follow the existing analyzer controls, with narrow screens stacking the model and effort controls to keep full labels and options readable. Saved changes apply to the next analysis run.
