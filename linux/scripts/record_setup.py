"""Record synthetic PTY walkthroughs. Requires the development-only pexpect package."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

import pexpect

ROOT = Path(__file__).resolve().parents[1]


def record(scenario, output):
    start = time.monotonic()
    with output.open('w') as stream:
        stream.write(json.dumps({'version': 2, 'width': 120, 'height': 42,
                                 'title': 'Synthetic guided setup: ' + scenario}) + '\n')
        class Recorder:
            def write(self, text):
                stream.write(json.dumps([round(time.monotonic() - start, 3), 'o', text]) + '\n')
                stream.flush()
            def flush(self):
                stream.flush()
        child = pexpect.spawn(sys.executable, ['-B', 'tests/setup_terminal_fixture.py', scenario],
                              cwd=ROOT, encoding='utf-8', timeout=30, dimensions=(42, 120))
        child.logfile_read = Recorder()
        try:
            child.expect('Use Tailscale.*: ')
            child.sendline('y' if scenario == 'remote' else 'n')
            child.expect('Codex configuration directory.*: ')
            child.sendline('')
            child.expect('Read Codex config.*: ')
            child.sendline('n' if scenario == 'decline' else 'y')
            if scenario in ('failure', 'decline'):
                child.expect(pexpect.EOF)
                return
            child.expect(r'Private data: ([^\r\n]+)')
            data = Path(child.match.group(1))
            child.expect('Customize these suggestions.*: ')
            child.sendline('n')
            child.expect('Apply these changes.*: ')
            child.sendline('y')
            child.expect('Have you approved those hooks.*: ')
            if scenario == 'cancel':
                child.sendintr()
                child.expect('Run management again')
                child.expect('Read the installation record.*: ')
                child.sendline('y')
                child.expect('Choose inspect.*: ')
                child.sendline('inspect')
                child.expect(pexpect.EOF)
                return
            child.sendline('y')
            if scenario != 'remote':
                child.expect(r"Run printf '(scope-check-[a-f0-9]+)")
                marker = child.match.group(1)
                child.expect('Did the task finish normally.*: ')
                payload = json.dumps({'hook_event_name': 'PreToolUse', 'session_id': 'synthetic',
                                      'tool_input': marker}).encode()
                subprocess.run([str(ROOT / 'build/observer'), str(data / 'collector/ingest.sock')],
                               input=payload, check=True, timeout=2)
                time.sleep(0.2)
                child.sendline('y')
                child.expect('Did that task also finish normally.*: ')
                child.sendline('y')
            child.expect('Run management again')
            child.expect('Read the installation record.*: ')
            child.sendline('y')
            if scenario == 'recovery':
                child.expect('Undo its recorded changes now.*: ')
                child.sendline('y')
                child.expect(pexpect.EOF)
                return
            child.expect('Choose inspect.*: ')
            child.sendline('uninstall')
            child.expect('Remove unchanged Scope.*: ')
            child.sendline('y')
            if scenario != 'edited':
                child.expect('Also delete unchanged local token.*: ')
                child.sendline('n')
            child.expect(pexpect.EOF)
        finally:
            if child.isalive():
                child.terminate(force=True)
            child.close()
    if child.exitstatus not in (0, None):
        raise SystemExit(f'{scenario} walkthrough failed: {child.exitstatus}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for scenario in ('failure', 'decline', 'cancel', 'success', 'edited', 'remote', 'recovery'):
        record(scenario, args.output / (scenario + '.cast'))
        print('Recorded:', scenario)


if __name__ == '__main__':
    main()
