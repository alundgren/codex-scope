"""Durable installation ownership and conservative removal."""

import hashlib
import json
import os
from pathlib import Path
import stat

from . import install
from .host import SetupError, listener, private_path, read_private, run, serve_config, systemctl


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sync_dir(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Installation:
    def __init__(self, registry, record):
        self.registry = Path(registry)
        self.record = record

    @classmethod
    def load(cls, registry):
        raw = read_private(Path(registry) / 'installation.json')
        record = json.loads(raw)
        if record.get('version') != 1:
            raise SetupError("Unknown installation record; preserve it for recovery")
        try:
            home = Path(registry).parents[2]
            for name in ('config', 'app', 'data', 'runtime'):
                private_path(record[name], home, allow_writable=True)
            if record['runtime'] != str(Path(record['data']) / 'collector'):
                raise ValueError()
            if record['unit'] != str(home / '.config/systemd/user/codex-scope.service'):
                raise ValueError()
            if record['phase'] not in ('installing', 'installed', 'removing', 'removed', 'needs_cleanup'):
                raise ValueError()
            if len(record['files']) > 128 or len(record['directories']) > 64:
                raise ValueError()
            for name in record['files']:
                path = Path(name)
                if (name != record['unit'] and not path.is_relative_to(record['app'])
                        and not path.is_relative_to(record['data'])):
                    raise ValueError()
        except (KeyError, TypeError, ValueError) as error:
            raise SetupError('Invalid installation record; preserve it for manual recovery') from error
        return cls(registry, record)

    def save(self):
        install.atomic_write(self.registry / 'installation.json', install.serialize(self.record))

    def directory(self, path):
        path = Path(path)
        if path.exists() or path.is_symlink():
            raise SetupError(f"Refusing to overwrite existing directory: {path}")
        if not path.parent.exists():
            self.directory(path.parent)
        self.record['directories'][str(path)] = None
        self.save()
        path.mkdir(mode=0o700)
        sync_dir(path.parent)
        self.record['directories'][str(path)] = path.stat().st_ino
        self.save()

    def file(self, path, data, mode=0o600, retain=False):
        path = Path(path)
        self.record['files'][str(path)] = {'hash': digest(data), 'mode': mode, 'retain': retain}
        self.save()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        sync_dir(path.parent)

    def check_parents(self, path):
        for parent in Path(path).parents:
            if parent.is_symlink():
                raise SetupError(f'Symlink parent preserved: {parent}')
            inode = self.record['directories'].get(str(parent))
            if inode is not None and parent.exists() and parent.stat().st_ino != inode:
                raise SetupError(f'Directory identity changed; preserved: {parent}')

    def matches(self, path):
        self.check_parents(path)
        entry = self.record['files'].get(str(path))
        data = read_private(path, optional=True)
        return (entry is not None and data is not None and digest(data) == entry['hash']
                and stat.S_IMODE(Path(path).stat().st_mode) == entry['mode'])

    def unit_owned(self):
        path = Path(self.record['unit'])
        if not path.exists():
            return False
        if not self.matches(path):
            raise SetupError(f"Service file was edited; preserved: {path}")
        dropins = systemctl('show', 'codex-scope.service', '--property=DropInPaths', '--value').strip()
        fragment = systemctl('show', 'codex-scope.service', '--property=FragmentPath', '--value').strip()
        if dropins or fragment not in ('', str(path)):
            raise SetupError("Service overrides or another service definition exist; preserved")
        return True

    def rollback(self):
        self.record['phase'] = 'removing'
        self.save()
        problems = []

        def attempt(action):
            try:
                action()
                return True
            except (OSError, ValueError, SetupError) as error:
                problems.append(str(error) if isinstance(error, SetupError) else
                                f"Cleanup failed: {type(error).__name__}; retained installation record")
                return False

        def remove_route():
            if self.record.get('route_intent'):
                current = listener(serve_config(), self.record['https_port'])
                if current:
                    if current != self.record['route']:
                        raise SetupError("Tailscale listener was edited; preserved")
                    run(['tailscale', 'serve', f"--https={self.record['https_port']}", 'off'])
                    if listener(serve_config(), self.record['https_port']):
                        raise SetupError("Tailscale listener removal was not confirmed")
                self.record['route_intent'] = False
                self.save()

        attempt(remove_route)
        service_safe = True

        def stop_service():
            nonlocal service_safe
            if self.record.get('service_intent') or Path(self.record['unit']).exists():
                if not self.unit_owned():
                    raise SetupError("Service file is missing; cannot establish ownership of the running service")
                unit_directory = Path(self.record['unit']).parent
                link = unit_directory / 'default.target.wants/codex-scope.service'
                enablement = [*unit_directory.glob('*.wants/codex-scope.service'),
                              *unit_directory.glob('*.requires/codex-scope.service')]
                if any(candidate != link for candidate in enablement):
                    raise SetupError('Additional service enablement exists; preserved')
                if link.is_symlink() and link.resolve() != Path(self.record['unit']):
                    raise SetupError("Service enablement was changed; preserved")
                if link.exists() and not link.is_symlink():
                    raise SetupError("Service enablement is no longer a symlink; preserved")
                systemctl('disable', '--now', 'codex-scope.service')
                if systemctl('show', 'codex-scope.service', '--property=ActiveState', '--value').strip() not in ('inactive', 'failed'):
                    raise SetupError("Collector stop could not be confirmed")
                self.record['service_intent'] = False
                self.save()

        service_safe = attempt(stop_service)

        def remove_hooks():
            if not self.record.get('hooks_intent'):
                return
            config = Path(self.record['config'])
            _, ownership = install.read_config(config / 'codex-scope-owned.json')
            if ownership and ownership != self.record['hook_ownership']:
                raise SetupError("Hook ownership changed; preserved hooks and ownership record")
            # A missing ownership file after interrupted uninstall is safe only
            # when none of the labelled entries remain.
            if ownership:
                install.update(config, uninstall=True)
            _, remaining = install.read_config(config / 'hooks.json')
            label = 'codex-scope ' + self.record['identity']
            if any(h.get('statusMessage') == label
                   for groups in remaining.get('hooks', {}).values() for g in groups
                   for h in g.get('hooks', []) if isinstance(h, dict)):
                raise SetupError("Edited or duplicate Scope hooks remain; preserved for manual review")
            if not self.record['hooks_existed'] and remaining == {'hooks': {}}:
                (config / 'hooks.json').unlink()
                sync_dir(config)
            self.record['hooks_intent'] = False
            self.save()

        hooks_safe = attempt(remove_hooks)

        # Do not remove executable dependencies beneath an edited/running service
        # or an observer command that we could not safely remove.
        if service_safe and hooks_safe:
            for name, entry in list(self.record['files'].items()):
                if entry['retain']:
                    continue
                def remove_file(name=name):
                    path = Path(name)
                    if path.exists() or path.is_symlink():
                        if not self.matches(path):
                            raise SetupError(f"Edited file preserved: {path}")
                        path.unlink()
                        sync_dir(path.parent)
                attempt(remove_file)
            if self.record.get('unit'):
                attempt(lambda: systemctl('daemon-reload'))
            # Runtime files are created by the collector, never recording data.
            runtime = Path(self.record['runtime'])
            for name in ('collector.lock', 'ingest.sock'):
                path = runtime / name
                if path.exists() or path.is_symlink():
                    def remove_runtime(path=path, name=name):
                        self.check_parents(path)
                        info = path.lstat()
                        expected = stat.S_ISSOCK(info.st_mode) if name == 'ingest.sock' else stat.S_ISREG(info.st_mode)
                        if not expected or info.st_uid != os.getuid() or path.is_symlink():
                            raise SetupError(f"Unexpected runtime file preserved: {path}")
                        if name == 'collector.lock':
                            import fcntl
                            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
                            try:
                                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            finally:
                                os.close(fd)
                        path.unlink()
                    attempt(remove_runtime)
            for name, inode in reversed(list(self.record['directories'].items())):
                path = Path(name)
                if path.exists() or path.is_symlink():
                    if path.is_symlink() or inode != path.stat().st_ino:
                        problems.append(f"Directory identity changed; preserved: {path}")
                    else:
                        try:
                            path.rmdir()
                        except OSError:
                            if path.is_relative_to(self.record['app']):
                                problems.append(f'Application directory contains retained files: {path}')
        if service_safe and hooks_safe:
            for name, change in sorted(self.record.get('permissions', {}).items(),
                                       key=lambda item: -len(Path(item[0]).parts)):
                def restore_mode(name=name, change=change):
                    path = Path(name)
                    info = path.lstat()
                    now = stat.S_IMODE(info.st_mode)
                    if path.is_symlink() or info.st_ino != change['inode']:
                        raise SetupError(f'Directory identity changed; permissions preserved: {path}')
                    if now == change['after']:
                        path.chmod(change['before'])
                    elif now != change['before']:
                        raise SetupError(f'Directory permissions were edited; preserved: {path}')
                attempt(restore_mode)
        self.record['phase'] = 'needs_cleanup' if problems else 'removed'
        self.save()
        return problems

    def purge_retained(self):
        if self.record['phase'] != 'removed':
            raise SetupError("Complete uninstall before deleting retained files")
        for name, entry in self.record['files'].items():
            if entry['retain'] and Path(name).exists():
                if not self.matches(Path(name)):
                    raise SetupError(f"Retained file was edited; preserved: {name}")
                Path(name).unlink()
        for name, inode in reversed(list(self.record['directories'].items())):
            path = Path(name)
            if path.exists() and not path.is_symlink() and path.stat().st_ino == inode:
                try:
                    path.rmdir()
                except OSError:
                    pass
        self.save()
