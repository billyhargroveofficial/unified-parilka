"""Telegram runtime policy, footer and vision hooks for the parilka profile.

Native Hermes ``display.runtime_footer`` stays disabled (it shows %, not our
format); this module appends the exact footer for tracked group turns and
caps vision analysis to 6 images per Telegram agent turn (attachment cap
ledger + pre_llm budget bridge + pre_tool_call gate). A strict group gate
additionally requires a literal ``@botusername`` mention: replying to the bot
or matching a wake-word pattern alone cannot dispatch an agent. All tracking
state is thread-safe, bounded (TTL + max entries) and free of raw message data.

Registered by :func:`register` on top of the existing parilka_chat hooks.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional

PARILKA_PROFILE = "parilka"
CHAT_ID_ENV = "PARILKA_TELEGRAM_CHAT_ID"

# This is a profile plugin, whose fallback must match the configured Codex
# catalog when Hermes metadata is temporarily unavailable (for example during
# boot). The resolver below still replaces it for a selected different model.
FOOTER_DEFAULT_MAX_TOKENS = 272000
VISION_MAX_IMAGES = 6
VISION_TOOL_NAME = "vision_analyze"
_VISION_BLOCK_MESSAGE = "Лимит анализа изображений: максимум 6 за один ход."
_STRICT_MENTION_SKIP_REASON = "explicit-telegram-at-mention-required"

# Bounded per-session tracking: stale entries are pruned by TTL, the oldest
# entries are evicted beyond the cap. Only metadata is stored — never text.
_STATE_TTL_SECONDS = 3600.0
_STATE_MAX_ENTRIES = 128
_VISION_TTL_SECONDS = 3600.0
_VISION_MAX_ENTRIES = 128

_lock = threading.Lock()
_state: Dict[str, Dict[str, Any]] = {}
# Pending kept-image counts from the pre_gateway cap, keyed
# "chat_id:message_id" — metadata only, consumed by the pre_llm bridge.
_vision_ledger: Dict[str, Dict[str, Any]] = {}
# Per-turn vision budgets keyed "session_id:turn_id" (fallback sequence when
# turn_id is missing) — metadata only.
_vision_budget: Dict[str, Dict[str, Any]] = {}
# Per-session fallback turn sequence when turn_id is missing.
_turn_seq: Dict[str, Dict[str, Any]] = {}


def _prune_store(store: Dict[str, Dict[str, Any]], now: float) -> None:
    """Drop stale entries (TTL) and evict the oldest beyond the cap."""
    stale = [
        key
        for key, entry in store.items()
        if now - entry["ts"] > _VISION_TTL_SECONDS
    ]
    for key in stale:
        store.pop(key, None)
    overflow = len(store) - _VISION_MAX_ENTRIES
    if overflow > 0:
        oldest = sorted(store.items(), key=lambda item: item[1]["ts"])[:overflow]
        for key, _ in oldest:
            store.pop(key, None)


def _valid_message_id(value: Any) -> Optional[int]:
    """Positive int (or digit string) within the Telegram safe id range."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        msg_id = value
    elif isinstance(value, str) and value.strip():
        try:
            msg_id = int(value.strip())
        except (TypeError, ValueError):
            return None
    else:
        return None
    if msg_id < 1 or msg_id > 9007199254740991:
        return None
    return msg_id


def _turn_key(session_id: Any, turn_id: Any, now: float, *, allocate: bool) -> str:
    """Budget key: session_id+turn_id when present, else a per-session
    monotonic fallback sequence so distinct turns never share a budget."""
    session = str(session_id)
    if turn_id is not None and str(turn_id):
        return f"{session}:{turn_id}"
    entry = _turn_seq.get(session)
    seq = entry["n"] if entry is not None else 0
    if allocate:
        _turn_seq[session] = {"n": seq + 1, "ts": now}
        return f"{session}:fb:{seq + 1}"
    return f"{session}:fb:{seq}"


def _compact_tokens(count: int) -> str:
    """Compact a token count: 38100 -> 38.1k, 1048576 -> 1.0m."""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}m"
    if count >= 1_000:
        return f"{count / 1_000:.1f}k"
    return str(count)


def _format_elapsed(seconds: float) -> str:
    """Elapsed wall time: 30 -> "30с", 63 -> "1м 3с"."""
    total = int(seconds)
    minutes, secs = divmod(total, 60)
    if minutes:
        return f"{minutes}м {secs}с"
    return f"{secs}с"


def _bare_model(model: Any) -> str:
    """Strip any provider prefix: "provider/model" -> "model"."""
    return str(model).rsplit("/", 1)[-1]


def _resolve_model_context_length(model: str, provider: str, base_url: str) -> int:
    """Resolve the acting model's real provider-scoped context window.

    Hermes already owns the authoritative resolver used by its compressor.
    Reuse it here instead of maintaining a second model table in the Parilka
    plugin.  Imports are lazy so a footer failure can never prevent plugin
    registration or gateway startup.
    """
    try:
        from agent.model_metadata import get_model_context_length
        from hermes_cli.config import (
            get_compatible_custom_providers,
            load_config_readonly,
        )

        config = load_config_readonly()
        model_config = config.get("model")
        configured_context = (
            model_config.get("context_length")
            if isinstance(model_config, Mapping)
            else None
        )
        if (
            not isinstance(configured_context, int)
            or isinstance(configured_context, bool)
            or configured_context <= 0
        ):
            configured_context = None
        resolved = get_model_context_length(
            model,
            base_url=base_url,
            config_context_length=configured_context,
            provider=provider,
            custom_providers=get_compatible_custom_providers(config),
        )
        if isinstance(resolved, int) and not isinstance(resolved, bool) and resolved > 0:
            return resolved
    except Exception:
        pass
    return FOOTER_DEFAULT_MAX_TOKENS


def _footer(
    model: Any,
    used: int,
    max_tokens: int,
    tool_calls: int,
    elapsed: float,
) -> str:
    if (
        not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or max_tokens <= 0
    ):
        max_tokens = FOOTER_DEFAULT_MAX_TOKENS
    return (
        f"{_bare_model(model)} 🧠 · "
        f"{_compact_tokens(used)}/{_compact_tokens(max_tokens)} · "
        f"{tool_calls} tool calls · {_format_elapsed(elapsed)}"
    )


class FooterTracker:
    """Per-session footer tracking for valid Parilka Telegram group turns.

    pre_llm_call starts (and resets) tracking, post_api_request records the
    LATEST ``prompt_tokens`` only, post_tool_call counts every emitted call,
    transform_llm_output appends the exact footer and pops the state.
    """

    def __init__(
        self,
        profile: str,
        get_session_env: Callable[[], Dict[str, str]],
        assert_telegram_group: Callable[[Dict[str, str]], int],
        clock: Callable[[], float] = time.monotonic,
        resolve_context_length: Callable[[str, str, str], int] = (
            _resolve_model_context_length
        ),
    ) -> None:
        self._profile = profile
        self._get_session_env = get_session_env
        self._assert_telegram_group = assert_telegram_group
        self._clock = clock
        self._resolve_context_length = resolve_context_length

    def _valid_session(self, session_id: Any) -> bool:
        if self._profile != PARILKA_PROFILE or session_id is None:
            return False
        try:
            env = self._get_session_env()
            self._assert_telegram_group(env)
        except Exception:
            return False
        return True

    def _prune(self, now: float) -> None:
        stale = [
            sid
            for sid, entry in _state.items()
            if now - entry["start"] > _STATE_TTL_SECONDS
        ]
        for sid in stale:
            _state.pop(sid, None)
        overflow = len(_state) - _STATE_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(_state.items(), key=lambda item: item[1]["start"])[
                :overflow
            ]
            for sid, _ in oldest:
                _state.pop(sid, None)

    def pre_llm_call(self, **kwargs: Any) -> None:
        """Reset per-session tracking when a valid Telegram group turn starts."""
        session_id = kwargs.get("session_id")
        if not self._valid_session(session_id):
            return
        now = self._clock()
        with _lock:
            _state[session_id] = {
                "start": now,
                "used": 0,
                "tool_calls": 0,
                "model": str(kwargs.get("model") or ""),
                "context_length": FOOTER_DEFAULT_MAX_TOKENS,
                "context_signature": None,
            }
            self._prune(now)

    def post_api_request(self, **kwargs: Any) -> None:
        """Record the LATEST prompt_tokens only — never a sum or accumulation.

        ``prompt_tokens`` already includes cache exactly once; input/cache/
        output are not combined and API calls are not accumulated.
        """
        session_id = kwargs.get("session_id")
        usage = kwargs.get("usage")
        prompt_tokens = (
            usage.get("prompt_tokens") if isinstance(usage, Mapping) else None
        )
        # Canonical prompt_tokens is a nonnegative int — bool is not a token
        # count and negatives are invalid.
        valid_prompt_tokens = (
            isinstance(prompt_tokens, int)
            and not isinstance(prompt_tokens, bool)
            and prompt_tokens >= 0
        )
        model = str(kwargs.get("model") or "")
        provider = str(kwargs.get("provider") or "")
        base_url = str(kwargs.get("base_url") or "")
        signature = (model, provider, base_url)
        should_resolve = False
        with _lock:
            entry = _state.get(session_id)
            if entry is not None:
                if valid_prompt_tokens:
                    entry["used"] = prompt_tokens
                if model and entry["context_signature"] != signature:
                    entry["model"] = model
                    entry["context_signature"] = signature
                    entry["context_length"] = FOOTER_DEFAULT_MAX_TOKENS
                    should_resolve = True

        # Model metadata resolution can consult a provider cache or endpoint;
        # never hold the shared tracker lock while doing that work. Marking the
        # signature before resolving also deduplicates repeated API calls in a
        # single long tool loop.
        if should_resolve:
            try:
                resolved = self._resolve_context_length(model, provider, base_url)
            except Exception:
                resolved = FOOTER_DEFAULT_MAX_TOKENS
            if (
                not isinstance(resolved, int)
                or isinstance(resolved, bool)
                or resolved <= 0
            ):
                resolved = FOOTER_DEFAULT_MAX_TOKENS
            with _lock:
                entry = _state.get(session_id)
                if entry is not None and entry["context_signature"] == signature:
                    entry["context_length"] = resolved

    def post_tool_call(self, **kwargs: Any) -> None:
        """Count every emitted tool call, including blocked/error ones."""
        session_id = kwargs.get("session_id")
        with _lock:
            entry = _state.get(session_id)
            if entry is not None:
                entry["tool_calls"] += 1

    def transform_llm_output(self, **kwargs: Any) -> Any:
        """Append the exact footer to tracked Telegram turns, then pop state."""
        session_id = kwargs.get("session_id")
        response_text = kwargs.get("response_text")
        if session_id is None or not isinstance(response_text, str):
            return response_text
        with _lock:
            entry = _state.pop(session_id, None)
        if entry is None:
            return response_text
        elapsed = self._clock() - entry["start"]
        footer = _footer(
            entry.get("model") or kwargs.get("model", ""),
            entry["used"],
            entry["context_length"],
            entry["tool_calls"],
            elapsed,
        )
        return f"{response_text}\n\n{footer}"


def make_strict_telegram_mention_gate(
    profile: str,
    env_getter: Callable[[str], Optional[str]] = os.environ.get,
    chat_id_env: str = CHAT_ID_ENV,
) -> Callable[..., Optional[Dict[str, str]]]:
    """Require an explicit ``@botusername`` in the configured group.

    Native Hermes ``telegram.require_mention`` deliberately treats a reply to
    the bot as a trigger. Parilka's group policy is narrower: replies remain
    ordinary chat context and only a Telegram username mention containing the
    literal ``@`` wakes the agent. Telegram strips the addressed bot handle
    from ``event.text`` before gateway plugins run, so inspect the original
    Telegram text/caption only after proving that its message id is the id of
    this exact ``MessageEvent``. That identity check prevents a stale/merged
    raw object from authorizing a later reply or sticker. The live adapter is
    still the authority for the current BotFather username, so renames are
    followed automatically.

    The target group fails closed when the live adapter or current raw Telegram
    payload cannot be proved and inspected. Other profiles, platforms, chats
    and DMs are no-ops.
    """
    allowed_chat_id = (env_getter(chat_id_env) or "").strip()

    def pre_gateway_dispatch(
        event: Any, gateway: Any = None, **kwargs: Any
    ) -> Optional[Dict[str, str]]:
        if profile != PARILKA_PROFILE or not allowed_chat_id:
            return None
        source = getattr(event, "source", None)
        if source is None:
            return None
        source_platform = getattr(source, "platform", None)
        platform_name = getattr(source_platform, "value", source_platform)
        if platform_name != "telegram":
            return None
        if str(getattr(source, "chat_id", "")) != allowed_chat_id:
            return None
        if getattr(source, "chat_type", None) != "group":
            return None

        denied = {
            "action": "skip",
            "reason": _STRICT_MENTION_SKIP_REASON,
        }
        try:
            adapters = getattr(gateway, "adapters", None)
            if not isinstance(adapters, Mapping):
                return denied
            adapter = adapters.get(source_platform)
            if adapter is None:
                adapter = adapters.get("telegram")
            if adapter is None:
                for key, candidate in adapters.items():
                    if getattr(key, "value", key) == "telegram":
                        adapter = candidate
                        break
            if adapter is None:
                return denied

            current_username = getattr(adapter, "_current_bot_username", None)
            if not callable(current_username):
                return denied

            username = str(current_username() or "").lstrip("@").lower()
            if not username:
                return denied

            raw_message = getattr(event, "raw_message", None)
            event_message_id = _valid_message_id(getattr(event, "message_id", None))
            raw_message_id = _valid_message_id(
                getattr(raw_message, "message_id", None)
            )
            if (
                raw_message is None
                or event_message_id is None
                or raw_message_id != event_message_id
            ):
                return denied

            # Username characters are ASCII by Telegram contract. Boundaries
            # prevent foo@bot.example / @bot_suffix substring matches while
            # still accepting /command@bot and a normal standalone mention.
            current_sources = (
                getattr(raw_message, "text", None),
                getattr(raw_message, "caption", None),
            )
            standalone_mention = re.compile(
                rf"(?<![A-Za-z0-9_])@{re.escape(username)}(?![A-Za-z0-9_])",
                re.IGNORECASE,
            )
            command_mention = re.compile(
                rf"(?:^|\s)/[A-Za-z0-9_]+@{re.escape(username)}"
                rf"(?![A-Za-z0-9_])",
                re.IGNORECASE,
            )
            for current_text in current_sources:
                if not isinstance(current_text, str):
                    continue
                if standalone_mention.search(
                    current_text
                ) or command_mention.search(current_text):
                    return None
        except Exception:
            return denied
        return denied

    return pre_gateway_dispatch


def make_vision_cap(
    profile: str,
    env_getter: Callable[[str], Optional[str]] = os.environ.get,
    chat_id_env: str = CHAT_ID_ENV,
    clock: Callable[[], float] = time.monotonic,
) -> Callable[[Any], Optional[Dict[str, str]]]:
    """Factory for the pre_gateway_dispatch vision cap with captured profile.

    Keeps the first VISION_MAX_IMAGES image attachments of a single merged
    Telegram MessageEvent (source platform telegram — the Platform enum is
    normalized to its value — exact allowed chat id, chat_type group),
    preserving order and every non-image attachment. When images are dropped
    the hook returns the gateway rewrite shape ``{"action": "rewrite",
    "text": ...}`` — the original text plus a short system note (no media
    paths). At or below the cap it returns None without touching the event.

    The kept image count (even when nothing was dropped) is recorded into
    the bounded ``_vision_ledger`` under the allowed chat id + message id
    key — metadata only, no texts, URLs or paths; invalid or missing
    message ids are not recorded.

    The cap limits vision ANALYSIS only: the Telegram adapter download has
    already happened by pre_gateway_dispatch time.
    """
    allowed_chat_id = (env_getter(chat_id_env) or "").strip()

    def pre_gateway_dispatch(
        event: Any, **kwargs: Any
    ) -> Optional[Dict[str, str]]:
        if profile != PARILKA_PROFILE or not allowed_chat_id:
            return None
        source = getattr(event, "source", None)
        if source is None:
            return None
        # SessionSource.platform is the Platform enum (value "telegram"), not
        # a raw string — normalize so both the enum and plain stubs match.
        platform = getattr(source, "platform", None)
        platform = getattr(platform, "value", platform)
        if platform != "telegram":
            return None
        if str(getattr(source, "chat_id", "")) != allowed_chat_id:
            return None
        if getattr(source, "chat_type", None) != "group":
            return None

        urls = getattr(event, "media_urls", None)
        types = getattr(event, "media_types", None)
        if (
            not isinstance(urls, list)
            or not isinstance(types, list)
            or len(urls) != len(types)
        ):
            return None

        message_type = getattr(getattr(event, "message_type", None), "value", None)

        def _is_image(mime: Any) -> bool:
            if isinstance(mime, str) and mime:
                return mime.startswith("image/")
            return message_type == "photo"

        kept_urls: list = []
        kept_types: list = []
        images_total = 0
        images_kept = 0
        for url, mime in zip(urls, types):
            if _is_image(mime):
                images_total += 1
                if images_kept >= VISION_MAX_IMAGES:
                    continue
                images_kept += 1
            kept_urls.append(url)
            kept_types.append(mime)

        if images_total > 0:
            msg_id = _valid_message_id(getattr(event, "message_id", None))
            if msg_id is not None:
                now = clock()
                with _lock:
                    _vision_ledger[f"{allowed_chat_id}:{msg_id}"] = {
                        "count": images_kept,
                        "ts": now,
                    }
                    _prune_store(_vision_ledger, now)

        if images_kept == images_total:
            return None

        event.media_urls = kept_urls
        event.media_types = kept_types
        original = event.text if isinstance(event.text, str) else ""
        note = (
            f"\n\n[система: для анализа взято {images_kept} "
            f"из {images_total} изображений]"
        )
        return {"action": "rewrite", "text": f"{original}{note}"}

    return pre_gateway_dispatch


def make_vision_budget_bridge(
    profile: str,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    clock: Callable[[], float] = time.monotonic,
) -> Callable[..., None]:
    """Factory for the pre_llm vision budget bridge with captured context.

    For a valid Parilka Telegram group turn, atomically moves the pending
    kept-image count recorded by the pre_gateway_dispatch cap for the
    message that started this turn into a fresh budget for the current
    session/turn; a turn without pending attachments starts at zero. Foreign
    profiles and invalid sessions are a no-op.
    """

    def pre_llm_call(**kwargs: Any) -> None:
        session_id = kwargs.get("session_id")
        if profile != PARILKA_PROFILE or session_id is None:
            return
        try:
            env = get_session_env()
            message_id = assert_telegram_group(env)
        except Exception:
            return
        now = clock()
        with _lock:
            pending = _vision_ledger.pop(
                f"{env.get('chat_id', '')}:{message_id}", None
            )
            turn_key = _turn_key(
                session_id, kwargs.get("turn_id"), now, allocate=True
            )
            _vision_budget[turn_key] = {
                "attach": pending["count"] if pending else 0,
                "used": 0,
                "ts": now,
            }
            _prune_store(_vision_ledger, now)
            _prune_store(_vision_budget, now)
            _prune_store(_turn_seq, now)

    return pre_llm_call


def make_vision_budget_gate(
    profile: str,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    clock: Callable[[], float] = time.monotonic,
) -> Callable[..., Optional[Dict[str, str]]]:
    """Factory for the pre_tool_call vision budget gate with captured context.

    Handles only ``vision_analyze``. For a valid Parilka Telegram group
    session the gate allows attempts atomically while attachments + allowed
    calls stay below VISION_MAX_IMAGES; every allowed attempt counts even if
    the tool later fails. The next attempts are blocked with a stable short
    Russian message (no data or paths). Other tools and foreign
    profiles/sessions are a no-op.
    """

    def pre_tool_call(**kwargs: Any) -> Optional[Dict[str, str]]:
        if str(kwargs.get("tool_name", "")) != VISION_TOOL_NAME:
            return None
        session_id = kwargs.get("session_id")
        if profile != PARILKA_PROFILE or session_id is None:
            return None
        try:
            env = get_session_env()
            assert_telegram_group(env)
        except Exception:
            return None
        now = clock()
        with _lock:
            turn_key = _turn_key(
                session_id, kwargs.get("turn_id"), now, allocate=False
            )
            entry = _vision_budget.get(turn_key)
            if entry is None:
                entry = {"attach": 0, "used": 0, "ts": now}
                _vision_budget[turn_key] = entry
                _prune_store(_vision_budget, now)
            if entry["attach"] + entry["used"] >= VISION_MAX_IMAGES:
                return {"action": "block", "message": _VISION_BLOCK_MESSAGE}
            entry["used"] += 1
            return None

    return pre_tool_call


def register(
    ctx: Any,
    *,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    env_getter: Callable[[str], Optional[str]] = os.environ.get,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Register strict mention, footer, vision cap and vision budget hooks."""
    profile = getattr(ctx, "profile_name", None)
    tracker = FooterTracker(profile, get_session_env, assert_telegram_group, clock)
    ctx.register_hook("pre_llm_call", tracker.pre_llm_call)
    ctx.register_hook(
        "pre_llm_call",
        make_vision_budget_bridge(
            profile, get_session_env, assert_telegram_group, clock
        ),
    )
    ctx.register_hook("post_api_request", tracker.post_api_request)
    ctx.register_hook("post_tool_call", tracker.post_tool_call)
    ctx.register_hook("transform_llm_output", tracker.transform_llm_output)
    ctx.register_hook(
        "pre_gateway_dispatch",
        make_strict_telegram_mention_gate(profile, env_getter),
    )
    ctx.register_hook(
        "pre_gateway_dispatch", make_vision_cap(profile, env_getter, clock=clock)
    )
    ctx.register_hook(
        "pre_tool_call",
        make_vision_budget_gate(
            profile, get_session_env, assert_telegram_group, clock
        ),
    )
