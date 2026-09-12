# Install the Linux collector

Use a normal Linux account with systemd user services, Python 3.11 or newer,
Make, a C compiler, and Codex CLI. Setup names missing prerequisites and stops;
it does not install packages or run sudo. Tailscale is optional.

```sh
git clone https://github.com/alundgren/codex-scope.git
cd codex-scope
./linux/install.sh
```

Setup asks whether to use Tailscale and suggests `~/.codex` for existing Codex
configuration. It checks for `config.toml`, then asks permission before reading
that file, `hooks.json`, and the relevant local service settings. It does not
read transcripts or display configuration contents, tokens, or captured payloads.

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

The compiled observer and Python package are copied to the chosen application
directory. Service commands, hook commands, credentials, and recovery tools
have no dependency on the clone; the clone can be removed afterward.

## Inspect, verify, and uninstall

The permanent management command is:

```sh
~/.local/state/codex-scope-installer/manage.sh
```

It offers `inspect`, `verify`, `uninstall`, and `purge`. These actions can also
be supplied as arguments. A second run of `linux/install.sh` finds the same
installation record; it never overwrites a working install or performs an
in-place upgrade.

```sh
~/.local/state/codex-scope-installer/manage.sh inspect
~/.local/state/codex-scope-installer/manage.sh verify
~/.local/state/codex-scope-installer/manage.sh uninstall
```

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

Purge refuses edited recovery tools. After purge, a fresh installation is
possible. In-place upgrades are intentionally not implemented.

## Failure and recovery

Failure or Ctrl+C during installation triggers rollback. Every external change
has a durable intent recorded before it is attempted. A process kill, power
loss, or VM crash cannot run immediate cleanup: the next invocation detects the
unfinished record and offers rollback before allowing a new installation.

Do not edit Codex hooks, the Scope unit, or its Serve listener concurrently with
setup/removal. Comparisons detect many changes but cannot make independent
editors, systemd, and Tailscale share a transaction. Cleanup preserves ambiguous
resources and reports incomplete recovery rather than claiming success.

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

See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
for private HTTPS listeners and persistent `--bg` configuration. Scope uses
`serve --https=PORT off` to remove only its listener, never `serve reset` or
Funnel.
