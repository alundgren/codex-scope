"""Check installed Codex registration support without touching account config."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scope.contract import EVENTS
from scope.install import update


async def probe(directory, codex):
    home = directory / "codex"
    workspace = directory / "workspace"
    workspace.mkdir()
    observer = Path(__file__).resolve().parents[1] / "build/observer"
    update(home, observer, directory / "absent.sock")
    (home / "config.toml").write_text('[analytics]\nenabled = false\n[feedback]\nenabled = false\n')
    env = dict(os.environ, CODEX_HOME=str(home))
    process = await asyncio.create_subprocess_exec(
        codex, "app-server", "--stdio", cwd=workspace, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=1024 * 1024)
    async def rpc(number, method, params):
        process.stdin.write((json.dumps({"id": number, "method": method, "params": params}) + "\n").encode())
        await process.stdin.drain()
        while True:
            line = await asyncio.wait_for(process.stdout.readline(), 15)
            if not line:
                raise RuntimeError("Codex closed before replying")
            response = json.loads(line)
            if response.get("id") == number:
                if "error" in response:
                    raise RuntimeError(f"Codex rejected {method}")
                return response["result"]
    try:
        await rpc(1, "initialize", {"clientInfo": {"name": "codex_scope_probe", "version": "1"},
                                    "capabilities": {"experimentalApi": True}})
        process.stdin.write(b'{"method":"initialized"}\n')
        result = await rpc(2, "hooks/list", {"cwds": [str(workspace)]})
        return result
    finally:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            process.kill()
            await process.wait()


def main():
    codex = shutil.which("codex")
    if not codex:
        raise SystemExit("Codex is not installed.")
    version = subprocess.check_output([codex, "--version"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="scope-probe-") as temporary:
        result = asyncio.run(probe(Path(temporary), codex))
    # Print only registration metadata, never commands, paths, or payloads.
    events, trust, errors, warnings = [], [], 0, 0
    def visit(value):
        nonlocal errors, warnings
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ("event", "eventName", "hookEventName") and isinstance(child, str):
                    events.append(child)
                elif key in ("trusted", "isTrusted", "trustStatus", "trustState"):
                    trust.append(child)
                elif key == "errors" and isinstance(child, list):
                    errors += len(child)
                elif key == "warnings" and isinstance(child, list):
                    warnings += len(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(result)
    expected = sorted(event[0].lower() + event[1:] for event in EVENTS)
    report = {"runtime": version, "registered_events": sorted(set(events)),
              "registration_errors": errors, "registration_warnings": warnings, "trust_states": trust,
              "all_registrations_recognized": sorted(set(events)) == expected and errors == 0 and warnings == 0,
              "real_event_emission_and_policy_coexistence": "not tested",
              "account_configuration_modified": False}
    print(json.dumps(report, indent=2))
    if not report["all_registrations_recognized"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
