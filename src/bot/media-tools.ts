import type { StoredMessage } from "../store.js";
import type { ToolProgressPort } from "./tool-progress.js";
import {
  BotImageMediaError,
  MAX_TELEGRAM_IMAGE_TURN_BYTES,
  TelegramImageDownloader,
  selectTelegramImageTarget,
  type TelegramImageDataUrl,
  type TelegramImageDownloadApi,
  type TelegramImageTarget,
} from "./media/index.js";

const MAX_IMAGES_PER_TURN = 4;

/**
 * Host-only image ingress. Its output is suitable for Responses `input_image`
 * input and deliberately contains neither Bot API identifiers nor paths.
 */
export class BotMediaTools {
  readonly #downloader: TelegramImageDownloader;

  constructor(api: TelegramImageDownloadApi) {
    this.#downloader = new TelegramImageDownloader({ api });
  }

  findImage(trigger: StoredMessage, replyTarget?: StoredMessage) {
    return selectTelegramImageTarget(trigger, replyTarget);
  }

  async resolveImages(input: {
    trigger: StoredMessage;
    replyTarget?: StoredMessage;
    signal: AbortSignal;
    toolProgressPort?: ToolProgressPort;
  }): Promise<readonly TelegramImageDataUrl[]> {
    const target = this.findImage(input.trigger, input.replyTarget);
    if (!target) return [];
    return this.resolveImageTargets({ ...input, targets: [target] });
  }

  /**
   * Narrow future seam for a host-side album selector. It intentionally takes
   * resolved targets rather than Telegram IDs, URLs, or model-supplied input.
   */
  async resolveImageTargets(input: {
    targets: readonly TelegramImageTarget[];
    signal: AbortSignal;
    toolProgressPort?: ToolProgressPort;
  }): Promise<readonly TelegramImageDataUrl[]> {
    if (input.targets.length > MAX_IMAGES_PER_TURN) {
      throw new BotImageMediaError("file_too_large");
    }
    const result: TelegramImageDataUrl[] = [];
    let totalBytes = 0;
    for (const [index, target] of input.targets.entries()) {
      // Keep the presentation call id opaque and free of Telegram identifiers.
      const callId = `telegram-image:${String(index + 1)}`;
      input.toolProgressPort?.onToolStarted({ toolName: "загрузка изображения", callId });
      try {
        const image = await this.#downloader.download(target, input.signal);
        totalBytes += image.byteLength;
        if (totalBytes > MAX_TELEGRAM_IMAGE_TURN_BYTES) {
          throw new BotImageMediaError("file_too_large");
        }
        result.push({
          dataUrl: image.dataUrl,
          mimeType: image.mimeType,
          source: target.source,
          messageId: target.message.messageId,
        });
        input.toolProgressPort?.onToolCompleted({ toolName: "загрузка изображения", callId }, true);
      } catch (error) {
        input.toolProgressPort?.onToolCompleted({ toolName: "загрузка изображения", callId }, false);
        throw error;
      }
    }
    return result;
  }
}
