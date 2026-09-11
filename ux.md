# Viewer experience

The task is to see what Codex emits, find an event, and inspect its input without losing the current reading position. The selected design is the [Event journal prototype](docs/mockups/event-journal-v2.html). Open the HTML file locally in a browser. The [Electron build handoff](docs/mockups/event-journal-v2-notes.md) supplies implementation boundaries and acceptance checks. The prototype is synthetic, not a running Electron application.

The first [Electron implementation](electron/README.md) opens a fixed synthetic
recording. Row selection, original-text inspection, copying and the custom
payload scrollbar work. Search, session and hook filters, Live navigation and
Clear are disabled placeholders for later work. The static journal pin marks
the selected visible row; it is not a scrubber. The header says Synthetic data,
with no connection claim. Three to five neighboring rows fit the current
window, and selecting an adjacent row exposes further fixtures. The narrow
journal keeps three rows above the payload. All accepted payloads display in
their original text form, with no formatting expansion. Metadata and previews
can use visible ellipses to keep the payload accessible; inspection and copying
preserve the complete text. These are the deliberate partial-scope differences
from the full experience below. [Recorded Linux evidence](docs/electron-validation.md)
compares the actual app with the reference.

Use “Codex Scope” in the window title. Event journal is the single view title. Do not add subheadings, event numbers, a Back to events button, a timestamp-jump button, or a separate Go live toolbar button. The journal and selected payload remain visible together. At narrow widths, put the payload below the journal instead of replacing it.

The toolbar contains a literal payload search, a session dropdown with All sessions as its default, and a multi-select hook filter with All hooks as its default. Filters apply to retained history and live arrivals equally. Filtering changes what is displayed, not what is collected. Debounce search, cancel obsolete queries, and prevent stale results from replacing a newer query. Identify payload matches even when they occur outside the visible preview.

Each journal entry shows receive time in UTC, hook type, a short preview, and the session identifier. Keep the selected entry visually distinct with a warm background and a small accent marker. Show a bounded neighborhood around it. The left journal has no scrollbar. Do not simply hide a scrollbar on a long list that still requires scrolling to discover events.

The journal's left pin is a vertical scrubber. The top is the oldest matching retained event. Each stop represents one matching event in recording order, not an equal duration of elapsed time. The last stop below the newest event is Live. Clicking or dragging the track selects a stop and updates both journal entries and payload. The newest event itself can still be inspected in history mode; only the Live stop resumes following. The Live label is part of the scrubber and is also clickable. Use neutral warm text and a quiet warm background for its active state. Avoid a green fill that competes with event content.

Arrow Up and Left select the previous event; Arrow Down and Right select the next event. Home selects the oldest retained match; End selects Live. Page Up and Page Down move five matching events. The mouse wheel over the journal moves through events with bounded updates. Support touch dragging. Expose a named vertical slider with its current receive time and hook, or Live, as its accessible value. Event rows remain keyboard-operable buttons.

Selecting an event or scrubbing away from Live freezes following while capture continues. Incoming events do not change the selected event, visible neighborhood, or payload scroll position. Count new matching events separately. Returning to Live clears this count and selects the newest matching event. Normal application startup starts in Live; the prototype deliberately opens a populated historical event to demonstrate inspection.

Connection and viewing mode are separate. Show whether the viewer is connected and whether its position is held. Live while disconnected does not reconnect the collector or recover missed events. Reconnecting starts a new live connection and preserves a visible coverage gap with an unknown loss count. It does not move a user who is inspecting history.

The inspector shows the complete accepted payload as plain text, with receive time, session, optional tool, and byte count. Copy JSON copies the original accepted payload bytes as text, not a reconstructed object with fields removed or reordered. The production data contract must preserve those original bytes. The prototype formats synthetic objects for illustration and does not demonstrate byte preservation.

The right payload pane scrolls normally with wheel, trackpad, touch, and keyboard. Hide browser-native scrollbar visuals and provide a custom draggable thumb and track. Derive thumb height from the visible fraction of content and thumb position from scroll offset. Clicking the track positions the thumb around the click; dragging preserves the initial grab offset. Arrow keys move a small distance, Page Up and Page Down move most of the viewport, and Home and End reach its limits. Hide and remove the custom control from keyboard navigation when content fits. Use a named scrollbar role, its controlled element, orientation, and value. Keep the payload itself focusable for native keyboard scrolling.

Clear history is a small red outlined button containing a locked icon and Clear. The first activation unlocks it for 3,000 milliseconds, changes the icon and accessible label, and shows Clear? with a receding fill. Only another activation before that deadline deletes history. Expiry relocks without deleting anything; an activation after expiry starts a new confirmation window. Use a monotonic deadline, not animation completion, to authorize deletion. Escape and document hiding cancel the unlocked state. Reduced motion can suppress the fill animation without extending the deadline. Disable the control on an empty recording. Do not show a modal confirmation dialog.

Clearing invalidates loaded rows, selected payloads, counters, pending queries, and old incoming batches, and starts a fresh recording connection. Late work from the previous recording cannot repopulate history. Closing the only window quits and deletes the temporary recording without a routine confirmation. Hiding or minimizing keeps capture running. Report deletion failures without hanging indefinitely.

| Condition | Visible behavior |
| --- | --- |
| Empty recording | Show connection state and that no events have arrived. Do not infer hook installation from connectivity. Disable event scrubbing and clearing. |
| No filter matches | Keep the toolbar visible, show No matching events, and offer Reset filters. Do not display an unrelated selected payload. |
| Disconnection | Preserve received history and inspection position. Show the gap and unknown loss count. |
| Known drops | Show the known count and reason separately from intervals with unknown losses. |
| History eviction | Update earliest retained time. If the selected event is removed, explain that and select the nearest retained matching event. Never silently relabel another payload as the evicted event. |
| Storage pressure | State that incoming data is being dropped, retain responsive navigation, and preserve available history. |
| Search timeout | Stop the query, keep the filters editable, and invite a narrower search or reset. |
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
cleanup result. Existing installations offer inspection, verification, removal,
and optional deletion of retained files, without an implicit upgrade.
