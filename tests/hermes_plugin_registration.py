"""Tests: plugin registration, schemas, raw mapping, config/env exactness."""

from __future__ import annotations

import json
import os
import unittest
from typing import Any, Dict, Set
from unittest.mock import MagicMock

from tests.support.hermes_plugin_helpers import REPO_ROOT

import parilka_chat  # type: ignore[import-not-found]


class PluginRegistrationTests(unittest.TestCase):
    """register() requires exact profile and wires clean names + hooks."""

    def test_tool_names_match_expected_set(self):
        expected = {
            "rag_bm25_search",
            "keyword_search",
            "read_chat_slice",
            "day_digest",
            "thread_context",
        }
        self.assertEqual(set(parilka_chat.TOOL_NAMES), expected)

    def test_raw_mapping_is_exact_prefixed_names(self):
        self.assertEqual(
            parilka_chat.RAW_TOOL_NAMES,
            {
                "rag_bm25_search": "mcp__telegram_parilka__rag_bm25_search",
                "keyword_search": "mcp__telegram_parilka__keyword_search",
                "read_chat_slice": "mcp__telegram_parilka__read_chat_slice",
                "day_digest": "mcp__telegram_parilka__day_digest",
                "thread_context": "mcp__telegram_parilka__thread_context",
            },
        )

    def test_tool_schemas_have_no_forbidden_fields(self):
        for name, schema in parilka_chat.TOOL_SCHEMAS.items():
            props = schema.get("parameters", {}).get("properties", {})
            self.assertNotIn("chat", props, f"{name} schema has chat")
            self.assertNotIn(
                "source_message_id", props,
                f"{name} schema has source_message_id",
            )

    def test_tool_schemas_all_have_name_description_parameters(self):
        for name, schema in parilka_chat.TOOL_SCHEMAS.items():
            self.assertEqual(schema["name"], name)
            self.assertIn("description", schema)
            self.assertIn("parameters", schema)
            self.assertEqual(schema["parameters"]["type"], "object")

    def test_read_chat_slice_schema_has_no_after_id(self):
        props = parilka_chat.TOOL_SCHEMAS["read_chat_slice"]["parameters"]["properties"]
        self.assertNotIn("after_id", props)

    def test_register_calls_expected_tools_and_hooks(self):
        ctx = MagicMock()
        ctx.profile_name = "parilka"
        parilka_chat.register(ctx)

        self.assertEqual(ctx.register_tool.call_count, len(parilka_chat.TOOL_NAMES))
        registered_names: Set[str] = set()
        registered_toolsets: Set[str] = set()
        for call in ctx.register_tool.call_args_list:
            kwargs = call[1]
            registered_names.add(kwargs["name"])
            registered_toolsets.add(kwargs["toolset"])
        self.assertEqual(registered_names, set(parilka_chat.TOOL_NAMES))
        self.assertEqual(registered_toolsets, {"parilka_chat"})

        hook_names = {call[0][0] for call in ctx.register_hook.call_args_list}
        self.assertIn("pre_llm_call", hook_names)
        self.assertIn("pre_tool_call", hook_names)

    def test_register_skips_when_profile_empty(self):
        """Exact profile required — empty profile never registers."""
        for profile in ("", None, "default"):
            ctx = MagicMock()
            ctx.profile_name = profile
            parilka_chat.register(ctx)
            ctx.register_tool.assert_not_called()
            ctx.register_hook.assert_not_called()


class ToolSchemasArtifactTests(unittest.TestCase):
    """Verify the Python schemas match the checked-in tool-schemas.json."""

    def test_schemas_match_artifact(self):
        artifact_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "tool-schemas.json",
        )
        with open(artifact_path, "r", encoding="utf-8") as f:
            artifact = json.load(f)

        artifact_by_name: Dict[str, Dict[str, Any]] = {
            e["name"]: e for e in artifact
        }

        for name, schema in parilka_chat.TOOL_SCHEMAS.items():
            self.assertIn(name, artifact_by_name, f"{name} missing from artifact")
            art = artifact_by_name[name]
            self.assertEqual(
                schema["description"], art["description"],
                f"description drift for {name}",
            )
            self.assertEqual(
                schema["parameters"], art["parameters"],
                f"parameters drift for {name}",
            )

    def test_artifact_has_exactly_five_entries(self):
        artifact_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "tool-schemas.json",
        )
        with open(artifact_path, "r", encoding="utf-8") as f:
            artifact = json.load(f)
        self.assertEqual(len(artifact), 5)
        names = sorted(e["name"] for e in artifact)
        self.assertEqual(names, [
            "day_digest",
            "keyword_search",
            "rag_bm25_search",
            "read_chat_slice",
            "thread_context",
        ])


class ConfigYamlTests(unittest.TestCase):
    """config.yaml must match the exact Hermes v0.20 contract."""

    def setUp(self):
        import yaml  # type: ignore[import-not-found]

        cfg_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile", "config.yaml",
        )
        with open(cfg_path, "r", encoding="utf-8") as f:
            self.cfg = yaml.safe_load(f)

    def test_model_mapping_exact(self):
        self.assertEqual(
            self.cfg["model"],
            {"default": "gpt-5.6-luna", "provider": "openai-codex"},
        )

    def test_codex_catalog_and_context_override_exact(self):
        self.assertNotIn("providers", self.cfg)
        self.assertIn("deepseek", self.cfg["model_catalog"]["excluded_providers"])
        self.assertEqual(
            self.cfg["model_overrides"]["openai-codex"]["gpt-5.6-luna"],
            {"context_window": 272000},
        )

    def test_telegram_streaming_disabled(self):
        self.assertIs(
            self.cfg["display"]["platforms"]["telegram"]["streaming"], False
        )

    def test_telegram_tool_progress_contract(self):
        """Telegram-only live tool-call progress: accumulate in one editable
        message, clean up only after the final answer is delivered. No token/
        answer streaming and no thinking_progress are enabled anywhere."""
        global_display = self.cfg["display"]
        telegram = global_display["platforms"]["telegram"]

        # Scope: global tool_progress stays off; only Telegram opts in.
        self.assertEqual(global_display["tool_progress"], "off")
        self.assertEqual(telegram["tool_progress"], "all")
        self.assertEqual(telegram["tool_progress_grouping"], "accumulate")
        self.assertIs(telegram["cleanup_progress"], True)

        # This profile has no global answer-streaming override.
        self.assertNotIn("streaming", self.cfg)
        self.assertNotIn("streaming", global_display)
        self.assertIs(telegram["streaming"], False)

        # Thinking progress is not enabled.
        self.assertNotIn("thinking_progress", global_display)
        self.assertNotIn("thinking_progress", telegram)

        # Interim messages are enabled only for the Telegram presentation.
        self.assertIs(telegram["interim_assistant_messages"], True)

    def test_stt_use_gateway_false_at_root(self):
        self.assertIs(self.cfg["stt"]["use_gateway"], False)
        self.assertEqual(self.cfg["stt"]["provider"], "openai")
        self.assertEqual(self.cfg["stt"]["language"], "ru")
        openai = self.cfg["stt"]["openai"]
        self.assertEqual(openai["model"], "flov-whisper")
        self.assertEqual(openai["base_url"], "http://127.0.0.1:17432/v1")
        self.assertEqual(openai["api_key"], "flov-local")

    def test_native_codex_search_and_lightpanda_extract(self):
        self.assertEqual(
            self.cfg["web"],
            {
                "search_backend": "codex-native",
                "extract_backend": "lightpanda-local",
                "keyless_rescue": False,
                "codex_native": {
                    "model": "gpt-5.6-luna", "reasoning": "low",
                    "search_context_size": "medium", "timeout_seconds": 120,
                    "profile_prompt_cache": True,
                },
                "lightpanda_local": {
                    "binary": "/home/billy/.cache/lightpanda-node/lightpanda",
                    "timeout_seconds": 18, "connect_timeout_ms": 5000,
                    "http_timeout_ms": 8000, "terminate_ms": 12000,
                },
            },
        )
        self.assertNotIn("searxng", self.cfg)
        self.assertNotIn("firecrawl", self.cfg)

    def test_guardrails_and_loop_caps_exact(self):
        gr = self.cfg["tool_loop_guardrails"]
        self.assertIs(gr["warnings_enabled"], False)
        self.assertNotIn("hard_stop_enabled", gr)
        self.assertEqual(
            gr["loop_caps"], {"max_web_searches": 0, "max_subagents": 0}
        )

    def test_mcp_server_absolute_command_and_exact_include(self):
        server = self.cfg["mcp_servers"]["telegram-parilka"]
        self.assertTrue(server["command"].startswith("/"))
        self.assertEqual(
            server["tools"]["include"],
            ["rag_bm25_search", "keyword_search", "read_chat_slice",
             "day_digest", "thread_context"],
        )

    def test_plugins_memory_groups_toolsets_kept(self):
        self.assertEqual(
            self.cfg["plugins"]["enabled"],
            ["parilka-chat", "dashboard_auth/basic", "web/codex-native",
             "web/lightpanda-local"],
        )
        self.assertEqual(self.cfg["memory"]["memory_char_limit"], 8000)
        self.assertIn("-1003179772905", self.cfg["telegram"]["allowed_chats"])
        self.assertIn(
            "-1003179772905", self.cfg["telegram"]["group_allowed_chats"]
        )
        telegram_toolsets = self.cfg["platform_toolsets"]["telegram"]
        self.assertIn("parilka_chat", telegram_toolsets)
        # Raw MCP toolset must stay absent from model platform toolsets.
        for toolset in telegram_toolsets:
            self.assertFalse(toolset.startswith("mcp__"))

    def test_config_has_no_secret_values(self):
        raw = json.dumps(self.cfg, ensure_ascii=False)
        self.assertNotIn("sk-", raw)
        self.assertNotIn("ALIBABA_TOKEN_PLAN_API_KEY=", raw)

    # ── Security / toolsets hardening (Hermes 0.20.0) ──────────────────

    def test_config_version_is_exact_38(self):
        self.assertEqual(self.cfg["_config_version"], 38)

    def test_telegram_extra_commands_enabled_false(self):
        """telegram.extra.commands_enabled: false — native Hermes option
        disables the slash-command menu and dispatch. Mention chat is not
        affected: require_mention stays true and the ordinary Telegram
        platform toolset is untouched."""
        extra = self.cfg["telegram"]["extra"]
        self.assertEqual(extra, {
            "rich_messages": True,
            "commands_enabled": False,
            "markdown_documents_only": True,
        })
        self.assertIs(extra["commands_enabled"], False)
        self.assertIs(self.cfg["telegram"]["require_mention"], True)
        self.assertEqual(
            self.cfg["platform_toolsets"]["telegram"],
            ["parilka_chat", "memory", "skills", "web", "vision",
             "session_search", "tts"],
        )

    def test_platform_toolsets_telegram_exact_allowed_list(self):
        allowed = self.cfg["platform_toolsets"]["telegram"]
        # Telegram has only the safe chat/memory/web/media surface.  It never
        # receives local code execution or a delegation bridge.
        expected = [
            "parilka_chat", "memory", "skills", "web", "vision",
            "session_search", "tts",
        ]
        self.assertEqual(allowed, expected)
        self.assertNotIn("hermes-telegram", allowed)

    def test_agent_disabled_toolsets_exact_deny_set(self):
        denied = self.cfg["agent"]["disabled_toolsets"]
        # browser/search are intentionally NOT denied: both share web_search
        # with the allowed `web` toolset, and disabled_toolsets is subtracted
        # after the allowlist — denying them would strip web_search.
        expected = [
            "bfl",
            "clarify",
            "code_execution",
            "computer_use",
            "context_engine",
            "cronjob",
            "discord",
            "discord_admin",
            "feishu_doc",
            "feishu_drive",
            "file",
            "homeassistant",
            "image_gen",
            "kanban",
            "project",
            "spotify",
            "stt",
            "telegram-parilka",
            "terminal",
            "todo",
            "video",
            "video_gen",
            "x_search",
            "yuanbao",
        ]
        self.assertEqual(denied, expected)

    def test_dangerous_local_toolsets_stay_denied(self):
        """The safe boundary must not weaken: file/terminal/code_execution/
        project/computer_use stay denied and never move to the allowlist."""
        allowed = set(self.cfg["platform_toolsets"]["telegram"])
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        dangerous = {"file", "terminal", "code_execution", "project",
                     "computer_use"}
        self.assertEqual(
            dangerous & denied, dangerous,
            f"Dangerous local toolsets must all stay denied, missing: "
            f"{dangerous - denied}",
        )
        self.assertEqual(
            dangerous & allowed, set(),
            f"Dangerous local toolsets must never be allowed, got: "
            f"{dangerous & allowed}",
        )
        self.assertNotIn("delegation", allowed)

    def test_known_plugin_toolsets_telegram_exact(self):
        kpt = self.cfg["known_plugin_toolsets"]["telegram"]
        self.assertEqual(kpt, ["parilka_chat", "spotify"])

    def test_no_intersection_between_allowed_and_denied(self):
        allowed = set(self.cfg["platform_toolsets"]["telegram"])
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        intersection = allowed & denied
        self.assertEqual(
            intersection,
            set(),
            f"Allow/deny intersection must be empty, got: {intersection}",
        )

    def test_stt_uses_local_gatewayless_provider(self):
        self.assertNotIn("enabled", self.cfg["stt"])
        self.assertIs(self.cfg["stt"]["use_gateway"], False)

    def test_tool_search_disabled_at_top_level(self):
        tools = self.cfg.get("tools", {})
        ts = tools.get("tool_search", {})
        self.assertEqual(ts.get("enabled"), "off",
                         "tools.tool_search.enabled must be 'off' — "
                         "parilka profile uses 5 direct plugin tools "
                         "without progressive disclosure bridge")


class DistributionAndEnvTests(unittest.TestCase):
    """distribution.yaml and .env.template validation."""

    def test_distribution_yaml_parses(self):
        import yaml  # type: ignore[import-not-found]

        dist_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile",
            "distribution.yaml",
        )
        with open(dist_path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)

        self.assertEqual(doc["name"], "parilka")
        self.assertEqual(doc["kind"], "profile")
        self.assertIn("hermes_requires", doc)

    def test_env_template_has_only_local_non_secret_settings(self):
        tmpl_path = os.path.join(
            REPO_ROOT,
            "integrations", "hermes", "parilka-profile", ".env.template",
        )
        with open(tmpl_path, "r", encoding="utf-8") as f:
            content = f.read()

        self.assertIn("PARILKA_TELEGRAM_CHAT_ID=-1003179772905", content)
        self.assertIn("PARILKA_MCP_HTTP_URL=http://127.0.0.1:8766/mcp", content)
        self.assertIn("auth add openai-codex", content)
        self.assertNotIn("SEARXNG_URL=", content)
        self.assertNotIn("FIRECRAWL_API_URL=", content)

    def test_env_template_has_no_secret_values(self):
        tmpl_path = os.path.join(
            REPO_ROOT,
            "integrations", "hermes", "parilka-profile", ".env.template",
        )
        with open(tmpl_path, "r", encoding="utf-8") as f:
            content = f.read()

        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if key.endswith("_API_KEY") or key.endswith("_TOKEN"):
                    self.assertEqual(
                        value, "",
                        f"Secret key {key} has a value in .env.template",
                    )


if __name__ == "__main__":
    unittest.main()
