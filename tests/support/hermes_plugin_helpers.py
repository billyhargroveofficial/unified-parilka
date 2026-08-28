"""Shared helpers for parilka-chat Hermes plugin offline tests.

Do NOT import secrets, use network, Telegram, provider APIs, or mutate ~/.hermes.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict

REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
PLUGIN_PARENT = os.path.join(
    REPO_ROOT, "integrations", "hermes", "parilka-profile", "plugins",
)
sys.path.insert(0, PLUGIN_PARENT)

import parilka_chat  # noqa: E402  (requires PLUGIN_PARENT on sys.path)

DEFAULT_CHAT_ID = "-1003179772905"


def fake_session_env(
    platform: str = "telegram",
    chat_id: str = DEFAULT_CHAT_ID,
    chat_type: str = "group",
    user_id: str = "123456789",
    user_name: str = "TestUser",
    message_id: str = "42",
    profile: str = "parilka",
) -> Dict[str, str]:
    return {
        "platform": platform,
        "chat_id": chat_id,
        "chat_type": chat_type,
        "user_id": user_id,
        "user_name": user_name,
        "message_id": message_id,
        "profile": profile,
    }


def fake_dispatch_ok(inner: Dict[str, Any]) -> str:
    """Build the exact public dispatch success shape {"result": "<inner JSON>"}."""
    return json.dumps(
        {"result": json.dumps(inner, ensure_ascii=False)},
        ensure_ascii=False,
    )


def fake_dispatch_error(message: str = "something went wrong") -> str:
    """Build a top-level dispatch error shape {"error": "..."}."""
    return json.dumps({"error": message}, ensure_ascii=False)


def fake_legacy_mcp_response(inner: Dict[str, Any]) -> str:
    """Build the legacy MCP envelope (content[0].text) — must be rejected."""
    return json.dumps({
        "content": [{"type": "text", "text": json.dumps(inner, ensure_ascii=False)}],
    })


def cached_row(
    message_id: int,
    text: str,
    sender_name: str = "User",
    sender_id: str = "111",
    is_own: bool = False,
    date: str = "",
    reply_to: int | None = None,
) -> Dict[str, Any]:
    """Build a camelCase cached message row as returned by read_chat_slice."""
    row: Dict[str, Any] = {
        "sourceId": f"chat:{message_id}",
        "messageId": message_id,
        "senderId": sender_id,
        "senderName": sender_name,
        "date": date,
        "replyToMessageId": reply_to,
        "authorRole": "assistant" if is_own else "user",
        "isOwnTurn": is_own,
        "text": text,
    }
    return row


def slice_ok_response(
    rows: list,
    first_message_id: int = 1,
    last_message_id: int | None = None,
    total_available: int | None = None,
    returned_count: int | None = None,
    omitted_count: int = 0,
    requested_count: int | None = None,
) -> Dict[str, Any]:
    """Build an ok read_chat_slice inner payload with sane coverage.

    ``requested_count`` mirrors the TS ``requested.count`` of the dispatch
    that produced this response; it defaults to the plugin's SLICE_COUNT so
    fixtures never drift from the hook's primary request.
    """
    if last_message_id is None:
        last_message_id = max((r.get("messageId", 0) for r in rows), default=0)
    if total_available is None:
        total_available = len(rows)
    if returned_count is None:
        returned_count = len(rows)
    if requested_count is None:
        requested_count = parilka_chat.SLICE_COUNT
    return {
        "ok": True,
        "tool": "read_chat_slice",
        "status": "done" if rows else "empty",
        "result": {
            "mode": "recent",
            "requested": {"count": requested_count},
            "coverage": {
                "upperMessageId": None,
                "totalAvailable": total_available,
                "returnedCount": returned_count,
                "coveredCount": returned_count,
                "firstMessageId": first_message_id,
                "lastMessageId": last_message_id,
                "emptyTextCount": 0,
                "truncated": False,
                "omittedCount": omitted_count,
                "hasMore": False,
            },
            "messages": rows,
        },
        "evidence": [],
    }
