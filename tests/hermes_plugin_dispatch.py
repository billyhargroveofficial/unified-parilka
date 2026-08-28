"""Tests: tool handler dispatch for parilka-chat plugin.

Covers raw prefixed MCP routing (clean name dispatches
mcp__telegram_parilka__<tool> exactly once), strict argument allowlisting
(forged chat/source_message_id rejected without dispatch), and the exact
public outer shape {"result": "<inner JSON>"} with generic top-level errors.
"""

from __future__ import annotations

import json
import os
import unittest
from unittest.mock import MagicMock, patch

from tests.support.hermes_plugin_helpers import (
    fake_dispatch_error,
    fake_dispatch_ok,
    fake_legacy_mcp_response,
    fake_session_env,
)

import parilka_chat  # type: ignore[import-not-found]


def make_ctx(profile: str = "parilka") -> MagicMock:
    ctx = MagicMock()
    ctx.profile_name = profile
    return ctx


_MISSING = object()


class ToolHandlerRawRoutingTests(unittest.TestCase):
    """Clean registered names must dispatch the raw prefixed name, once."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def valid_args_for(self, clean_name: str) -> dict:
        return {
            "rag_bm25_search": {"query": "test"},
            "keyword_search": {"query": "test"},
            "read_chat_slice": {"mode": "recent"},
            "day_digest": {"day_from": "2026-08-01"},
            "thread_context": {"message_id": 5},
        }[clean_name]

    def assert_dispatched_raw(self, clean_name: str):
        """Handler for clean_name must call dispatch_tool(raw_name, args)."""
        expected_raw = f"mcp__telegram_parilka__{clean_name}"
        self.assertEqual(parilka_chat.RAW_TOOL_NAMES[clean_name], expected_raw)

        with patch(
            "parilka_chat._get_session_env",
            return_value=fake_session_env(message_id="42"),
        ):
            ctx = make_ctx()
            ctx.dispatch_tool.return_value = fake_dispatch_ok(
                {"ok": True, "tool": clean_name, "status": "done",
                 "result": {}, "evidence": []},
            )
            handler = parilka_chat._make_tool_handler(clean_name, ctx)
            handler(self.valid_args_for(clean_name))

        ctx.dispatch_tool.assert_called_once()
        called_name, called_args = ctx.dispatch_tool.call_args[0]
        self.assertEqual(called_name, expected_raw)
        self.assertEqual(called_args["source_message_id"], 42)

    def test_rag_bm25_search_dispatches_raw(self):
        self.assert_dispatched_raw("rag_bm25_search")

    def test_keyword_search_dispatches_raw(self):
        self.assert_dispatched_raw("keyword_search")

    def test_read_chat_slice_dispatches_raw(self):
        self.assert_dispatched_raw("read_chat_slice")

    def test_day_digest_dispatches_raw(self):
        self.assert_dispatched_raw("day_digest")

    def test_thread_context_dispatches_raw(self):
        self.assert_dispatched_raw("thread_context")

    def test_raw_mapping_covers_all_clean_names(self):
        self.assertEqual(
            set(parilka_chat.RAW_TOOL_NAMES), set(parilka_chat.TOOL_NAMES)
        )
        for name in parilka_chat.TOOL_NAMES:
            raw = parilka_chat.RAW_TOOL_NAMES[name]
            self.assertTrue(raw.startswith("mcp__telegram_parilka__"))
            self.assertTrue(raw.endswith(f"__{name}"))


class ToolHandlerContractTests(unittest.TestCase):
    """Outer shape, argument allowlist, generic errors."""

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "-1003179772905"
        self.session_patch = patch(
            "parilka_chat._get_session_env",
            return_value=fake_session_env(message_id="42"),
        )
        self.session_patch.start()

    def tearDown(self):
        self.session_patch.stop()
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def call(self, name="rag_bm25_search", args=_MISSING, profile="parilka", ctx=None):
        if ctx is None:
            ctx = make_ctx(profile)
        handler = parilka_chat._make_tool_handler(name, ctx)
        if args is _MISSING:
            args = {"query": "test"}
        return handler(args)

    def test_success_shape_is_exact_outer_envelope(self):
        inner = {"ok": True, "tool": "rag_bm25_search", "status": "done",
                 "result": {"messages": []}, "evidence": []}
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = fake_dispatch_ok(inner)
        result = self.call(ctx=ctx)
        outer = json.loads(result)
        self.assertEqual(set(outer.keys()), {"result"})
        self.assertIsInstance(outer["result"], str)
        self.assertEqual(json.loads(outer["result"]), inner)

    def test_operational_ok_false_passes_unchanged(self):
        inner = {"ok": False, "tool": "rag_bm25_search",
                 "error": {"code": "cache_error", "retryable": False,
                           "message": "DB is closed"},
                 "evidence": []}
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = fake_dispatch_ok(inner)
        result = json.loads(self.call(ctx=ctx))
        self.assertEqual(json.loads(result["result"]), inner)
        self.assertNotIn("error", result)

    def test_forged_chat_rejected_without_dispatch(self):
        ctx = make_ctx()
        result = self.call(args={"query": "x", "chat": "-1009999999999"}, ctx=ctx)
        self.assertEqual(json.loads(result), {"error": parilka_chat.INVALID_ARGS})
        ctx.dispatch_tool.assert_not_called()

    def test_forged_source_message_id_rejected_without_dispatch(self):
        ctx = make_ctx()
        result = self.call(args={"query": "x", "source_message_id": 99999}, ctx=ctx)
        self.assertEqual(json.loads(result), {"error": parilka_chat.INVALID_ARGS})
        ctx.dispatch_tool.assert_not_called()

    def test_extra_key_rejected_without_dispatch(self):
        ctx = make_ctx()
        result = self.call(args={"query": "x", "extra": "keep-me"}, ctx=ctx)
        self.assertEqual(json.loads(result), {"error": parilka_chat.INVALID_ARGS})
        ctx.dispatch_tool.assert_not_called()

    def test_non_mapping_args_rejected_without_dispatch(self):
        for bad in ([{"query": "x"}], "query=x", None, 42):
            ctx = make_ctx()
            result = self.call(args=bad, ctx=ctx)
            self.assertEqual(
                json.loads(result), {"error": parilka_chat.INVALID_ARGS}
            )
            ctx.dispatch_tool.assert_not_called()

    def test_session_rejection_is_generic_top_level_error(self):
        with patch(
            "parilka_chat._get_session_env",
            return_value=fake_session_env(platform="discord"),
        ):
            result = self.call()
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.SESSION_REJECTED}
        )

    def test_missing_allowed_chat_env_is_generic_top_level_error(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)
        result = self.call()
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.SESSION_REJECTED}
        )

    def test_wrong_captured_profile_is_generic_top_level_error(self):
        ctx = make_ctx(profile="default")
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.SESSION_REJECTED}
        )
        ctx.dispatch_tool.assert_not_called()

    def test_outer_error_shape_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = fake_dispatch_error("connection refused")
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_malformed_outer_json_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = "not valid json {{{"
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_non_dict_outer_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = json.dumps([1, 2, 3])
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_non_string_result_field_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = json.dumps({"result": 123})
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_malformed_inner_json_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = json.dumps({"result": "not-json"})
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_legacy_mcp_envelope_rejected(self):
        ctx = make_ctx()
        ctx.dispatch_tool.return_value = fake_legacy_mcp_response(
            {"ok": True, "tool": "rag_bm25_search", "status": "done",
             "result": {}, "evidence": []},
        )
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_dispatch_exception_is_generic_top_level_error(self):
        ctx = make_ctx()
        ctx.dispatch_tool.side_effect = RuntimeError("connection refused")
        result = self.call(ctx=ctx)
        self.assertEqual(
            json.loads(result), {"error": parilka_chat.PROTOCOL_ERROR}
        )

    def test_source_message_id_injected_from_session_only(self):
        with patch(
            "parilka_chat._get_session_env",
            return_value=fake_session_env(message_id="999"),
        ):
            ctx = make_ctx()
            ctx.dispatch_tool.return_value = fake_dispatch_ok(
                {"ok": True, "tool": "read_chat_slice", "status": "done",
                 "result": {}, "evidence": []},
            )
            handler = parilka_chat._make_tool_handler("read_chat_slice", ctx)
            handler({"mode": "recent", "count": 10})
        dispatched_args = ctx.dispatch_tool.call_args[0][1]
        self.assertEqual(dispatched_args["source_message_id"], 999)
        self.assertNotIn("chat", dispatched_args)


if __name__ == "__main__":
    unittest.main()
