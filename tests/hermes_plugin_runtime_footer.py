"""Tests: exact Telegram runtime footer and vision cap for parilka-chat.

Covers FooterTracker semantics (latest prompt_tokens only, tool call counts,
injected clock determinism, per-session separation, bounded state, no raw
data), the pre_gateway_dispatch vision cap (first 6 images, order, non-image
retention, note without media paths, metadata-only ledger), the per-turn
vision budget (pre_llm bridge + pre_tool_call gate), hook registration, and
the config.yaml / SOUL.md contract.
"""

from __future__ import annotations

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

from tests.support.hermes_plugin_helpers import (
    DEFAULT_CHAT_ID,
    REPO_ROOT,
    fake_session_env,
)

import parilka_chat  # type: ignore[import-not-found]
from parilka_chat import runtime_hooks  # type: ignore[import-not-found]

FOOTER_MODEL = "gpt-5.6-luna"


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def _clear_runtime_state():
    for store in (runtime_hooks._state, runtime_hooks._vision_ledger,
                  runtime_hooks._vision_budget, runtime_hooks._turn_seq):
        store.clear()


class FooterTrackerTests(unittest.TestCase):
    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = DEFAULT_CHAT_ID
        self.clock = FakeClock()
        self.env = fake_session_env()
        self.tracker = runtime_hooks.FooterTracker(
            "parilka",
            get_session_env=lambda: self.env,
            assert_telegram_group=parilka_chat._assert_telegram_group,
            clock=self.clock,
        )

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)
        runtime_hooks._state.clear()

    def start_turn(self, session_id="s1", model=FOOTER_MODEL):
        self.tracker.pre_llm_call(
            session_id=session_id, turn_id=1, model=model, platform="telegram"
        )

    def transform(self, session_id="s1", text="Ответ.", model=FOOTER_MODEL):
        return self.tracker.transform_llm_output(
            response_text=text, session_id=session_id,
            model=model, platform="telegram",
        )

    def test_footer_exact_format_and_usage_semantics(self):
        """38100 only — cache/input/output must never be summed in."""
        self.start_turn()
        self.tracker.post_api_request(
            session_id="s1",
            usage={
                "prompt_tokens": 38100,
                "prompt_tokens_details": {"cached_tokens": 5000},
                "completion_tokens": 250,
                "total_tokens": 43350,
            },
        )
        for _ in range(3):
            self.tracker.post_tool_call(session_id="s1", tool_name="keyword_search")
        self.clock.now = 30.0
        out = self.transform()
        self.assertEqual(
            out,
            "Ответ.\n\n"
            "gpt-5.6-luna 🧠 · 38.1k/272.0k · 3 tool calls · 30с",
        )
        lowered = out.lower()
        for forbidden in ("43.3k", "43350", "cache", "output", "pct", "%"):
            self.assertNotIn(forbidden, lowered)

    def test_latest_prompt_tokens_overwrites(self):
        self.start_turn()
        self.tracker.post_api_request(
            session_id="s1", usage={"prompt_tokens": 1000, "completion_tokens": 9000}
        )
        self.tracker.post_api_request(
            session_id="s1", usage={"prompt_tokens": 5000, "completion_tokens": 9000}
        )
        out = self.transform()
        self.assertIn("5.0k/272.0k", out)
        self.assertNotIn("1.0k/272.0k", out)
        self.assertNotIn("6.0k/272.0k", out)

    def test_bool_or_negative_prompt_tokens_rejected(self):
        """Canonical prompt_tokens is a nonnegative int — bool and negatives
        must not overwrite the tracked value."""
        self.start_turn()
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": True})
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": -5})
        out = self.transform()
        self.assertIn("0/272.0k", out)

    def test_tool_count_includes_each_call(self):
        self.start_turn()
        for _ in range(2):
            self.tracker.post_tool_call(session_id="s1")
        out = self.transform()
        self.assertIn("2 tool calls", out)

    def test_elapsed_minutes_format(self):
        self.start_turn()
        self.clock.now = 63.0
        out = self.transform()
        self.assertIn("· 1м 3с", out)

    def test_bare_model_strips_provider_prefix(self):
        model = "openai-codex/gpt-5.6-luna"
        self.start_turn(model=model)
        out = self.transform(model=model)
        self.assertIn("gpt-5.6-luna 🧠", out)

    def test_untracked_session_gets_no_footer(self):
        self.assertEqual(self.transform(), "Ответ.")

    def test_state_popped_after_transform(self):
        self.start_turn()
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        self.transform()
        self.assertEqual(self.transform(), "Ответ.")

    def test_state_separated_per_session(self):
        self.start_turn("s1")
        self.start_turn("s2")
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 100})
        self.tracker.post_api_request(session_id="s2", usage={"prompt_tokens": 200})
        self.tracker.post_tool_call(session_id="s2")
        out1 = self.transform("s1")
        out2 = self.transform("s2")
        self.assertIn("100/272.0k", out1)
        self.assertNotIn("100/272.0k", out2)
        self.assertIn("200/272.0k · 1 tool calls", out2)

    def test_invalid_group_no_tracking(self):
        self.env = fake_session_env(chat_id="-1009999999999")
        self.start_turn()
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        self.assertEqual(self.transform(), "Ответ.")

    def test_empty_session_env_no_tracking(self):
        self.env = {}
        self.start_turn()
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        self.assertEqual(self.transform(), "Ответ.")

    def test_wrong_captured_profile_no_tracking(self):
        tracker = runtime_hooks.FooterTracker(
            "default",
            get_session_env=lambda: self.env,
            assert_telegram_group=parilka_chat._assert_telegram_group,
            clock=self.clock,
        )
        tracker.pre_llm_call(
            session_id="s1", turn_id=1, model=FOOTER_MODEL, platform="telegram"
        )
        tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        out = tracker.transform_llm_output(
            response_text="Ответ.", session_id="s1",
            model=FOOTER_MODEL, platform="telegram",
        )
        self.assertEqual(out, "Ответ.")

    def test_state_holds_no_raw_data(self):
        self.start_turn()
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        self.assertEqual(
            set(runtime_hooks._state["s1"]),
            {"start", "used", "tool_calls", "model", "context_length",
             "context_signature"},
        )

    def test_ttl_prune_drops_stale_sessions(self):
        with patch.object(runtime_hooks, "_STATE_TTL_SECONDS", 60.0):
            self.start_turn("s1")
            self.clock.now = 61.0
            self.start_turn("s2")
        self.tracker.post_api_request(session_id="s1", usage={"prompt_tokens": 10})
        self.assertEqual(self.transform("s1"), "Ответ.")
        self.assertNotIn("s1", runtime_hooks._state)

    def test_max_entries_evicts_oldest(self):
        with patch.object(runtime_hooks, "_STATE_MAX_ENTRIES", 2):
            self.start_turn("s1")
            self.start_turn("s2")
            self.start_turn("s3")
        self.assertNotIn("s1", runtime_hooks._state)
        self.assertIn("s2", runtime_hooks._state)
        self.assertIn("s3", runtime_hooks._state)


class VisionCapTests(unittest.TestCase):
    def make_event(self, platform="telegram", chat_id=DEFAULT_CHAT_ID,
                   chat_type="group", message_type="photo", urls=None,
                   types=None, text="Смотри фото"):
        class _MessageType:
            def __init__(self, value):
                self.value = value

        class _Source:
            def __init__(self):
                self.platform = platform
                self.chat_id = chat_id
                self.chat_type = chat_type

        class _Event:
            pass

        event = _Event()
        event.source = _Source()
        event.message_type = _MessageType(message_type)
        event.media_urls = list(urls or [])
        event.media_types = list(types or [])
        event.text = text
        return event

    def make_hook(self, profile="parilka", chat_id=DEFAULT_CHAT_ID):
        return runtime_hooks.make_vision_cap(
            profile, env_getter=lambda name: chat_id
        )

    def images(self, count, prefix="img", mime="image/jpeg"):
        urls = [f"{prefix}-{i}.jpg" for i in range(count)]
        types = [mime] * count
        return urls, types

    def tearDown(self):
        _clear_runtime_state()

    def test_first_six_images_kept_with_rewrite_note(self):
        urls, types = self.images(8)
        event = self.make_event(urls=urls, types=types, text="Смотри")
        result = self.make_hook()(event)
        self.assertIsNotNone(result)
        self.assertEqual(event.media_urls, urls[:6])
        self.assertEqual(event.media_types, types[:6])
        # Exact gateway rewrite contract: dict with action=rewrite plus text.
        self.assertEqual(
            result,
            {
                "action": "rewrite",
                "text": "Смотри\n\n[система: для анализа взято 6 из 8 изображений]",
            },
        )
        for url in urls:
            self.assertNotIn(url, result["text"])

    def test_non_image_attachments_kept_and_order_preserved(self):
        urls = [f"img-{i}.jpg" for i in range(8)]
        types = ["image/jpeg"] * 8
        urls[2:2] = ["doc.pdf", "audio.ogg"]
        types[2:2] = ["application/pdf", "audio/ogg"]
        event = self.make_event(urls=urls, types=types)
        result = self.make_hook()(event)
        self.assertIsNotNone(result)
        self.assertIn("6 из 8", result["text"])
        self.assertEqual(event.media_urls, [
            "img-0.jpg", "img-1.jpg", "doc.pdf", "audio.ogg",
            "img-2.jpg", "img-3.jpg", "img-4.jpg", "img-5.jpg",
        ])
        self.assertEqual(event.media_types, [
            "image/jpeg", "image/jpeg", "application/pdf", "audio/ogg",
            "image/jpeg", "image/jpeg", "image/jpeg", "image/jpeg",
        ])

    def test_empty_mime_photo_treated_as_image(self):
        urls, types = self.images(8, mime="")
        event = self.make_event(urls=urls, types=types)
        result = self.make_hook()(event)
        self.assertIsNotNone(result)
        self.assertIn("6 из 8", result["text"])
        self.assertEqual(len(event.media_urls), 6)

    def test_empty_mime_non_photo_not_capped(self):
        urls, types = self.images(8, mime="")
        event = self.make_event(message_type="document", urls=urls, types=types)
        result = self.make_hook()(event)
        self.assertIsNone(result)
        self.assertEqual(len(event.media_urls), 8)

    def test_six_or_fewer_images_untouched(self):
        for count in (0, 3, 6):
            urls, types = self.images(count)
            event = self.make_event(urls=urls, types=types)
            result = self.make_hook()(event)
            self.assertIsNone(result)
            self.assertEqual(event.media_urls, urls)
            self.assertEqual(event.media_types, types)

    def test_enum_like_platform_value_normalized(self):
        """Actual SessionSource.platform is the Platform enum — its value
        must match; the previous raw-string comparison failed on enums."""
        class _Platform:
            value = "telegram"

        event = self.make_event()
        event.source.platform = _Platform()
        event.media_urls, event.media_types = self.images(8)
        result = self.make_hook()(event)
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "rewrite")
        self.assertEqual(len(event.media_urls), 6)

    def test_wrong_profile_no_mutation(self):
        urls, types = self.images(8)
        event = self.make_event(urls=urls, types=types)
        result = self.make_hook(profile="default")(event)
        self.assertIsNone(result)
        self.assertEqual(event.media_urls, urls)

    def test_unconfigured_chat_id_no_mutation(self):
        urls, types = self.images(8)
        event = self.make_event(urls=urls, types=types)
        hook = runtime_hooks.make_vision_cap(
            "parilka", env_getter=lambda name: ""
        )
        self.assertIsNone(hook(event))
        self.assertEqual(event.media_urls, urls)

    def test_wrong_source_no_mutation(self):
        urls, types = self.images(8)
        for kwargs in (
            {"platform": "discord"},
            {"chat_id": "-1009999999999"},
            {"chat_type": "private"},
        ):
            event = self.make_event(urls=urls, types=types, **kwargs)
            self.assertIsNone(self.make_hook()(event))
            self.assertEqual(event.media_urls, urls)
            self.assertEqual(event.media_types, types)

    def test_ledger_records_kept_count_and_skips_invalid_ids(self):
        urls, types = self.images(3)
        event = self.make_event(urls=urls, types=types)
        event.message_id = 42
        self.assertIsNone(self.make_hook()(event))
        entry = runtime_hooks._vision_ledger[f"{DEFAULT_CHAT_ID}:42"]
        self.assertEqual(entry["count"], 3)
        self.assertEqual(set(entry), {"count", "ts"})
        urls, types = self.images(8)
        event = self.make_event(urls=urls, types=types)
        event.message_id = 43
        self.assertEqual(self.make_hook()(event)["action"], "rewrite")
        self.assertEqual(runtime_hooks._vision_ledger[f"{DEFAULT_CHAT_ID}:43"]["count"], 6)
        for bad in (None, "", 0, -5, 2 ** 63, "abc", True):
            event = self.make_event(urls=urls, types=types)
            event.message_id = bad
            self.make_hook()(event)
        self.assertEqual(set(runtime_hooks._vision_ledger), {f"{DEFAULT_CHAT_ID}:42",
                                                             f"{DEFAULT_CHAT_ID}:43"})


class VisionBudgetTests(unittest.TestCase):
    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = DEFAULT_CHAT_ID
        self.clock = FakeClock()
        self.env = fake_session_env()
        self.bridge = runtime_hooks.make_vision_budget_bridge(
            "parilka", lambda: self.env, parilka_chat._assert_telegram_group,
            self.clock)
        self.gate = runtime_hooks.make_vision_budget_gate(
            "parilka", lambda: self.env, parilka_chat._assert_telegram_group,
            self.clock)

    def tearDown(self):
        _clear_runtime_state()

    def start_turn(self, session="s1", turn="t1"):
        self.bridge(session_id=session, turn_id=turn)

    def vision(self, session="s1", turn="t1"):
        return self.gate(tool_name="vision_analyze", session_id=session,
                         turn_id=turn)

    def test_six_calls_allowed_then_new_turn_resets(self):
        self.start_turn()
        self.assertEqual([self.vision() for _ in range(6)], [None] * 6)
        blocked = self.vision()
        self.assertEqual(blocked["action"], "block")
        self.assertEqual(blocked["message"], runtime_hooks._VISION_BLOCK_MESSAGE)
        self.assertNotIn(DEFAULT_CHAT_ID, blocked["message"])
        self.start_turn(turn="t2")
        self.assertIsNone(self.vision(turn="t2"))

    def test_attachments_count_into_budget(self):
        for attach, allowed in ((4, 2), (6, 0)):
            with self.subTest(attach=attach):
                runtime_hooks._vision_ledger[f"{DEFAULT_CHAT_ID}:42"] = {
                    "count": attach, "ts": 0.0}
                self.start_turn()
                self.assertNotIn(f"{DEFAULT_CHAT_ID}:42", runtime_hooks._vision_ledger)
                self.assertEqual([self.vision() for _ in range(allowed)], [None] * allowed)
                self.assertEqual(self.vision()["action"], "block")

    def test_budget_keyed_by_session_and_turn(self):
        self.start_turn("s1", "t1")
        self.start_turn("s2", "t1")
        self.assertEqual([self.vision("s1") for _ in range(6)], [None] * 6)
        self.assertIsNone(self.vision(session="s2"))
        self.assertEqual(self.vision(session="s1")["action"], "block")
        self.start_turn(turn=None)
        self.assertEqual([self.vision(turn=None) for _ in range(6)], [None] * 6)
        self.assertEqual(self.vision(turn=None)["action"], "block")
        self.start_turn(turn=None)
        self.assertIsNone(self.vision(turn=None))

    def test_wrong_tool_profile_group_noop(self):
        self.start_turn()
        self.assertIsNone(self.gate(tool_name="keyword_search",
                                    session_id="s1", turn_id="t1"))
        wrong = runtime_hooks.make_vision_budget_gate(
            "default", lambda: self.env, parilka_chat._assert_telegram_group,
            self.clock)
        self.assertIsNone(wrong(tool_name="vision_analyze",
                                session_id="s1", turn_id="t1"))
        self.env = fake_session_env(chat_id="-1009999999999")
        self.assertIsNone(self.vision())
        self.assertEqual(set(runtime_hooks._vision_budget), {"s1:t1"})

    def test_concurrency_never_exceeds_six(self):
        self.start_turn()
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: self.vision(), range(12)))
        self.assertEqual(results.count(None), 6)
        self.assertEqual(len(results) - results.count(None), 6)

    def test_maps_metadata_only_and_bounded(self):
        runtime_hooks._vision_ledger[f"{DEFAULT_CHAT_ID}:42"] = {"count": 3, "ts": 0.0}
        self.start_turn()
        self.assertEqual(set(runtime_hooks._vision_budget["s1:t1"]),
                         {"attach", "used", "ts"})
        for i in range(200):
            runtime_hooks._vision_ledger[f"{DEFAULT_CHAT_ID}:{500 + i}"] = {"count": 1, "ts": 0.0}
        runtime_hooks._prune_store(runtime_hooks._vision_ledger, 1.0)
        self.assertLessEqual(len(runtime_hooks._vision_ledger), runtime_hooks._VISION_MAX_ENTRIES)
        runtime_hooks._prune_store(runtime_hooks._vision_ledger, 10000.0)
        self.assertEqual(runtime_hooks._vision_ledger, {})


class RegistrationTests(unittest.TestCase):
    def test_register_wires_runtime_hooks(self):
        ctx = MagicMock()
        ctx.profile_name = "parilka"
        parilka_chat.register(ctx)
        hook_names = [call[0][0] for call in ctx.register_hook.call_args_list]
        for name in (
            "pre_llm_call", "post_api_request", "post_tool_call",
            "transform_llm_output", "pre_gateway_dispatch",
        ):
            self.assertIn(name, hook_names)
        # Vision bridge/gate add one pre_llm_call and one pre_tool_call hook.
        self.assertEqual(hook_names.count("pre_llm_call"), 3)
        self.assertEqual(hook_names.count("pre_tool_call"), 2)


class ConfigAndSoulContractTests(unittest.TestCase):
    def setUp(self):
        import yaml  # type: ignore[import-not-found]

        profile_dir = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile",
        )
        with open(os.path.join(profile_dir, "config.yaml"), "r", encoding="utf-8") as f:
            self.cfg = yaml.safe_load(f)
        with open(os.path.join(profile_dir, "SOUL.md"), "r", encoding="utf-8") as f:
            self.soul = f.read()

    def test_runtime_footer_disabled_explicitly(self):
        self.assertIs(self.cfg["display"]["runtime_footer"]["enabled"], False)

    def test_soul_memory_semantics_exact(self):
        self.assertIn("MEMORY.md", self.soul)
        self.assertIn("add/replace/remove", self.soul)
        self.assertIn("память не читают", self.soul)
        self.assertNotIn("через skills_list/skill_view", self.soul)


if __name__ == "__main__":
    unittest.main()
