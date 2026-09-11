"""Read hook registration metadata without starting a Codex session."""

import asyncio
import os
from pathlib import Path
import tempfile

from .contract import EVENTS


class ProbeError(ValueError):
    pass


async def hooks_list(codex, home, workspace):
    process = await asyncio.create_subprocess_exec(
        str(codex), "app-server", "--stdio", cwd=workspace,
        env=dict(os.environ, CODEX_HOME=str(home)),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=4 * 1024 * 1024)

    async def rpc(number, method, params):
        import json
        process.stdin.write((json.dumps({"id": number, "method": method, "params": params}) + "\n").encode())
        await process.stdin.drain()
        # Bound unsolicited notifications as well as the total request time.
        for _ in range(64):
            line = await process.stdout.readline()
            if not line:
                raise ProbeError("Codex closed before answering hooks/list")
            response = json.loads(line)
            if response.get("id") == number:
                if "error" in response:
                    raise ProbeError("Codex rejected hook inspection; check its configuration and MCP setup")
                return response["result"]
        raise ProbeError("Codex sent too many notifications during hook inspection")

    try:
        async with asyncio.timeout(20):
            await rpc(1, "initialize", {"clientInfo": {"name": "codex_scope_probe", "version": "1"},
                                       "capabilities": {"experimentalApi": True}})
            process.stdin.write(b'{"method":"initialized"}\n')
            return await rpc(2, "hooks/list", {"cwds": [str(workspace)]})
    except ProbeError:
        raise
    except (KeyError, TypeError, ValueError, TimeoutError) as error:
        raise ProbeError("Codex hook inspection failed or returned unsupported metadata") from error
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def registrations(result):
    try:
        entries = result["data"]
        if len(entries) != 1 or entries[0].get("errors") or entries[0].get("warnings"):
            raise ProbeError()
        hooks = entries[0]["hooks"]
        if not isinstance(hooks, list):
            raise ProbeError()
        return hooks
    except (KeyError, TypeError, ValueError) as error:
        raise ProbeError("Cannot verify Codex hook registrations without warnings or errors") from error


def check_entries(hooks, identity, trusted=False, command=None):
    owned = [h for h in hooks if h.get("statusMessage") == f"codex-scope {identity}"]
    expected = sorted(e[0].lower() + e[1:] for e in EVENTS)
    if (sorted(h.get("eventName", "") for h in owned) != expected
            or any(h.get("handlerType") != "command" or h.get("timeoutSec") != 1
                   or h.get("async") is not False or h.get("enabled") is not True for h in owned)):
        raise ProbeError("Codex did not recognize all twelve enabled synchronous observers")
    if command is not None and any(h.get("command") != command for h in owned):
        raise ProbeError("Observer commands changed during approval; preserve them for review")
    state = "trusted" if trusted else "untrusted"
    if any(h.get("trustStatus") != state for h in owned):
        raise ProbeError("Hook trust could not be verified" if trusted else "Isolated hooks unexpectedly have trust")


def compatible(codex, observer):
    from .install import read_config, update
    with tempfile.TemporaryDirectory(prefix="scope-probe-") as temporary:
        root = Path(temporary)
        home, workspace = root / "codex", root / "workspace"
        workspace.mkdir()
        update(home, observer, root / "absent.sock")
        (home / "config.toml").write_text('[analytics]\nenabled = false\n[feedback]\nenabled = false\n')
        _, record = read_config(home / "codex-scope-owned.json")
        result = asyncio.run(hooks_list(codex, home, workspace))
        check_entries(registrations(result), record["identity"])
        return result
