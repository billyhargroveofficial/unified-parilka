import type { StoredMessage } from "../../store.js";
import type {
  SelectedTelegramMedia,
  TelegramMediaTarget,
  TelegramMediaKind,
  TelegramMediaReference,
  TelegramMediaSource,
} from "./contracts.js";

const MAX_RAW_MESSAGE_CHARS = 2_000_000;
const MAX_FILE_ID_CHARS = 512;

type JsonObject = Record<string, unknown>;

/**
 * Extracts a download reference from the raw Bot API message kept in the
 * durable store. Invalid, old MTProto, and unexpected payloads simply have no
 * downloadable media. This parser never throws and does not expose raw JSON.
 */
export function parseStoredTelegramMedia(
  message: Pick<StoredMessage, "rawJson">,
): TelegramMediaReference | undefined {
  const raw = message.rawJson;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_MESSAGE_CHARS) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const value = asObject(parsed);
  if (!value) {
    return undefined;
  }

  return parsePhoto(value)
    ?? parseSingleFile(value, "voice")
    ?? parseSingleFile(value, "video_note")
    ?? parseSingleFile(value, "audio");
}

/**
 * Picks media only from the addressed message or the one message it directly
 * replies to. This prevents a tool from turning arbitrary chat history into a
 * media extraction interface.
 */
export function selectTargetedTelegramMedia(input: {
  trigger: Pick<StoredMessage, "messageId" | "rawJson">;
  reply?: Pick<StoredMessage, "messageId" | "rawJson">;
  source?: TelegramMediaSource;
  kinds?: readonly TelegramMediaKind[];
}): SelectedTelegramMedia | undefined {
  const candidates: Array<{
    source: TelegramMediaSource;
    message: Pick<StoredMessage, "messageId" | "rawJson"> | undefined;
  }> = input.source === "trigger"
    ? [{ source: "trigger", message: input.trigger }]
    : input.source === "reply"
      ? [{ source: "reply", message: input.reply }]
      : [
          { source: "trigger", message: input.trigger },
          { source: "reply", message: input.reply },
        ];

  for (const candidate of candidates) {
    if (!candidate.message) {
      continue;
    }
    const media = parseStoredTelegramMedia(candidate.message);
    if (!media || (input.kinds && !input.kinds.includes(media.kind))) {
      continue;
    }
    return {
      source: candidate.source,
      messageId: candidate.message.messageId,
      media,
    };
  }
  return undefined;
}

/**
 * Convenience form for bot turns: only the addressed message and its direct
 * reply target are eligible. The returned stored message lets the caller
 * retain attribution without giving a model arbitrary message lookup.
 */
export function selectTelegramMediaTarget(
  trigger: StoredMessage,
  replyTarget?: StoredMessage,
  kinds?: readonly TelegramMediaKind[],
): TelegramMediaTarget | undefined {
  const direct = selectedTarget(
    trigger,
    replyTarget,
    kinds,
  );
  if (direct) {
    return direct;
  }

  // Privacy-mode bots commonly receive the addressed reply but not the
  // original unmentioned voice/photo as a standalone update. Bot API embeds
  // precisely that direct reply in the addressed message, so recover it from
  // the already-persisted payload. It is still one-hop, same-chat media --
  // never arbitrary history selected by a model or by a user-supplied ID.
  const embeddedReply = embeddedReplyTarget(trigger);
  return embeddedReply === undefined
    ? undefined
    : selectedTarget(trigger, embeddedReply, kinds, true);
}

function selectedTarget(
  trigger: StoredMessage,
  replyTarget: StoredMessage | undefined,
  kinds: readonly TelegramMediaKind[] | undefined,
  skipTrigger = false,
): TelegramMediaTarget | undefined {
  const selected = selectTargetedTelegramMedia({
    trigger,
    reply: replyTarget,
    ...(skipTrigger ? { source: "reply" as const } : {}),
    ...(kinds === undefined ? {} : { kinds }),
  });
  if (!selected) {
    return undefined;
  }
  const message = selected.source === "trigger" ? trigger : replyTarget;
  return message === undefined
    ? undefined
    : { ...selected.media, source: selected.source, message };
}

/**
 * Reconstructs only the one direct `reply_to_message` carried by a Bot API
 * update. This is intentionally separate from normal history lookup: it
 * covers privacy-mode delivery without opening a path to arbitrary message
 * IDs or cross-chat media.
 */
function embeddedReplyTarget(trigger: StoredMessage): StoredMessage | undefined {
  const root = parseRawMessage(trigger.rawJson);
  const reply = asObject(root?.reply_to_message);
  if (!reply) {
    return undefined;
  }
  const messageId = positiveInteger(reply.message_id);
  const chat = asObject(reply.chat);
  const chatId = telegramId(chat?.id);
  if (messageId === undefined || chatId !== trigger.chatId) {
    return undefined;
  }
  const rawJson = boundedJson(reply);
  if (rawJson === undefined) {
    return undefined;
  }
  const from = asObject(reply.from);
  const date = botApiDate(reply.date);
  const senderId = telegramId(from?.id);
  const senderName = displayName(from);
  return {
    chatId,
    messageId,
    ...(date === undefined ? {} : { date }),
    ...(senderId === undefined ? {} : { senderId }),
    ...(senderName === undefined ? {} : { senderName }),
    text: messageText(reply),
    rawJson,
  };
}

function parsePhoto(value: JsonObject): TelegramMediaReference | undefined {
  if (!Array.isArray(value.photo)) {
    return undefined;
  }
  let selected: JsonObject | undefined;
  let selectedArea = -1;
  for (const item of value.photo) {
    const photo = asObject(item);
    if (!photo || !fileId(photo.file_id)) {
      continue;
    }
    const width = nonNegativeInteger(photo.width);
    const height = nonNegativeInteger(photo.height);
    const area = (width ?? 0) * (height ?? 0);
    if (!selected || area > selectedArea) {
      selected = photo;
      selectedArea = area;
    }
  }
  return selected ? referenceFromFile("photo", selected) : undefined;
}

function parseSingleFile(
  value: JsonObject,
  kind: Exclude<TelegramMediaKind, "photo">,
): TelegramMediaReference | undefined {
  const file = asObject(value[kind]);
  return file && fileId(file.file_id) ? referenceFromFile(kind, file) : undefined;
}

function referenceFromFile(
  kind: TelegramMediaKind,
  file: JsonObject,
): TelegramMediaReference {
  const fileIdValue = fileId(file.file_id);
  if (!fileIdValue) {
    throw new TypeError("A validated Telegram file id is required.");
  }
  const fileSize = nonNegativeInteger(file.file_size);
  const durationSeconds = nonNegativeInteger(file.duration);
  const width = nonNegativeInteger(file.width);
  const height = nonNegativeInteger(file.height);
  const mimeType = boundedString(file.mime_type, 128);
  return {
    kind,
    fileId: fileIdValue,
    mediaType: mimeType ?? defaultMediaType(kind),
    ...(fileSize === undefined ? {} : { fileSize }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function defaultMediaType(kind: TelegramMediaKind): string {
  switch (kind) {
    case "photo":
      return "image/jpeg";
    case "voice":
      return "audio/ogg";
    case "video_note":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parseRawMessage(raw: unknown): JsonObject | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_MESSAGE_CHARS) {
    return undefined;
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function boundedJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json.length <= MAX_RAW_MESSAGE_CHARS ? json : undefined;
  } catch {
    return undefined;
  }
}

function fileId(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_FILE_ID_CHARS
    && /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const integer = nonNegativeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function telegramId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  return typeof value === "string" && /^-?\d+$/u.test(value)
    ? value.replace(/^-?0+(?=\d)/u, (zeroes) => zeroes.startsWith("-") ? "-" : "")
    : undefined;
}

function botApiDate(value: unknown): string | undefined {
  const seconds = nonNegativeInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const timestamp = seconds * 1_000;
  if (!Number.isSafeInteger(timestamp)) {
    return undefined;
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function displayName(value: JsonObject | undefined): string | undefined {
  const candidates = [value?.username, value?.first_name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256) {
      return candidate;
    }
  }
  return undefined;
}

function messageText(value: JsonObject): string {
  const text = typeof value.text === "string"
    ? value.text
    : typeof value.caption === "string"
      ? value.caption
      : "";
  return text.length <= 16_384 ? text : text.slice(0, 16_384);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}
