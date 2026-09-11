# Viewer experience

The task is to see what Codex emits, find an event, and inspect its input without losing the current reading position.

## One stream, two viewing modes

Live mode follows the newest matching events. Scrolling away from the newest row, selecting a row for inspection, or choosing Pause freezes following. Capture continues, while a count shows newly received matching events. Go live clears the historical position and follows the newest matching rows. There is no Play control or time-based reenactment.

Connection status and viewing mode are separate. "History · capturing" means the position is frozen but events are arriving. "Disconnected" means events may be missing. Go live cannot repair a disconnected transport or fetch missed events.

## Find and inspect

Keep hook selection, literal text search, and Pause or Go live prominent. Support multiple selected hook types, with All as the default. Apply the same filters to live and historical queries. Debounce text changes and keep stale query results from replacing newer ones.

Rows show receive time, hook type, session, tool where available, and a short preview. Session IDs distinguish concurrent Codex sessions. Previews may be shortened visibly; the inspector shows the complete accepted payload. A search hit can occur in text that is not visible in the preview, so identify the matching field or highlight it in the inspector.

Load older and newer pages around stable event IDs. Offer a timestamp jump, show the display timezone, and explain when the requested time predates retained history. Keep scroll position stable when filters return results and when new events arrive. On narrow windows, the inspector can replace the list with a clear Back action.

The inspector supports expanding JSON fields and copying the accepted raw payload. Treat all values as plain text. Large accepted events must not trigger unbounded syntax highlighting, formatting, or expansion work.

## Limits and exceptional states

- Empty recording: show connection state and whether any event has been received. Do not claim hooks are installed from a working connection alone.
- No filter matches: keep filters visible and provide a clear reset action.
- Disconnection: preserve history and show the affected interval with unknown loss count.
- Known drops: show a bounded count and reason when available, without claiming complete accounting.
- Storage eviction: show the earliest retained timestamp. If the current event is evicted, say so and offer the nearest retained history. Any already open payload remains subject to a memory cap.
- Storage or resource pressure: stop accepting excess data while preserving responsive navigation. State why collection is limited.
- Query timeout: stop work and invite a narrower search; do not keep background scans running.
- Clear history: use a destructive control and a brief confirmation because deletion is irreversible. Clear loaded rows, selected payloads, counters, and pending old results too.
- Window close: quit and clean up without a routine confirmation dialog. If deletion fails, report that failure without hanging indefinitely.

## Visual decisions

The [SVG mockup](docs/diagrams/event-stream.svg) is a design illustration with synthetic data, not a screenshot of a working product. Use warm paper `#F2EADE`, surfaces `#EADFCD`, primary text `#604939`, and blue-gray links `#3D5D71`. Use `#784F26` sparingly for the main action and `#8F3A2D` for destructive actions.

Use system UI fonts in the initial offline desktop app, with system monospace for timestamps, identifiers, and JSON. Keep normal text at least 16px and use 400, 500, and 600 weights. The system stack avoids a network font dependency. No theme switcher is planned.

Virtualize the event list. Keyboard navigation, visible focus, semantic controls, and accessible labels belong in the first implementation. Avoid announcing every incoming row to assistive technology; announce connection and mode changes instead.
