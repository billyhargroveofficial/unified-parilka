"""Narrow regression tests for parilka-chat plugin tweaks.

Covers: pre_tool_call session gate before background_review, managed
skill_manage target blocking, pre-window gap semantics, high-water marker
suffix parsing, strict message id validation, and profile file contracts.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from tests.support.hermes_plugin_helpers import fake_session_env

import parilka_chat  # type: ignore[import-not-found]

PROFILE_DIR = (
    Path(__file__).resolve().parents[1]
    / "integrations"
    / "hermes"
    / "parilka-profile"
)


def _fake_write_approval(origin: str):
    """Patch tools.write_approval.current_origin for the hook."""
    fake_wa = type(sys)("tools")
    fake_wa_sub = type(sys)("write_approval")
    fake_wa_sub.current_origin = lambda: origin
    fake_wa.write_approval = fake_wa_sub
    return patch.dict(
        "sys.modules", {"tools": fake_wa, "tools.write_approval": fake_wa_sub}
    )


class PreToolCallGateTweaksTests(unittest.TestCase):
    """#1/#7: session gate precedes origin; managed skills always blocked."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"
        os.environ["PARILKA_BOT_MEMORY_WRITE_SENDER_IDS"] = "123456789"

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)
        os.environ.pop("PARILKA_BOT_MEMORY_WRITE_SENDER_IDS", None)

    def make_hook(self, profile="parilka", session=None):
        ctx = MagicMock()
        ctx.profile_name = profile
        if session is not None:
            session_patch = patch(
                "parilka_chat._get_session_env", return_value=session
            )
            session_patch.start()
            self.addCleanup(session_patch.stop)
        return parilka_chat._make_pre_tool_call_hook(ctx)

    def test_background_review_requires_valid_group_session(self):
        """#1: background_review outside a valid group session is blocked."""
        hook = self.make_hook(session=fake_session_env(platform="discord"))
        with _fake_write_approval("background_review"):
            result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")

    def test_background_review_allowed_from_valid_group_session(self):
        """#1: background_review from the correct group session is allowed."""
        hook = self.make_hook(session=fake_session_env())
        with _fake_write_approval("background_review"):
            result = hook(tool_name="memory", args={"action": "write", "key": "k"})
        self.assertIsNone(result)

    def test_blocks_skill_manage_for_managed_name(self):
        """#7: name parilka-lessons is never model-editable."""
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "parilka-lessons"},
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block")
        self.assertIn("managed", result["message"])

    def test_blocks_skill_manage_for_managed_prefix(self):
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "parilka-skill-weekly"},
        )
        self.assertEqual(result["action"], "block")

    def test_blocks_skill_manage_for_managed_category(self):
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={
                "operation": "create",
                "name": "other",
                "category": "parilka-managed",
            },
        )
        self.assertEqual(result["action"], "block")

    def test_managed_skill_manage_blocked_even_for_background_review(self):
        hook = self.make_hook(session=fake_session_env())
        with _fake_write_approval("background_review"):
            result = hook(
                tool_name="skill_manage",
                args={"operation": "create", "name": "parilka-lessons"},
            )
        self.assertEqual(result["action"], "block")

    def test_allows_skill_manage_for_unmanaged_name(self):
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "test-skill"},
        )
        self.assertIsNone(result)

    def test_managed_error_is_stable_and_generic(self):
        """#7: block message is stable and contains no paths."""
        hook = self.make_hook(session=fake_session_env(user_id="123456789"))
        result = hook(
            tool_name="skill_manage",
            args={"operation": "create", "name": "parilka-lessons"},
        )
        self.assertEqual(result["message"], parilka_chat.MANAGED_SKILL_ERROR)
        self.assertNotIn("/", result["message"])


class PreWindowGapTests(unittest.TestCase):
    """#2: gap is true only when rows were omitted before the window."""

    MESSAGES = [
        {"messageId": 5, "text": "a", "senderName": "x"},
        {"messageId": 10, "text": "b", "senderName": "x"},
    ]

    def build(self, coverage, high_water=3):
        ctx = parilka_chat._build_context(
            self.MESSAGES, coverage, high_water, current_source=100
        )
        self.assertIsNotNone(ctx)
        return ctx

    def test_gap_true_when_omitted_and_hw_below_window(self):
        ctx = self.build(
            {
                "firstMessageId": 5,
                "lastMessageId": 10,
                "totalAvailable": 20,
                "returnedCount": 2,
                "omittedCount": 3,
            }
        )
        self.assertIn("разрыв до окна: да", ctx)

    def test_gap_true_on_first_injection(self):
        ctx = self.build(
            {
                "firstMessageId": 5,
                "lastMessageId": 10,
                "totalAvailable": 20,
                "returnedCount": 2,
                "omittedCount": 3,
            },
            high_water=0,
        )
        self.assertIn("разрыв до окна: да", ctx)

    def test_gap_false_without_omitted_rows(self):
        ctx = self.build(
            {
                "firstMessageId": 5,
                "lastMessageId": 10,
                "totalAvailable": 2,
                "returnedCount": 2,
                "omittedCount": 0,
            }
        )
        self.assertIn("разрыв до окна: нет", ctx)

    def test_gap_true_via_has_more(self):
        ctx = self.build(
            {
                "firstMessageId": 5,
                "lastMessageId": 10,
                "totalAvailable": 2,
                "returnedCount": 2,
                "omittedCount": 0,
                "hasMore": True,
            }
        )
        self.assertIn("разрыв до окна: да", ctx)


class HighWaterSuffixParseTests(unittest.TestCase):
    """#3: marker is parsed only from the suffix after content + '\\n\\n'."""

    def parse(self, history):
        return parilka_chat._parse_high_water_from_api_content(history)

    def test_marker_in_suffix_is_parsed(self):
        val = self.parse(
            [
                {
                    "role": "user",
                    "content": "привет",
                    "api_content": "привет\n\nx\u200bhw=42\u200b",
                }
            ]
        )
        self.assertEqual(val, 42)

    def test_marker_inside_content_is_ignored(self):
        val = self.parse(
            [
                {
                    "role": "user",
                    "content": "привет\u200bhw=9\u200b",
                    "api_content": "привет\u200bhw=9\u200b\n\nхвост",
                }
            ]
        )
        self.assertEqual(val, 0)

    def test_marker_mid_suffix_is_ignored(self):
        val = self.parse(
            [
                {
                    "role": "user",
                    "content": "а",
                    "api_content": "а\n\n\u200bhw=8\u200b mid",
                }
            ]
        )
        self.assertEqual(val, 0)

    def test_without_content_prefix_is_ignored(self):
        val = self.parse(
            [{"role": "user", "content": "а", "api_content": "б\n\n\u200bhw=8\u200b"}]
        )
        self.assertEqual(val, 0)

    def test_non_user_role_is_ignored(self):
        val = self.parse(
            [
                {
                    "role": "assistant",
                    "content": "а",
                    "api_content": "а\n\n\u200bhw=8\u200b",
                }
            ]
        )
        self.assertEqual(val, 0)


class MessageRowValidationTests(unittest.TestCase):
    """#4: message ids must be positive ints; bool/float/oversize rejected."""

    def row(self, msg):
        return parilka_chat._format_row(msg, high_water=0, current_source=100)

    def test_bool_message_id_rejected(self):
        self.assertIsNone(self.row({"messageId": True, "text": "x"}))
        self.assertIsNone(self.row({"messageId": False, "text": "x"}))

    def test_float_message_id_rejected(self):
        self.assertIsNone(self.row({"messageId": 1.5, "text": "x"}))

    def test_oversize_message_id_rejected(self):
        self.assertIsNone(self.row({"messageId": 10**16, "text": "x"}))

    def test_non_positive_message_id_rejected(self):
        self.assertIsNone(self.row({"messageId": 0, "text": "x"}))
        self.assertIsNone(self.row({"messageId": -5, "text": "x"}))

    def test_valid_row_accepted(self):
        row = self.row({"messageId": 5, "text": "ok", "senderName": "x"})
        self.assertIsNotNone(row)
        self.assertEqual(row[0], 5)

    def test_bool_reply_to_not_rendered(self):
        row = self.row({"messageId": 5, "text": "ok", "replyToMessageId": True})
        self.assertIsNotNone(row)
        self.assertNotIn("reply_to=", row[1])

    def test_bool_coverage_window_ids_fall_back(self):
        """#4: bool coverage ids fall back to rendered row bounds."""
        ctx = parilka_chat._build_context(
            [
                {"messageId": 5, "text": "a", "senderName": "x"},
                {"messageId": 10, "text": "b", "senderName": "x"},
            ],
            {
                "firstMessageId": True,
                "lastMessageId": False,
                "totalAvailable": 2,
                "returnedCount": 2,
                "omittedCount": 0,
            },
            high_water=0,
            current_source=100,
        )
        self.assertIsNotNone(ctx)
        self.assertIn("окно 5..10", ctx)


class ProfileFilesContentTests(unittest.TestCase):
    """File-level contracts for config.yaml, SOUL.md, .env.template, HERMES.md."""

    def read(self, name):
        return (PROFILE_DIR / name).read_text(encoding="utf-8")

    def squash(self, text):
        """Collapse markdown line wraps so phrases survive re-wrapping."""
        return " ".join(text.split())

    def test_config_nudge_intervals(self):
        """#5: memory nudge off, skills creation nudge at 10."""
        text = self.read("config.yaml")
        self.assertIn("nudge_interval: 0", text)
        self.assertIn("creation_nudge_interval: 10", text)

    def test_soul_managed_contracts(self):
        """#6: managed entries/skills forbidden, memory described as mutation."""
        text = self.read("SOUL.md")
        self.assertIn("[parilka:managed:*]", text)
        self.assertIn("parilka-managed", text)
        self.assertIn("add/replace/remove", text)
        self.assertIn("Markdown-таблицы", text)

    def test_soul_capability_precedence(self):
        """#10: self-capability facts in managed memory are historical snapshots."""
        text = self.squash(self.read("SOUL.md"))
        self.assertIn("snapshot", text)
        self.assertIn("authenticated Codex tool surface", text)
        self.assertIn("vision unavailable", text)
        self.assertIn("runtime footer", text)

    def test_soul_vision_full_turn_wording(self):
        """#10: vision cap is per full turn, not per album."""
        text = self.read("SOUL.md")
        self.assertIn("полный ход", text)
        self.assertIn("6 изображений суммарно", text)
        self.assertIn("входящие", text)
        self.assertIn("vision_analyze", text)

    def test_env_template_no_openai_key(self):
        """#8: vision auth via native credentials, no OPENAI_API_KEY."""
        text = self.read(".env.template")
        self.assertNotIn("OPENAI_API_KEY", text)
        self.assertIn("auth add openai-codex", text)

    def test_hermes_runbook_no_openai_key_and_no_verify_claim(self):
        """#8/#9: runbook drops OPENAI_API_KEY; verify needs no authorization."""
        text = (
            Path(__file__).resolve().parents[1] / "operations" / "HERMES.md"
        ).read_text(encoding="utf-8")
        self.assertNotIn("OPENAI_API_KEY", text)
        self.assertIn("auth add openai-codex", text)
        self.assertNotIn("НЕ запускать без авторизации", text)

    def test_hermes_runbook_vision_cap_full_turn(self):
        """#10: runbook documents the full-turn ledger/bridge/gate vision cap."""
        text = self.squash(
            (
                Path(__file__).resolve().parents[1] / "operations" / "HERMES.md"
            ).read_text(encoding="utf-8")
        )
        self.assertIn("full Telegram turn", text)
        self.assertIn("input attachments", text)
        self.assertIn("later tool calls", text)


if __name__ == "__main__":
    unittest.main()
