# codex-scope

A live inspector for Codex hook events. Capture on a Linux host, inspect on a Mac, and keep a bounded, temporary history while the viewer is open.

**Status: Linux capture, guided installation, and a finite Electron inspector are implemented.** The Electron app inspects and copies five bundled hook fixtures independently of the collector. Live transport, database history, filters and Clear remain deferred. Broader real-session and macOS validation remain. Start with [guided Linux installation](linux/install.md), [Linux development](linux/README.md), [Electron development](electron/README.md) and [remaining work](plan.md).

Codex must keep working when capture fails. Missing events are acceptable; blocking a session, changing a hook decision, or exhausting the laptop's resources is not.

## Where it runs

[![Network topology: Codex and a local collector on Linux, connected through Tailscale Serve to an Electron viewer and temporary SQLite history on macOS.](docs/diagrams/topology.svg)](docs/diagrams/topology.svg)

One Linux capture host serves one macOS viewer. Multiple Codex sessions can appear in the same stream. Tailscale Serve is the documented remote connection method; the viewer accepts a configured endpoint rather than depending on a particular machine or tailnet.

## How capture behaves

[![Hook sequence: best-effort local handoff, prompt observer exit, bounded delivery to the viewer, and dropping events on failure.](docs/diagrams/hook-sequence.svg)](docs/diagrams/hook-sequence.svg)

Observers receive the payloads Codex supplies to supported hook events. They do not wrap existing hook commands, inspect their output, read transcripts, or collect environment variables. Accepted payloads retain their original fields. Oversized or excess events are dropped instead of silently truncated.

An explicit install command registers account-level observers while preserving existing hooks. Uninstall removes only unchanged entries owned by codex-scope. A basic live install, capture, collector-stop, and uninstall trial passed; broader compatibility and performance checks remain incomplete. Codex's own hook trust process still applies.

No offline recording is planned, in this or later releases. Events generated while disconnected can be lost permanently. The viewer will distinguish known drops from intervals where the loss count is unknown.

## Explore the stream

[Run the finite Electron inspector](electron/README.md) to inspect original synthetic payloads. [Linux Electron evidence](docs/electron-validation.md) records the checks and limits. The [selected Event journal prototype](docs/mockups/event-journal-v2.html), [viewer behavior](ux.md) and [Electron build handoff](docs/mockups/event-journal-v2-notes.md) describe the complete intended experience below. These live-history controls are not yet implemented in the Electron slice.

- Follow incoming events, or freeze the view while capture continues.
- Filter by session, hook type, and free text across retained payloads.
- Drag the journal pin through older and newer events, or move to its Live endpoint to follow arrivals.
- Inspect and copy an event's complete accepted payload.
- Clear history without closing the app.

There is no historical playback. The complete viewer will bound SQLite storage and evict older history as necessary. The current Electron slice bounds its fixed fixtures, visible rows, selected payload and pending operations.

## Run from a clone

Run `make -C linux test` to build and test the Linux implementation without Electron. [Linux development](linux/README.md) includes synthetic capture commands and tested tool versions. [Electron development](electron/README.md) documents its independent install, build, test and launch commands, validated under Linux Xvfb. Signing, notarization, automatic updates, and a Mac installer are outside the initial build.

`linux/` owns Linux code, dependencies, commands, and tests. `electron/` owns the viewer and its independent tooling. `protocol/` contains the shared wire contract and synthetic fixtures; neither application imports the other's implementation. Root `AGENTS.md` records project principles.

See [deployment](docs/deployment.md) for the proposed setup using fictional connection details, and [architecture](docs/architecture.md) for responsibilities and failure behavior. [ux.md](ux.md) records the viewing experience.

## Data lifetime and privacy

The planned SQLite history will live on the Mac. Normal close must quit and delete its recording directory and sidecars, with abandoned-file cleanup after a crash. Those lifecycle operations remain unimplemented. The current Electron inspector keeps only bundled synthetic data in memory and quits on close. Deletion of future recordings will be ordinary filesystem cleanup, not forensic secure erasure.

The Linux collector has no event files or database. It discards undelivered events when the connection ends. A dead connection may take a bounded heartbeat timeout to detect.

Raw hook payloads can contain commands, paths, prompt text, or secrets already supplied to Codex. They stay inside the configured connection and local recording. There is no telemetry or payload logging. Examples and screenshots in this repository use synthetic data. Keep real endpoints, credentials, captures, and machine configuration outside Git.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [MIT license](LICENSE)
