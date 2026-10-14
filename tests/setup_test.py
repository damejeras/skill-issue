"""Run with python3 -m unittest discover -s tests -p '*_test.py'."""
import json
import os
import pathlib
import pty
import select
import subprocess
import tempfile
import time
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "src/setup.ts"


class Wizard:
    def __init__(self, root):
        self.master, slave = pty.openpty()
        self.process = subprocess.Popen(
            ["node", str(SOURCE)], stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, "SETUP_DIR": str(root)},
        )
        os.close(slave)
        self.output = b""

    def expect(self, text):
        deadline = time.monotonic() + 10
        while text.encode() not in self.output:
            if time.monotonic() > deadline:
                raise AssertionError(f"Missing {text!r}: {self.output.decode(errors='replace')}")
            if select.select([self.master], [], [], .1)[0]:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    raise AssertionError(self.output.decode(errors="replace"))
        self.output = self.output.split(text.encode(), 1)[1]

    def answer(self, text=""):
        os.write(self.master, text.encode() + b"\n")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=5)
        os.close(self.master)


class SetupTest(unittest.TestCase):
    def test_cancel_resume_and_clean_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "skill-issue"
            wizard = Wizard(root)
            try:
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Bot name [Skill Issue]:")
                wizard.answer('Release "helper" $BOT')
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Bot token:")
                wizard.answer("xoxb-test-secret")
                wizard.expect("App-level token:")
                saved = json.loads((config / ".skill-issue-setup.json").read_text())
                self.assertEqual(saved["botToken"], "xoxb-test-secret")
                self.assertEqual((config / ".skill-issue-setup.json").stat().st_mode & 0o777, 0o600)
                os.write(wizard.master, b"\x03")
                self.assertNotEqual(wizard.process.wait(timeout=5), 0)
            finally:
                wizard.close()

            wizard = Wizard(root)
            try:
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Resume setup?")
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("App-level token:")
                self.assertNotIn(b"xoxb-test-secret", wizard.output)
                wizard.answer("xapp-test-secret")
                wizard.expect("Choose [1]:")
                wizard.answer("2")
                wizard.expect("Anthropic API key:")
                wizard.answer("sk-ant-test-$secret")
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Setup complete.")
                self.assertEqual(wizard.process.wait(timeout=5), 0)
            finally:
                wizard.close()
            self.assertFalse((config / ".skill-issue-setup.json").exists())
            self.assertFalse((config / ".skill-issue-setup.json.tmp").exists())
            compose = (root / "compose.yaml").read_text()
            self.assertIn("sk-ant-test-$$secret", compose)
            self.assertNotIn(":/workspace:ro", compose)
            self.assertEqual((root / "compose.yaml").stat().st_mode & 0o777, 0o600)
            self.assertTrue((config / "skills").is_dir())

    def test_saved_tokens_can_be_edited_on_resume_and_before_finishing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "skill-issue"
            config.mkdir()
            draft = config / ".skill-issue-setup.json"
            draft.write_text(json.dumps({
                "name": "Bot", "repository": None, "botToken": "xoxb-wrong",
                "appToken": "xapp-test", "auth": "api", "apiKey": "sk-ant-wrong",
            }))
            wizard = Wizard(root)
            try:
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Resume setup?")
                wizard.expect("Choose [1]:")
                wizard.answer("2")
                wizard.expect("Choose [1]:")
                wizard.answer("1")
                wizard.expect("xoxb-wrong")
                wizard.answer("\x15xoxb-correct")
                wizard.expect("Choose [1]:")
                self.assertEqual(json.loads(draft.read_text())["botToken"], "xoxb-correct")
                wizard.answer("4")
                wizard.expect("Ready to write compose.yaml?")
                wizard.expect("Choose [1]:")
                wizard.answer("2")
                wizard.expect("Choose [1]:")
                wizard.answer("3")
                wizard.expect("sk-ant-wrong")
                wizard.answer("\x15sk-ant-correct")
                wizard.expect("Choose [1]:")
                wizard.answer("4")
                wizard.expect("Ready to write compose.yaml?")
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Setup complete.")
                self.assertEqual(wizard.process.wait(timeout=5), 0)
            finally:
                wizard.close()
            output = (root / "compose.yaml").read_text()
            self.assertIn("xoxb-correct", output)
            self.assertIn("sk-ant-correct", output)
            self.assertNotIn("wrong", output)
            self.assertFalse(draft.exists())

    def test_symlink_outside_mount_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = pathlib.Path(directory)
            (root / "escape").symlink_to(outside, target_is_directory=True)
            wizard = Wizard(root)
            try:
                wizard.expect("Choose [1]:")
                wizard.answer("3")
                wizard.expect("Configuration folder:")
                wizard.answer("escape/bot")
                wizard.expect("Choose a path inside")
                self.assertNotEqual(wizard.process.wait(timeout=5), 0)
            finally:
                wizard.close()
            self.assertFalse((pathlib.Path(outside) / "bot").exists())

    def test_bot_refuses_unfinished_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, ".skill-issue-setup.json").write_text("private draft")
            result = subprocess.run(["node", str(SOURCE.with_name("main.ts"))],
                env={**os.environ, "CLAUDE_CONFIG_DIR": directory}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Finish the setup wizard", result.stderr)
            self.assertNotIn("private draft", result.stderr)

    def test_existing_compose_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "skill-issue"
            config.mkdir()
            (config / ".skill-issue-setup.json").write_text(json.dumps({
                "name": "Bot", "repository": None, "botToken": "xoxb-test",
                "appToken": "xapp-test", "auth": "api", "apiKey": "sk-ant-test",
            }))
            (root / "compose.yaml").write_text("existing configuration")
            wizard = Wizard(root)
            try:
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Choose [1]:")
                wizard.answer()
                wizard.expect("Choose [1]:")
                wizard.answer()
                self.assertEqual(wizard.process.wait(timeout=5), 0)
            finally:
                wizard.close()
            self.assertEqual((root / "compose.yaml").read_text(), "existing configuration")
            self.assertTrue((config / ".skill-issue-setup.json").exists())
