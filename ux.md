# Viewer experience

The task is to see what Codex emits, find an event, and inspect its input without losing the current reading position. The selected design is the [Event journal prototype](docs/mockups/event-journal-v2.html). Open the HTML file locally in a browser. The [Electron build handoff](docs/mockups/event-journal-v2-notes.md) supplies implementation boundaries and acceptance checks. The prototype is synthetic, not a running Electron application.

The [Electron implementation](electron/README.md) opens a quiet idle view with capture stopped. The compact Functions menu searches Event journal, Analyze session, PR review and Settings. PR review states that it is not available yet. Start capture requires valid connection settings; Stop capture retains history and analysis state. The event journal starts its viewing position in Live. With capture active it receives live version 1 events. Synthetic
development mode uses five seed fixtures and one new event each second. Selecting a row holds that event, its visible neighbors, and payload
offset while arrivals continue. The Live label resumes following. Three to five
nearby rows fit the window, with three above the payload at narrow widths.
Clear uses the specified two-activation lock and starts an empty new recording.
Eviction, known drops, storage pressure and cleanup failures appear in the
existing status area.

Search, full-session-ID filtering and multi-select hooks apply to retained
events and matching arrival counts. The journal pin is an interactive scrubber
with a distinct Live endpoint. Filter choices page within fixed limits, and a
query timeout keeps the previous selection visibly identified while offering
Reset filters. The header reports Connecting, Connected or Disconnected for configured
transport, and Synthetic data for fixture mode. Connection coverage stays unknown
before the first connection and across gaps. The status area distinguishes the
latest collector lifetime drop totals from local viewer drops. Reconnect keeps a
held selection and payload offset; Clear starts a new recording and connection. Payloads display as original text without formatting expansion. Metadata
and previews may use visible ellipses; the payload and Copy JSON preserve
complete accepted text. Private HTTPS proxy behavior, real Codex compatibility
and macOS behavior remain unverified.

Use “Codex Scope” in the window title. Use Event journal as the title while the journal is open. Do not add subheadings, event numbers, a Back to events button, a timestamp-jump button, or a separate Go live toolbar button. The journal and selected payload remain visible together. At narrow widths, put the payload below the journal instead of replacing it.

Give the desktop session control enough width to read ordinary repository and
branch names; keep the narrow toolbar wrapping below search.

Session choices show the latest retained repository and branch label plus a short
session-ID suffix. Labels use collector Git metadata when available, otherwise
the hook working directory, with project/worktree names for T3 paths. Without
either, show the full ID. Filtering always uses the full ID, and the inspector
keeps it available. Refresh labels on opening the dropdown without changing the
selected event or payload position. Git labels describe the last observation;
quiet sessions may keep an older label until later events carry refreshed
metadata. The collector documentation states this additional Git data collection
and its limits explicitly.

The toolbar contains a literal payload search, a session dropdown with All sessions as its default, and a multi-select hook filter with All hooks as its default. Filters apply to retained history and live arrivals equally. Filtering changes what is displayed, not what is collected. Debounce search, cancel obsolete queries, and prevent stale results from replacing a newer query. Identify payload matches even when they occur outside the visible preview.

Each journal entry shows receive time in UTC, hook type, a short preview, and the session identifier. Keep the selected entry visually distinct with a warm background and a small accent marker. Show a bounded neighborhood around it. The left journal has no scrollbar. Do not simply hide a scrollbar on a long list that still requires scrolling to discover events.

The journal's left pin is a vertical scrubber. The top is the oldest matching retained event. Each stop represents one matching event in recording order, not an equal duration of elapsed time. The last stop below the newest event is Live. Clicking or dragging the track selects a stop and updates both journal entries and payload. The newest event itself can still be inspected in history mode; only the Live stop resumes following. The Live label is part of the scrubber and is also clickable. Use neutral warm text and a quiet warm background for its active state. Avoid a green fill that competes with event content.

Arrow Up and Left select the previous event; Arrow Down and Right select the next event. Home selects the oldest retained match; End selects Live. Page Up and Page Down move five matching events. The mouse wheel over the journal moves through events with bounded updates. Support touch dragging. Expose a named vertical slider with its current receive time and hook, or Live, as its accessible value. Event rows remain keyboard-operable buttons.

Selecting an event or scrubbing away from Live freezes following while capture continues. Incoming events do not change the selected event, visible neighborhood, or payload scroll position. Count new matching events separately. Returning to Live clears this count and selects the newest matching event. Normal application startup keeps capture stopped; the journal viewing position starts in Live; the prototype deliberately opens a populated historical event to demonstrate inspection.

Connection and viewing mode are separate. Show whether the viewer is connected and whether its position is held. Live while disconnected does not reconnect the collector or recover missed events. Reconnecting starts a new live connection and preserves a visible coverage gap with an unknown loss count. It does not move a user who is inspecting history.

The inspector shows the complete accepted payload as plain text, with receive time, session, optional tool, and byte count. Copy JSON copies the original accepted payload bytes as text, not a reconstructed object with fields removed or reordered. The production data contract must preserve those original bytes. The prototype formats synthetic objects for illustration and does not demonstrate byte preservation.

The right payload pane scrolls normally with wheel, trackpad, touch, and keyboard. Hide browser-native scrollbar visuals and provide a custom draggable thumb and track. Derive thumb height from the visible fraction of content and thumb position from scroll offset. Clicking the track positions the thumb around the click; dragging preserves the initial grab offset. Arrow keys move a small distance, Page Up and Page Down move most of the viewport, and Home and End reach its limits. Hide and remove the custom control from keyboard navigation when content fits. Use a named scrollbar role, its controlled element, orientation, and value. Keep the payload itself focusable for native keyboard scrolling.

Clear history is a small red outlined button containing a locked icon and Clear. The first activation unlocks it for 3,000 milliseconds, changes the icon and accessible label, and shows Clear? with a receding fill. Only another activation before that deadline deletes history. Expiry relocks without deleting anything; an activation after expiry starts a new confirmation window. Use a monotonic deadline, not animation completion, to authorize deletion. Escape and document hiding cancel the unlocked state. Reduced motion can suppress the fill animation without extending the deadline. Disable the control on an empty recording. Do not show a modal confirmation dialog.

Clearing invalidates loaded rows, selected payloads, counters, pending queries, and old incoming batches, and starts a fresh recording connection. Late work from the previous recording cannot repopulate history. Closing the only window quits, deletes the temporary recording and clears temporary analysis runs without a routine confirmation. Hiding or minimizing keeps capture running. Report deletion failures without hanging indefinitely.

| Condition | Visible behavior |
| --- | --- |
| Empty recording | Show connection state and that no events have arrived. Do not infer hook installation from connectivity. Disable event scrubbing and clearing. |
| No filter matches | Keep the toolbar visible, show No matching events, and offer Reset filters. Do not display an unrelated selected payload. |
| Disconnection | Preserve received history and inspection position. Show the gap and unknown loss count. |
| Known drops | Show the known count and reason separately from intervals with unknown losses. |
| History eviction | Update earliest retained time. If the selected event is removed, explain that and select the nearest retained matching event. Never silently relabel another payload as the evicted event. |
| Storage pressure | State that incoming data is being dropped, retain responsive navigation, and preserve available history. |
| Search timeout | Stop the query, keep the filters editable, and invite a narrower search or reset. |
| History unavailable | Show restart guidance and disable history controls, including Clear. Keep visible rows, original payload text and its scroll position readable. Native text selection and copying remain available. |
| Clear failure | Report the failure. Do not claim all history was deleted; isolate old recording results while cleanup is resolved. |

Use warm paper `#F2EADE`, panels `#EADFCD`, raised areas `#E0D2BD`, fields `#F9F6F0`, borders `#C1AF9A`, primary text `#604939`, secondary text `#66574D`, links and payload text `#3D5D71`, selected-event accents `#784F26`, and destructive controls `#8F3A2D`. The custom scrollbar uses a panel-colored track and a border-colored thumb, darkening on interaction. A small green connection dot is acceptable; Live is neutral. Keep visible focus rings, soft corners, and 400, 500, and 600 font weights. Use system UI text at 16px for primary controls and event names, 13.5px for secondary text and JSON, and system monospace for identifiers, timestamps, and payloads. No theme switcher or remote font dependency.

Keep UI work bounded. The scrubber does not justify loading the complete recording into the renderer. Render only the visible event neighborhood, keep a limited summary cache, and load selected payloads on demand. Bound text formatting and search work for large accepted events. Announce connection and mode changes and clear confirmation status; do not announce every incoming row.

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
the narrow journal divides its available height between events and payload.

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

Settings provides independent diagnosis and PR review model/effort pairs. Both start empty, including migration from an older prefilled model. Opening a model picker or Refresh models reads the local CLI catalog without starting a turn. Show every returned identifier and mark hidden entries; retain a missing saved choice visibly as unavailable. Effort choices come only from the selected model, and choosing a different model clears the effort. Discovery errors, cancellation and stale invocation errors preserve selections and other input. Save settings persists explicit choices without requiring collector credentials. Native select controls follow the existing analyzer controls, with narrow screens stacking each pair to keep full labels and options readable. Review execution remains unavailable until its delivery work is complete.
