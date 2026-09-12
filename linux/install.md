# Install the Linux collector

Use a normal Linux account with systemd user services and Codex CLI. The
installed collector, observer, and recovery command are native Rust
executables. They need neither Python nor Bun. Tailscale is optional.

The collector also performs bounded, read-only Git queries in working directories
supplied by hook events to label sessions with repository and branch names.
Git at `/usr/bin/git` is optional; without it the viewer uses directory or session
ID labels. This collects additional metadata beyond hook input. It does not read
transcripts, remote URLs, working-file contents or other hook output. The observer
never waits for Git. See [lookup limits and delayed updates](README.md#git-session-labels).

Build from the checkout with a Rust toolchain, or place prebuilt `codex-scope`
and `codex-scope-observer` beside `linux/install.sh`. In a source checkout, the
script runs a release Cargo build before guided setup so source updates cannot
silently use older executables. A prebuilt pair beside the script starts
directly:

```sh
git clone https://github.com/alundgren/codex-scope.git
cd codex-scope
./linux/install.sh
```

You can also build explicitly and run the native command:

```sh
cargo build --locked --release --manifest-path linux/Cargo.toml --bins
./linux/target/release/codex-scope setup
```

Setup names missing prerequisites and stops. It does not install packages or
run sudo. It asks whether to use Tailscale and suggests `~/.codex` for existing
Codex configuration. It checks for `config.toml`, then asks permission before
reading that file, `hooks.json`, and the relevant local service settings. It
does not read transcripts or display configuration contents, tokens, or
captured payloads. JSON and TOML with duplicate keys are rejected.

Accept the suggested directories and available ports, or customize them. Paths
must be below your home directory, outside the checkout, without symlink
components. Existing application/data directories and services are refused.
The loopback suggestion starts at 4319; Tailscale HTTPS starts at 8443. Neither
is a reservation: setup checks again before making changes.

Setup may ask to remove group/other write permission from selected directories
and their parents. Those permissions are recorded and restored during removal
only if they have not subsequently changed. If lingering is disabled, setup
stops and gives the `loginctl enable-linger` command for you to run with
administrator approval. This prerequisite is an account-wide setting and is not
changed or undone by the installer.

An automatic rehearsal installs and uninstalls hooks in a private temporary
configuration. An isolated app-server probe checks all twelve registrations
against your installed Codex. There is no version allowlist. These checks do
not start a model session, grant trust, or prove real-session compatibility.
You can run the same registration probe independently:

```sh
./linux/target/release/codex-scope probe
```

Before changing live files, setup prints the selected paths, endpoint, service,
and hook count and asks for approval. Afterward:

1. Open another terminal and run the Codex command printed by setup. Use
   `/hooks` to review and approve only its twelve new commands, then exit.
   If an unrelated required MCP prevents startup, fix it separately. Setup
   will not disable it or bypass hook trust.
2. Run the short task printed by setup in a fresh session in your usual Codex
   client. Confirm that it finishes normally. The diagnostic viewer must also
   receive an event containing this test's unique marker within three minutes.
3. Setup stops the collector. Run the second printed task and confirm it still
   finishes normally. Setup restarts the collector and verifies its endpoint.

Only one viewer can connect. Close an existing viewer before these checks.
The diagnostic viewer does not save payloads; events generated while no viewer
is connected are discarded and cannot be recovered. Concurrent sessions can
contribute to the total count. A matching marker proves receipt of the test
input, not coverage of every hook event or a latency budget.

On success, the collector runs as `codex-scope.service`, enabled for the user
at startup. If selected, a dedicated private Tailscale Serve HTTPS listener
also persists. Setup prints the endpoint, token-file path, and an SSH copy
command for the other machine. Configure your UI with that endpoint and bearer
token. The diagnostic test does not establish UI or cross-device compatibility.

The two native executables are copied to the chosen application directory.
Another copy of `codex-scope` and a shell launcher provide permanent recovery
tools. Service commands, hook commands, credentials, and recovery tools have no
dependency on the checkout or a language toolchain. The checkout can be removed
afterward.

## Inspect, verify, and uninstall

The permanent management command is:

```sh
~/.local/state/codex-scope-installer/manage.sh
```

It offers `inspect`, `verify`, `uninstall`, and `purge`. These actions can also
be supplied as arguments. To install or upgrade, run `./linux/install.sh` from
the updated checkout. It builds the current source and detects the installation
state. An installed copy defaults to an explicit upgrade prompt. Upgrades keep
the token, endpoint, paths, service settings, and hook commands, and replace the
collector, observer, and recovery executable. Identical executables need no restart.

The installer checks observer registration compatibility before replacement and
checks the endpoint after restarting the collector. These checks do not prove
real-session capture; use `manage.sh verify` for the interactive checks. Events
during the restart are lost. Failed upgrades restore the previous executables;
an interrupted upgrade is recovered by rerunning `./linux/install.sh`. Edited
executables or service definitions stop the upgrade and are preserved.

After an uninstall, the same script offers to delete retained credentials,
backups, and recovery tools before beginning a fresh installation. That fresh
installation creates a new token. Interrupted initial setup is rolled back first.

```sh
~/.local/state/codex-scope-installer/manage.sh inspect
~/.local/state/codex-scope-installer/manage.sh verify
~/.local/state/codex-scope-installer/manage.sh uninstall
```

The copied executable also accepts `codex-scope manage ACTION`. Both entry
points ask permission before reading the installation record and selected
configuration.

Uninstall removes unchanged owned hooks, the service, the dedicated Serve
listener, and application files. It never resets all Tailscale routes or
restores the whole Codex configuration over later edits. Changed or duplicate
hooks, modified services, extra routes on its listener, and edited files are
preserved and reported. When ownership is uncertain, dependencies remain in
place for manual review.

Uninstall offers to delete the unchanged local token and configuration backups;
keeping them is the default. It leaves inert Codex hook approval records and
lock files. A token copied to another machine must be removed there separately.
Recovery tools and the installation record stay available until explicitly
purged after successful uninstall:

```sh
~/.local/state/codex-scope-installer/manage.sh purge
```

Purge refuses edited or unexpected recovery files before deleting retained
credentials or backups. After purge, a fresh installation is possible.
Normal upgrades do not require uninstall or purge.

## Failure and recovery

Failure or Ctrl+C during installation triggers rollback. Every external change
has a durable intent recorded before it is attempted. A process kill, power
loss, or VM crash cannot run immediate cleanup: the next invocation detects the
unfinished record and offers rollback before allowing a new installation.

Do not edit Codex hooks, the Scope unit, or its Serve listener concurrently with
setup/removal. Comparisons detect many changes but cannot make independent
editors, systemd, and Tailscale share a transaction. Cleanup preserves ambiguous
resources and reports incomplete recovery rather than claiming success.

Configuration, command output, and probe output each have a 4 MiB limit.
Commands and the full app-server exchange have a 20-second deadline. Setup
terminates child process groups on failure so inherited output pipes cannot
keep it waiting. Native executable copies have a 64 MiB limit; the development
binary tested during this port was 51 MiB, while release binaries are smaller.
These limits bound setup work separately from the collector's capture budgets.

No credentials or command output are included in setup error logs. For a
collector startup failure, inspect the local service status:

```sh
systemctl --user status codex-scope.service --no-pager
journalctl --user -u codex-scope.service -n 30 --no-pager
```

An occupied loopback port is reported explicitly. Setup does not stop the
process occupying it. For Tailscale mode, the account must already have access
to configure Serve, be logged in, and have HTTPS certificates enabled. Existing
foreground Serve handlers or Tailscale Services require manual configuration;
setup stops rather than rewriting them. Tailnet access rules still apply.

Scope uses `serve --https=PORT off` to remove only its private listener, never
`serve reset` or Funnel. See the
[Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Development validation

Linux build, tests, the isolated Codex probe, and the temporary systemd check
use Cargo or shell directly. They do not require the Electron workspace:

```sh
cargo test --manifest-path linux/Cargo.toml
./linux/target/debug/codex-scope probe
./linux/scripts/check_service.sh
```

The service check creates a uniquely named temporary user service, sends one
synthetic event, verifies authenticated receipt, stops the service, and checks
that the observer succeeds with no receiver. It removes its service and
temporary files afterward. Its optional argument selects a loopback port.

For development-only terminal evidence, build the release binaries and run:

```sh
node linux/scripts/record_setup.ts .artifacts/visual/native-setup
node linux/scripts/render_setup.ts .artifacts/visual/native-setup
```

The recorder uses a real PTY and native CLI with an isolated temporary home.
Its Codex registration/approval metadata, service commands, and Tailscale
prerequisite response are synthetic. It runs the real native collector and
observer for the live marker and stopped-collector checks. Scenarios cover
read consent denial, missing prerequisites, probe failure, Tailscale
prerequisites, symlinked service enablement refusal, cancellation rollback,
install/inspect/uninstall/purge, edited
service preservation, interrupted-install recovery, upgrade confirmation and
decline, unchanged builds, failed-upgrade rollback, interrupted-upgrade recovery,
and fresh setup after removal. The renderer needs the
workspace's development Playwright dependency and browser; it does not change
the Linux build or installed prerequisites. Generated casts, PNGs and video stay
under ignored `.artifacts/visual/`.
