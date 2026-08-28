"""Hermes plugin: parilka-chat trusted bridge to parilka-unified MCP.

Registers five clean cache-only read tools (toolset ``parilka_chat``) without
``chat`` or ``source_message_id`` in the model-facing schema. The handler
derives both from the gateway session context, enforces the configured
Telegram group (from required env ``PARILKA_TELEGRAM_CHAT_ID``), validates
profile, and injects ``source_message_id`` before dispatching the underlying
call via ``ctx.dispatch_tool`` under the *prefixed raw* MCP registry name
(``mcp__telegram_parilka__<tool>``). Dispatching the clean name would recurse
into this wrapper.

Hooks:
- ``pre_llm_call``: inject a bounded cached-chatter slice for the current
   group turn, with high-water dedup via historical ``api_content`` sidecars
   so repeated turns inject only newer rows.
- ``pre_tool_call``: gate native memory/skill writes to the configured
   allowlist; block unless allowed sender or background_review. All ``memory``
   and ``skill_manage`` calls are writes — the native tool surfaces are
   write-only (reads go through skills_list/skill_view separately). Managed
   projection entries (``[parilka:managed:`` memory prefix / managed skill
   targets) are never model-editable, not even via background_review. The same
   hook confines local ``image_generate`` edit sources to the profile image
   cache so enabling image generation does not restore arbitrary file reads.
- ``pre_llm_call``/``post_api_request``/``post_tool_call``/
  ``transform_llm_output`` (runtime_hooks): exact Telegram runtime footer
  (``<model> 🧠 · <used>/<max> · <N> tool calls · <elapsed>``) for tracked
  group turns; ``used`` is the latest ``prompt_tokens`` only and ``max`` is
  Hermes' provider-scoped context window for the acting model.
- ``pre_gateway_dispatch`` (runtime_hooks): require a literal Telegram
  ``@botusername`` mention in the configured group (a reply alone never wakes
  the agent), then cap vision to the first 6 image attachments of a merged
  Telegram MessageEvent while keeping non-image media.

Fails closed: outside the allowed Telegram group or wrong profile, every
handler and hook is a no-op or denies.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple

from .runtime_hooks import register as _register_runtime_hooks
from .schemas import TOOL_NAMES, TOOL_SCHEMAS

logger = logging.getLogger(__name__)

# ── constants ───────────────────────────────────────────────────────────────

REQUIRED_PLATFORM = "telegram"
REQUIRED_PROFILE = "parilka"
ALLOWED_CHAT_ID_ENV = "PARILKA_TELEGRAM_CHAT_ID"
MCP_SERVER_KEY = "telegram-parilka"
MCP_TOOL_PREFIX = "mcp__"

# Clean model-facing name → raw prefixed registry name. Hermes prefixes every
# MCP tool with ``mcp__<sanitizedServer>__<tool>`` (tools/mcp_tool.py
# mcp_prefixed_tool_name); the server config key ``telegram-parilka``
# sanitizes to ``telegram_parilka``. ctx.dispatch_tool MUST receive the raw
# prefixed name — the clean name resolves back to this plugin's own handler
# and recurses into the wrapper.
RAW_TOOL_NAMES: Dict[str, str] = {
    name: f"{MCP_TOOL_PREFIX}{MCP_SERVER_KEY.replace('-', '_')}__{name}"
    for name in TOOL_NAMES
}

# Cached slice width for pre_llm_call. read_chat_slice schema has no
# after_id — the plugin fetches a bounded recent window and filters ids >
# previous high-water locally. SLICE_COUNT=300: a live real-data run proved
# one 300-row request succeeds, and boundToolPayload can only collapse when
# every string is <=64 chars and the payload still exceeds the 192_000-char
# projection cap (MAX_READ_CHAT_SLICE_OUTPUT_CHARS in
# src/bot/read-tools/contracts.ts) — with ordinary JSON-safe rows the worst
# such state (64-char strings) still fits at 300 rows, and the 8_500-char
# render budget fills with at most ~200 minimal rows. Any ok response
# without a usable messages list (the projection-only collapse of an
# oversized window) triggers ONE bounded retry with FALLBACK_SLICE_COUNT
# =50, which is structurally safe even under maximum JSON escape expansion:
# a pessimistic row whose every string field is 64 control characters
# serializes to ~2.1 KB (each control char escapes to 6 chars), so 50 rows
# plus the envelope stay near 55% of the cap. The former value 1000
# exceeded the cap on real data — the live bug.
SLICE_COUNT = 300
FALLBACK_SLICE_COUNT = 50

# Maximum injected context chars (hard budget per turn, inclusive of header,
# metadata and marker).
MAX_CONTEXT_CHARS = 8500
# Maximum chars per individual cached message text (before the explicit
# "[текст усечён]" marker).
MAX_MESSAGE_CHARS = 1200
# Context marker: hidden token at the very END of the injected context,
# parsed on subsequent turns from the api_content sidecar to implement
# high-water dedup.
CONTEXT_MARKER = "\u200B"  # zero-width space — control char, never in real text

# Bounded generic top-level errors; never raw exceptions, values or IDs.
SESSION_REJECTED = "parilka-chat: session rejected"
INVALID_ARGS = "parilka-chat: invalid arguments"
DISPATCH_FAILED = "parilka-chat: dispatch failed"
PROTOCOL_ERROR = "parilka-chat: protocol error"

# Native write-only tools gated by pre_tool_call.
_WRITE_TOOL_NAMES = frozenset({"memory", "skill_manage"})
_IMAGE_TOOL_NAME = "image_generate"

_HW_PATTERN = re.compile(
    re.escape(CONTEXT_MARKER) + r"hw=(\d+)" + re.escape(CONTEXT_MARKER) + r"$"
)


# ── env helpers ─────────────────────────────────────────────────────────────


def _env_csv(name: str) -> Set[str]:
    raw = os.getenv(name, "")
    if not raw.strip():
        return set()
    return {v.strip() for v in raw.split(",") if v.strip()}


def _allowed_chat_id() -> str:
    """Return the required allowed Telegram chat id from env (fail closed).

    The allowed group comes ONLY from PARILKA_TELEGRAM_CHAT_ID; a missing or
    empty value is a configuration error, never a fallback to a default.
    """
    return os.getenv(ALLOWED_CHAT_ID_ENV, "").strip()


# ── session guard ───────────────────────────────────────────────────────────


def _resolve_session_profile(raw: str) -> str:
    """Session profile: raw non-empty value, else the active HERMES_HOME
    profile inferred by the native resolver.

    Single-profile gateways (multiplex_profiles=false) leave
    HERMES_SESSION_PROFILE empty while the process runs under
    ``HERMES_HOME=<root>/profiles/<name>``. Fail closed: import/runtime
    errors resolve to "" so the strict guard rejects the turn. Never
    mutates the environment.
    """
    if raw:
        return raw
    try:
        from hermes_cli.profiles import get_active_profile_name

        return get_active_profile_name() or ""
    except Exception:
        return ""


def _get_session_env() -> Dict[str, str]:
    """Return the current gateway session context as a plain dict."""
    try:
        from gateway.session_context import get_session_env as _gse

        return {
            "platform": _gse("HERMES_SESSION_PLATFORM", ""),
            "chat_id": _gse("HERMES_SESSION_CHAT_ID", ""),
            "chat_type": _gse("HERMES_SESSION_CHAT_TYPE", ""),
            "user_id": _gse("HERMES_SESSION_USER_ID", ""),
            "user_name": _gse("HERMES_SESSION_USER_NAME", ""),
            "message_id": _gse("HERMES_SESSION_MESSAGE_ID", ""),
            "profile": _resolve_session_profile(
                _gse("HERMES_SESSION_PROFILE", "")
            ),
        }
    except ImportError:
        return {}


def _assert_telegram_group(env: Dict[str, str]) -> int:
    """Validate session is a Telegram group turn in the allowed chat/profile.

    Returns the positive integer message_id on success.
    Raises ValueError with a generic (value-free) message on failure so no
    expected IDs or raw session values can leak into logs or model output.
    """
    allowed = _allowed_chat_id()
    if not allowed:
        raise ValueError("allowed chat id env is not configured")
    if env.get("platform", "") != REQUIRED_PLATFORM:
        raise ValueError("session platform mismatch")
    if env.get("profile", "") != REQUIRED_PROFILE:
        raise ValueError("session profile mismatch")
    if env.get("chat_id", "") != allowed:
        raise ValueError("session chat mismatch")
    if env.get("chat_type", "") != "group":
        raise ValueError("session chat_type mismatch")
    raw_msg_id = env.get("message_id", "")
    if not raw_msg_id:
        raise ValueError("session message_id missing")
    try:
        msg_id = int(raw_msg_id)
    except (TypeError, ValueError):
        raise ValueError("session message_id invalid")
    if msg_id < 1 or msg_id > 9007199254740991:  # JS MAX_SAFE_INTEGER
        raise ValueError("session message_id out of safe range")
    return msg_id


# ── dispatch helpers ────────────────────────────────────────────────────────


def _dispatch_via_ctx(ctx: Any, tool_name: str, args: Dict[str, Any]) -> str:
    """Call ``ctx.dispatch_tool`` for the raw prefixed ``tool_name``.

    Returns the raw JSON string from the tool handler. Exceptions are
    re-raised as a generic RuntimeError without the exception value.
    """
    try:
        result = ctx.dispatch_tool(tool_name, args)
    except Exception:
        raise RuntimeError(DISPATCH_FAILED)

    if isinstance(result, dict):
        return json.dumps(result, ensure_ascii=False)
    if isinstance(result, str):
        return result
    return str(result)


def _unwrap_dispatch_result(raw: str) -> Dict[str, Any]:
    """Parse the exact public dispatch shape into the inner Parilka JSON.

    The ONLY accepted shape is a JSON object ``{"result": "<inner JSON>"}``
    where the inner text parses to a JSON object. Outer errors, malformed
    JSON, non-string results, malformed inner JSON and legacy MCP envelopes
    all raise RuntimeError with a generic message.
    """
    try:
        outer = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(PROTOCOL_ERROR)
    if not isinstance(outer, dict):
        raise RuntimeError(PROTOCOL_ERROR)
    inner_text = outer.get("result")
    if not isinstance(inner_text, str):
        raise RuntimeError(PROTOCOL_ERROR)
    try:
        inner = json.loads(inner_text)
    except json.JSONDecodeError:
        raise RuntimeError(PROTOCOL_ERROR)
    if not isinstance(inner, dict):
        raise RuntimeError(PROTOCOL_ERROR)
    return inner


def _generic_error(message: str) -> str:
    """Bounded generic top-level error visible to the model."""
    return json.dumps({"error": message}, ensure_ascii=False)


# ── tool handler factory ────────────────────────────────────────────────────


def _make_tool_handler(name: str, ctx: Any) -> Callable:
    """Return a handler for *name* that validates session and dispatches.

    The handler is called as ``handler(args_dict, **kwargs)`` by the Hermes
    tool registry. Every key must belong to the clean schema (forged
    ``chat``/``source_message_id`` are rejected, not stripped); on success the
    handler returns the exact outer shape ``{"result": "<inner JSON>"}``.
    """
    ctx_profile = getattr(ctx, "profile_name", "")
    allowed_keys = set(TOOL_SCHEMAS[name]["parameters"]["properties"])
    raw_name = RAW_TOOL_NAMES[name]

    def handler(args_dict: Dict[str, Any], **kwargs: Any) -> str:
        if ctx_profile != REQUIRED_PROFILE:
            return _generic_error(SESSION_REJECTED)
        try:
            env = _get_session_env()
            source_message_id = _assert_telegram_group(env)
        except ValueError:
            return _generic_error(SESSION_REJECTED)

        if not isinstance(args_dict, Mapping):
            return _generic_error(INVALID_ARGS)
        if any(key not in allowed_keys for key in args_dict):
            return _generic_error(INVALID_ARGS)

        clean_args = dict(args_dict)
        clean_args["source_message_id"] = source_message_id

        try:
            raw = _dispatch_via_ctx(ctx, raw_name, clean_args)
            inner = _unwrap_dispatch_result(raw)
        except Exception:
            logger.debug("parilka-chat: dispatch failed for %s", raw_name)
            return _generic_error(PROTOCOL_ERROR)
        return json.dumps(
            {"result": json.dumps(inner, ensure_ascii=False)},
            ensure_ascii=False,
        )

    return handler


# ── pre_llm_call hook ───────────────────────────────────────────────────────


def _make_pre_llm_call_hook(ctx: Any) -> Callable:
    """Return a pre_llm_call hook that dispatches through captured ctx."""

    ctx_profile = getattr(ctx, "profile_name", "")

    def hook(**kwargs: Any) -> Optional[Dict[str, str]]:
        """Inject bounded cached-chatter context for valid Telegram group turns.

        Returns ``{"context": "..."}`` or None (no-op when not our group/profile
        or when the dispatch fails).
        """
        if ctx_profile != REQUIRED_PROFILE:
            return None
        try:
            env = _get_session_env()
            source_message_id = _assert_telegram_group(env)
        except ValueError:
            return None

        conversation_history = kwargs.get("conversation_history") or []
        high_water = _parse_high_water_from_api_content(conversation_history)

        # read_chat_slice schema has no after_id: fetch a bounded recent
        # window and filter ids > high-water locally. Healthy turns dispatch
        # exactly once; an ok response without a usable messages list (the
        # projection-only collapse of an oversized window) is retried once
        # with the smaller bounded fallback count. Dispatch/protocol
        # failures and ok:false are never retried.
        usable: Optional[Tuple[List[Any], Dict[str, Any]]] = None
        for attempt, count in enumerate(
            (SLICE_COUNT, FALLBACK_SLICE_COUNT)
        ):
            dispatch_args: Dict[str, Any] = {
                "mode": "recent",
                "count": count,
                "source_message_id": source_message_id,
            }
            try:
                raw = _dispatch_via_ctx(
                    ctx, RAW_TOOL_NAMES["read_chat_slice"], dispatch_args
                )
                inner = _unwrap_dispatch_result(raw)
            except Exception:
                logger.debug(
                    "parilka-chat: pre_llm_call context fetch failed for %s",
                    RAW_TOOL_NAMES["read_chat_slice"],
                )
                return None

            if not inner.get("ok"):
                return None
            result = inner.get("result")
            if not isinstance(result, dict):
                return None
            messages = result.get("messages")
            if not isinstance(messages, list):
                if attempt == 0:
                    logger.debug(
                        "parilka-chat: pre_llm_call ok slice without "
                        "messages (projection-only collapse?); bounded "
                        "retry with count=%s",
                        FALLBACK_SLICE_COUNT,
                    )
                continue
            coverage = result.get("coverage")
            if not isinstance(coverage, dict):
                return None
            usable = (messages, coverage)
            break

        if usable is None:
            return None
        messages, coverage = usable

        context = _build_context(
            messages, coverage, high_water, source_message_id
        )
        if context is None:
            return None
        return {"context": context}

    return hook


# JS MAX_SAFE_INTEGER — верхняя граница валидных Telegram message ids.
MAX_SAFE_INTEGER_ID = 9007199254740991


def _format_row(
    msg: Any, high_water: int, current_source: int
) -> Optional[Tuple[int, str]]:
    """Format one camelCase cached message row, or None when not renderable.

    Rows are renderable only when valid: dict with a positive Python int
    messageId (bool is not an id), string text, id < current_source and id >
    high_water. Empty-text, malformed or excluded rows return None and never
    advance the marker.
    """
    if not isinstance(msg, dict):
        return None
    raw_id = msg.get("messageId")
    if not isinstance(raw_id, int) or isinstance(raw_id, bool):
        return None
    msg_id = raw_id
    if msg_id < 1 or msg_id > MAX_SAFE_INTEGER_ID:
        return None
    if msg_id >= current_source or (high_water > 0 and msg_id <= high_water):
        return None
    text = msg.get("text")
    if not isinstance(text, str):
        return None
    text = text.replace(CONTEXT_MARKER, "")
    if not text.strip():
        return None

    is_own = bool(msg.get("isOwnTurn")) or (
        str(msg.get("authorRole") or "") == "assistant"
    )
    if is_own:
        label = "[ассистент]"
    else:
        sender_name = msg.get("senderName")
        sender_id = msg.get("senderId")
        if isinstance(sender_name, str) and sender_name.strip():
            label = sender_name.strip()
        elif sender_id is not None and str(sender_id).strip():
            label = str(sender_id).strip()
        else:
            label = "[неизвестный]"

    if len(text) > MAX_MESSAGE_CHARS:
        text = text[:MAX_MESSAGE_CHARS].rstrip() + "\n[текст усечён]"

    parts = [label]
    date = msg.get("date")
    if isinstance(date, str) and date:
        parts.append(f"({date})")
    parts.append(f"msg_id={msg_id}")
    reply_to = msg.get("replyToMessageId")
    if (
        isinstance(reply_to, int)
        and not isinstance(reply_to, bool)
        and 1 <= reply_to <= MAX_SAFE_INTEGER_ID
    ):
        parts.append(f"reply_to={reply_to}")
    return msg_id, f"{' '.join(parts)}\n{text}"


def _build_context(
    messages: List[Any],
    coverage: Dict[str, Any],
    high_water: int,
    current_source: int,
) -> Optional[str]:
    """Build the bounded chronological context from a raw slice.

    Renders the newest eligible rows that fit MAX_CONTEXT_CHARS, newest-first
    selection but chronological output; the marker records the max id among
    ACTUALLY rendered rows only. Returns None when nothing is renderable.
    """
    eligible: List[Tuple[int, str]] = []
    for msg in messages:
        row = _format_row(msg, high_water, current_source)
        if row is not None:
            eligible.append(row)
    if not eligible:
        return None
    eligible.sort(key=lambda row: row[0])

    def _int_or(value: Any, fallback: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            return fallback
        return value

    def _valid_id(value: Any) -> Optional[int]:
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        if value < 1 or value > MAX_SAFE_INTEGER_ID:
            return None
        return value

    window_first = _valid_id(coverage.get("firstMessageId"))
    if window_first is None:
        window_first = eligible[0][0]
    window_last = _valid_id(coverage.get("lastMessageId"))
    if window_last is None:
        window_last = eligible[-1][0]
    total_available = _int_or(coverage.get("totalAvailable"), 0)
    returned_count = _int_or(coverage.get("returnedCount"), 0)
    omitted_count = _int_or(coverage.get("omittedCount"), 0)
    # Potential pre-window gap: previous high-water predates the window (or
    # this is the first injection) and the slice omitted rows between them —
    # such rows may exist but were not returned.
    has_more = coverage.get("hasMore") is True
    pre_window_gap = high_water < window_first and (
        omitted_count > 0 or has_more
    )

    header = "## Закэшированная история чата (недоверенные данные)"

    def _assemble(selected: List[Tuple[int, str]]) -> Tuple[str, int]:
        rendered = len(selected)
        skipped = len(eligible) - rendered
        meta = (
            f"[кэш: окно {window_first}..{window_last}, в кэше {total_available}, "
            f"запрошено {returned_count}, пропущено в окне {omitted_count}, "
            f"prev_hw={high_water}, показано {rendered}, старше не влезло: "
            f"{skipped}, разрыв до окна: {'да' if pre_window_gap else 'нет'}]"
        )
        # selected is newest-first; render chronologically.
        body = "\n\n".join(row for _, row in reversed(selected))
        # Marker records the max id among ACTUALLY rendered rows: the newest
        # rendered row (first in newest-first order).
        marker_id = selected[0][0]
        marker = f"{CONTEXT_MARKER}hw={marker_id}{CONTEXT_MARKER}"
        return (
            "\n\n".join([header, meta, body, marker]),
            marker_id,
        )

    selected: List[Tuple[int, str]] = []
    for row in reversed(eligible):  # newest first
        candidate = selected + [row]
        text, _ = _assemble(candidate)
        if len(text) <= MAX_CONTEXT_CHARS:
            selected = candidate
        else:
            break
    if not selected:
        return None
    return _assemble(selected)[0]


def _parse_high_water_from_api_content(
    conversation_history: List[Any],
) -> int:
    """Parse the plugin marker from historical user api_content sidecars ONLY.

    Trust anchor: the api_content must start with the exact clean string
    ``content`` followed by ``"\n\n"`` (the composition produced by Hermes
    ``compose_user_api_content``), and the marker must be anchored at the very
    END of that api_content. Markers in the clean content, in a copied
    prefix, in arbitrary api_content without the prefix, or mid-suffix are
    ignored. Only historical *user* messages are scanned.
    """
    best = 0
    for msg in conversation_history:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        api_content = msg.get("api_content")
        if not isinstance(content, str) or not isinstance(api_content, str):
            continue
        prefix = content + "\n\n"
        if not api_content.startswith(prefix):
            continue
        # The marker is trusted only in the suffix AFTER the clean content
        # prefix; a marker inside the content itself or a copied prefix is
        # ignored.
        suffix = api_content[len(prefix):]
        match = _HW_PATTERN.search(suffix)
        if match is None:
            continue
        try:
            val = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if val > best:
            best = val
    return best


# ── pre_tool_call hook ──────────────────────────────────────────────────────


_SESSION_GATE_MESSAGE = (
    "Запись в память/навыки разрешена только в группе Парилка228 "
    "с активной Telegram-сессией."
)
MANAGED_SKILL_ERROR = "parilka-chat: managed skills are read-only"
# Future-proof prefix owned by the hermes-projection writer: any memory entry
# starting with it is projection-owned and never model-editable.
MANAGED_MEMORY_PREFIX = "[parilka:managed:"
MANAGED_MEMORY_ERROR = "parilka-chat: managed memory is read-only"
IMAGE_SOURCE_ERROR = (
    "parilka-chat: image source must be HTTPS/data or a cached Telegram image"
)


def _write_blocked(message: str = _SESSION_GATE_MESSAGE) -> Dict[str, str]:
    return {"action": "block", "message": message}


def _image_source_blocked(args: Any) -> bool:
    """Fail closed for local image sources outside the profile image cache.

    ``image_generate`` supports image editing and therefore its provider may
    open a model-supplied local path.  Telegram turns deliberately have no
    generic file tool, so this secondary read surface must not become a path
    traversal/exfiltration primitive.  Remote HTTPS and data-URI inputs are
    passed through; local paths must resolve to a regular file beneath the
    active profile's ``cache/images`` directory.  Resolving before the
    containment check rejects ``..`` and symlink escapes.
    """
    if not isinstance(args, Mapping):
        return False  # malformed args remain the native tool's responsibility

    raw_sources: List[Any] = [args.get("image_url")]
    references = args.get("reference_image_urls")
    if isinstance(references, str):
        raw_sources.append(references)
    elif isinstance(references, (list, tuple)):
        raw_sources.extend(references)

    sources = [
        source.strip()
        for source in raw_sources
        if isinstance(source, str) and source.strip()
    ]
    if not sources:
        return False  # plain text-to-image never reads a local source

    try:
        from hermes_constants import get_hermes_home

        cache_root = (get_hermes_home() / "cache" / "images").resolve()
    except Exception:
        return True

    for source in sources:
        lower = source.lower()
        if lower.startswith(("https://", "data:")):
            continue
        try:
            resolved = Path(source).expanduser().resolve()
            resolved.relative_to(cache_root)
        except (OSError, RuntimeError, ValueError):
            return True
        try:
            if not resolved.is_file():
                return True
        except OSError:
            return True
    return False


def _targets_managed_skill(args: Any) -> bool:
    """True when skill_manage args target a managed projection entry.

    Managed targets (name ``parilka-lessons``, prefix ``parilka-skill-*`` or
    category ``parilka-managed``) are owned by the hermes-projection writer
    and are never model-editable. Non-mapping args are not managed targets.
    """
    if not isinstance(args, Mapping):
        return False
    name = args.get("name")
    if isinstance(name, str) and (
        name == "parilka-lessons" or name.startswith("parilka-skill-")
    ):
        return True
    category = args.get("category")
    return isinstance(category, str) and category == "parilka-managed"


# Sentinel returned when the current managed memory state cannot be
# inspected; the caller must fail closed for destructive operations.
_INSPECTION_FAILED = object()


def _managed_memory_entries() -> Any:
    """Current managed entries from the profile MEMORY.md, or the sentinel.

    Profile-scoped through the native ``tools.memory_tool`` (``get_memory_dir``
    + ``ENTRY_DELIMITER``) so the check sees the same store the native tool
    mutates. The file is opened and inspected through ONE descriptor:
    O_NOFOLLOW rejects symlinks at open time, fstat on the same descriptor
    rejects non-regular files, and the read/decode is fail-closed — only
    FileNotFoundError on open means an empty store, every other open/fstat/
    read/decode error is an inspection failure the caller must treat
    fail-closed for destructive operations. Path resolution is fail-closed
    too: any exception from ``get_memory_dir()`` or building the path, or a
    non-path-like result, is an inspection failure. Symlinks are never
    followed, so no lstat→read swap can redirect the check. Never logs or
    persists raw memory content.
    """
    try:
        from tools.memory_tool import ENTRY_DELIMITER, get_memory_dir
    except Exception:
        return _INSPECTION_FAILED
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        return _INSPECTION_FAILED  # platform cannot guarantee no-follow
    try:
        path = get_memory_dir() / "MEMORY.md"
    except Exception:
        return _INSPECTION_FAILED  # path resolution must never escape the hook
    if not isinstance(path, os.PathLike):
        return _INSPECTION_FAILED  # non-path-like result is not resolvable
    cloexec = getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, os.O_RDONLY | cloexec | nofollow)
    except FileNotFoundError:
        return []  # missing → no managed entries
    except OSError:
        return _INSPECTION_FAILED  # includes symlink and permission errors
    try:
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return _INSPECTION_FAILED  # unusual file type
            chunks: List[bytes] = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
        except OSError:
            return _INSPECTION_FAILED
        try:
            raw = b"".join(chunks).decode("utf-8")
        except UnicodeDecodeError:
            return _INSPECTION_FAILED
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return [e.strip() for e in raw.split(ENTRY_DELIMITER) if e]


def _memory_target(args: Any) -> str:
    """Native memory target resolution: 'memory' unless explicitly 'user'."""
    if isinstance(args, Mapping):
        target = args.get("target")
        if target == "user":
            return "user"
    return "memory"


def _targets_managed_memory(args: Any) -> bool:
    """True when a memory call can mutate a projection-owned managed entry.

    Target ``user`` is never affected. For target ``memory``:
      - ``add``/``replace`` whose stripped content starts with the
        future-proof ``[parilka:managed:`` prefix is always blocked — no
        inspection needed.
      - ``replace``/``remove`` (single shape or each batch operation) whose
        stripped ``old_text`` is a case-sensitive substring of any current
        managed entry in MEMORY.md is blocked — the same substring semantics
        as the native MemoryStore, so mid-entry needles match too. When the
        current entries cannot be inspected (symlink/unusual/unreadable
        file), the check fails closed for destructive replace/remove only;
        an ordinary add without the managed prefix passes. Malformed args
        (non-list operations, non-string fields) are left to native
        validation.
    """
    if not isinstance(args, Mapping):
        return False
    if _memory_target(args) != "memory":
        return False
    operations = args.get("operations")
    if operations:
        if not isinstance(operations, list):
            return False  # malformed batch — native validation rejects it
        ops = [op for op in operations if isinstance(op, Mapping)]
    else:
        ops = [args]

    managed: Optional[List[str]] = None
    for op in ops:
        action = op.get("action")
        content = op.get("content")
        if (
            action in ("add", "replace")
            and isinstance(content, str)
            and content.strip().startswith(MANAGED_MEMORY_PREFIX)
        ):
            return True
        if action not in ("replace", "remove"):
            continue
        if managed is None:
            entries = _managed_memory_entries()
            if entries is _INSPECTION_FAILED:
                return True  # fail closed: destructive op, state unknown
            managed = [
                e for e in entries if e.startswith(MANAGED_MEMORY_PREFIX)
            ]
        old_text = op.get("old_text")
        if not isinstance(old_text, str):
            continue  # malformed — native validation rejects it
        needle = old_text.strip()
        if not needle:
            continue  # native rejects empty old_text without matching
        if any(needle in entry for entry in managed):
            return True
    return False


def _make_pre_tool_call_hook(ctx: Any) -> Callable:
    """Return a pre_tool_call hook gating writes and local image reads.

    Native ``memory`` tool is write-only — all calls to tool name "memory"
    are writes (reads go through skills_list/skill_view separately).
    Native ``skill_manage`` is write-only — all calls are create/patch/edit/
    delete/write_file/remove_file.

    Allowed unconditionally:
      - Any tool other than ``memory``, ``skill_manage`` or
        ``image_generate``.
      - Text-to-image calls and image edits whose sources are HTTPS/data URIs
        or regular files inside the active profile's image cache.

    Allowed with a valid Parilka Telegram group session (captured profile and
    task-local session checked BEFORE any origin exception):
      - background_review origin (checked via tools.write_approval.current_origin()).

    Foreground: additionally requires sender id in comma-separated
    PARILKA_BOT_MEMORY_WRITE_SENDER_IDS.

    Never allowed — stable generic error, no paths/secrets:
      - image_generate with an HTTP URL, arbitrary local path, missing local
        file, or path/symlink escaping the profile image cache;
      - skill_manage targeting a managed projection entry (name
        parilka-lessons, prefix parilka-skill-*, category parilka-managed);
        the projection writes those files directly.
      - memory targeting a projection-owned entry: add/replace content with
        the [parilka:managed: prefix, or replace/remove whose old_text
        matches a current managed entry (fail-closed when MEMORY.md cannot
        be inspected); the projection writes those entries directly.
    """

    ctx_profile = getattr(ctx, "profile_name", "")

    def hook(**kwargs: Any) -> Optional[Dict[str, str]]:
        tool_name = str(kwargs.get("tool_name", ""))

        tool_args = kwargs.get("args")
        if not isinstance(tool_args, Mapping):
            tool_args = kwargs.get("tool_args")

        if tool_name == _IMAGE_TOOL_NAME:
            if _image_source_blocked(tool_args):
                return _write_blocked(IMAGE_SOURCE_ERROR)
            return None

        if tool_name not in _WRITE_TOOL_NAMES:
            return None

        # Captured profile AND task-local Telegram group session are required
        # before any origin exception: background_review is allowed only when
        # it comes from a valid Parilka group session.
        if ctx_profile != REQUIRED_PROFILE:
            return _write_blocked()

        try:
            env = _get_session_env()
            _assert_telegram_group(env)
        except ValueError:
            return _write_blocked()

        # Managed projection targets are never model-editable — not even via
        # background_review; the projection owns those files/entries.
        if tool_name == "skill_manage" and _targets_managed_skill(tool_args):
            return _write_blocked(MANAGED_SKILL_ERROR)
        if tool_name == "memory" and _targets_managed_memory(tool_args):
            return _write_blocked(MANAGED_MEMORY_ERROR)

        # Check origin via the real Hermes API (never trust tool args)
        try:
            from tools.write_approval import current_origin

            origin = current_origin()
        except ImportError:
            origin = "foreground"

        if origin == "background_review":
            return None

        user_id = env.get("user_id", "")
        allowed = _env_csv("PARILKA_BOT_MEMORY_WRITE_SENDER_IDS")

        if not allowed:
            return {
                "action": "block",
                "message": (
                    "Запись в память/навыки запрещена: список авторизованных "
                    "отправителей не настроен."
                ),
            }
        if user_id not in allowed:
            return {
                "action": "block",
                "message": (
                    "Запись в память/навыки разрешена только авторизованным "
                    "участникам."
                ),
            }
        return None

    return hook


# ── plugin entry point ──────────────────────────────────────────────────────


def register(ctx: Any) -> None:
    """Register parilka-chat tools and hooks with the Hermes plugin context.

    Captures ctx in handler/hook closures so each tool dispatch routes through
    the public ctx.dispatch_tool API. No private registry imports.
    """
    # Exact profile required — an empty or mismatched profile never registers.
    if getattr(ctx, "profile_name", None) != REQUIRED_PROFILE:
        logger.warning(
            "parilka-chat: skipping registration outside profile %s",
            REQUIRED_PROFILE,
        )
        return

    for name in TOOL_NAMES:
        schema = TOOL_SCHEMAS.get(name)
        if schema is None:
            logger.warning("parilka-chat: no schema for tool %r", name)
            continue
        ctx.register_tool(
            name=name,
            toolset="parilka_chat",
            schema=schema,
            handler=_make_tool_handler(name, ctx),
        )
        logger.info("parilka-chat: registered tool %s", name)

    ctx.register_hook("pre_llm_call", _make_pre_llm_call_hook(ctx))
    ctx.register_hook("pre_tool_call", _make_pre_tool_call_hook(ctx))
    _register_runtime_hooks(
        ctx,
        get_session_env=_get_session_env,
        assert_telegram_group=_assert_telegram_group,
    )
    logger.info("parilka-chat: hooks registered")
