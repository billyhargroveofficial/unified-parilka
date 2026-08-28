"""Tests: pre_llm_call hook for parilka-chat plugin.

Covers the causal cached-context slice: exactly one raw prefixed dispatch
with {"mode":"recent","count":SLICE_COUNT,"source_message_id":N} on healthy
turns (no after_id), one bounded smaller retry when an ok response carries
no usable messages list (the projection-only collapse), suffix-anchored
high-water parsing from api_content sidecars, strict 8500-char budget,
render-only marker semantics, and the structural safety of SLICE_COUNT
against the 192000-char projection cap.
"""

from __future__ import annotations

import json
import os
import re
import unittest
from unittest.mock import MagicMock, patch

from tests.support.hermes_plugin_helpers import (
    cached_row,
    fake_dispatch_ok,
    fake_session_env,
    slice_ok_response,
)

import parilka_chat  # type: ignore[import-not-found]

MARKER = parilka_chat.CONTEXT_MARKER
RAW_SLICE = "mcp__telegram_parilka__read_chat_slice"
# Mirror of MAX_READ_CHAT_SLICE_OUTPUT_CHARS in src/bot/read-tools/contracts.ts
# — the TS projection cap for read_chat_slice payloads.
MAX_SLICE_PROJECTION_CHARS = 192_000


def make_ctx(profile: str = "parilka") -> MagicMock:
    ctx = MagicMock()
    ctx.profile_name = profile
    return ctx


def run_hook(ctx, session, rows=None, inner=None, history=None,
             responses=None):
    """Run the pre_llm hook with a fake session and dispatch response(s).

    ``responses`` (a list of raw dispatch return strings consumed in order
    via side_effect) overrides ``rows``/``inner`` for multi-dispatch
    scenarios like the projection-only fallback.
    """
    if responses is not None:
        ctx.dispatch_tool.side_effect = responses
    else:
        if inner is None:
            inner = slice_ok_response(rows or [])
        ctx.dispatch_tool.return_value = fake_dispatch_ok(inner)
    with patch("parilka_chat._get_session_env", return_value=session):
        hook = parilka_chat._make_pre_llm_call_hook(ctx)
        return hook(
            session_id="s1", user_message="hi",
            conversation_history=history or [], is_first_turn=True,
            model="test", platform="telegram",
        )


class PreLlmSessionGuardTests(unittest.TestCase):
    """pre_llm_call must no-op outside the allowed group/profile."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def test_returns_none_for_wrong_platform(self):
        ctx = make_ctx()
        result = run_hook(ctx, fake_session_env(platform="discord"))
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_not_called()

    def test_returns_none_for_wrong_profile(self):
        ctx = make_ctx()
        result = run_hook(ctx, fake_session_env(profile="default"))
        self.assertIsNone(result)

    def test_returns_none_for_wrong_group(self):
        ctx = make_ctx()
        result = run_hook(ctx, fake_session_env(chat_id="-1009999999999"))
        self.assertIsNone(result)

    def test_returns_none_for_wrong_captured_ctx_profile(self):
        ctx = make_ctx(profile="default")
        result = run_hook(ctx, fake_session_env())
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_not_called()


class PreLlmDispatchTests(unittest.TestCase):
    """Exactly one raw prefixed slice dispatch with exact args."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def test_exact_raw_dispatch_args_no_after_id(self):
        ctx = make_ctx()
        run_hook(
            ctx, fake_session_env(message_id="100"),
            rows=[cached_row(95, "Привет!")],
        )
        ctx.dispatch_tool.assert_called_once_with(
            RAW_SLICE,
            {"mode": "recent", "count": parilka_chat.SLICE_COUNT,
             "source_message_id": 100},
        )

    def test_dispatch_twice_uses_same_exact_args_with_highwater(self):
        """High-water filters locally; dispatch args never contain after_id."""
        ctx = make_ctx()
        history = [{
            "role": "user",
            "content": "prev",
            "api_content": "prev\n\n\u200Bhw=90\u200B",
        }]
        run_hook(
            ctx, fake_session_env(message_id="200"),
            rows=[cached_row(195, "new"), cached_row(90, "seen")],
            history=history,
        )
        ctx.dispatch_tool.assert_called_once_with(
            RAW_SLICE,
            {"mode": "recent", "count": parilka_chat.SLICE_COUNT,
             "source_message_id": 200},
        )
        ctx_text = run_hook(
            ctx, fake_session_env(message_id="200"),
            rows=[cached_row(195, "new"), cached_row(90, "seen")],
            history=history,
        )["context"]
        self.assertIn("new", ctx_text)
        self.assertNotIn("seen", ctx_text)

    def test_ok_false_returns_none_no_retry(self):
        ctx = make_ctx()
        result = run_hook(
            ctx, fake_session_env(),
            inner={"ok": False, "tool": "read_chat_slice",
                   "error": {"code": "cache_error", "retryable": False,
                             "message": "fail"},
                   "evidence": []},
        )
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_called_once()

    def test_malformed_result_returns_none_no_retry(self):
        ctx = make_ctx()
        result = run_hook(
            ctx, fake_session_env(),
            inner={"ok": True, "tool": "read_chat_slice", "status": "done",
                   "result": "not-a-dict", "evidence": []},
        )
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_called_once()

    def test_malformed_messages_returns_none_after_bounded_retry(self):
        """A success without a usable messages list retries once, bounded."""
        ctx = make_ctx()
        inner = slice_ok_response([cached_row(95, "x")])
        inner["result"]["messages"] = "not-a-list"
        result = run_hook(ctx, fake_session_env(), inner=inner)
        self.assertIsNone(result)
        self.assertEqual(ctx.dispatch_tool.call_count, 2)

    def test_malformed_coverage_returns_none_no_retry(self):
        ctx = make_ctx()
        inner = slice_ok_response([cached_row(95, "x")])
        inner["result"]["coverage"] = None
        result = run_hook(ctx, fake_session_env(), inner=inner)
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_called_once()

    def test_dispatch_exception_fails_soft_no_retry(self):
        ctx = make_ctx()
        ctx.dispatch_tool.side_effect = RuntimeError("MCP down")
        result = run_hook(ctx, fake_session_env(), rows=[cached_row(95, "x")])
        self.assertIsNone(result)
        ctx.dispatch_tool.assert_called_once()


class PreLlmProjectionCollapseTests(unittest.TestCase):
    """Projection-only ok responses fail soft with ONE bounded smaller retry.

    Reproduces the live failure: read_chat_slice collapsed its oversized
    payload to result={"projection": ...} (no messages/coverage) and the
    hook silently returned None on every turn. The hook must not crash and
    must recover via the bounded fallback dispatch.
    """

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"
        self.ctx = make_ctx()
        self.session = fake_session_env(message_id="100")

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def projection_only(self) -> dict:
        """The exact collapse shape produced by boundToolPayload."""
        return {
            "ok": True,
            "tool": "read_chat_slice",
            "status": "done",
            "result": {
                "projection": {
                    "truncated": True,
                    "omittedEvidence": 0,
                    "maxCharacters": MAX_SLICE_PROJECTION_CHARS,
                },
            },
            "evidence": [],
        }

    def test_projection_only_retries_once_and_injects_fallback(self):
        fallback_rows = [cached_row(95, "Привет!", sender_name="Alice")]
        result = run_hook(
            self.ctx, self.session,
            responses=[
                fake_dispatch_ok(self.projection_only()),
                fake_dispatch_ok(slice_ok_response(
                    fallback_rows,
                    requested_count=parilka_chat.FALLBACK_SLICE_COUNT,
                )),
            ],
        )
        self.assertIsNotNone(result)
        self.assertIn("Привет!", result["context"])
        self.assertIn("Alice", result["context"])
        self.assertTrue(
            result["context"].endswith(MARKER + "hw=95" + MARKER)
        )
        calls = [c.args for c in self.ctx.dispatch_tool.call_args_list]
        self.assertEqual(calls, [
            (RAW_SLICE, {"mode": "recent", "count": parilka_chat.SLICE_COUNT,
                         "source_message_id": 100}),
            (RAW_SLICE, {"mode": "recent",
                         "count": parilka_chat.FALLBACK_SLICE_COUNT,
                         "source_message_id": 100}),
        ])

    def test_projection_only_twice_returns_none_without_crash(self):
        result = run_hook(
            self.ctx, self.session,
            responses=[
                fake_dispatch_ok(self.projection_only()),
                fake_dispatch_ok(self.projection_only()),
            ],
        )
        self.assertIsNone(result)
        self.assertEqual(self.ctx.dispatch_tool.call_count, 2)


class PreLlmContextTests(unittest.TestCase):
    """Rendered context: order, labels, exclusions, budget, metadata."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"
        self.ctx = make_ctx()
        self.session = fake_session_env(message_id="200")

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def context_for(self, rows, history=None, coverage=None):
        inner = slice_ok_response(rows)
        if coverage is not None:
            inner["result"]["coverage"] = coverage
        result = run_hook(
            self.ctx, self.session, inner=inner, history=history or []
        )
        self.assertIsNotNone(result)
        return result["context"]

    def test_chronological_output_with_assistant_labels(self):
        rows = [
            cached_row(95, "вопрос", sender_name="Alice"),
            cached_row(98, "ответ бота", sender_name="Bot", is_own=True),
        ]
        ctx_text = self.context_for(rows)
        self.assertLess(ctx_text.index("вопрос"), ctx_text.index("ответ бота"))
        self.assertIn("[ассистент]", ctx_text)
        self.assertIn("Alice", ctx_text)

    def test_excludes_ids_at_or_above_source(self):
        rows = [
            cached_row(95, "past", sender_name="C"),
            cached_row(200, "future", sender_name="A"),
            cached_row(201, "also future", sender_name="B"),
        ]
        ctx_text = self.context_for(rows)
        self.assertNotIn("future", ctx_text)
        self.assertIn("past", ctx_text)

    def test_highwater_dedup_excludes_seen_rows(self):
        history = [{
            "role": "user",
            "content": "prev",
            "api_content": "prev\n\n" + MARKER + "hw=190" + MARKER,
        }]
        rows = [
            cached_row(195, "new", sender_name="A"),
            cached_row(190, "seen", sender_name="B"),
            cached_row(180, "older seen", sender_name="C"),
        ]
        ctx_text = self.context_for(rows, history=history)
        self.assertIn("new", ctx_text)
        self.assertNotIn("seen", ctx_text)
        self.assertNotIn("older seen", ctx_text)

    def test_total_context_within_exact_budget_no_allowance(self):
        rows = [cached_row(100 + i, "x" * 200, sender_name=f"U{i}") for i in range(80)]
        ctx_text = self.context_for(rows)
        self.assertLessEqual(len(ctx_text), parilka_chat.MAX_CONTEXT_CHARS)
        self.assertIn("старше не влезло:", ctx_text)

    def test_context_never_sliced_mid_row(self):
        rows = [cached_row(100 + i, "x" * 200, sender_name=f"U{i}") for i in range(80)]
        ctx_text = self.context_for(rows)
        parts = ctx_text.split("\n\n")
        self.assertEqual(parts[-1], MARKER + "hw=" + parts[-1].split("=")[1].strip(MARKER) + MARKER)
        # Every rendered body line is a complete row: label + msg_id.
        for line in parts[2:-1]:
            self.assertRegex(line, r"^(\[ассистент\]|\[?U\d+\]?) .*msg_id=\d+")

    def test_marker_is_max_rendered_row_only(self):
        rows = [
            cached_row(105, "", sender_name="Empty"),   # empty → not rendered
            cached_row(104, 123, sender_name="Bad"),    # malformed → not rendered
            cached_row(102, "real", sender_name="A"),
            cached_row(101, "real2", sender_name="B"),
        ]
        ctx_text = self.context_for(rows)
        self.assertIn(MARKER + "hw=102" + MARKER, ctx_text)
        self.assertNotIn("Empty", ctx_text)
        self.assertNotIn("msg_id=105", ctx_text)
        self.assertNotIn("msg_id=104", ctx_text)

    def test_budget_skipped_rows_do_not_advance_marker(self):
        rows = [cached_row(100 + i, "x" * 200, sender_name=f"U{i}") for i in range(80)]
        ctx_text = self.context_for(rows)
        match = re.search(re.escape(MARKER) + r"hw=(\d+)" + re.escape(MARKER), ctx_text)
        marker_id = int(match.group(1))
        rendered_ids = {
            int(m.group(1))
            for m in re.finditer(r"msg_id=(\d+)", ctx_text)
        }
        self.assertEqual(marker_id, max(rendered_ids))
        self.assertIn("старше не влезло: ", ctx_text)
        skipped = int(re.search(r"старше не влезло: (\d+)", ctx_text).group(1))
        self.assertGreater(skipped, 0)
        self.assertEqual(skipped, 80 - len(rendered_ids))

    def test_metadata_fields_present(self):
        rows = [cached_row(150, "a", sender_name="A"), cached_row(160, "b", sender_name="B")]
        coverage = {
            "firstMessageId": 150,
            "lastMessageId": 160,
            "totalAvailable": 500,
            "returnedCount": 2,
            "omittedCount": 3,
        }
        ctx_text = self.context_for(rows, coverage=coverage)
        self.assertIn("окно 150..160", ctx_text)
        self.assertIn("в кэше 500", ctx_text)
        self.assertIn("запрошено 2", ctx_text)
        self.assertIn("пропущено в окне 3", ctx_text)
        self.assertIn("prev_hw=0", ctx_text)
        self.assertIn("показано 2", ctx_text)
        self.assertIn("старше не влезло: 0", ctx_text)
        # First injection with omitted rows is a pre-window gap (#2).
        self.assertIn("разрыв до окна: да", ctx_text)

    def test_pre_window_gap_flag_when_highwater_predates_window(self):
        history = [{
            "role": "user",
            "content": "prev",
            "api_content": "prev\n\n" + MARKER + "hw=90" + MARKER,
        }]
        rows = [cached_row(150, "a", sender_name="A"), cached_row(160, "b", sender_name="B")]
        coverage = {"firstMessageId": 150, "lastMessageId": 160,
                    "totalAvailable": 500, "returnedCount": 2, "omittedCount": 1}
        ctx_text = self.context_for(rows, history=history, coverage=coverage)
        self.assertIn("prev_hw=90", ctx_text)
        self.assertIn("разрыв до окна: да", ctx_text)

    def test_no_eligible_rows_returns_none(self):
        history = [{
            "role": "user",
            "content": "prev",
            "api_content": "prev\n\n" + MARKER + "hw=250" + MARKER,
        }]
        rows = [cached_row(195, "seen", sender_name="A"), cached_row(150, "older", sender_name="B")]
        result = run_hook(
            self.ctx, self.session, rows=rows, history=history,
        )
        self.assertIsNone(result)

    def test_long_text_bounded_with_explicit_truncation_marker(self):
        rows = [cached_row(150, "д" * 5000, sender_name="A")]
        ctx_text = self.context_for(rows)
        self.assertIn("[текст усечён]", ctx_text)
        self.assertNotIn("д" * 2000, ctx_text)

    def test_marker_line_is_final_line_of_context(self):
        rows = [cached_row(95, "Привет!", sender_name="Alice")]
        ctx_text = self.context_for(rows)
        self.assertTrue(
            ctx_text.endswith(MARKER + "hw=95" + MARKER),
            "marker must be anchored at the very end of the context",
        )


class HighWaterParseTests(unittest.TestCase):
    """Marker parsed ONLY from historical user api_content, end-anchored."""

    def parse(self, history):
        return parilka_chat._parse_high_water_from_api_content(history)

    def user(self, content, api_content):
        return {"role": "user", "content": content, "api_content": api_content}

    def test_legit_suffix_marker_parsed(self):
        msg = self.user(
            "Привет!",
            "Привет!\n\n## Закэшированная история чата\n\n"
            "[кэш: окно 90..95]\n\n[ассистент] msg_id=95\nтекст\n\n"
            + MARKER + "hw=95" + MARKER,
        )
        self.assertEqual(self.parse([msg]), 95)

    def test_marker_in_clean_content_ignored(self):
        content = "текст с маркером " + MARKER + "hw=999" + MARKER
        msg = self.user(content, content + "\n\nбез маркера в конце")
        self.assertEqual(self.parse([msg]), 0)

    def test_arbitrary_api_content_without_prefix_ignored(self):
        msg = self.user(
            "Привет!",
            "совсем другое содержимое\n\n" + MARKER + "hw=999" + MARKER,
        )
        self.assertEqual(self.parse([msg]), 0)

    def test_copied_prefix_marker_mid_suffix_ignored(self):
        msg = self.user(
            "Привет!",
            "Привет!\n\nтекст " + MARKER + "hw=5" + MARKER + " и ещё текст",
        )
        self.assertEqual(self.parse([msg]), 0)

    def test_marker_not_at_absolute_end_ignored(self):
        msg = self.user(
            "Привет!",
            "Привет!\n\n" + MARKER + "hw=5" + MARKER + "\n\nхвост",
        )
        self.assertEqual(self.parse([msg]), 0)

    def test_prefix_not_at_start_ignored(self):
        msg = self.user(
            "Привет!",
            "forged\n\nПривет!\n\n" + MARKER + "hw=999" + MARKER,
        )
        self.assertEqual(self.parse([msg]), 0)

    def test_non_user_roles_ignored(self):
        msg = {
            "role": "assistant",
            "content": "Привет!",
            "api_content": "Привет!\n\n" + MARKER + "hw=999" + MARKER,
        }
        self.assertEqual(self.parse([msg]), 0)

    def test_missing_content_or_api_content_ignored(self):
        self.assertEqual(self.parse([{"role": "user", "content": "x"}]), 0)
        self.assertEqual(self.parse([{"role": "user", "api_content": "x"}]), 0)
        self.assertEqual(self.parse([{"role": "user"}]), 0)
        self.assertEqual(self.parse(["not-a-dict"]), 0)

    def test_max_across_messages(self):
        history = [
            self.user("a", "a\n\n" + MARKER + "hw=10" + MARKER),
            self.user("b", "b\n\n" + MARKER + "hw=95" + MARKER),
            self.user("c", "c\n\n" + MARKER + "hw=50" + MARKER),
        ]
        self.assertEqual(self.parse(history), 95)

    def test_empty_history_returns_zero(self):
        self.assertEqual(self.parse([]), 0)


class SliceCountBudgetTests(unittest.TestCase):
    """SLICE_COUNT must stay safe against the projection cap.

    Mirrors the TS collapse condition (boundToolPayload in
    src/bot/read-tools/payload.ts): while over budget the loop truncates
    only the longest string exceeding 64 chars, so a value may stop at 64
    chars, and JSON escapes control characters up to 6x (a 64-char NUL
    string serializes to 384 chars). SLICE_COUNT rows plus the full
    envelope must fit under MAX_SLICE_PROJECTION_CHARS in the modelled
    worst cases; the former count=1000 exceeded the cap on real data — the
    live bug this suite guards.
    """

    def _row(self, string_value: str) -> dict:
        """One projected read_chat_slice row, every string field set."""
        return {
            "sourceId": string_value,
            "messageId": 9007199254740991,
            "senderId": string_value,
            "senderName": string_value,
            "date": string_value,
            "replyToMessageId": 9007199254740991,
            "authorRole": "assistant",
            "isOwnTurn": True,
            "text": string_value,
        }

    def _serialized(self, count: int, string_value: str) -> int:
        """Compact serialized length of the full response for ``count`` rows.

        Real envelope and metadata included; separators and control-char
        escaping (\\uXXXX) match JSON.stringify.
        """
        payload = {
            "ok": True,
            "tool": "read_chat_slice",
            "status": "done",
            "result": {
                "mode": "recent",
                "requested": {"count": count},
                "coverage": {
                    "upperMessageId": None,
                    "totalAvailable": count,
                    "returnedCount": count,
                    "coveredCount": count,
                    "firstMessageId": 1,
                    "lastMessageId": count,
                    "firstDate": string_value,
                    "lastDate": string_value,
                    "emptyTextCount": 0,
                    "truncated": False,
                    "omittedCount": 0,
                    "hasMore": False,
                    "nextCursor": string_value,
                },
                "messages": [self._row(string_value)] * count,
            },
            "evidence": [],
        }
        return len(json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"),
        ))

    def test_primary_slice_count_fits_json_safe_64_char_rows(self):
        # Post-truncation values may stop at 64 chars; JSON-safe content
        # serializes 1:1, so the primary 300 rows must still fit the cap.
        total = self._serialized(parilka_chat.SLICE_COUNT, "x" * 64)
        self.assertLessEqual(
            total, MAX_SLICE_PROJECTION_CHARS,
            "SLICE_COUNT=%s would collapse to projection-only under the "
            "%s-char cap" % (
                parilka_chat.SLICE_COUNT, MAX_SLICE_PROJECTION_CHARS,
            ),
        )

    def test_fallback_slice_count_fits_max_escape_expansion(self):
        # Fully pessimistic: every string field is 64 control characters,
        # each escaping to 6 serialized chars (matches JSON.stringify).
        total = self._serialized(
            parilka_chat.FALLBACK_SLICE_COUNT, "\x00" * 64,
        )
        self.assertLessEqual(
            total, MAX_SLICE_PROJECTION_CHARS,
            "FALLBACK_SLICE_COUNT=%s must fit under maximum JSON escape "
            "expansion" % parilka_chat.FALLBACK_SLICE_COUNT,
        )


if __name__ == "__main__":
    unittest.main()
