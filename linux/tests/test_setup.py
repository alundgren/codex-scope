import copy
import io
import json
import os
from pathlib import Path
import signal
import socket
import stat
import tempfile
import unittest
from unittest.mock import patch

from scope import install, setup
from scope.host import SetupError, available, expected_listener, listener, private_path, run
from scope.managed import Installation
from scope.probe import check_entries, registrations
from scope.contract import EVENTS

SOURCE = Path(__file__).resolve().parents[1]


class HostTests(unittest.TestCase):
    def test_confirmation_defaults_to_no(self):
        with patch('builtins.input', return_value=''):
            self.assertFalse(setup.yes('Proceed?'))
            self.assertTrue(setup.yes('Proceed?', True))

    def test_command_timeout_and_output_limit(self):
        import sys
        with self.assertRaises(SetupError):
            run([sys.executable, '-c', 'import time; time.sleep(2)'], timeout=0.03)
        with patch('scope.host.LIMIT', 100), self.assertRaises(SetupError):
            run([sys.executable, '-c', 'print("x" * 1000)'])

    def test_failed_command_does_not_expose_output(self):
        import sys
        with self.assertRaises(SetupError) as result:
            run([sys.executable, '-c', 'import sys; print("secret"); sys.exit(1)'])
        self.assertNotIn('secret', str(result.exception))

    def test_port_conflict_and_path_rejection(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.assertFalse(available(sock.getsockname()[1]))
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / 'link').symlink_to(home, target_is_directory=True)
            for path in (home / 'link/app', home / 'bad%name', home.parent, home / '../outside'):
                with self.assertRaises(SetupError):
                    private_path(path, home)

    def test_listener_includes_other_routes_and_funnel(self):
        expected = expected_listener('machine.example.ts.net', 8443, 4319)
        config = copy.deepcopy(expected)
        config['TCP']['443'] = {'HTTPS': True}
        self.assertEqual(listener(config, 8443), expected)
        config['AllowFunnel'] = {'machine.example.ts.net:8443': True}
        self.assertNotEqual(listener(config, 8443), expected)
        with self.assertRaises(SetupError):
            listener({'Foreground': {'other': {}}}, 8443)

    def test_probe_rejects_unknown_warnings_missing_events_and_wrong_trust(self):
        hooks = [{'eventName': e[0].lower() + e[1:], 'statusMessage': 'codex-scope test',
                  'handlerType': 'command', 'timeoutSec': 1, 'async': False,
                  'enabled': True, 'trustStatus': 'untrusted'} for e in EVENTS]
        check_entries(hooks, 'test')
        for invalid in (hooks[:-1], [{**h, 'trustStatus': 'trusted'} for h in hooks],
                        [{**h, 'async': True} for h in hooks]):
            with self.assertRaises(ValueError):
                check_entries(invalid, 'test')
        for result in ({}, {'data': []}, {'data': [{'hooks': hooks, 'warnings': ['warning']}]}):
            with self.assertRaises(ValueError):
                registrations(result)


class GuidedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='scope-setup-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / '.codex'
        self.config.mkdir(mode=0o700)
        self.config_text = b'[features]\nexample = true\n'
        (self.config / 'config.toml').write_bytes(self.config_text)
        self.original = {'hooks': {'PreToolUse': [{'hooks': [{'type': 'command', 'command': 'exit 2'}]}]}}
        (self.config / 'hooks.json').write_text(json.dumps(self.original))
        self.registry = self.home / '.local/state/codex-scope-installer'
        self.app = self.home / '.local/share/codex-scope'
        self.data = self.home / '.local/state/codex-scope'
        self.unit = self.home / '.config/systemd/user/codex-scope.service'
        self.state = 'inactive'
        self.remote = False
        self.routes = {'TCP': {'443': {'HTTPS': True}}, 'Web': {
            'machine.example.ts.net:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:9999'}}}}}
        self.before_routes = copy.deepcopy(self.routes)
        self.calls = []
        for target, replacement in (
            ('scope.setup.prerequisite', lambda remote: 'machine.example.ts.net' if remote else None),
            ('scope.setup.compatible', lambda *a: None),
            ('scope.setup.hooks_list', self.hooks_list),
            ('scope.setup.live_checks', lambda *a: None),
            ('scope.setup.wait_http', lambda *a: None),
            ('scope.setup.inspect_http', lambda *a: None),
            ('scope.setup.available', lambda *a: True),
            ('scope.setup.choose_port', lambda start, excluded=(): start),
            ('scope.setup.systemctl', self.systemctl),
            ('scope.managed.systemctl', self.systemctl),
            ('scope.setup.run', self.command),
            ('scope.managed.run', self.command),
            ('scope.setup.serve_config', lambda: copy.deepcopy(self.routes)),
            ('scope.managed.serve_config', lambda: copy.deepcopy(self.routes)),
            ('builtins.input', self.answer),
            ('sys.stdout', io.StringIO()),
        ):
            p = patch(target, replacement)
            p.start()
            self.addCleanup(p.stop)
        old_int, old_term = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGINT, old_int)
        self.addCleanup(signal.signal, signal.SIGTERM, old_term)

    def answer(self, question):
        if 'Use Tailscale' in question:
            return 'y' if self.remote else 'n'
        if 'directory [' in question:
            return ''
        if 'Customize' in question:
            return 'n'
        return 'y'

    async def hooks_list(self, *args):
        record = json.loads((self.config / 'codex-scope-owned.json').read_text())
        return {'data': [{'hooks': [
            {'eventName': e[0].lower() + e[1:], 'statusMessage': 'codex-scope ' + record['identity'],
             'handlerType': 'command', 'timeoutSec': 1, 'async': False, 'enabled': True,
             'trustStatus': 'trusted',
             'command': record['entries'][e]['hooks'][0]['command']} for e in EVENTS]}]}

    def systemctl(self, *args):
        self.calls.append(args)
        if '--property=LoadState' in args:
            return 'loaded' if self.unit.exists() else 'not-found'
        if '--property=DropInPaths' in args:
            return ''
        if '--property=FragmentPath' in args:
            return str(self.unit) if self.unit.exists() else ''
        if '--property=ActiveState' in args:
            return self.state
        if args[0] in ('enable', 'start'):
            self.state = 'active'
        if args[0] in ('disable', 'stop'):
            self.state = 'inactive'
        return ''

    def command(self, args, **kwargs):
        self.calls.append(tuple(map(str, args)))
        if args[0] == 'tailscale':
            port = int(next(a.split('=')[1] for a in args if a.startswith('--https=')))
            key = f'machine.example.ts.net:{port}'
            if args[-1] == 'off':
                self.routes['TCP'].pop(str(port), None)
                self.routes['Web'].pop(key, None)
            else:
                expected = expected_listener('machine.example.ts.net', port, int(args[-1].rsplit(':', 1)[1]))
                for group in ('TCP', 'Web'):
                    self.routes[group].update(expected[group])
        return ''

    def install(self):
        return setup.new_install(self.home, self.registry, SOURCE)

    def assert_restored(self):
        self.assertEqual(json.loads((self.config / 'hooks.json').read_text()), self.original)
        self.assertEqual((self.config / 'config.toml').read_bytes(), self.config_text)
        self.assertFalse((self.config / 'codex-scope-owned.json').exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.app.exists())
        self.assertEqual(self.state, 'inactive')

    def test_install_uninstall_and_retained_credentials(self):
        job = self.install()
        self.assertEqual(job.record['phase'], 'installed')
        self.assertIn(str(self.app), self.unit.read_text())
        self.assertNotIn(str(SOURCE), self.unit.read_text())
        self.assertEqual(job.rollback(), [])
        self.assert_restored()
        self.assertTrue((self.data / 'viewer.token').exists())
        self.assertEqual(job.rollback(), [])
        job.purge_retained()
        self.assertFalse(self.data.exists())

    def test_remote_install_removes_only_its_listener(self):
        self.remote = True
        job = self.install()
        self.assertIn('8443', self.routes['TCP'])
        self.assertEqual(job.rollback(), [])
        self.assertEqual(self.routes, self.before_routes)
        self.assert_restored()

    def test_fail_after_service_start_rolls_back_without_replacing_config(self):
        with patch('scope.setup.live_checks', side_effect=SetupError('synthetic failure')):
            with self.assertRaises(SetupError):
                self.install()
        self.assert_restored()
        self.assertEqual(Installation.load(self.registry).record['phase'], 'removed')

    def test_ctrl_c_during_approval_rolls_back(self):
        original = self.answer
        def answer(question):
            if 'Have you approved' in question:
                raise KeyboardInterrupt()
            return original(question)
        with patch('builtins.input', answer), self.assertRaises(KeyboardInterrupt):
            self.install()
        self.assert_restored()

    def test_recovery_loads_after_interrupted_install(self):
        job = self.install()
        job.record['phase'] = 'installing'
        job.save()
        recovered = Installation.load(self.registry)
        self.assertEqual(recovered.rollback(), [])
        self.assert_restored()

    def test_edited_service_preserves_executable_and_reports_cleanup_needed(self):
        job = self.install()
        self.unit.write_text(self.unit.read_text() + '\n# user edit\n')
        problems = job.rollback()
        self.assertTrue(any('edited' in p for p in problems))
        self.assertTrue((self.app / 'observer').exists())
        self.assertEqual(job.record['phase'], 'needs_cleanup')
        self.assertEqual(self.state, 'active')

    def test_edited_tailscale_route_is_not_removed(self):
        self.remote = True
        job = self.install()
        self.routes['Web']['machine.example.ts.net:8443']['Handlers']['/extra'] = {'Text': 'keep'}
        problems = job.rollback()
        self.assertTrue(any('Tailscale' in p for p in problems))
        self.assertIn('/extra', self.routes['Web']['machine.example.ts.net:8443']['Handlers'])

    def test_edited_hook_is_preserved_and_reported(self):
        job = self.install()
        current = json.loads((self.config / 'hooks.json').read_text())
        current['hooks']['Stop'][0]['hooks'][0]['command'] = 'true'
        (self.config / 'hooks.json').write_text(json.dumps(current))
        problems = job.rollback()
        self.assertTrue(any('hooks remain' in p for p in problems))
        self.assertTrue((self.app / 'observer').exists())
        self.assertEqual(json.loads((self.config / 'hooks.json').read_text())['hooks']['Stop'][0]['hooks'][0]['command'], 'true')

    def test_unrelated_config_edits_survive_uninstall(self):
        job = self.install()
        edited = self.config_text + b'\n[other]\nkeep = true\n'
        (self.config / 'config.toml').write_bytes(edited)
        current = json.loads((self.config / 'hooks.json').read_text())
        current['extra'] = 'keep'
        (self.config / 'hooks.json').write_text(json.dumps(current))
        self.assertEqual(job.rollback(), [])
        self.assertEqual((self.config / 'config.toml').read_bytes(), edited)
        self.assertEqual(json.loads((self.config / 'hooks.json').read_text()), {**self.original, 'extra': 'keep'})

    def test_permission_changes_are_approved_and_restored(self):
        self.config.chmod(0o770)
        job = self.install()
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o750)
        self.assertEqual(job.rollback(), [])
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o770)

    def test_preexisting_application_refused_without_touching_config(self):
        self.app.mkdir(parents=True)
        (self.app / 'keep').write_text('keep')
        with self.assertRaises(SetupError):
            self.install()
        self.assertFalse(self.registry.exists())
        self.assertEqual((self.app / 'keep').read_text(), 'keep')

    def test_denied_read_permission_does_not_read_config(self):
        original = self.answer
        with patch('builtins.input', side_effect=lambda q: 'n' if q.startswith('Read Codex') else original(q)), \
                patch('scope.setup.config_files') as read:
            with self.assertRaises(SetupError):
                self.install()
            read.assert_not_called()
        self.assertFalse(self.registry.exists())

    def test_missing_hooks_file_is_removed_after_uninstall(self):
        (self.config / 'hooks.json').unlink()
        job = self.install()
        self.assertEqual(job.rollback(), [])
        self.assertFalse((self.config / 'hooks.json').exists())

    def test_build_failure_does_not_create_live_resources(self):
        with patch('scope.setup.run', side_effect=SetupError('compiler failed')):
            with self.assertRaises(SetupError):
                self.install()
        self.assertFalse(self.app.exists())
        self.assertFalse(self.registry.exists())
        self.assertFalse((self.config / 'codex-scope-owned.json').exists())


    def test_edited_hook_ownership_is_not_used_to_remove_other_hooks(self):
        job = self.install()
        path = self.config / 'codex-scope-owned.json'
        record = json.loads(path.read_text())
        record['entries']['PreToolUse'] = self.original['hooks']['PreToolUse'][0]
        path.write_text(json.dumps(record))
        problems = job.rollback()
        self.assertTrue(any('ownership changed' in p for p in problems))
        current = json.loads((self.config / 'hooks.json').read_text())
        self.assertIn(self.original['hooks']['PreToolUse'][0], current['hooks']['PreToolUse'])
        self.assertTrue((self.app / 'observer').exists())

    def test_partial_route_command_is_recovered(self):
        self.remote = True
        def command(args, **kwargs):
            result = self.command(args, **kwargs)
            if args[0] == 'tailscale' and args[-1] != 'off':
                raise SetupError('connection lost after applying listener')
            return result
        with patch('scope.setup.run', command), self.assertRaises(SetupError):
            self.install()
        self.assertEqual(self.routes, self.before_routes)
        self.assert_restored()

    def test_symlink_parent_preserves_external_files(self):
        job = self.install()
        moved = self.home / 'moved-source'
        (self.app / 'scope').rename(moved)
        (self.app / 'scope').symlink_to(moved, target_is_directory=True)
        problems = job.rollback()
        self.assertTrue(problems)
        self.assertTrue((moved / 'collector.py').exists())

    def test_unrecorded_file_is_preserved_and_reported(self):
        job = self.install()
        (self.app / 'user-file').write_text('keep')
        problems = job.rollback()
        self.assertTrue(any('retained files' in p for p in problems))
        self.assertEqual((self.app / 'user-file').read_text(), 'keep')

    def test_changed_permissions_are_not_reset(self):
        self.config.chmod(0o770)
        job = self.install()
        self.config.chmod(0o700)
        problems = job.rollback()
        self.assertTrue(any('permissions were edited' in p for p in problems))
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o700)

    def test_service_dropin_preserves_running_dependencies(self):
        job = self.install()
        def systemctl(*args):
            if '--property=DropInPaths' in args:
                return '/synthetic/override.conf'
            return self.systemctl(*args)
        with patch('scope.managed.systemctl', systemctl):
            problems = job.rollback()
        self.assertTrue(any('overrides' in p for p in problems))
        self.assertEqual(self.state, 'active')
        self.assertTrue((self.app / 'scope/collector.py').exists())


    def test_copied_runtime_imports_without_checkout_on_python_path(self):
        import subprocess
        import sys
        job = self.install()
        environment = dict(os.environ, HOME=str(self.home))
        environment.pop('PYTHONPATH', None)
        code = ('from pathlib import Path; import scope; from scope.managed import Installation; '
                'print(scope.__file__); '
                'print(Installation.load(Path.home()/".local/state/codex-scope-installer").record["phase"])')
        result = subprocess.run([sys.executable, '-B', '-c', code], cwd=self.app,
                                env=environment, capture_output=True, text=True, check=True, timeout=5)
        self.assertIn(str(self.app / 'scope'), result.stdout)
        self.assertNotIn(str(SOURCE), result.stdout)
        self.assertIn('installed', result.stdout)
        self.assertEqual(job.rollback(), [])
