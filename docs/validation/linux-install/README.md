# Guided installer validation

Linux x86_64, Python 3.14.4, Codex CLI 0.153.4, and systemd 259.5 were used
for this development check on 2026-09-11. No live account hooks or persistent
Tailscale routes were installed during implementation validation.

- `make -C linux test` covers the collector and observer plus guided setup,
  rollback, privacy refusal, command/output limits, edited resources, ownership
  changes, symlink parents, existing installations, and copied runtime imports.
- `make -C linux probe` checks actual isolated Codex registrations and untrusted
  status. It does not start a model session or establish event coverage.
- `make -C linux service-check` validates the generated unit with
  `systemd-analyze --user verify`, starts a uniquely named temporary user service,
  checks authenticated synthetic delivery, stops it, and checks the absent
  receiver. The temporary unit is collected afterward.

The [terminal walkthrough](walkthrough.webm) replays actual PTY output from the
changed installer in xterm.js at 120 columns by 42 rows. The screenshots below
were inspected at the same size. There is no visual reference/mockup for this
CLI. The original asciicast recordings are linked alongside each screenshot.
The recording contains synthetic paths and configuration only, with no tokens
or captured payloads.

| Scenario | Screenshot | PTY recording |
| --- | --- | --- |
| Missing prerequisite, no live changes | [failure](failure.png) | [recording](failure.cast) |
| Configuration read permission declined | [decline](decline.png) | [recording](decline.cast) |
| Ctrl+C at hook approval, automatic rollback and inspection | [cancel](cancel.png) | [recording](cancel.cast) |
| Local capture, collector-stop test, uninstall, retained backups | [success](success.png) | [recording](success.cast) |
| Edited service preserved and incomplete cleanup reported | [edited](edited.png) | [recording](edited.cast) |
| Optional Tailscale setup and removal | [remote](remote.png) | [recording](remote.cast) |
| Interrupted installation record recovered on next invocation | [recovery](recovery.png) | [recording](recovery.cast) |

The PTY fixture uses the real copied collector, observer, and diagnostic viewer
for local scenarios, with synthetic input. Host service commands, Codex approval
metadata, and Tailscale operations are simulated. Remote HTTPS delivery and
real interactive hook approval are therefore **not established by this
walkthrough**. The interrupted-record case simulates a crash before the final
success record, rather than cutting power to this VM. Real systemd behavior and
Codex registration are checked separately as described above.

The earlier user-reported live smoke test is recorded in `plan.md`. It is not a
substitute for running this new guided installer end to end on a live account.
Actual private HTTPS proxy delivery, cross-device UI connectivity, other Codex
versions, broader event coverage, and macOS behavior remain unverified.

To repeat the PTY scenarios with the optional development-only `pexpect`
package available:

```sh
make -C linux
python3 linux/scripts/record_setup.py /tmp/scope-install-walkthrough
```

Do not run two copies of the PTY fixture simultaneously: each intentionally
uses the same suggested local port where available. The recorder never invokes
live host service or Tailscale mutations. Review the resulting `.cast` files
with an asciicast player or a terminal emulator. `pexpect`, xterm.js, Playwright,
and Chromium are validation tools only; none is shipped by the installer.
