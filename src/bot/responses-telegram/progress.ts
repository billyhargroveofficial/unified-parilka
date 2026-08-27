import type {
  ThinkingProgressEvent,
  ToolProgressEvent,
  ToolProgressPort,
} from "../tool-progress.js";

/** Safe subset of hosted Responses web actions visible in Telegram. */
export type ResponsesWebAction = "search" | "open_page" | "find_in_page";

/** Local tools that the Parilka host has already schema-validated. */
export type ValidatedLocalToolName =
  | "rag_bm25_search"
  | "keyword_search"
  | "read_chat_slice"
  | "day_digest"
  | "thread_context"
  | "load_chat_skill";

export type ResponsesImageProgressKind = "input" | "view" | "generation";

export interface ResponsesWebProgressEvent {
  readonly itemId: string;
  readonly action: ResponsesWebAction;
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * A caller may construct this only after it has accepted the function name and
 * arguments. Raw Responses function-call events deliberately have no route
 * into the visible progress surface.
 */
export interface ValidatedLocalToolDispatch {
  readonly callId: string;
  readonly toolName: ValidatedLocalToolName;
  readonly validation: "accepted";
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface ResponsesImageProgressEvent {
  readonly itemId: string;
  readonly kind: ResponsesImageProgressKind;
}

const WEB_LABELS: Readonly<Record<ResponsesWebAction, string>> = {
  search: "web_search",
  open_page: "web_fetch",
  find_in_page: "find_in_page",
};

const LOCAL_LABELS: Readonly<Record<ValidatedLocalToolName, string>> = {
  rag_bm25_search: "rag_bm25_search",
  keyword_search: "keyword_search",
  read_chat_slice: "read_chat_slice",
  day_digest: "day_digest",
  thread_context: "thread_context",
  load_chat_skill: "load_chat_skill",
};

const IMAGE_LABELS: Readonly<Record<ResponsesImageProgressKind, string>> = {
  input: "input_image",
  view: "view_image",
  generation: "image_generation",
};

/**
 * Projects a typed, metadata-only Responses lifecycle into the existing one
 * bubble publisher. It has no Telegram API dependency and never sees model
 * deltas, tool outputs, or image bytes. Bounded hosted selectors and
 * schema-validated local arguments are forwarded for a one-line allowlist.
 */
export class ResponsesTelegramProgress {
  readonly #port: ToolProgressPort | undefined;
  readonly #events = new Map<string, ToolProgressEvent>();
  #thinking: ThinkingProgressEvent | undefined;
  #toolObserved = false;

  constructor(port: ToolProgressPort | undefined) {
    this.#port = port;
  }

  startThinking(responseId: string): void {
    // The initial thinking marker is useful before the first observable tool.
    // Responses continuation legs emit another reasoning lifecycle after each
    // tool result; rendering every one would create two Telegram edits per leg
    // and can exhaust the group rate limit before the final answer is sent.
    if (this.#thinking !== undefined || this.#toolObserved) {
      return;
    }
    const normalized = requiredId(responseId, "responseId");
    this.#thinking = { callId: `responses:thinking:${normalized}` };
    notify(() => this.#port?.onThinkingStarted?.(this.#thinking!));
  }

  completeThinking(ok = true): void {
    const event = this.#thinking;
    if (event === undefined) {
      return;
    }
    this.#thinking = undefined;
    notify(() => this.#port?.onThinkingCompleted?.(event, ok));
  }

  startWeb(event: ResponsesWebProgressEvent): void {
    const itemId = requiredId(event.itemId, "itemId");
    const label = WEB_LABELS[event.action];
    if (label === undefined) {
      return;
    }
    this.#start(`responses:web:${itemId}`, label, "hosted_web", event.input);
  }

  completeWeb(itemId: string, ok = true): void {
    this.#complete(`responses:web:${requiredId(itemId, "itemId")}`, ok);
  }

  /** Invoke only after the host has validated and accepted the function call. */
  startValidatedLocalTool(event: ValidatedLocalToolDispatch): void {
    if (event.validation !== "accepted") {
      return;
    }
    const callId = requiredId(event.callId, "callId");
    const label = LOCAL_LABELS[event.toolName];
    if (label === undefined) {
      return;
    }
    this.#start(
      `responses:function:${callId}`,
      label,
      event.toolName,
      event.input,
    );
  }

  completeValidatedLocalTool(callId: string, ok: boolean): void {
    this.#complete(`responses:function:${requiredId(callId, "callId")}`, ok);
  }

  startImage(event: ResponsesImageProgressEvent): void {
    const itemId = requiredId(event.itemId, "itemId");
    const label = IMAGE_LABELS[event.kind];
    if (label === undefined) {
      return;
    }
    this.#start(`responses:image:${itemId}`, label, `image:${event.kind}`);
  }

  completeImage(itemId: string, ok = true): void {
    this.#complete(`responses:image:${requiredId(itemId, "itemId")}`, ok);
  }

  /** Completes every observable item when the overall Responses turn ends. */
  completeOutstanding(ok: boolean): void {
    for (const [callId, event] of this.#events) {
      this.#events.delete(callId);
      notify(() => this.#port?.onToolCompleted(event, ok));
    }
    this.completeThinking(ok);
  }

  #start(
    callId: string,
    toolName: string,
    toolId: string,
    input?: Readonly<Record<string, unknown>>,
  ): void {
    const previous = this.#events.get(callId);
    if (previous?.toolName === toolName &&
      progressInputFingerprint(previous.input) === progressInputFingerprint(input)) {
      return;
    }
    this.#toolObserved = true;
    this.completeThinking(true);
    const event = {
      callId,
      toolName,
      toolId,
      ...(input === undefined ? {} : { input }),
    };
    this.#events.set(callId, event);
    notify(() => this.#port?.onToolStarted(event));
  }

  #complete(callId: string, ok: boolean): void {
    const event = this.#events.get(callId);
    if (event === undefined) {
      return;
    }
    this.#events.delete(callId);
    notify(() => this.#port?.onToolCompleted(event, ok));
  }
}

function progressInputFingerprint(
  input: Readonly<Record<string, unknown>> | undefined,
): string {
  return input === undefined ? "" : JSON.stringify(input);
}

function requiredId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new TypeError(`${name} must be a non-empty identifier up to 256 characters.`);
  }
  return normalized;
}

function notify(callback: () => void | Promise<void> | undefined): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Presentation cannot affect the response stream or host tool dispatch.
  }
}
