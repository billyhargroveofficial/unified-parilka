import type { StoredMessage } from "../../store.js";
import type {
  TelegramImageReference,
  TelegramImageSource,
  TelegramImageTarget,
} from "./contracts.js";

const MAX_RAW_MESSAGE_CHARS = 2_000_000;
const MAX_FILE_ID_CHARS = 512;

type JsonObject = Record<string, unknown>;

/**
 * Parses only image-capable Bot API message shapes. This is intentionally
 * transport-private: no file id or download path is rendered into model text.
 */
export function parseStoredTelegramImage(
  message: Pick<StoredMessage, "rawJson">,
): TelegramImageReference | undefined {
  return parseImageMessage(parseRawMessage(message.rawJson));
}

/**
 * Selects an image from the addressed message, then exactly one direct reply.
 * An embedded reply is used only to cover Bot API privacy-mode delivery; it
 * never creates arbitrary chat-history access.
 */
export function selectTelegramImageTarget(
  trigger: StoredMessage,
  replyTarget?: StoredMessage,
): TelegramImageTarget | undefined {
  const triggerImage = parseStoredTelegramImage(trigger);
  if (triggerImage) return { ...triggerImage, source: "trigger", message: trigger };

  if (replyTarget) {
    const replyImage = parseStoredTelegramImage(replyTarget);
    if (replyImage) return { ...replyImage, source: "reply", message: replyTarget };
  }

  const embedded = embeddedReplyTarget(trigger);
  const replyImage = embedded && parseStoredTelegramImage(embedded);
  return replyImage && embedded
    ? { ...replyImage, source: "reply", message: embedded }
    : undefined;
}

function parseImageMessage(value: JsonObject | undefined): TelegramImageReference | undefined {
  return parsePhoto(value) ?? parseDocument(value);
}

function parsePhoto(value: JsonObject | undefined): TelegramImageReference | undefined {
  if (!Array.isArray(value?.photo)) return undefined;
  let selected: JsonObject | undefined;
  let selectedArea = -1;
  for (const candidate of value.photo) {
    const photo = asObject(candidate);
    if (!photo || !fileId(photo.file_id)) continue;
    const width = nonNegativeInteger(photo.width);
    const height = nonNegativeInteger(photo.height);
    const area = (width ?? 0) * (height ?? 0);
    if (selected === undefined || area > selectedArea) {
      selected = photo;
      selectedArea = area;
    }
  }
  if (!selected) return undefined;
  return referenceFromFile("photo", selected, "image/jpeg");
}

function parseDocument(value: JsonObject | undefined): TelegramImageReference | undefined {
  const document = asObject(value?.document);
  if (!document || !fileId(document.file_id)) return undefined;
  const mimeType = supportedImageMime(document.mime_type);
  return mimeType === undefined ? undefined : referenceFromFile("document", document, mimeType);
}

function referenceFromFile(
  kind: TelegramImageReference["kind"],
  file: JsonObject,
  mediaType: TelegramImageReference["mediaType"],
): TelegramImageReference {
  const id = fileId(file.file_id);
  if (!id) throw new TypeError("validated file id is required");
  const fileSize = nonNegativeInteger(file.file_size);
  const width = nonNegativeInteger(file.width);
  const height = nonNegativeInteger(file.height);
  return {
    kind,
    fileId: id,
    mediaType,
    ...(fileSize === undefined ? {} : { fileSize }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function embeddedReplyTarget(trigger: StoredMessage): StoredMessage | undefined {
  const root = parseRawMessage(trigger.rawJson);
  const reply = asObject(root?.reply_to_message);
  if (!reply) return undefined;
  const messageId = positiveInteger(reply.message_id);
  const replyChatId = telegramId(asObject(reply.chat)?.id);
  if (messageId === undefined || replyChatId !== trigger.chatId) return undefined;
  const rawJson = boundedJson(reply);
  if (rawJson === undefined) return undefined;
  return {
    chatId: trigger.chatId,
    messageId,
    text: messageText(reply),
    ...(botApiDate(reply.date) === undefined ? {} : { date: botApiDate(reply.date) }),
    ...(telegramId(asObject(reply.from)?.id) === undefined ? {} : { senderId: telegramId(asObject(reply.from)?.id) }),
    ...(displayName(asObject(reply.from)) === undefined ? {} : { senderName: displayName(asObject(reply.from)) }),
    rawJson,
  };
}

function parseRawMessage(raw: unknown): JsonObject | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_MESSAGE_CHARS) return undefined;
  try { return asObject(JSON.parse(raw)); } catch { return undefined; }
}

function supportedImageMime(value: unknown): TelegramImageReference["mediaType"] | undefined {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "image/jpeg": return "image/jpeg";
    case "image/png": return "image/png";
    case "image/webp": return "image/webp";
    case "image/gif": return "image/gif";
    default: return undefined;
  }
}

function fileId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FILE_ID_CHARS && /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = nonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function telegramId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : undefined;
  return typeof value === "string" && /^-?\d+$/u.test(value)
    ? value.replace(/^-?0+(?=\d)/u, (zeroes) => zeroes.startsWith("-") ? "-" : "")
    : undefined;
}

function boundedJson(value: unknown): string | undefined {
  try {
    const result = JSON.stringify(value);
    return result.length <= MAX_RAW_MESSAGE_CHARS ? result : undefined;
  } catch { return undefined; }
}

function messageText(value: JsonObject): string {
  const text = typeof value.text === "string" ? value.text : typeof value.caption === "string" ? value.caption : "";
  return text.length <= 16_384 ? text : text.slice(0, 16_384);
}

function botApiDate(value: unknown): string | undefined {
  const seconds = nonNegativeInteger(value);
  if (seconds === undefined) return undefined;
  try { return new Date(seconds * 1_000).toISOString(); } catch { return undefined; }
}

function displayName(value: JsonObject | undefined): string | undefined {
  for (const candidate of [value?.username, value?.first_name]) {
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256) return candidate;
  }
  return undefined;
}
