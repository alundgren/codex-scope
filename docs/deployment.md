# Deployment

This is a setup design. codex-scope has no runnable application commands yet. Implementation must replace the lifecycle descriptions below with commands tested from clean Linux and macOS clones.

## Machines and connection

Use a Linux host that runs Codex and a Mac that runs the Electron viewer. They can communicate through a private tailnet. No GUI is needed on the Linux host, and the Mac initiates the live connection.

On Linux, the collector will expose its viewer API on a configurable loopback port. Tailscale Serve can proxy that service over HTTPS within the tailnet. For example, after starting a collector listening on the illustrative port 4318:

```sh
# Example only; first inspect existing Serve routes and choose an unused port.
tailscale serve status
tailscale serve --bg http://127.0.0.1:4318
```

Copy the HTTPS endpoint reported by Serve into local viewer configuration. A fictional example is `https://capture-host.example-tailnet.ts.net`. Do not commit the real address. Check existing routes before changing Serve configuration; do not reset unrelated services. See the [official command reference](https://tailscale.com/docs/reference/tailscale-cli/serve) for HTTPS prerequisites and route options.

Configure tailnet access rules so only the intended client can reach the service. Do not use a public publishing route. The viewer connection also requires a locally configured application token. The observer ingestion interface stays local to the Linux account and is never proxied by Serve.

## Intended first-run workflow

1. Clone this repository on Linux and macOS, install the pinned dependencies, and follow the implemented development commands.
2. Start the Linux collector with local configuration. Create its connection token locally without printing it into logs or shell history.
3. Run the observer installation command on Linux. Review the exact entries it adds and complete Codex's required hook trust flow. The installer must state whether the tested runtime needs a fresh session.
4. Configure the private route and put its endpoint and token in the Mac's local configuration.
5. Run the Mac development command to open Electron. Verify receipt of synthetic diagnostic events before using a real coding session.
6. Close the window to end the recording and delete its history. Observers can remain installed for the next viewer run. An uninstall command removes only owned observer entries.

## Local configuration

The implementation will provide placeholder-only configuration examples and document their actual schema. Machine names, account names, paths, endpoint URLs, credentials, and resource overrides belong in ignored local files or the OS configuration directory. Never put them into committed defaults or diagrams.

The repository ignore rules are a backstop, not an anonymizer. Do not add real payloads to tests, diagnostic logs, issues, screenshots, or examples. The UI intentionally displays original accepted payloads, which may themselves include sensitive text.

## Development delivery

The first Mac workflow is a development command from a clone that opens an Electron window. It does not require signing or notarization. The Linux collector runs as a local process initially; service-manager packaging can be documented separately if needed.

The setup is complete only after the smoke checks in [plan.md](../plan.md) have run on both target operating systems. Do not claim macOS validation from a Linux-only run.
