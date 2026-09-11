"""Manual/PTY walkthrough with synthetic config and simulated host integrations.

Run from linux/: python3 tests/setup_terminal_fixture.py [failure|cancel|edited|remote]
The collector and observer are real subprocesses. systemd, Tailscale, and hook
approval metadata are test doubles. No account configuration is used.
"""

import json
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scope import setup
from scope.host import SetupError, choose_port
from scope.managed import Installation
from test_setup import GuidedTests

original_input, original_stdout = input, sys.stdout
original_live_checks = setup.live_checks
original_wait_http = setup.wait_http
original_inspect_http = setup.inspect_http
original_inspect = setup.inspect

def checked_inspect(*args, **kwargs):
    try:
        return original_inspect(*args, **kwargs)
    except Exception as error:
        print("Synthetic viewer check error:", type(error).__name__, str(error))
        raise

scenario = sys.argv[1] if len(sys.argv) > 1 else 'success'


class TerminalFixture(GuidedTests):
    collector = None

    def systemctl(self, *args):
        value = super().systemctl(*args)
        if args[0] in ('enable', 'start') and (not self.collector or self.collector.poll() is not None):
            self.collector = subprocess.Popen(
                [sys.executable, '-B', '-m', 'scope.collector', '--runtime-dir', str(self.data / 'collector'),
                 '--token-file', str(self.data / 'viewer.token'), '--port',
                 str(json.loads((self.registry / 'installation.json').read_text())['port'])],
                cwd=self.app, stdout=subprocess.DEVNULL, stderr=(self.home / 'collector-error.txt').open('w'))
            time.sleep(0.2)
            if self.collector.poll() is not None:
                print('Synthetic collector startup error:', (self.home / 'collector-error.txt').read_text())
        if args[0] in ('disable', 'stop') and self.collector and self.collector.poll() is None:
            self.collector.terminate()
            self.collector.wait(timeout=5)
        return value


fixture = TerminalFixture()
fixture.setUp()
# These overrides restore real interactive prompts and actual collector checks.
try:
    with patch('builtins.input', original_input), patch('sys.stdout', original_stdout), \
            patch('pathlib.Path.home', return_value=fixture.home), patch.object(sys, 'argv', ['install.sh']), \
            patch('scope.setup.choose_port', choose_port), \
            patch('scope.setup.inspect', checked_inspect), \
            patch('scope.setup.wait_http', original_wait_http), \
            patch('scope.setup.inspect_http', original_inspect_http if scenario != 'remote' else lambda *a: None), \
            patch('scope.setup.live_checks', original_live_checks if scenario != 'remote' else lambda *a: None):
        print('Synthetic walkthrough: host service/route commands and approvals are simulated.')
        print('The local collector and observer run normally; no live account files are used.')
        if scenario == 'failure':
            with patch('scope.setup.prerequisite', side_effect=SetupError('Missing codex. Install Codex CLI, then run setup again.')):
                setup.main()
        else:
            code = setup.main()
            if code == 0 and scenario == 'edited':
                fixture.unit.write_text(fixture.unit.read_text() + '\n# edited by fixture user\n')
            if code == 0 and scenario == 'recovery':
                job = Installation.load(fixture.registry)
                job.record['phase'] = 'installing'
                job.save()
                print('Fixture simulates a crash before the final success record was written.')
            if fixture.registry.exists():
                print('Run management again to inspect, uninstall, or recover.')
                setup.main()
finally:
    if fixture.collector and fixture.collector.poll() is None:
        fixture.collector.terminate()
        fixture.collector.wait(timeout=5)
    fixture.doCleanups()
