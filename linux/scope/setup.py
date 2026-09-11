"""Guided single-account Linux setup. No configuration is read before consent."""

import argparse
import asyncio
import fcntl
import json
import os
from pathlib import Path
import pwd
import secrets
import shlex
import shutil
import signal
import stat
import sys
import tempfile
import threading
import tomllib
import uuid

from . import install
from .collector import read_token
from .host import (SetupError, available, choose_port, expected_listener, listener,
                   private_path, read_private, run, serve_config, systemctl)
from .managed import Installation, digest, sync_dir
from .probe import ProbeError, check_entries, compatible, hooks_list, registrations
from .viewer import inspect


SERVICE = 'codex-scope.service'


def ask(question, default=''):
    suffix = f' [{default}]' if default else ''
    return input(question + suffix + ': ').strip() or default


def yes(question, default=False):
    while True:
        answer = input(question + (' [Y/n]: ' if default else ' [y/N]: ')).strip().lower()
        if not answer:
            return default
        if answer in ('y', 'yes'):
            return True
        if answer in ('n', 'no'):
            return False
        print('Enter y or n.')


def confirm(question):
    if not yes(question):
        raise SetupError('Cancelled.')


def need(name, package):
    path = shutil.which(name)
    if not path:
        raise SetupError(f'Missing {name}. Install {package}, then run setup again.')
    return path


def prerequisite(remote):
    if sys.platform != 'linux' or os.getuid() == 0:
        raise SetupError('Run as your normal Linux account, not root or sudo.')
    for name, package in (('codex', 'Codex CLI'), ('make', 'make'), ('cc', 'a C compiler such as gcc'),
                          ('systemctl', 'systemd'), ('loginctl', 'systemd')):
        need(name, package)
    systemctl('show', '--property=Version', '--value')
    if run(['loginctl', 'show-user', str(os.getuid()), '--property=Linger', '--value']).strip() != 'yes':
        raise SetupError('User lingering is disabled. For startup after logout/reboot, run '
                         f'loginctl enable-linger {pwd.getpwuid(os.getuid()).pw_name} '
                         'with administrator approval, then retry. Setup has not changed this account setting.')
    if remote:
        need('tailscale', 'Tailscale')
        status = json.loads(run(['tailscale', 'status', '--json']))
        dns = status.get('Self', {}).get('DNSName', '').rstrip('.')
        if status.get('BackendState') != 'Running' or not dns or not status.get('CertDomains'):
            raise SetupError('Tailscale must be logged in with HTTPS certificates enabled. '
                             'Complete Tailscale setup first; no routes were changed.')
        return dns
    return None


def config_files(config):
    raw = read_private(config / 'config.toml')
    try:
        tomllib.loads(raw.decode())
        hooks_raw, hooks = install.read_config(config / 'hooks.json')
    except (ValueError, UnicodeError) as error:
        raise SetupError('Codex configuration is malformed or exceeds a supported limit; no files changed') from error
    if (config / 'codex-scope-owned.json').exists():
        raise SetupError('An existing Scope hook installation has no guided setup record. '
                         'Uninstall it with its original installer before continuing.')
    return raw, hooks_raw, hooks


def rehearsal(hooks, observer):
    with tempfile.TemporaryDirectory(prefix='scope-rehearsal-') as directory:
        root = Path(directory)
        install.atomic_write(root / 'hooks.json', install.serialize(hooks))
        install.update(root, observer, root / 'absent.sock')
        install.update(root, uninstall=True)
        _, restored = install.read_config(root / 'hooks.json')
        if restored != {**hooks, 'hooks': hooks.get('hooks', {})}:
            raise SetupError('Automatic install/uninstall rehearsal did not preserve existing hooks')


def unit_text(app, data):
    python = Path(sys.executable).resolve()
    # Double quoted systemd arguments with all expansion characters rejected in paths.
    return (f'[Unit]\nDescription=Codex Scope collector\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n'
            f'[Service]\nType=simple\nWorkingDirectory={app}\n'
            f'ExecStart="{python}" -B -m scope.collector --runtime-dir "{data / "collector"}" '
            f'--token-file "{data / "viewer.token"}" --port {{port}}\n'
            'UMask=0077\nRestart=on-failure\nRestartSec=5\n\n'
            '[Install]\nWantedBy=default.target\n')


def port_prompt(label, default):
    value = ask(label, str(default))
    try:
        port = int(value)
    except ValueError as error:
        raise SetupError('Enter a numeric port from 1024 to 65535') from error
    if not available(port):
        raise SetupError(f'Port {port} is unavailable. Nothing will be stopped to free it.')
    return port


def ensure_separate(paths, source):
    for index, path in enumerate(paths):
        if path.is_relative_to(source) or source.is_relative_to(path):
            raise SetupError('Installation paths must be outside the checkout')
        for other in paths[index + 1:]:
            if path.is_relative_to(other) or other.is_relative_to(path):
                raise SetupError('Configuration, application, and data directories must not overlap')


def inspect_http(endpoint):
    import http.client
    from urllib.parse import urlsplit
    url = urlsplit(endpoint)
    cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
    connection = cls(url.hostname, url.port, timeout=5)
    try:
        connection.request('GET', '/v1/stream')
        if connection.getresponse().status != 401:
            raise SetupError('Endpoint did not reject an unauthenticated request with HTTP 401')
    finally:
        connection.close()


def wait_http(endpoint):
    import time
    for attempt in range(20):
        try:
            inspect_http(endpoint)
            return
        except ConnectionRefusedError:
            if attempt == 19:
                raise SetupError('Collector did not become ready within five seconds')
            time.sleep(0.25)


def live_checks(job):
    r = job.record
    if not job.unit_owned():
        raise SetupError('Installed service is missing')
    token = read_token(Path(r['data']) / 'viewer.token')
    wait_http(r['endpoint'])
    ready, finish = threading.Event(), threading.Event()
    result, failure = [], []
    marker = 'scope-check-' + secrets.token_hex(4)

    def watch():
        try:
            result.append(inspect(r['endpoint'], token, 180, on_ready=ready.set,
                                  match_text=marker, finish=finish))
        except Exception:
            failure.append(True)
            ready.set()

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        if not ready.wait(8) or failure:
            raise SetupError('Diagnostic viewer could not connect. Close any other viewer and check the endpoint.')
        print('In a fresh session in your usual Codex client, submit:')
        print(f"Run printf '{marker}\\n'. Do not modify any files.")
        confirm('Did the task finish normally?')
    finally:
        finish.set()
        watcher.join(timeout=8)
    if watcher.is_alive() or failure or not result or result[0].get('matching_events', 0) == 0:
        raise SetupError('No matching live event was verified within three minutes. Capture remains unverified.')
    print(f"Received events: {result[0]['events']}; test marker found. Loss outside the collector is unknown.")
    # Check ownership again after the potentially long interactive task.
    if not job.unit_owned():
        raise SetupError('Service changed during verification')
    systemctl('stop', SERVICE)
    if systemctl('show', SERVICE, '--property=ActiveState', '--value').strip() != 'inactive':
        raise SetupError('Collector stop could not be confirmed')
    try:
        print("In the same client, submit: Run printf 'scope collector stopped\\n'. Do not modify any files.")
        confirm('Did that task also finish normally?')
    finally:
        if job.unit_owned():
            systemctl('start', SERVICE)
    wait_http(r['endpoint'])
    print('Live capture and collector-stop checks passed. UI connectivity and full compatibility are not verified.')


def show(job):
    r = job.record
    print(f"Installation state: {r['phase']}")
    print(f"Endpoint: {r['endpoint']}")
    print(f"Private token file: {Path(r['data']) / 'viewer.token'}")
    print(f"Manage or uninstall: {shlex.quote(str(job.registry / 'manage.sh'))}")
    if r.get('dns'):
        user = pwd.getpwuid(os.getuid()).pw_name
        remote = shlex.quote(f"{user}@{r['dns']}:{shlex.quote(str(Path(r['data']) / 'viewer.token'))}")
        print('On your other machine, copy the token over SSH into a private directory:')
        print('mkdir -p ~/.config/codex-scope && chmod 700 ~/.config/codex-scope')
        print(f'scp {remote} ~/.config/codex-scope/viewer.token')
        print('chmod 600 ~/.config/codex-scope/viewer.token')
    print('No viewer connected means events are discarded. Only one viewer may connect at a time.')


def prepare_registry(registry, source):
    registry.mkdir(mode=0o700, parents=True)
    (registry / 'scope').mkdir(mode=0o700)
    for path in (source / 'scope').glob('*.py'):
        install.atomic_write(registry / 'scope' / path.name, path.read_bytes())
    launcher = b'#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec python3 -B -m scope.setup "$@"\n'
    install.atomic_write(registry / 'manage.sh', launcher)
    (registry / 'manage.sh').chmod(0o700)
    sync_dir(registry)


def new_install(home, registry, source):
    remote = yes('Use Tailscale to connect from another device?')
    config = private_path(ask('Codex configuration directory', str(home / '.codex')), home, True, allow_writable=True)
    if not (config / 'config.toml').is_file() or (config / 'config.toml').is_symlink():
        raise SetupError('No regular config.toml found in that directory. Choose your existing Codex configuration.')
    confirm('Read Codex config.toml and hooks.json here, and check local services?')
    dns = prerequisite(remote)
    config_raw, hooks_raw, hooks = config_files(config)
    app = home / '.local/share/codex-scope'
    data = home / '.local/state/codex-scope'
    port = choose_port(4319)
    serve_before = serve_config() if remote else {}
    https_port = choose_port(8443, [port]) if remote else None
    if remote:
        while listener(serve_before, https_port):
            https_port = choose_port(https_port + 1, [port])
    print(f'Application: {app}\nPrivate data: {data}\nLoopback port: {port}')
    if remote:
        print(f'Tailscale HTTPS port: {https_port}')
    if yes('Customize these suggestions?'):
        app = Path(ask('Application directory', str(app)))
        data = Path(ask('Private data directory', str(data)))
        port = port_prompt('Loopback port', port)
        if remote:
            https_port = port_prompt('Tailscale HTTPS port', https_port)
    app, data = private_path(app, home, allow_writable=True), private_path(data, home, allow_writable=True)
    ensure_separate([config, app, data, registry], source.parent)
    if app.exists() or data.exists():
        raise SetupError('Application or data directory already exists. Choose unused directories; setup will not overwrite them.')
    if len(os.fsencode(data / 'collector/ingest.sock')) >= 108:
        raise SetupError('Private data path is too long for a Unix socket; choose a shorter directory')
    unit = home / '.config/systemd/user' / SERVICE
    private_path(unit.parent, home, allow_writable=True)
    enablement = [*unit.parent.glob('*.wants/' + SERVICE), *unit.parent.glob('*.requires/' + SERVICE)]
    if unit.exists() or unit.is_symlink() or enablement or systemctl('show', SERVICE, '--property=LoadState', '--value').strip() != 'not-found':
        raise SetupError('A codex-scope systemd service already exists; preserve it and uninstall it separately first')
    if remote and (port == https_port or listener(serve_before, https_port)):
        raise SetupError('Chosen Tailscale HTTPS port is already configured or matches the collector port')
    mode = stat.S_IMODE(config.stat().st_mode)
    permissions = {}
    for chosen in (config, app, data, unit.parent):
        for path in (chosen, *chosen.parents):
            if path.is_relative_to(home) and path.exists() and str(path) not in permissions:
                info = path.stat()
                before = stat.S_IMODE(info.st_mode)
                if before & 0o022:
                    confirm(f'Remove group/other write permission from {path} for this installation?')
                    permissions[str(path)] = {'before': before, 'after': before & ~0o022,
                                              'inode': info.st_ino}
    print('Checking the build, isolated Codex registrations, and automatic uninstall rehearsal...')
    run(['make', '-C', source], timeout=120)
    observer = source / 'build/observer'
    compatible(shutil.which('codex'), observer)
    rehearsal(hooks, observer)
    endpoint = f'https://{dns}:{https_port}' if remote else f'http://127.0.0.1:{port}'
    print(f'Application: {app}\nPrivate data: {data}\nCodex configuration: {config}')
    print(f'Add 12 observer hooks and enable {SERVICE} at startup.')
    print(f'Endpoint: {endpoint}. Capture is discarded whenever no viewer is connected.')
    confirm('Apply these changes and run the two interactive tests?')
    if read_private(config / 'config.toml') != config_raw or install.read_config(config / 'hooks.json')[0] != hooks_raw:
        raise SetupError('Codex configuration changed during setup; retry after other edits finish')
    if not available(port) or (remote and (not available(https_port) or serve_config() != serve_before)):
        raise SetupError('Port availability or Tailscale configuration changed; retry')
    prepare_registry(registry, source)
    job = Installation(registry, {
        'version': 1, 'identity': uuid.uuid4().hex, 'phase': 'installing',
        'config': str(config), 'config_mode': mode, 'hooks_existed': hooks_raw is not None,
        'app': str(app), 'data': str(data), 'runtime': str(data / 'collector'),
        'unit': str(unit), 'endpoint': endpoint, 'dns': dns, 'port': port, 'https_port': https_port,
        'files': {}, 'directories': {}, 'permissions': permissions,
        'recovery': {str(p.relative_to(registry)): digest(p.read_bytes())
                     for p in [registry / 'manage.sh', *(registry / 'scope').glob('*.py')]},
    })
    job.save()
    try:
        for name, change in sorted(permissions.items(), key=lambda item: len(Path(item[0]).parts)):
            path = Path(name)
            info = path.lstat()
            if info.st_ino != change['inode'] or stat.S_IMODE(info.st_mode) != change['before']:
                raise SetupError('Directory permissions changed during setup; stopping')
            path.chmod(change['after'])
        job.directory(app)
        job.directory(app / 'scope')
        for path in (source / 'scope').glob('*.py'):
            job.file(app / 'scope' / path.name, path.read_bytes())
        job.file(app / 'observer', observer.read_bytes(), 0o700)
        job.file(app / 'install.sh', (registry / 'manage.sh').read_bytes(), 0o700)
        job.directory(data)
        job.directory(data / 'backup')
        job.directory(data / 'collector')
        job.file(data / 'backup/config.toml', config_raw, retain=True)
        if hooks_raw is not None:
            job.file(data / 'backup/hooks.json', hooks_raw, retain=True)
        job.file(data / 'viewer.token', (secrets.token_hex(32) + '\n').encode(), retain=True)
        job.record['hook_ownership'] = install.merge(
            hooks, app / 'observer', data / 'collector/ingest.sock',
            identity=job.record['identity'])[install.OWNER]
        job.record['hooks_intent'] = True
        job.save()
        install.update(config, app / 'observer', data / 'collector/ingest.sock', identity=job.record['identity'])
        if not unit.parent.exists():
            job.directory(unit.parent)
        job.file(unit, unit_text(app, data).replace('{port}', str(port)).encode())
        job.record['service_intent'] = True
        job.save()
        systemctl('daemon-reload')
        systemctl('enable', '--now', SERVICE)
        wait_http(f'http://127.0.0.1:{port}')
        if remote:
            if serve_config() != serve_before:
                raise SetupError('Tailscale routes changed during installation; stopping before exposure')
            job.record['route'] = expected_listener(dns, https_port, port)
            job.record['route_intent'] = True
            job.save()
            run(['tailscale', 'serve', '--bg', f'--https={https_port}', f'http://127.0.0.1:{port}'])
            if listener(serve_config(), https_port) != job.record['route']:
                raise SetupError('Tailscale did not create the expected private listener')
            inspect_http(endpoint)
        print('In another terminal, run:')
        print(f'CODEX_HOME={shlex.quote(str(config))} codex -C {shlex.quote(str(home))}')
        print('Open /hooks, approve only the 12 new codex-scope commands, then exit.')
        print('If another MCP blocks startup, fix it separately; setup will not disable it.')
        confirm('Have you approved those hooks?')
        result = asyncio.run(hooks_list(shutil.which('codex'), config, home))
        expected_command = install.merge({}, app / 'observer', data / 'collector/ingest.sock',
                                         identity=job.record['identity'])['hooks']['Stop'][0]['hooks'][0]['command']
        check_entries(registrations(result), job.record['identity'], trusted=True, command=expected_command)
        live_checks(job)
        job.record['phase'] = 'installed'
        job.save()
        show(job)
        return job
    except BaseException:
        print('\nInstallation did not finish. Undoing the recorded changes...')
        # A second Ctrl+C must not interrupt the cleanup half-way through.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        problems = job.rollback()
        for problem in problems:
            print(problem)
        print('Cleanup is incomplete; review the preserved resources.' if problems else
              'Rollback finished. Backups and credentials are retained.')
        print('To inspect or retry cleanup, run:')
        print(shlex.quote(str(registry / 'manage.sh')))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('inspect', 'verify', 'uninstall', 'purge'))
    args = parser.parse_args()
    os.umask(0o077)
    home = Path.home().absolute()
    registry = home / '.local/state/codex-scope-installer'
    source = Path(__file__).resolve().parents[1]
    print('Codex Scope setup')
    try:
        if not sys.stdin.isatty():
            raise SetupError('Run setup in an interactive terminal; unattended installation is not supported.')
        private_path(registry, home)
        # The lock is separate from the installation so cleanup never unlinks an active lock.
        lock_parent = home / '.local/state'
        lock_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(lock_parent / '.codex-scope-setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise SetupError('Setup lock is not an account-owned regular file')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def interrupted(*unused):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, interrupted)
            if registry.exists():
                if not (registry / 'installation.json').exists():
                    raise SetupError(f'Incomplete recovery directory exists: {registry}. Preserve and inspect it before retrying.')
                confirm('Read the installation record and selected Codex/service configuration?')
                job = Installation.load(registry)
                if job.record['phase'] in ('installing', 'removing', 'needs_cleanup'):
                    print('An interrupted installation needs rollback before another install can start.')
                    confirm('Undo its recorded changes now?')
                    problems = job.rollback()
                    for problem in problems:
                        print(problem)
                    if problems:
                        print('Cleanup is incomplete. Review the preserved resources, then run management again.')
                        return 1
                    print('Rollback finished. Backups and credentials are retained.')
                    return 0
                action = args.action or ask('Choose inspect, verify, uninstall, or purge', 'inspect')
                if action == 'inspect':
                    show(job)
                    if job.record['phase'] == 'installed':
                        print('Service state: ' + systemctl('show', SERVICE, '--property=ActiveState', '--value').strip())
                elif action == 'verify':
                    if job.record['phase'] != 'installed':
                        raise SetupError('Only a completed installation can be verified')
                    live_checks(job)
                elif action == 'uninstall':
                    confirm('Remove unchanged Scope hooks, service, listener, and application files?')
                    problems = job.rollback()
                    for problem in problems:
                        print(problem)
                    if problems:
                        print('Cleanup is incomplete. Review the preserved resources, then run management again.')
                        return 1
                    print('Uninstall finished. Hook approval records remain inert; existing Codex settings were preserved.')
                    if yes('Also delete unchanged local token and configuration backups?'):
                        job.purge_retained()
                    print('Recovery tools and record are retained. To remove them after review:')
                    print(f'{shlex.quote(str(registry / "manage.sh"))} purge')
                elif action == 'purge':
                    confirm('Delete retained token, backups, and recovery tools after uninstall?')
                    job.purge_retained()
                    # Registry is installer-owned; refuse unknown files rather than recursive removal.
                    expected = {'installation.json', 'manage.sh', 'scope'}
                    if {p.name for p in registry.iterdir()} != expected:
                        raise SetupError('Unexpected recovery files exist; preserved the recovery directory')
                    for path in (registry / 'scope').iterdir():
                        if path.is_symlink() or not path.is_file() or path.suffix != '.py':
                            raise SetupError('Unexpected recovery files exist; preserved recovery tools')
                    for name, expected_hash in job.record['recovery'].items():
                        if digest(read_private(registry / name)) != expected_hash:
                            raise SetupError('Edited recovery tools were preserved')
                    for path in (registry / 'scope').iterdir():
                        path.unlink()
                    (registry / 'scope').rmdir()
                    for name in ('installation.json', 'manage.sh'):
                        (registry / name).unlink()
                    registry.rmdir()
                    print('Retained files removed. A fresh install is now possible.')
                else:
                    raise SetupError('Choose inspect, verify, uninstall, or purge')
            elif args.action:
                raise SetupError('No guided installation record was found')
            else:
                new_install(home, registry, source)
    except (SetupError, OSError, ValueError, TimeoutError, KeyboardInterrupt, EOFError) as error:
        message = str(error) if isinstance(error, (SetupError, ProbeError)) else type(error).__name__
        if isinstance(error, (KeyboardInterrupt, EOFError)):
            message = 'Cancelled.'
        print(f'Stopped: {message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
