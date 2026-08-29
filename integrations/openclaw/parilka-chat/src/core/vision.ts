import { VISION_MAX_IMAGES, VISION_TOOL_NAMES } from "./types.js";

const STATE_TTL_MS = 60 * 60_000;
const STATE_MAX_ENTRIES = 128;

interface Budget {
  used: number;
  ts: number;
}

function prune(store: Map<string, Budget>, now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.ts > STATE_TTL_MS) store.delete(key);
  }
  const overflow = store.size - STATE_MAX_ENTRIES;
  if (overflow <= 0) return;
  const oldest = [...store.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, overflow);
  for (const [key] of oldest) store.delete(key);
}

export const VISION_BLOCK_MESSAGE =
  "Лимит анализа изображений: максимум 6 за один ход.";

export function isVisionTool(name: string): boolean {
  return VISION_TOOL_NAMES.has(name) || name.toLowerCase().includes("vision");
}

export function countInboundImages(media: ReadonlyArray<{ kind?: string; contentType?: string }> | undefined): number {
  if (!media || media.length === 0) return 0;
  return media.filter((item) => {
    const kind = (item.kind ?? "").toLowerCase();
    const type = (item.contentType ?? "").toLowerCase();
    return kind.includes("image") || type.startsWith("image/");
  }).length;
}

export class VisionBudget {
  readonly #store = new Map<string, Budget>();

  consume(key: string, count: number, now = Date.now()): { allowed: boolean; used: number } {
    if (!key || count <= 0) {
      return { allowed: true, used: this.#store.get(key)?.used ?? 0 };
    }
    prune(this.#store, now);
    const current = this.#store.get(key)?.used ?? 0;
    if (current >= VISION_MAX_IMAGES) {
      return { allowed: false, used: current };
    }
    const next = current + count;
    if (next > VISION_MAX_IMAGES) {
      this.#store.set(key, { used: VISION_MAX_IMAGES, ts: now });
      return { allowed: false, used: VISION_MAX_IMAGES };
    }
    this.#store.set(key, { used: next, ts: now });
    return { allowed: true, used: next };
  }

  used(key: string): number {
    return this.#store.get(key)?.used ?? 0;
  }
}
