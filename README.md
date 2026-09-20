# codex-scope

## Install the server side

```sh
git clone https://github.com/alundgren/codex-scope.git
cd codex-scope
./linux/install.sh
```

Keep the pairing URL printed by the installer.

## Start the Electron app

```sh
vp i --frozen-lockfile
vp -C electron run setup
./electron/start.sh
```

Paste the pairing URL into Settings, save it, and select **Start capture**.

To run the app without a collector:

```sh
./electron/start.sh --synthetic
```

## Network topology

[![Network topology: Codex and a local collector on Linux, connected through Tailscale Serve to an Electron viewer and temporary SQLite history on macOS.](docs/diagrams/topology.svg)](docs/diagrams/topology.svg)

## Hook sequence

[![Hook sequence: best-effort local handoff, prompt observer exit, bounded delivery to the viewer, and dropping events on failure.](docs/diagrams/hook-sequence.svg)](docs/diagrams/hook-sequence.svg)

## What is codex-scope for?

Codex Scope captures Codex hook events on a Linux host and shows them in a live Electron viewer. It keeps a bounded, temporary history so you can inspect tool calls and payloads while a session is running.
