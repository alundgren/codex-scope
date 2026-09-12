# Deployment

Start with [guided Linux installation](../linux/install.md) for a permanent collector and optional private HTTPS listener. A basic live Linux smoke test has passed; guided live deployment and private proxy validation remain outstanding. The Electron viewer supports synthetic fixtures and the version 1 live connection. The Rust/TypeScript port needs its own validation evidence; earlier Python/C results do not establish the new runtime behavior.

## Machines and connection

Use a Linux host that runs Codex and a Mac that runs the Electron viewer. They can communicate through a private tailnet. No GUI is needed on the Linux host, and the Mac initiates the live connection.

On Linux, the collector will expose its viewer API on a configurable loopback port. Tailscale Serve can proxy that service over HTTPS within the tailnet. For example, after starting a collector listening on the illustrative port 4319:

```sh
# Example only; first inspect existing Serve routes and choose an unused port.
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:4319
```

Copy the HTTPS endpoint reported by Serve into local viewer configuration. A fictional example is `https://capture-host.example-tailnet.ts.net:8443`. Do not commit the real address. Check existing routes before changing Serve configuration; do not reset unrelated services. See the [official command reference](https://tailscale.com/docs/reference/tailscale-cli/serve) for HTTPS prerequisites and route options.

Configure tailnet access rules so only the intended client can reach the service. Do not use a public publishing route. The viewer connection also requires a locally configured application token. The observer ingestion interface stays local to the Linux account and is never proxied by Serve.

## Intended first-run workflow

1. Clone this repository on Linux and run `./linux/install.sh`. It copies its runtime outside the checkout, checks prerequisites and permissions, and offers private Tailscale access.
2. Review and approve the exact observer hooks using the printed Codex CLI command and `/hooks`.
3. Complete the two guided tasks in a fresh session in your usual Codex client. The collector remains enabled only after setup succeeds.
4. Configure the private route and put its endpoint and token in the Mac's local configuration.
5. Run the Mac development command to open Electron. Verify receipt of synthetic diagnostic events before using a real coding session.
6. Close the window to end the recording and delete its history. Observers can remain installed for the next viewer run. An uninstall command removes only owned observer entries.

## Local configuration

Linux commands accept explicit runtime-directory and private token-file paths. The collector uses loopback port 4319 by default; `--port` selects another port. `codex-scope token --token-file PATH` creates a private token without printing it. Run commands from `linux/`; complete local examples are in its README. Machine names, account names, paths, endpoint URLs, and credentials belong in ignored local files or the OS configuration directory. Never put them into committed defaults or diagrams.

The repository ignore rules are a backstop, not an anonymizer. Do not add real payloads to tests, diagnostic logs, issues, screenshots, or examples. The UI intentionally displays original accepted payloads, which may themselves include sensitive text.

## Development delivery

The Mac development workflow uses Bun-managed dependencies and `vp` commands from a clone to open an Electron window. It does not require signing or notarization. The Linux collector can run in the foreground for development or as the user service installed by guided setup. Its native diagnostic viewer can test the stream without Electron and does not persist events. Source installation needs Rust/Cargo, a C compiler and a linker. Installed native Linux executables need neither Rust nor Bun to run; the installed files and their system library requirements must match the host platform.

The setup is complete only after the smoke checks in [plan.md](../plan.md) have run on both target operating systems. Do not claim macOS validation from a Linux-only run.
