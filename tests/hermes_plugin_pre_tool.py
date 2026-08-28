"""Tests: pre_tool_call hook for parilka-chat plugin — memory/skill write gating.

The hook is a factory capturing ctx; the closure validates the captured
profile and the task-local session before allowing foreground writes.
"""

from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

from tests.support.hermes_plugin_helpers import fake_session_env

import parilka_chat  # type: ignore[import-not-found]

ENTRY_DELIMITER = "\n§\n"
MANAGED_ENTRY = "[parilka:managed:week:causal-proof] Недельная сводка 2026-07-13"
PLAIN_ENTRY = "Пользователь любит кофе"


def _patch_memory_tool(memory_dir):
    """Point the hook's native memory inspection at a profile-scoped dir."""
    module = types.ModuleType("tools.memory_tool")
    module.ENTRY_DELIMITER = ENTRY_DELIMITER
    module.get_memory_dir = lambda: memory_dir
    return patch.dict("sys.modules", {"tools.memory_tool": module})


@contextmanager
def fake_memory_store(entries):
    """Run with a temp MEMORY.md holding *entries* (None → missing file)."""
    with tempfile.TemporaryDirectory() as tmp:
        memory_dir = Path(tmp)
        if entries is not None:
            (memory_dir / "MEMORY.md").write_text(
                ENTRY_DELIMITER.join(entries), encoding="utf-8"
            )
        with _patch_memory_tool(memory_dir):
            yield memory_dir


class PreToolCallHookTests(unittest.TestCase):
    """Test _make_pre_tool_call_hook: memory/skill write allowlist gating."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)
        os.environ.pop("PARILKA_BOT_MEMORY_WRITE_SENDER_IDS", None)

    def make_hook(self, profile: str = "parilka", session=None):
        ctx = MagicMock()
        ctx.profile_name = profile
        if session is not None:
            session_patch = patch("parilka_chat._get_session_env", return_value=session)
            session_patch.start()
            self.addCleanup(session_patch.stop)
        return parilka_chat._make_pre_tool_call_hook(ctx)

    def set_allowlist(self, value: str) -> None:
        os.environ["PARILKA_BOT_MEMORY_WRITE_SENDER_IDS"] = value

    def test_allows_non_write_tools(self):
        hook = self.make_hook()
        result = hook(tool_name="web_search", args={"query": "test"})
        self.assertIsNone(result)

    def test_blocks_memory_call_without_allowlist(self):
        hook = self.make_hook(session=fake_session_env())
        result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")
        self.assertIn("не настроен", result["message"])

    def test_blocks_wrong_captured_profile_even_with_valid_session(self):
        self.set_allowlist("111,123456789")
        hook = self.make_hook(profile="default", session=fake_session_env())
        result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_allows_memory_call_for_background_review(self):
        hook = self.make_hook(session=fake_session_env())

        fake_wa = type(sys)("tools")
        fake_wa_sub = type(sys)("write_approval")
        fake_wa_sub.current_origin = lambda: "background_review"
        fake_wa.write_approval = fake_wa_sub

        with patch.dict(
            "sys.modules", {"tools": fake_wa, "tools.write_approval": fake_wa_sub}
        ):
            result = hook(tool_name="memory", args={"action": "write", "key": "k"})
            self.assertIsNone(result)

    def test_background_review_still_requires_correct_profile(self):
        fake_wa = type(sys)("tools")
        fake_wa_sub = type(sys)("write_approval")
        fake_wa_sub.current_origin = lambda: "background_review"
        fake_wa.write_approval = fake_wa_sub

        hook = self.make_hook(profile="default", session=fake_session_env())
        with patch.dict(
            "sys.modules", {"tools": fake_wa, "tools.write_approval": fake_wa_sub}
        ):
            result = hook(tool_name="memory", args={"action": "write", "key": "k"})
            self.assertIsNotNone(result)
            self.assertEqual(result["action"], "block")

    def test_blocks_memory_write_when_not_in_allowlist(self):
        self.set_allowlist("111,222")
        hook = self.make_hook(session=fake_session_env(user_id="999"))
        result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_allows_memory_write_when_in_allowlist(self):
        self.set_allowlist("111,123456789,222")
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNone(result)

    def test_blocks_skill_manage_without_allowlist(self):
        hook = self.make_hook(session=fake_session_env())
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "test-skill"},
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_allows_skill_manage_when_in_allowlist(self):
        self.set_allowlist("111,123456789")
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "test-skill"},
        )
        self.assertIsNone(result)

    def test_denies_memory_delete_without_allowlist(self):
        hook = self.make_hook(session=fake_session_env())
        result = hook(tool_name="memory", args={"action": "delete", "key": "x"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_blocks_memory_when_not_telegram_group(self):
        self.set_allowlist("123456789")
        hook = self.make_hook(session=fake_session_env(platform="discord"))
        result = hook(tool_name="memory", args={"action": "write", "key": "x"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")
        self.assertIn("группе", result["message"])

    def test_blocks_memory_when_wrong_chat(self):
        self.set_allowlist("123456789")
        hook = self.make_hook(session=fake_session_env(chat_id="-1009999999999"))
        result = hook(tool_name="memory", args={"action": "write", "key": "x"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_blocks_memory_when_wrong_session_profile(self):
        self.set_allowlist("123456789")
        hook = self.make_hook(session=fake_session_env(profile="default"))
        result = hook(tool_name="memory", args={"action": "write", "key": "x"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_current_origin_arg_forgery_ignored(self):
        """Even if tool args claim background_review, real origin wins."""
        hook = self.make_hook(session=fake_session_env())
        result = hook(
            tool_name="memory",
            args={"action": "write", "current_origin": "background_review"},
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_blocks_add_with_managed_prefix_content(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY, PLAIN_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "add",
                    "target": "memory",
                    "content": "[parilka:managed:skills] поддельная запись",
                },
            )
            self.assertIsNotNone(result)
            self.assertEqual(result["action"], "block")

    def test_blocks_replace_with_managed_prefix_content(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "replace",
                    "target": "memory",
                    "old_text": "обычная запись",
                    "content": "[parilka:managed:new] подделка",
                },
            )
            self.assertEqual(result["action"], "block")

    def test_blocks_replace_matching_managed_entry_inner_substring(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY, PLAIN_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "replace",
                    "target": "memory",
                    "old_text": "Недельная сводка 2026-07-13",
                    "content": "новая запись",
                },
            )
            self.assertEqual(result["action"], "block")

    def test_blocks_remove_matching_managed_entry_inner_substring(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "remove",
                    "target": "memory",
                    "old_text": "2026-07-13",
                },
            )
            self.assertEqual(result["action"], "block")

    def test_blocks_batch_with_remove_touching_managed_entry(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY, PLAIN_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "target": "memory",
                    "operations": [
                        {"action": "add", "content": "новая запись"},
                        {"action": "remove", "old_text": "Недельная сводка"},
                    ],
                },
            )
            self.assertEqual(result["action"], "block")

    def test_blocks_batch_with_managed_prefix_add(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "target": "memory",
                    "operations": [
                        {"action": "add", "content": "[parilka:managed:x] фейк"},
                        {"action": "add", "content": "обычная запись"},
                    ],
                },
            )
            self.assertEqual(result["action"], "block")

    def test_managed_memory_block_applies_to_background_review(self):
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env())

            fake_wa = type(sys)("tools")
            fake_wa_sub = type(sys)("write_approval")
            fake_wa_sub.current_origin = lambda: "background_review"
            fake_wa.write_approval = fake_wa_sub

            with patch.dict(
                "sys.modules",
                {"tools": fake_wa, "tools.write_approval": fake_wa_sub},
            ):
                result = hook(
                    tool_name="memory",
                    args={
                        "action": "replace",
                        "target": "memory",
                        "old_text": "Недельная сводка",
                        "content": "новое",
                    },
                )
                self.assertEqual(result["action"], "block")

    def test_allows_owner_edit_of_plain_entry(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY, PLAIN_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "replace",
                    "target": "memory",
                    "old_text": "кофе",
                    "content": "чай",
                },
            )
            self.assertIsNone(result)

    def test_managed_memory_does_not_affect_user_target(self):
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            added = hook(
                tool_name="memory",
                args={
                    "action": "add",
                    "target": "user",
                    "content": "[parilka:managed:fake] запись",
                },
            )
            self.assertIsNone(added)
            replaced = hook(
                tool_name="memory",
                args={
                    "action": "replace",
                    "target": "user",
                    "old_text": "Недельная сводка",
                    "content": "новое",
                },
            )
            self.assertIsNone(replaced)

    def test_inspection_failure_blocks_destructive_but_not_plain_add(self):
        self.set_allowlist("123456789")
        with tempfile.TemporaryDirectory() as tmp:
            for mode in ("symlink", "invalid-utf8", "directory"):
                with self.subTest(mode=mode):
                    memory_dir = Path(tmp) / mode
                    memory_dir.mkdir()
                    memory_path = memory_dir / "MEMORY.md"
                    if mode == "symlink":
                        target = memory_dir / "elsewhere.md"
                        target.write_text(
                            ENTRY_DELIMITER.join([MANAGED_ENTRY]),
                            encoding="utf-8",
                        )
                        os.symlink(target, memory_path)
                    elif mode == "invalid-utf8":
                        memory_path.write_bytes(b"\xff\xfe\x00\xd8")
                    else:
                        memory_path.mkdir()  # not a regular file
                    with _patch_memory_tool(memory_dir):
                        hook = self.make_hook(
                            session=fake_session_env(user_id="123456789")
                        )
                        blocked = hook(
                            tool_name="memory",
                            args={
                                "action": "replace",
                                "target": "memory",
                                "old_text": "Недельная сводка",
                                "content": "новое",
                            },
                        )
                        self.assertIsNotNone(blocked)
                        self.assertEqual(blocked["action"], "block")
                        removed = hook(
                            tool_name="memory",
                            args={
                                "action": "remove",
                                "target": "memory",
                                "old_text": "Недельная сводка",
                            },
                        )
                        self.assertEqual(removed["action"], "block")
                        allowed = hook(
                            tool_name="memory",
                            args={
                                "action": "add",
                                "target": "memory",
                                "content": "обычная запись",
                            },
                        )
                        self.assertIsNone(allowed)

    def test_missing_memory_file_means_no_managed_entries(self):
        self.set_allowlist("123456789")
        with fake_memory_store(None):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            result = hook(
                tool_name="memory",
                args={
                    "action": "remove",
                    "target": "memory",
                    "old_text": "anything",
                },
            )
            self.assertIsNone(result)

    def test_open_permission_error_fails_closed_for_destructive_ops(self):
        """PermissionError on open is an inspection failure, not an empty store."""
        self.set_allowlist("123456789")
        with fake_memory_store([MANAGED_ENTRY]):
            hook = self.make_hook(session=fake_session_env(user_id="123456789"))
            with patch(
                "parilka_chat.os.open",
                side_effect=PermissionError("denied"),
            ):
                replaced = hook(
                    tool_name="memory",
                    args={
                        "action": "replace",
                        "target": "memory",
                        "old_text": "Недельная сводка",
                        "content": "новое",
                    },
                )
                self.assertEqual(replaced["action"], "block")
                removed = hook(
                    tool_name="memory",
                    args={
                        "action": "remove",
                        "target": "memory",
                        "old_text": "Недельная сводка",
                    },
                )
                self.assertEqual(removed["action"], "block")
                added = hook(
                    tool_name="memory",
                    args={
                        "action": "add",
                        "target": "memory",
                        "content": "обычная запись",
                    },
                )
                self.assertIsNone(added)

    def test_get_memory_dir_failure_blocks_destructive_ops(self):
        """A raising native get_memory_dir is an inspection failure."""
        self.set_allowlist("123456789")
        module = types.ModuleType("tools.memory_tool")
        module.ENTRY_DELIMITER = ENTRY_DELIMITER
        for exc in (PermissionError("denied"), RuntimeError("boom")):
            with self.subTest(exc=type(exc).__name__):
                def raiser(exc=exc):
                    raise exc

                module.get_memory_dir = raiser
                with patch.dict("sys.modules", {"tools.memory_tool": module}):
                    hook = self.make_hook(
                        session=fake_session_env(user_id="123456789")
                    )
                    replaced = hook(
                        tool_name="memory",
                        args={
                            "action": "replace",
                            "target": "memory",
                            "old_text": "Недельная сводка",
                            "content": "новое",
                        },
                    )
                    self.assertEqual(replaced["action"], "block")
                    self.assertEqual(
                        replaced["message"], parilka_chat.MANAGED_MEMORY_ERROR
                    )
                    removed = hook(
                        tool_name="memory",
                        args={
                            "action": "remove",
                            "target": "memory",
                            "old_text": "Недельная сводка",
                        },
                    )
                    self.assertEqual(removed["action"], "block")
                    self.assertEqual(
                        removed["message"], parilka_chat.MANAGED_MEMORY_ERROR
                    )
                    added = hook(
                        tool_name="memory",
                        args={
                            "action": "add",
                            "target": "memory",
                            "content": "обычная запись",
                        },
                    )
                    self.assertIsNone(added)


if __name__ == "__main__":
    unittest.main()
