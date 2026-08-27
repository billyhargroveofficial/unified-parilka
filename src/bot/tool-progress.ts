import { renderProgressText } from "./tool-progress-render.js";

export { renderProgressText } from "./tool-progress-render.js";

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
  /** Stable host-owned identity used to select the safe input projection. */
  readonly toolId?: string;
  /** Raw model input is projected through an allowlist before presentation. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Number of provider-side operations represented by this event. */
  readonly batchSize?: number;
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
  ): Promise<ToolProgressDeleteResult>;
}

/**
 * A terminal delete rejection is definitive for this presentation bubble: it
 * may remain visible in Telegram, but retrying cannot remove it.  Callers may
 * therefore retire the durable fence without confusing it with a transport or
 * rate-limit failure, which must remain retryable.
 */
export type ToolProgressDeleteResult =
  | { ok: true }
  | { ok: false; terminal?: true };

export interface ToolProgressStore {
  saveBotTurnProgress(
    turnId: number,
    workerId: string,
    progress: { messageId?: number; state?: ToolProgressState },
    nowMs?: number,
  ): boolean;
  clearBotTurnProgress(turnId: number, nowMs?: number): boolean;
}

/** Narrow timer boundary so visibility timing stays deterministic in tests. */
export interface ToolProgressScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
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
  /** Kept deliberately short: it is presentation polish, not a second timeout. */
  minVisibleMs?: number;
  now?: () => number;
  scheduler?: ToolProgressScheduler;
}

export interface ToolCallStatus {
  readonly kind: "thinking" | "tool";
  readonly toolName: string;
  readonly toolId?: string;
  readonly state: "running" | "ok" | "error";
  readonly inputPreview?: string;
  readonly batchSize?: number;
}

const DEFAULT_MAX_TEXT_LENGTH = 3_500;
export const DEFAULT_PROGRESS_MIN_VISIBLE_MS = 1_000;
const MAX_PROGRESS_MIN_VISIBLE_MS = 1_200;
/**
 * Hard presentation budget per turn. A normal eight-function Responses turn
 * fits (initial thinking + eight tool starts), while pathological hosted event
 * streams cannot consume Telegram's whole per-chat allowance before the final.
 */
export const MAX_PROGRESS_SNAPSHOTS_PER_TURN = 10;
/** A sent but unfenced UI bubble gets one short independent cleanup attempt. */
const UNFENCED_PROGRESS_CLEANUP_TIMEOUT_MS = 5_000;

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
  readonly #minVisibleMs: number;
  readonly #now: () => number;
  readonly #scheduler: ToolProgressScheduler;
  #messageId: number | undefined;
  #state: ToolProgressState = "none";
  #pending = new Map<string, ToolCallStatus>();
  #dispatchPromise: Promise<void> = Promise.resolve();
  #finishPromise: Promise<void> | undefined;
  #lastRenderedText: string | undefined;
  #visibleAtMs: number | undefined;
  /**
   * A message ACK can race the durable lease fence. Do not edit it again, but
   * retain its id in-process for a second best-effort deletion at terminal.
   */
  #unfencedMessageId: number | undefined;
  /**
   * A rejected send can be an ambiguous post-accept network outcome. Without
   * its Telegram id we cannot safely compensate, so never send another bubble
   * in this turn and risk a duplicate visible tool status.
   */
  #sendOutcomeUnknown = false;
  #finished = false;
  #dispatchedSnapshots = 0;

  constructor(options: ToolProgressPublisherOptions) {
    this.#turnId = options.turnId;
    this.#workerId = options.workerId;
    this.#chatId = options.chatId;
    this.#signal = options.signal;
    this.#botApi = options.botApi;
    this.#store = options.store;
    this.#messageId = options.initialMessageId;
    this.#maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.#minVisibleMs = positiveDuration(
      options.minVisibleMs ?? DEFAULT_PROGRESS_MIN_VISIBLE_MS,
    );
    this.#now = options.now ?? (() => Date.now());
    this.#scheduler = options.scheduler ?? defaultScheduler;
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
      try {
        const result = await this.#botApi.deleteMessage(
          this.#chatId,
          this.#messageId,
          signal,
        );
        if (result.ok) {
          this.#messageId = undefined;
          this.#state = "none";
          this.#lastRenderedText = undefined;
          this.#visibleAtMs = undefined;
          this.#store.clearBotTurnProgress(this.#turnId, this.#now());
          return;
        }
      } catch {
        // A stale presentation bubble is never an agent or delivery failure.
      }
      // Keep the message ID durable: a later claimed attempt can retry the
      // cleanup instead of orphaning a presentation bubble in Telegram.
      this.#state = "unknown";
      this.#persist();
    }
  }

  onThinkingStarted(event: ThinkingProgressEvent): void {
    if (this.#finished) return;
    this.#pending.set(event.callId, {
      kind: "thinking",
      toolName: "thinking",
      state: "running",
    });
    this.#dispatch();
  }

  onThinkingCompleted(event: ThinkingProgressEvent, ok: boolean): void {
    if (this.#finished) return;
    const previous = this.#pending.get(event.callId);
    if (!previous) {
      return;
    }
    this.#pending.set(event.callId, {
      ...previous,
      state: ok ? "ok" : "error",
    });
    // A successful transition is folded into the next tool-start snapshot.
    // Sending a standalone completion edit doubles Bot API traffic without
    // adding durable information; failures remain immediately visible.
    if (!ok) {
      this.#dispatch();
    }
  }

  onToolStarted(event: ToolProgressEvent): void {
    if (this.#finished) return;
    // Replace the initial thinking line with the first concrete tool instead
    // of retaining a permanently completed presentation-only marker.
    for (const [callId, status] of this.#pending) {
      if (status.kind === "thinking" && status.state === "ok") {
        this.#pending.delete(callId);
      }
    }
    const batchSize = normalizedBatchSize(event.batchSize);
    this.#pending.set(event.callId, {
      kind: "tool",
      toolName: event.toolName,
      ...(event.toolId === undefined ? {} : { toolId: event.toolId }),
      ...(batchSize === undefined
        ? {}
        : { batchSize }),
      state: "running",
      inputPreview: toolInputPreview(event.toolId ?? event.toolName, event.input),
    });
    this.#dispatch();
  }

  onToolCompleted(event: ToolProgressEvent, ok: boolean): void {
    if (this.#finished) return;
    const previous = this.#pending.get(event.callId);
    const batchSize = normalizedBatchSize(event.batchSize) ?? previous?.batchSize;
    this.#pending.set(event.callId, {
      kind: previous?.kind ?? "tool",
      toolName: event.toolName,
      ...(previous?.toolId === undefined && event.toolId === undefined
        ? {}
        : { toolId: event.toolId ?? previous?.toolId }),
      ...(batchSize === undefined
        ? {}
        : { batchSize }),
      state: ok ? "ok" : "error",
      inputPreview:
        previous?.inputPreview ?? toolInputPreview(
          event.toolId ?? previous?.toolId ?? event.toolName,
          event.input,
        ),
    });
    // Successful completion is visible in the next tool-start snapshot. This
    // bounds a five-tool turn to one send plus five edits, leaving Telegram
    // capacity for deletion and the actual final reply. Errors are exceptional
    // and must still be rendered immediately.
    if (!ok) {
      this.#dispatch();
    }
  }

  /**
   * Finishes the progress presentation once the agent has a terminal result.
   * Deletes the message before publication or shadow completion, and waits
   * for any in-flight edit.
   */
  async finish(signal: AbortSignal): Promise<void> {
    if (this.#finishPromise !== undefined) {
      return this.#finishPromise;
    }
    // Freeze before awaiting queued I/O: late model/tool callbacks must never
    // schedule a new Telegram message after this terminal cleanup begins.
    this.#finished = true;
    this.#finishPromise = this.#finish(signal);
    return this.#finishPromise;
  }

  async #finish(signal: AbortSignal): Promise<void> {
    await this.#dispatchPromise;
    if (this.#unfencedMessageId !== undefined) {
      await this.#compensateUnfencedMessage(this.#unfencedMessageId);
    }
    if (this.#messageId !== undefined) {
      await this.#waitForMinimumVisibility(signal);
      let deleted = false;
      let terminalFailure = false;
      try {
        const result = await this.#botApi.deleteMessage(
          this.#chatId,
          this.#messageId,
          signal,
        );
        deleted = result.ok;
        terminalFailure = !result.ok && result.terminal === true;
      } catch {
        // Keep the exact durable message-id fence below. The final reply must
        // still be deliverable even if deleting presentation text fails.
      }
      if (!deleted && !terminalFailure) {
        // Do not clear this fence on an ambiguous delete. The durable turn's
        // next attempt can recover this exact message instead.
        this.#state = "unknown";
        this.#persist();
        return;
      }
      this.#messageId = undefined;
    }
    if (this.#sendOutcomeUnknown) {
      this.#state = "unknown";
      this.#persist();
      return;
    }
    this.#state = "none";
    this.#visibleAtMs = undefined;
    this.#store.clearBotTurnProgress(this.#turnId, this.#now());
  }

  #dispatch(): void {
    if (this.#dispatchedSnapshots >= MAX_PROGRESS_SNAPSHOTS_PER_TURN) {
      return;
    }
    this.#dispatchedSnapshots += 1;
    // Snapshot at the event boundary. Otherwise a fast completion can mutate
    // `#pending` before the first queued render and collapse send+edit into a
    // single invisible message just before terminal deletion.
    const text = renderProgressText(this.#pending, this.#maxTextLength);
    // Every Bot API operation below catches its own rejection, so this serial
    // promise never becomes a rejected/unhandled presentation failure.
    this.#dispatchPromise = this.#dispatchPromise.then(() =>
      this.#renderAndSend(text),
    );
  }

  async #renderAndSend(text: string): Promise<void> {
    // Do not create a second bubble while a prior post-ACK fence failure is
    // still being compensated. That would trade one recoverable UI artifact
    // for an unbounded sequence of them.
    if (this.#unfencedMessageId !== undefined || this.#sendOutcomeUnknown) {
      return;
    }
    if (this.#messageId === undefined) {
      this.#state = "dispatching";
      // Never create a UI message if this worker can no longer establish the
      // pre-send durable fence. A later owner may safely try again.
      if (!this.#persist()) {
        this.#state = "unknown";
        return;
      }
      let result: { ok: true; messageId: number } | { ok: false };
      try {
        result = await this.#botApi.sendMessage(
          this.#chatId,
          text,
          this.#signal,
        );
      } catch {
        this.#sendOutcomeUnknown = true;
        this.#state = "unknown";
        this.#persist();
        return;
      }
      if (result.ok) {
        this.#messageId = result.messageId;
        this.#state = "active";
        this.#lastRenderedText = text;
        this.#visibleAtMs = this.#now();
        // The ACK is not enough: if the post-send fence was refused or the
        // store threw, do not leave a message that no future worker can find.
        if (!this.#persist()) {
          const messageId = this.#messageId;
          this.#messageId = undefined;
          this.#lastRenderedText = undefined;
          this.#visibleAtMs = undefined;
          this.#state = "unknown";
          await this.#compensateUnfencedMessage(messageId);
          return;
        }
        return;
      } else {
        this.#state = "unknown";
      }
    } else {
      if (this.#lastRenderedText === text) {
        return;
      }
      this.#state = "active";
      let result: { ok: true } | { ok: false };
      try {
        result = await this.#botApi.editMessageText(
          this.#chatId,
          this.#messageId,
          text,
          this.#signal,
        );
      } catch {
        this.#state = "unknown";
        this.#persist();
        return;
      }
      if (result.ok) {
        this.#lastRenderedText = text;
        // A late tool-start/completion edit must remain observable too; the
        // initial thinking bubble may already have been visible for minutes.
        this.#visibleAtMs = this.#now();
      }
    }
    this.#persist();
  }

  /**
   * Progress is presentation-only. The SQLite fence is mandatory after an ACK
   * but a refusal/exception must not reject the model turn or strand its UI.
   */
  #persist(): boolean {
    try {
      return this.#store.saveBotTurnProgress(
        this.#turnId,
        this.#workerId,
        {
          messageId: this.#messageId,
          state: this.#state,
        },
        this.#now(),
      );
    } catch {
      return false;
    }
  }

  /**
   * A progress bubble created by this process has a stable Telegram id, so it
   * remains safe to delete even after its durable turn lease was fenced away.
   * This signal deliberately does not inherit the lost worker signal: a lease
   * abort must not itself turn the compensating cleanup into a no-op.
   */
  async #compensateUnfencedMessage(messageId: number): Promise<void> {
    this.#unfencedMessageId = messageId;
    try {
      const result = await this.#botApi.deleteMessage(
        this.#chatId,
        messageId,
        AbortSignal.timeout(UNFENCED_PROGRESS_CLEANUP_TIMEOUT_MS),
      );
      if (result.ok) {
        this.#unfencedMessageId = undefined;
      }
    } catch {
      // The id remains in-memory for one terminal retry. A process crash here
      // is an unavoidable ambiguous Bot API outcome, not a lease violation.
    }
  }

  async #waitForMinimumVisibility(signal: AbortSignal): Promise<void> {
    if (this.#visibleAtMs === undefined || signal.aborted) {
      return;
    }
    const remainingMs = this.#minVisibleMs - (this.#now() - this.#visibleAtMs);
    if (remainingMs <= 0) {
      return;
    }
    await sleep(this.#scheduler, remainingMs, signal);
  }
}

const defaultScheduler: ToolProgressScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Tool progress minimum visible duration must be non-negative.");
  }
  return Math.min(Math.floor(value), MAX_PROGRESS_MIN_VISIBLE_MS);
}

function sleep(
  scheduler: ToolProgressScheduler,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let handle: unknown;
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      if (handle !== undefined) {
        scheduler.clearTimeout(handle);
      }
      done();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    handle = scheduler.setTimeout(done, delayMs);
  });
}

function normalizedBatchSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, 99);
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
  const query = textField(input, "query");
  if (toolName === "rag_bm25_search" && query) {
    return queryPreviewText(query);
  }
  if (toolName === "keyword_search" && query) {
    return queryPreviewText(query);
  }
  if (toolName === "day_digest") {
    const dayFrom = textField(input, "day_from");
    const dayTo = textField(input, "day_to");
    if (dayFrom) {
      return `${dayFrom}${dayTo ? `..${dayTo}` : ""}`;
    }
  }
  if (toolName === "read_chat_slice") {
    if (textField(input, "cursor")) {
      return "next";
    }
    if (input.mode === "recent") {
      const count = integerField(input, "count");
      if (count !== undefined) {
        return String(count);
      }
      return "recent";
    }
    if (input.mode === "period") {
      const dayFrom = textField(input, "day_from");
      const dayTo = textField(input, "day_to");
      if (dayFrom) {
        return `${dayFrom}${dayTo ? `..${dayTo}` : ""}`;
      }
      return "period";
    }
  }
  if (toolName === "thread_context") {
    const messageId = integerField(input, "message_id");
    if (messageId !== undefined) {
      return `#${messageId}`;
    }
  }
  if (toolName === "load_chat_skill") {
    const name = textField(input, "name");
    if (name) {
      return queryPreviewText(name);
    }
  }
  if (toolName === "hosted_web") {
    if (query) return queryPreviewText(query);
    const pattern = textField(input, "pattern");
    if (pattern) return queryPreviewText(pattern);
    const url = textField(input, "url");
    if (url) return compactUrl(url);
  }
  return undefined;
}

function queryPreviewText(query: string): string {
  const normalized = query.replace(/\s+/gu, " ").trim();
  return normalized;
}

function compactUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch {
    return queryPreviewText(value);
  }
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
