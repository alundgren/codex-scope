# Viewer alternatives

These four interactive studies explore the existing viewer contract using synthetic fixtures. Open `alternatives.html` directly in a browser. The numbered controls switch layouts and reset the demo for comparison.

1. Stream desk keeps the event list beside a payload inspector.
2. Session workspace adds a session filter and puts the payload below the list.
3. Event journal gives each chronological entry more room for its preview.
4. Focus view replaces the list with the selected payload and a Back action.

All four use the existing warm paper palette and system fonts. Layout and navigation vary; there is no product theme preference. The session filter is a proposed addition for concurrent sessions. These alternatives do not replace the agreed product design until one is selected.

The prototype simulates arrivals explicitly, keeping demos repeatable. It has no collector, database, credentials, or Electron integration. Scenario controls outside the app demonstrate connection loss, empty history, known drops, eviction, storage pressure, and search timeout. Payload fixtures illustrate the UI and are not a runtime compatibility claim. Compact metadata and JSON use 13.5px for scanning; event names and primary controls remain 16px. The single HTML file has no external assets or network requests.

Browser validation covered all four alternatives in Chromium at 1440px and 600px window widths: selection freezes following, new matching-event counts, live return, literal search and reset, multiple hook filters, timestamp validation and jump, persistent reconnect gap notice, clear cancellation and confirmation, demo recovery, exceptional states, and narrow-window Back navigation. No browser errors or page-level horizontal overflow were observed. This validates a browser mockup, not Electron behavior or collection.
