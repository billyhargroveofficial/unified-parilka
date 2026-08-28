"""Tests: session guard (_assert_telegram_group) for parilka-chat plugin.

The allowed group comes ONLY from required env PARILKA_TELEGRAM_CHAT_ID;
a missing or empty value fails closed. Error messages carry no values.
"""

from __future__ import annotations

import os
import unittest

from tests.support.hermes_plugin_helpers import DEFAULT_CHAT_ID, fake_session_env

import parilka_chat  # type: ignore[import-not-found]


def set_allowed_chat(chat_id: str = DEFAULT_CHAT_ID) -> None:
    os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = chat_id


class SessionGuardTests(unittest.TestCase):
    """Test _assert_telegram_group fail-closed behavior."""

    def setUp(self):
        set_allowed_chat()

    def tearDown(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)

    def test_valid_telegram_group_returns_message_id(self):
        env = fake_session_env()
        self.assertEqual(parilka_chat._assert_telegram_group(env), 42)

    def test_missing_allowed_chat_env_fails_closed(self):
        os.environ.pop(parilka_chat.ALLOWED_CHAT_ID_ENV, None)
        env = fake_session_env()
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_empty_allowed_chat_env_fails_closed(self):
        os.environ[parilka_chat.ALLOWED_CHAT_ID_ENV] = "   "
        env = fake_session_env()
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_allowed_chat_comes_from_env_not_constant(self):
        set_allowed_chat("-1009999999999")
        env = fake_session_env(chat_id="-1009999999999")
        self.assertEqual(parilka_chat._assert_telegram_group(env), 42)

    def test_wrong_platform_raises(self):
        env = fake_session_env(platform="discord")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_wrong_profile_raises(self):
        env = fake_session_env(profile="default")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_wrong_chat_id_raises(self):
        env = fake_session_env(chat_id="-1009999999999")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_wrong_chat_type_raises(self):
        env = fake_session_env(chat_type="private")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_missing_message_id_raises(self):
        env = fake_session_env(message_id="")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_non_integer_message_id_raises(self):
        env = fake_session_env(message_id="abc")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_zero_message_id_raises(self):
        env = fake_session_env(message_id="0")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_negative_message_id_raises(self):
        env = fake_session_env(message_id="-1")
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_oversized_message_id_raises(self):
        env = fake_session_env(message_id="9007199254740992")  # > MAX_SAFE_INTEGER
        with self.assertRaises(ValueError):
            parilka_chat._assert_telegram_group(env)

    def test_error_messages_never_contain_values_or_ids(self):
        """Fail-closed messages are generic; no expected IDs leak."""
        for env in (
            fake_session_env(platform="discord"),
            fake_session_env(profile="default"),
            fake_session_env(chat_id="-1009999999999"),
            fake_session_env(chat_type="private"),
            fake_session_env(message_id="abc"),
        ):
            with self.assertRaises(ValueError) as ctx:
                parilka_chat._assert_telegram_group(env)
            msg = str(ctx.exception)
            self.assertNotIn(DEFAULT_CHAT_ID, msg)
            self.assertNotIn("discord", msg)
            self.assertNotIn("default", msg)
            self.assertNotIn("-1009999999999", msg)
            self.assertNotIn("abc", msg)
            self.assertNotIn("42", msg)


if __name__ == "__main__":
    unittest.main()
