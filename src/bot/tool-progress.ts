/**
 * Bounded, persisted Telegram tool-progress message.
 *
 * The progress message is presentation-only: it is sent once when the first
 * tool starts, edited as tools complete or fail, and deleted before the durable
 * final answer is published. Its lifecycle is tracked by a persisted fence in
 * the shared store so a crashed or retried turn can recover stale messages.
 */

export interface ToolProgressEvent {
  readonly toolName: string;
  readonly callId: string;
  /** Raw model input is projected through an allowlist before presentation. */
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * A presentation-only model-step marker. It deliberately has no text payload:
 * the UI may show that a model step is in progress, never its private
 * reasoning or draft response.
 */
export interface ThinkingProgressEvent {
  readonly callId: string;
}

export interface ToolProgressPort {
  onThinkingStarted?(event: ThinkingProgressEvent): void | Promise<void>;
  onThinkingCompleted?(
    event: ThinkingProgressEvent,
    ok: boolean,
  ): void | Promise<void>;
  onToolStarted(event: ToolProgressEvent): void | Promise<void>;
  onToolCompleted(event: ToolProgressEvent, ok: boolean): void | Promise<void>;
}

export interface ToolProgressBotApiPort {
  sendMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; messageId: number } | { ok: false }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false }>;
  deleteMessage(
    chatId: string,
    messageId: number,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false }>;
}

export interface ToolProgressStore {
  saveBotTurnProgress(
    turnId: number,
    workerId: string,
    progress: { messageId?: number; state?: ToolProgressState },
    nowMs?: number,
  ): boolean;
  clearBotTurnProgress(turnId: number, nowMs?: number): boolean;
}

export type ToolProgressState =
  | "none"
  | "dispatching"
  | "active"
  | "unknown";

export interface ToolProgressPublisherOptions {
  turnId: number;
  workerId: string;
  chatId: string;
  signal: AbortSignal;
  botApi: ToolProgressBotApiPort;
  store: ToolProgressStore;
  initialMessageId?: number;
  maxTextLength?: number;
  now?: () => number;
}

interface ToolCallStatus {
  readonly kind: "thinking" | "tool";
  readonly toolName: string;
  readonly state: "running" | "ok" | "error";
  readonly inputPreview?: string;
}

const DEFAULT_MAX_TEXT_LENGTH = 3_500;
const MAX_QUERY_PREVIEW_LINES = 3;
const MAX_QUERY_PREVIEW_LINE_CHARS = 96;

/**
 * Publishes a single Telegram progress message during model steps and read-tool
 * execution. Thinking is a status marker, never a model-output channel.
 *
 * All Bot API calls are best-effort: failures are swallowed so they can never
 * alter durable turn state. The publisher still persists the message ID and
 * state to the store so recovery can clean up stale messages.
 */
export class ToolProgressPublisher implements ToolProgressPort {
  readonly #turnId: number;
  readonly #workerId: string;
  readonly #chatId: string;
  readonly #signal: AbortSignal;
  readonly #botApi: ToolProgressBotApiPort;
  readonly #store: ToolProgressStore;
  readonly #maxTextLength: number;
  readonly #now: () => number;
  #messageId: number | undefined;
  #state: ToolProgressState = "none";
  #pending = new Map<string, ToolCallStatus>();
  #dispatchPromise: Promise<void> = Promise.resolve();
  #lastRenderedText: string | undefined;

  constructor(options: ToolProgressPublisherOptions) {
    this.#turnId = options.turnId;
    this.#workerId = options.workerId;
    this.#chatId = options.chatId;
    this.#signal = options.signal;
    this.#botApi = options.botApi;
    this.#store = options.store;
    this.#messageId = options.initialMessageId;
    this.#maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.#now = options.now ?? (() => Date.now());
  }

  get messageId(): number | undefined {
    return this.#messageId;
  }

  get state(): ToolProgressState {
    return this.#state;
  }

  /**
   * Removes a stale progress message from a previous attempt of the same turn.
   * Should be called once after claim before any tool calls start.
   */
  async recoverPrevious(signal: AbortSignal): Promise<void> {
    if (this.#messageId !== undefined) {
      await this.#botApi.deleteMessage(this.#chatId, this.#messageId, signal);
      this.#messageId = undefined;
      this.#state = "none";
      this.#lastRenderedText = undefined;
      this.#store.clearBotTurnProgress(this.#turnId, this.#now());
    }
  }

  onThinkingStarted(event: ThinkingProgressEvent): void {
    this.#pending.set(event.callId, {
      kind: "thinking",
      toolName: "thinking",
      state: "running",
    });
    this.#dispatch();
  }

  onThinkingCompleted(event: ThinkingProgressEvent, ok: boolean): void {
    const previous = this.#pending.get(event.callId);
    if (!previous) {
      return;
    }
    this.#pending.set(event.callId, {
      ...previous,
      state: ok ? "ok" : "error",
    });
    this.#dispatch();
  }

  onToolStarted(event: ToolProgressEvent): void {
    this.#pending.set(event.callId, {
      kind: "tool",
      toolName: event.toolName,
      state: "running",
      inputPreview: toolInputPreview(event.toolName, event.input),
    });
    this.#dispatch();
  }

  onToolCompleted(event: ToolProgressEvent, ok: boolean): void {
    const previous = this.#pending.get(event.callId);
    this.#pending.set(event.callId, {
      kind: previous?.kind ?? "tool",
      toolName: event.toolName,
      state: ok ? "ok" : "error",
      inputPreview:
        previous?.inputPreview ?? toolInputPreview(event.toolName, event.input),
    });
    this.#dispatch();
  }

  /**
   * Finishes the progress presentation once the agent has a terminal result.
   * Deletes the message before publication or shadow completion, and waits
   * for any in-flight edit.
   */
  async finish(signal: AbortSignal): Promise<void> {
    await this.#dispatchPromise;
    if (this.#messageId !== undefined) {
      await this.#botApi.deleteMessage(this.#chatId, this.#messageId, signal);
      this.#messageId = undefined;
    }
    this.#state = "none";
    this.#store.clearBotTurnProgress(this.#turnId, this.#now());
  }

  #dispatch(): void {
    this.#dispatchPromise = this.#dispatchPromise.then(() =>
      this.#renderAndSend(),
    );
  }

  async #renderAndSend(): Promise<void> {
    const text = renderProgressText(this.#pending, this.#maxTextLength);
    if (this.#messageId === undefined) {
      this.#state = "dispatching";
      this.#persist();
      const result = await this.#botApi.sendMessage(
        this.#chatId,
        text,
        this.#signal,
      );
      if (result.ok) {
        this.#messageId = result.messageId;
        this.#state = "active";
        this.#lastRenderedText = text;
      } else {
        this.#state = "unknown";
      }
    } else {
      if (this.#lastRenderedText === text) {
        return;
      }
      this.#state = "active";
      const result = await this.#botApi.editMessageText(
        this.#chatId,
        this.#messageId,
        text,
        this.#signal,
      );
      if (result.ok) {
        this.#lastRenderedText = text;
      }
    }
    this.#persist();
  }

  #persist(): void {
    this.#store.saveBotTurnProgress(
      this.#turnId,
      this.#workerId,
      {
        messageId: this.#messageId,
        state: this.#state,
      },
      this.#now(),
    );
  }
}

export function renderProgressText(
  pending: ReadonlyMap<string, ToolCallStatus>,
  maxLength: number,
): string {
  const lines: string[] = [];
  for (const [, status] of pending) {
    const icon =
      status.kind === "thinking" && status.state === "running"
        ? "🧠"
        : status.state === "running" ? "⏳" : status.state === "ok" ? "✓" : "✗";
    lines.push(`${icon} ${status.toolName}`);
    if (status.inputPreview) {
      lines.push(
        ...status.inputPreview.split("\n").map((line) => `  ${line}`),
      );
    }
  }
  const text = lines.join("\n");
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(1, maxLength - 1)) + "…";
}

/**
 * Progress is visible to the chat, so expose only a compact allowlist of tool
 * selectors. Never serialize a full tool argument object or a tool result.
 */
function toolInputPreview(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!input) {
    return undefined;
  }
  // The request itself can contain a private person's name or other sensitive
  // clue. Unlike a public web query, never echo it into the chat timeline.
  if (toolName === "research_lookup") {
    return "корпус: обезличенные HH-исследования";
  }
  if (toolName === "audio_transcribe") {
    // The media selector is application-owned. Show its tiny safe projection,
    // never an attachment name, file id, path, URL, or transcript.
    return input.source === "reply"
      ? "аудио: прямой реплай"
      : "аудио: текущее сообщение";
  }
  const query = textField(input, "query");
  if (query) {
    if (toolName === "rag_bm25_search") {
      return `rag: ${queryPreviewText(query)}`;
    }
    return queryPreview(query);
  }
  if (toolName === "static_page_fetch" || toolName === "firecrawl_crawl") {
    const url = textField(input, "url");
    if (url) {
      return urlPreview(url);
    }
  }
  if (toolName === "inspect_web_images") {
    // Count only: image URLs never appear in visible progress.
    const urls = Array.isArray(input.urls)
      ? input.urls.filter((u): u is string => typeof u === "string")
      : [];
    if (urls.length > 0) {
      return `картинки: ${Math.min(urls.length, 6)}`;
    }
  }
  if (
    toolName === "remember_fast" ||
    toolName === "remember_lesson" ||
    toolName === "save_chat_skill" ||
    toolName === "load_chat_skill"
  ) {
    const title = textField(input, "title") ?? textField(input, "name");
    if (title) {
      return `запись: ${queryPreviewText(title)}`;
    }
  }
  if (toolName === "day_digest") {
    const dayFrom = textField(input, "day_from");
    const dayTo = textField(input, "day_to");
    if (dayFrom) {
      return `период: ${dayFrom}${dayTo ? ` — ${dayTo}` : ""}`;
    }
  }
  if (toolName === "read_chat_slice") {
    if (textField(input, "cursor")) {
      return "срез: продолжение по курсору";
    }
    if (input.mode === "recent") {
      const count = integerField(input, "count");
      if (count !== undefined) {
        return `срез: последние ${count}`;
      }
      return "срез: последние сообщения";
    }
    if (input.mode === "period") {
      const dayFrom = textField(input, "day_from");
      const dayTo = textField(input, "day_to");
      if (dayFrom) {
        return `срез: ${dayFrom}${dayTo ? ` — ${dayTo}` : ""}`;
      }
      return "срез: период";
    }
  }
  if (toolName === "thread_context") {
    const messageId = integerField(input, "message_id");
    if (messageId !== undefined) {
      return `сообщение: #${messageId}`;
    }
  }
  return undefined;
}

function queryPreview(query: string): string {
  return `запрос: ${queryPreviewText(query)}`;
}

function urlPreview(value: string): string {
  try {
    const url = new URL(value);
    // Query strings often carry signed or user-specific values. The chat only
    // needs to see which public page is being opened.
    return `страница: ${queryPreviewText(`${url.protocol}//${url.host}${url.pathname}`)}`;
  } catch {
    return `страница: ${queryPreviewText(value)}`;
  }
}

function queryPreviewText(query: string): string {
  const normalized = query.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  const characters = Array.from(normalized);
  const capacity =
    MAX_QUERY_PREVIEW_LINES * MAX_QUERY_PREVIEW_LINE_CHARS;
  const truncated = characters.length > capacity;
  const visible = truncated
    ? characters.slice(0, capacity - 1)
    : characters;
  const rows: string[] = [];
  for (let index = 0; index < visible.length; index += MAX_QUERY_PREVIEW_LINE_CHARS) {
    rows.push(
      visible.slice(index, index + MAX_QUERY_PREVIEW_LINE_CHARS).join(""),
    );
  }
  if (truncated) {
    const last = rows.length - 1;
    rows[last] = `${rows[last] ?? ""}…`;
  }
  return rows
    .map((row, index) => index === 0 ? row : `        ${row}`)
    .join("\n");
}

function textField(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function integerField(
  input: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined {
  const value = input[field];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}
