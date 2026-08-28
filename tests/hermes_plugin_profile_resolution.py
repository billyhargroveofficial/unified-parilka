"""Tests: session profile resolution in _get_session_env for parilka-chat.

Single-profile gateway semantics (verified against the deployed Hermes
0.20.0): with multiplex_profiles=false, BasePlatformAdapter.build_source
leaves source.profile=None, so GatewayRunner._set_session_env sets
HERMES_SESSION_PROFILE empty even though the process runs under
HERMES_HOME=<root>/profiles/parilka. _get_session_env therefore resolves an
empty raw profile through hermes_cli.profiles.get_active_profile_name()
(which infers the name from HERMES_HOME) while never replacing an explicit
non-empty profile. Resolution is fail-closed: default/custom/import/runtime
errors resolve to "" and the strict _assert_telegram_group rejects the turn.
"""

from __future__ import annotations

import os
import re
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from tests.support.hermes_plugin_helpers import (
    DEFAULT_CHAT_ID,
    REPO_ROOT,
    fake_session_env,
)

import parilka_chat  # type: ignore[import-not-found]

# Never write bytecode into the installed Hermes checkout we import from.
sys.dont_write_bytecode = True

_PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def fake_raw_session(profile: str) -> dict:
    """Raw gateway session vars keyed by HERMES_SESSION_* as read by
    gateway.session_context.get_session_env."""
    env = fake_session_env(profile=profile)
    return {
        f"HERMES_SESSION_{key.upper()}": value for key, value in env.items()
    }


def make_fake_gateway(session: dict) -> types.ModuleType:
    """Fake ``gateway.session_context`` backed by a raw session dict."""

    module = types.ModuleType("gateway.session_context")

    def get_session_env(key: str, default: str = "") -> str:
        return session.get(key, default)

    module.get_session_env = get_session_env
    return module


def mirror_active_profile_name(hermes_home: str) -> str:
    """Mirror of 0.20.0 ``hermes_cli.profiles.get_active_profile_name``.

    Docker-aware inference: HERMES_HOME whose parent dir is ``profiles`` is
    a named profile; any other path is its own default root. Verified
    against the real deployed module in RealHermesActiveProfileNameTests.
    """
    root = Path(hermes_home)
    if root.parent.name == "profiles" and _PROFILE_ID_RE.fullmatch(root.name):
        return root.name
    return "default"


def make_fake_profiles(
    hermes_home: str, *, raise_error: bool = False
) -> dict:
    """Fake ``hermes_cli`` package with a scriptable resolver."""
    pkg = types.ModuleType("hermes_cli")
    pkg.__path__ = []
    profiles = types.ModuleType("hermes_cli.profiles")

    if raise_error:

        def get_active_profile_name() -> str:
            raise RuntimeError("resolver unavailable")

    else:

        def get_active_profile_name() -> str:
            return mirror_active_profile_name(hermes_home)

    profiles.get_active_profile_name = get_active_profile_name
    return {"hermes_cli": pkg, "hermes_cli.profiles": profiles}


class ProfileResolutionTests(unittest.TestCase):
    """Hermetic _get_session_env resolution (fake gateway + fake resolver).

    The fake resolver mirrors the deployed Hermes 0.20.0 semantics; the
    mirror itself is checked against the real module in
    RealHermesActiveProfileNameTests.
    """

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = DEFAULT_CHAT_ID

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def session_env(
        self, raw_profile: str, hermes_home: str, raise_error: bool = False
    ) -> dict:
        gateway = make_fake_gateway(fake_raw_session(raw_profile))
        profiles = make_fake_profiles(hermes_home, raise_error=raise_error)
        with patch.dict(
            sys.modules, {"gateway.session_context": gateway, **profiles}
        ):
            return parilka_chat._get_session_env()

    def test_empty_raw_with_active_parilka_resolves_and_passes(self):
        env = self.session_env("", "/opt/parilka/profiles/parilka")
        self.assertEqual(env["profile"], "parilka")
        self.assertEqual(parilka_chat._assert_telegram_group(env), 42)

    def test_empty_raw_with_active_default_rejected(self):
        env = self.session_env("", "/opt/parilka/custom-root")
        self.assertEqual(env["profile"], "default")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_empty_raw_with_active_foreign_profile_rejected(self):
        env = self.session_env("", "/opt/parilka/profiles/custom")
        self.assertEqual(env["profile"], "custom")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_empty_raw_with_resolver_error_rejected(self):
        env = self.session_env("", "/opt/parilka", raise_error=True)
        self.assertEqual(env["profile"], "")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_empty_raw_with_missing_resolver_rejected(self):
        """Import failure of hermes_cli.profiles resolves to "" (fail closed)."""
        gateway = make_fake_gateway(fake_raw_session(""))
        pkg = types.ModuleType("hermes_cli")
        pkg.__path__ = []
        with patch.dict(
            sys.modules,
            {
                "gateway.session_context": gateway,
                "hermes_cli": pkg,
                # None in sys.modules halts the submodule import with
                # ModuleNotFoundError regardless of any real installation.
                "hermes_cli.profiles": None,
            },
        ):
            env = parilka_chat._get_session_env()
        self.assertEqual(env["profile"], "")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_explicit_foreign_profile_never_replaced(self):
        """Explicit "default" stays "default" even with active parilka; the
        resolver must never run (it would raise)."""
        env = self.session_env(
            "default",
            "/opt/parilka/profiles/parilka",
            raise_error=True,
        )
        self.assertEqual(env["profile"], "default")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_explicit_parilka_passes_without_resolver(self):
        """Explicit "parilka" passes even with active default; the resolver
        must never run (it would raise)."""
        env = self.session_env(
            "parilka",
            "/opt/parilka/custom-root",
            raise_error=True,
        )
        self.assertEqual(env["profile"], "parilka")
        self.assertEqual(parilka_chat._assert_telegram_group(env), 42)


_HERMES_AGENT_ROOTS = (
    Path.home() / ".hermes" / "hermes-agent",
    Path(REPO_ROOT).parent / "hermes-agent",
)


class RealHermesActiveProfileNameTests(unittest.TestCase):
    """Prove the resolution contract against the deployed Hermes 0.20.0.

    Imports the REAL ``hermes_cli.profiles`` from the installed checkout
    (read-only; HERMES_HOME always points into a temp dir, never at
    ~/.hermes) and exercises both the native resolver and the plugin
    end-to-end for the single-profile gateway scenario. Skipped when no
    Hermes checkout is installed.
    """

    HERMES_ROOT = next(
        (root for root in _HERMES_AGENT_ROOTS if root.is_dir()), None
    )

    @classmethod
    def setUpClass(cls):
        if cls.HERMES_ROOT is None:
            raise unittest.SkipTest(
                "deployed Hermes checkout not found; "
                "real-resolver tests skipped"
            )
        if str(cls.HERMES_ROOT) not in sys.path:
            sys.path.insert(0, str(cls.HERMES_ROOT))
        from hermes_cli.profiles import get_active_profile_name

        cls.get_active_profile_name = staticmethod(get_active_profile_name)

    @classmethod
    def tearDownClass(cls):
        if cls.HERMES_ROOT is not None:
            path = str(cls.HERMES_ROOT)
            if path in sys.path:
                sys.path.remove(path)

    def setUp(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = DEFAULT_CHAT_ID

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def resolved(self, hermes_home: str) -> str:
        with patch.dict(os.environ, {"HERMES_HOME": hermes_home}):
            return self.get_active_profile_name()

    def test_named_profile_inferred_from_hermes_home(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(
                self.resolved(str(Path(tmp) / "profiles" / "parilka")),
                "parilka",
            )

    def test_custom_root_is_default_profile(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(
                self.resolved(str(Path(tmp) / "custom-root")), "default"
            )

    def test_foreign_named_profile_inferred(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(
                self.resolved(str(Path(tmp) / "profiles" / "custom")),
                "custom",
            )

    def test_mirror_matches_real_resolver(self):
        with TemporaryDirectory() as tmp:
            for name in ("profiles/parilka", "profiles/custom", "custom-root"):
                home = str(Path(tmp) / name)
                with patch.dict(os.environ, {"HERMES_HOME": home}):
                    real = self.get_active_profile_name()
                self.assertEqual(mirror_active_profile_name(home), real, home)

    def test_empty_raw_profile_end_to_end_resolves_and_passes(self):
        """Single-profile gateway: empty HERMES_SESSION_PROFILE under
        HERMES_HOME=<root>/profiles/parilka resolves and passes the guard."""
        with TemporaryDirectory() as tmp:
            home = str(Path(tmp) / "profiles" / "parilka")
            with patch.dict(os.environ, {"HERMES_HOME": home}):
                with patch.dict(
                    sys.modules,
                    {"gateway.session_context": make_fake_gateway(
                        fake_raw_session("")
                    )},
                ):
                    env = parilka_chat._get_session_env()
        self.assertEqual(env["profile"], "parilka")
        self.assertEqual(parilka_chat._assert_telegram_group(env), 42)

    def test_explicit_foreign_never_replaced_with_real_resolver(self):
        with TemporaryDirectory() as tmp:
            home = str(Path(tmp) / "profiles" / "parilka")
            with patch.dict(os.environ, {"HERMES_HOME": home}):
                with patch.dict(
                    sys.modules,
                    {"gateway.session_context": make_fake_gateway(
                        fake_raw_session("default")
                    )},
                ):
                    env = parilka_chat._get_session_env()
        self.assertEqual(env["profile"], "default")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)


if __name__ == "__main__":
    unittest.main()
