import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scope.install import OWNER, merge, update
from scope.contract import EVENTS


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scope-install-")
        self.directory = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.path = self.directory / "hooks.json"
        self.original = {"description": "keep", "hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "exit 2"}]}]}}
        self.path.write_text(json.dumps(self.original))

    def install(self):
        return update(self.directory, Path("/absent observer'file"), Path("/tmp/synthetic.sock"))

    def test_idempotent_install_and_uninstall_preserves_unrelated(self):
        self.assertTrue(self.install())
        first = self.path.read_bytes()
        self.assertFalse(self.install())
        self.assertEqual(self.path.read_bytes(), first)
        self.assertEqual(len(json.loads((self.directory / "codex-scope-owned.json").read_text())["entries"]), len(EVENTS))
        self.assertTrue(update(self.directory, uninstall=True))
        self.assertEqual(json.loads(self.path.read_text()), self.original)
        self.assertFalse(update(self.directory, uninstall=True))

    def test_edited_hook_survives_reinstall_and_uninstall(self):
        self.install()
        config = json.loads(self.path.read_text())
        edited = config["hooks"]["Stop"][0]
        edited["hooks"][0]["command"] = "echo user-edit"
        self.path.write_text(json.dumps(config))
        self.install()
        update(self.directory, uninstall=True)
        result = json.loads(self.path.read_text())
        self.assertEqual(result["hooks"]["Stop"], [edited])
        self.assertEqual(result["hooks"]["PreToolUse"], self.original["hooks"]["PreToolUse"])

    def test_duplicate_owned_entries_are_preserved(self):
        result = merge(self.original, Path("/observer"), Path("/socket"))
        group = result["hooks"]["Stop"][0]
        result["hooks"]["Stop"].append(copy.deepcopy(group))
        self.assertEqual(merge(result, None, None, True)["hooks"]["Stop"], [group, group])

    def test_missing_executable_command_is_silent_success(self):
        self.install()
        command = json.loads(self.path.read_text())["hooks"]["Stop"][0]["hooks"][0]["command"]
        result = subprocess.run(["/bin/sh", "-c", command], input=b"{}", capture_output=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))

    def test_malformed_config_is_unchanged(self):
        self.path.write_text("{invalid")
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(self.path.read_text(), "{invalid")

    def test_symlink_is_unchanged(self):
        target = self.directory / "other.json"
        target.write_text("{}")
        self.path.unlink()
        self.path.symlink_to(target)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(target.read_text(), "{}")

    def test_no_trust_file_is_created(self):
        self.install()
        self.assertEqual({p.name for p in self.directory.iterdir()},
                         {"hooks.json", ".codex-scope.lock", "codex-scope-owned.json"})

    def test_interrupted_config_update_can_be_recovered(self):
        self.install()
        before = self.path.read_bytes()
        from scope.install import atomic_write
        def interrupt(path, data):
            if path.name == "hooks.json":
                raise OSError("synthetic disk failure")
            atomic_write(path, data)
        with patch("scope.install.atomic_write", side_effect=interrupt):
            with self.assertRaises(OSError):
                update(self.directory, Path("/new-observer"), Path("/new-socket"))
        self.assertEqual(self.path.read_bytes(), before)
        update(self.directory, uninstall=True)
        self.assertEqual(json.loads(self.path.read_text()), self.original)

    def test_duplicate_configuration_keys_are_rejected(self):
        self.path.write_text('{"hooks": {}, "hooks": {}}')
        with self.assertRaises(ValueError):
            self.install()

    def test_concurrent_edit_detected_before_replacement(self):
        from scope.install import atomic_write
        other = {"description": "concurrent edit", "hooks": {}}
        def edit(path, data):
            atomic_write(path, data)
            if path.name == "codex-scope-owned.json":
                self.path.write_text(json.dumps(other))
        with patch("scope.install.atomic_write", side_effect=edit):
            with self.assertRaises(ValueError):
                self.install()
        self.assertEqual(json.loads(self.path.read_text()), other)
