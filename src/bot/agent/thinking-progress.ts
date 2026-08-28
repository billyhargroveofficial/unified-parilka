import type {
  ThinkingProgressEvent,
  ToolProgressPort,
} from "../tool-progress.js";

/**
 * Turns model-step boundaries into safe presentation events. No model content
 * ever crosses this boundary: the progress UI learns only that a step started,
 * completed, or failed.
 */
export class ThinkingProgressTracker {
  readonly #port: ToolProgressPort | undefined;
  #active: ThinkingProgressEvent | undefined;
  #nextId = 0;

  constructor(port: ToolProgressPort | undefined) {
    this.#port = port;
  }

  start(): void {
    if (this.#active) {
      this.finish(false);
    }
    const event = { callId: `thinking:${++this.#nextId}` };
    this.#active = event;
    this.#port?.onThinkingStarted?.(event);
  }

  finish(ok = true): void {
    const event = this.#active;
    if (!event) {
      return;
    }
    this.#active = undefined;
    this.#port?.onThinkingCompleted?.(event, ok);
  }
}
