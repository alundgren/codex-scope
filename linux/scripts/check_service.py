"""Exercise an isolated temporary user service without installing account hooks."""

from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scope.host import run
from scope.setup import unit_text, wait_http
from scope.viewer import inspect


def main():
    unit = 'codex-scope-check-' + uuid.uuid4().hex + '.service'
    with tempfile.TemporaryDirectory(prefix='scope-service-check-') as directory:
        root = Path(directory)
        app = root / 'app'
        shutil.copytree(Path(__file__).resolve().parents[1] / 'scope', app / 'scope',
                        ignore=shutil.ignore_patterns('__pycache__'))
        token = secrets.token_hex(32)
        (root / 'token').write_text(token + '\n')
        (root / 'token').chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        endpoint = f'http://127.0.0.1:{port}'
        unit_file = root / 'codex-scope.service'
        unit_file.write_text(unit_text(app, root).replace('{port}', str(port)))
        run(['systemd-analyze', '--user', 'verify', str(unit_file)])
        try:
            run(['systemd-run', '--user', '--unit=' + unit, '--collect',
                 '--property=WorkingDirectory=' + str(app), '--property=UMask=0077',
                 sys.executable, '-B', '-m', 'scope.collector', '--runtime-dir', str(root / 'run'),
                 '--token-file', str(root / 'token'), '--port', str(port)])
            wait_http(endpoint)
            ready = threading.Event()
            result = []
            thread = threading.Thread(target=lambda: result.append(inspect(endpoint, token, 2, on_ready=ready.set)))
            thread.start()
            assert ready.wait(5)
            payload = b'{"hook_event_name":"PreToolUse","session_id":"synthetic-service-check"}'
            observer = Path(__file__).resolve().parents[1] / 'build/observer'
            subprocess.run([str(observer), str(root / 'run/ingest.sock')], input=payload, check=True, timeout=2)
            thread.join(timeout=8)
            assert result and result[0]['events'] == 1
            run(['systemctl', '--user', 'stop', unit])
            assert not (root / 'run/ingest.sock').exists()
            subprocess.run([str(observer), str(root / 'run/ingest.sock')], input=payload, check=True, timeout=2)
            print('PASS: temporary systemd service, authenticated delivery, service stop, absent receiver.')
            print('No account hooks or existing services changed; input was synthetic.')
        finally:
            run(['systemctl', '--user', 'stop', unit], allowed=(0, 5))


if __name__ == '__main__':
    main()
