# codex-scope

A live inspector for Codex hook events. Capture on a Linux host, inspect on a Mac, and keep a bounded, temporary history while the viewer is open.

Linux capture and the Electron history viewer are implemented for synthetic testing. The viewer stores bounded temporary SQLite history, searches full accepted payloads and metadata, filters by session and hooks, and preserves reading position while arrivals continue. The version 1 live transport is implemented and tested with the landed collector using synthetic input on Linux. Real-session compatibility, private HTTPS proxy checks and macOS validation remain. Start with [Linux development](linux/README.md), [Electron development](electron/README.md) and [remaining work](plan.md).

Codex must keep working when capture fails. Missing events are acceptable; blocking a session, changing a hook decision, or exhausting the laptop's resources is not.

## Where it runs

[![Network topology: Codex and a local collector on Linux, connected through Tailscale Serve to an Electron viewer and temporary SQLite history on macOS.](docs/diagrams/topology.svg)](docs/diagrams/topology.svg)

One Linux capture host serves one macOS viewer. Multiple Codex sessions can appear in the same stream. Tailscale Serve is the documented remote connection method; the viewer accepts a configured endpoint rather than depending on a particular machine or tailnet.

## How capture behaves

[![Hook sequence: best-effort local handoff, prompt observer exit, bounded delivery to the viewer, and dropping events on failure.](docs/diagrams/hook-sequence.svg)](docs/diagrams/hook-sequence.svg)

Observers receive the payloads Codex supplies to supported hook events. They do not wrap existing hook commands, inspect their output, read transcripts, or collect environment variables. Accepted payloads retain their original fields. Oversized or excess events are dropped instead of silently truncated.

An explicit install command registers account-level observers while preserving existing hooks. Uninstall removes only unchanged entries owned by codex-scope. These commands are tested against isolated configuration; actual account installation and real-session behavior remain unverified. Codex's own hook trust process still applies.

No offline recording is planned, in this or later releases. Events generated while disconnected can be lost permanently. The viewer distinguishes known drops from intervals where the loss count is unknown.

## Explore the stream

[Run the Electron viewer](electron/README.md) with synthetic data or a configured collector. [Integrated regression validation](docs/electron-regression-validation.md) documents independent visual/resource commands, the complete scenario matrix and measured Linux limits. [Transport validation](docs/electron-transport-validation.md) records connection, failure and resource checks. [Search and navigation evidence](docs/electron-navigation-validation.md) records the current checks and limits. The [selected Event journal prototype](docs/mockups/event-journal-v2.html), [viewer behavior](ux.md) and [Electron build handoff](docs/mockups/event-journal-v2-notes.md) describe the experience.

- Follow incoming events, or freeze the view while capture continues.
- Filter by session, hook type, and free text across retained payloads.
- Drag the journal pin through older and newer events, or move to its Live endpoint to follow arrivals.
- Inspect and copy an event's complete accepted payload.
- Clear history without closing the app.

There is no historical playback. SQLite storage, sidecars, queries and pending operations have fixed limits. The viewer evicts oldest events when required, displays a bounded neighborhood and loads one selected payload.

## Run from a clone

Run `make -C linux test` to build and test the Linux implementation without Electron. [Linux development](linux/README.md) includes synthetic capture commands and tested tool versions. [Electron development](electron/README.md) documents its independent install, build, test and launch commands, validated under Linux Xvfb. Signing, notarization, automatic updates, and a Mac installer are outside the initial build.

`linux/` owns Linux code, dependencies, commands, and tests. `electron/` owns the viewer and its independent tooling. `protocol/` contains the shared wire contract and synthetic fixtures; neither application imports the other's implementation. Root `AGENTS.md` records project principles.

See [deployment](docs/deployment.md) for the proposed setup using fictional connection details, and [architecture](docs/architecture.md) for responsibilities and failure behavior. [ux.md](ux.md) records the viewing experience.

## Data lifetime and privacy

SQLite history lives in a private app-owned directory. Normal close quits and deletes the recording and sidecars. Startup removes abandoned owned recordings without reopening or recovering them. Linux Electron tests cover these operations; native macOS lifecycle remains unverified. Deletion is ordinary filesystem cleanup, not forensic secure erasure.

The Linux collector has no event files or database. It discards undelivered events when the connection ends. A dead connection may take a bounded heartbeat timeout to detect.

Raw hook payloads can contain commands, paths, prompt text, or secrets already supplied to Codex. They stay inside the configured connection and local recording. There is no telemetry or payload logging. Examples and screenshots in this repository use synthetic data. Keep real endpoints, credentials, captures, and machine configuration outside Git.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [MIT license](LICENSE)
