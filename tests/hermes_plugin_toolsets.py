"""Tests: toolsets hardening — allow/deny, known plugins, Hermes 0.20 smoke.

Static proofs validate config.yaml invariants.  Optional smoke tests exercise
the real Hermes 0.20.0 _get_platform_tools / get_tool_definitions pipeline
against the parilka profile (no network, no providers, no ~/.hermes mutation).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

from tests.support.hermes_plugin_helpers import REPO_ROOT


# ── Static proofs (no Hermes runtime) ──────────────────────────────────────

class ToolsetsStaticProofTests(unittest.TestCase):
    """Static proofs against config.yaml — no Hermes runtime required."""

    @classmethod
    def setUpClass(cls):
        import yaml  # type: ignore[import-not-found]

        cfg_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile",
            "config.yaml",
        )
        with open(cfg_path, "r", encoding="utf-8") as f:
            cls.cfg = yaml.safe_load(f)

    # ── Core invariants ─────────────────────────────────────────────────

    def test_config_version_38(self):
        self.assertEqual(self.cfg["_config_version"], 38)

    def test_hermes_telegram_absent_from_platform_toolsets(self):
        telegram_toolsets = self.cfg["platform_toolsets"]["telegram"]
        self.assertNotIn(
            "hermes-telegram", telegram_toolsets,
            "hermes-telegram composite must NOT be in platform_toolsets — "
            "it expands to file/terminal/code_execution and violates the "
            "distribution contract",
        )

    def test_allowed_toolsets_are_exactly_seven(self):
        allowed = self.cfg["platform_toolsets"]["telegram"]
        self.assertEqual(
            len(allowed), 7,
            f"Expected 7 allowed toolsets, got {len(allowed)}: {allowed}",
        )

    def test_allowed_toolsets_exact_names(self):
        allowed = self.cfg["platform_toolsets"]["telegram"]
        # delegation is the single deliberate addition — subagents inherit
        # only the safe surface, dangerous local toolsets stay denied.
        self.assertEqual(
            allowed,
            ["parilka_chat", "memory", "skills", "web", "vision",
             "session_search", "tts"],
        )

    def test_deny_set_has_exactly_24_entries(self):
        denied = self.cfg["agent"]["disabled_toolsets"]
        self.assertEqual(
            len(denied), 24,
            f"Expected 24 denied toolsets, got {len(denied)}",
        )

    def test_deny_set_is_sorted(self):
        denied = self.cfg["agent"]["disabled_toolsets"]
        self.assertEqual(denied, sorted(denied))

    def test_telegram_parilka_in_deny_not_in_allowed(self):
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        allowed = set(self.cfg["platform_toolsets"]["telegram"])
        self.assertIn("telegram-parilka", denied,
                      "MCP alias telegram-parilka must be in disabled_toolsets")
        self.assertNotIn("telegram-parilka", allowed,
                         "MCP alias telegram-parilka must NOT be in platform_toolsets")

    def test_no_raw_mcp_alias_in_allowed(self):
        """No raw MCP alias (mcp__*) in the allow list."""
        allowed = self.cfg["platform_toolsets"]["telegram"]
        for ts in allowed:
            self.assertFalse(
                ts.startswith("mcp__") or ts.startswith("telegram-"),
                f"Raw MCP alias '{ts}' must not appear in platform_toolsets",
            )

    def test_tool_search_disabled_at_top_level(self):
        tools = self.cfg.get("tools", {})
        ts = tools.get("tool_search", {})
        self.assertEqual(
            ts.get("enabled"), "off",
            "tools.tool_search.enabled must be 'off' — "
            "parilka profile uses 5 direct plugin tools "
            "without progressive disclosure bridge",
        )

    def test_dangerous_local_toolsets_all_denied(self):
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        for dangerous in ("file", "terminal", "code_execution", "project",
                          "computer_use"):
            self.assertIn(
                dangerous, denied,
                f"{dangerous} must be in disabled_toolsets",
            )
        allowed = set(self.cfg["platform_toolsets"]["telegram"])
        self.assertEqual(
            {"file", "terminal", "code_execution", "project",
             "computer_use"} & allowed,
            set(),
            "Dangerous local toolsets must never be allowed",
        )

    def test_browser_search_not_denied_shared_web_search(self):
        """browser/search must NOT be in disabled_toolsets.

        Hermes 0.20 resolves both to toolsets that share ``web_search``
        (``resolve_toolset("search") == ["web_search"]``; the browser
        composite also contains it), and agent.disabled_toolsets is a
        global subtraction applied AFTER the platform allowlist — so
        denying them strips web_search from the allowed ``web`` toolset
        and the model loses web search entirely.  The explicit telegram
        allowlist never includes browser/search, so both denies are
        redundant and were removed (config _config_version 38).
        """
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        self.assertNotIn("browser", denied,
                         "browser shares web_search with the web toolset — "
                         "denying it would strip web_search")
        self.assertNotIn("search", denied,
                         "search resolves to web_search — denying it would "
                         "strip web_search from the allowed web toolset")

    def test_spotify_in_both_deny_and_known_plugins(self):
        """spotify is denied as a model toolset but listed as a known
        plugin toolset so a disabled bundled plugin doesn't re-enable it."""
        denied = self.cfg["agent"]["disabled_toolsets"]
        known = self.cfg["known_plugin_toolsets"]["telegram"]
        self.assertIn("spotify", denied)
        self.assertIn("spotify", known)

    def test_parilka_chat_in_both_allowed_and_known_plugins(self):
        allowed = self.cfg["platform_toolsets"]["telegram"]
        known = self.cfg["known_plugin_toolsets"]["telegram"]
        self.assertIn("parilka_chat", allowed)
        self.assertIn("parilka_chat", known)

    def test_known_plugins_subset_of_union_allow_deny(self):
        """Every known plugin toolset must be either allowed or denied."""
        allowed = set(self.cfg["platform_toolsets"]["telegram"])
        denied = set(self.cfg["agent"]["disabled_toolsets"])
        known = set(self.cfg["known_plugin_toolsets"]["telegram"])
        union = allowed | denied
        orphan = known - union
        self.assertEqual(
            orphan, set(),
            f"Known plugin toolsets not in allow ∪ deny: {orphan}",
        )


# ── Hermes 0.20.0 checkout discovery ───────────────────────────────────────

_HERMES_CHECKOUT = Path("/home/billy/.hermes/hermes-agent")
_HERMES_VENV_PYTHON = _HERMES_CHECKOUT / "venv" / "bin" / "python3"


def _hermes_checkout_ready() -> bool:
    """True when the hermes-agent checkout and its venv are usable."""
    return (
        _HERMES_CHECKOUT.is_dir()
        and _HERMES_VENV_PYTHON.is_file()
        and (_HERMES_CHECKOUT / "hermes_cli" / "tools_config.py").is_file()
    )


@unittest.skipUnless(_hermes_checkout_ready(),
                     "Hermes 0.20 checkout not available at ~/.hermes/hermes-agent")
class Hermes020PlatformToolsSmoke(unittest.TestCase):
    """Exercise _get_platform_tools + get_tool_definitions with the real
    Hermes 0.20.0 checkout.  No network, no providers, no ~/.hermes mutation.

    The test copies the profile config into a temp HERMES_HOME so the
    tool_search config is honoured.  Plugin discovery runs from the
    checkout's own venv. No provider credentials are injected and no
    network/provider probe may run."""

    EXPECTED_TOOLS = {
        # Five parilka_chat plugin tools (clean cache-only read surface).
        "rag_bm25_search", "keyword_search", "read_chat_slice",
        "day_digest", "thread_context",
        # Built-in toolsets: memory, skills, native web, session search, TTS.
        "memory", "skills_list", "skill_view", "skill_manage",
        "web_search", "web_extract", "session_search", "text_to_speech",
    }

    @classmethod
    def setUpClass(cls):
        import yaml  # type: ignore[import-not-found]

        cfg_path = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile",
            "config.yaml",
        )
        with open(cfg_path, "r", encoding="utf-8") as f:
            cls.cfg = yaml.safe_load(f)

        # Create a temp directory tree that mimics <root>/profiles/parilka
        # so get_active_profile_name() returns "parilka" (no ~/.hermes touch).
        cls._tmp_root = tempfile.mkdtemp(prefix="hermes_smoke_")
        cls._tmp_home = os.path.join(cls._tmp_root, "profiles", "parilka")
        os.makedirs(cls._tmp_home, exist_ok=True)
        cls._tmp_config = os.path.join(cls._tmp_home, "config.yaml")
        with open(cls._tmp_config, "w", encoding="utf-8") as f:
            yaml.dump(cls.cfg, f)

        # Symlink the profile plugins into the temp profile home so the
        # parilka-chat plugin is discoverable by Hermes.
        _profile_plugins = os.path.join(
            REPO_ROOT, "integrations", "hermes", "parilka-profile",
            "plugins",
        )
        _tmp_plugins = os.path.join(cls._tmp_home, "plugins")
        os.symlink(_profile_plugins, _tmp_plugins)

        cls._hermes_python = str(_HERMES_VENV_PYTHON)
        cls._checkout = str(_HERMES_CHECKOUT)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls._tmp_root, ignore_errors=True)

    # ── helpers ────────────────────────────────────────────────────────

    def _run_hermes_code(self, code: str) -> "tuple[str, str, int]":
        """Execute *code* inside the hermes venv, with checkout on sys.path."""
        import subprocess

        env = os.environ.copy()
        env["HERMES_HOME"] = self._tmp_home
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Prevent any network / provider probe from firing.
        env["HERMES_OFFLINE"] = "1"
        proc = subprocess.run(
            [self._hermes_python, "-c", code],
            capture_output=True, text=True, timeout=30,
            env=env,
            cwd=self._checkout,
        )
        return proc.stdout, proc.stderr, proc.returncode

    # ── _get_platform_tools ────────────────────────────────────────────

    def test_get_platform_tools_exact_seven_no_raw_mcp_alias(self):
        """_get_platform_tools with include_default_mcp_servers=True must
        return exactly seven toolsets, with telegram-parilka subtracted and
        the safe TTS surface included."""
        code = f"""\
import sys, json, yaml
sys.path.insert(0, {self._checkout!r})
from hermes_cli.tools_config import _get_platform_tools
with open({self._tmp_config!r}) as f:
    cfg = yaml.safe_load(f)
enabled = _get_platform_tools(cfg, "telegram", include_default_mcp_servers=True)
print(json.dumps(sorted(enabled)))
"""
        stdout, stderr, rc = self._run_hermes_code(code)
        self.assertEqual(rc, 0, f"stderr: {stderr}")
        enabled = __import__("json").loads(stdout.strip())
        self.assertEqual(
            enabled,
            ["memory", "parilka_chat", "session_search", "skills", "tts",
             "vision", "web"],
            f"Unexpected enabled toolsets: {enabled}",
        )
        self.assertNotIn("telegram-parilka", enabled)

    def test_get_platform_tools_no_hermes_telegram_no_no_mcp_sentinel(self):
        """Explicit list bypasses default composite; no hermes-telegram, no no_mcp."""
        code = f"""\
import sys, json, yaml
sys.path.insert(0, {self._checkout!r})
from hermes_cli.tools_config import _get_platform_tools
with open({self._tmp_config!r}) as f:
    cfg = yaml.safe_load(f)
enabled = _get_platform_tools(cfg, "telegram", include_default_mcp_servers=True)
print(json.dumps(sorted(enabled)))
"""
        stdout, stderr, rc = self._run_hermes_code(code)
        self.assertEqual(rc, 0, f"stderr: {stderr}")
        enabled = __import__("json").loads(stdout.strip())
        self.assertNotIn("hermes-telegram", enabled)
        self.assertNotIn("no_mcp", enabled)

    # ── get_tool_definitions assembly ──────────────────────────────────

    def test_get_tool_definitions_exact_tool_set(self):
        """The assembled defs must be EXACTLY the expected set.

        Proves in one shot: the five parilka tools appear eagerly with
        tool_search off; Codex-native web tools and TTS survive
        (browser/search are not denied because they share web_search);
        and no browser/file/terminal/code_execution/project/computer_use/
        bridge (tool_search/tool_describe/tool_call) or raw MCP tools leak
        in — any extra name fails the exact match."""
        code = f"""\
import sys, json, yaml
sys.path.insert(0, {self._checkout!r})
from hermes_cli.tools_config import _get_platform_tools
from model_tools import get_tool_definitions

with open({self._tmp_config!r}) as f:
    cfg = yaml.safe_load(f)
enabled = _get_platform_tools(cfg, "telegram", include_default_mcp_servers=True)
disabled = cfg.get("agent", {{}}).get("disabled_toolsets", [])

defs = get_tool_definitions(
    enabled_toolsets=list(enabled),
    disabled_toolsets=disabled,
    quiet_mode=True,
)
print(json.dumps(sorted(t["function"]["name"] for t in defs)))
"""
        stdout, stderr, rc = self._run_hermes_code(code)
        self.assertEqual(rc, 0, f"stderr: {stderr}")
        names = set(__import__("json").loads(stdout.strip()))
        self.assertEqual(
            names, self.EXPECTED_TOOLS,
            f"Tool set mismatch — expected exactly {sorted(self.EXPECTED_TOOLS)}",
        )

    def test_disabled_toolsets_disjoint_from_allowed(self):
        """No tool of any disabled toolset may belong to the allowed
        platform toolsets (resolved via the real Hermes registry).

        agent.disabled_toolsets is a global subtraction after the
        allowlist, so a shared tool (like web_search in browser/search)
        silently disappears from the model.  This regression guard
        resolves every enabled and disabled toolset through the real
        Hermes and asserts zero overlap."""
        code = f"""\
import sys, json, yaml
sys.path.insert(0, {self._checkout!r})
from hermes_cli.tools_config import _get_platform_tools
from toolsets import resolve_toolset

with open({self._tmp_config!r}) as f:
    cfg = yaml.safe_load(f)
enabled = _get_platform_tools(cfg, "telegram", include_default_mcp_servers=True)
disabled = cfg.get("agent", {{}}).get("disabled_toolsets", [])

allowed_tools = set()
for ts in enabled:
    allowed_tools.update(resolve_toolset(ts))
overlaps = {{}}
for ts in disabled:
    shared = set(resolve_toolset(ts)) & allowed_tools
    if shared:
        overlaps[ts] = sorted(shared)
print(json.dumps(overlaps))
"""
        stdout, stderr, rc = self._run_hermes_code(code)
        self.assertEqual(rc, 0, f"stderr: {stderr}")
        overlaps = __import__("json").loads(stdout.strip())
        self.assertEqual(
            overlaps, {},
            f"Disabled toolset shares tools with allowed toolsets: "
            f"{overlaps} — the shared tool would be stripped by "
            f"agent.disabled_toolsets",
        )

    def test_get_tool_definitions_has_no_credential_probes(self):
        """Smoke: get_tool_definitions must not trigger provider/credential
        imports that would fail offline.  Stderr must be clean of auth errors."""
        code = f"""\
import sys, yaml
sys.path.insert(0, {self._checkout!r})
from hermes_cli.tools_config import _get_platform_tools
from model_tools import get_tool_definitions

with open({self._tmp_config!r}) as f:
    cfg = yaml.safe_load(f)
enabled = _get_platform_tools(cfg, "telegram", include_default_mcp_servers=True)
disabled = cfg.get("agent", {{}}).get("disabled_toolsets", [])

defs = get_tool_definitions(
    enabled_toolsets=list(enabled),
    disabled_toolsets=disabled,
    quiet_mode=True,
)
# Just assert it returns a list — no crash = success.
assert isinstance(defs, list), type(defs)
print(len(defs))
"""
        stdout, stderr, rc = self._run_hermes_code(code)
        self.assertEqual(rc, 0, f"stderr: {stderr}")
        # Must not contain credential/auth errors in stderr.
        stderr_lower = stderr.lower()
        for needle in ("apikey", "api_key", "unauthorized", "credential"):
            self.assertNotIn(
                needle, stderr_lower,
                f"Credential probe detected in stderr: {stderr[:500]}",
            )


if __name__ == "__main__":
    unittest.main()
