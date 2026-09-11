# codex-scope

A live inspector for Codex hook events. Capture on a Linux host, inspect on a Mac, and keep a bounded, temporary history while the viewer is open.

**Status: design agreed, implementation not started.** The images describe the intended application. There is no runnable collector or viewer yet. Start with [plan.md](plan.md) when implementing.

Codex must keep working when capture fails. Missing events are acceptable; blocking a session, changing a hook decision, or exhausting the laptop's resources is not.

## Where it runs

[![Network topology: Codex and a local collector on Linux, connected through Tailscale Serve to an Electron viewer and temporary SQLite history on macOS.](docs/diagrams/topology.svg)](docs/diagrams/topology.svg)

One Linux capture host serves one macOS viewer. Multiple Codex sessions can appear in the same stream. Tailscale Serve is the documented remote connection method; the viewer accepts a configured endpoint rather than depending on a particular machine or tailnet.

## How capture behaves

[![Hook sequence: best-effort local handoff, prompt observer exit, bounded delivery to the viewer, and dropping events on failure.](docs/diagrams/hook-sequence.svg)](docs/diagrams/hook-sequence.svg)

Observers receive the payloads Codex supplies to supported hook events. They do not wrap existing hook commands, inspect their output, read transcripts, or collect environment variables. Accepted payloads retain their original fields. Oversized or excess events are dropped instead of silently truncated.

An explicit install command will register account-level observers while preserving existing hooks. Uninstall will remove only entries owned by codex-scope. Codex's own hook trust process still applies.

No offline recording is planned, in this or later releases. Events generated while disconnected can be lost permanently. The viewer will distinguish known drops from intervals where the loss count is unknown.

## Explore the stream

[![Design mockup of the event viewer, with hook and text filters, frozen history, new-event count, full JSON inspection, and a Go live control. All displayed data is synthetic.](docs/diagrams/event-stream.svg)](docs/diagrams/event-stream.svg)

- Follow incoming events, or freeze the view while capture continues.
- Filter by hook type and free text across retained payloads.
- Scroll through older and newer events, jump to a time, or return to live.
- Inspect and copy an event's complete accepted payload.
- Clear history without closing the app.

There is no historical playback. The viewport, loaded rows, pending work, payload sizes, and SQLite storage all have limits. Older history is evicted as necessary; the interface shows what remains available.

## Run from a clone

The first implementation will support a development command that opens Electron on macOS from this repository. Signing, notarization, automatic updates, and an installer are outside the initial build. Dependency versions and exact commands will be added when they are implemented and tested, rather than documented as working ahead of time.

See [deployment](docs/deployment.md) for the proposed setup using fictional connection details, and [architecture](docs/architecture.md) for responsibilities and failure behavior. [ux.md](ux.md) records the viewing experience.

## Data lifetime and privacy

SQLite history lives on the Mac. Normal window close quits the app and deletes its recording directory, including database sidecar files. After a crash, the next launch removes abandoned recording files. Closing the window is distinct from hiding or minimizing it. Deletion is ordinary filesystem cleanup, not forensic secure erasure.

The Linux collector has no event files or database. It discards undelivered events when the connection ends. A dead connection may take a bounded heartbeat timeout to detect.

Raw hook payloads can contain commands, paths, prompt text, or secrets already supplied to Codex. They stay inside the configured connection and local recording. There is no telemetry or payload logging. Examples and screenshots in this repository use synthetic data. Keep real endpoints, credentials, captures, and machine configuration outside Git.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [MIT license](LICENSE)
