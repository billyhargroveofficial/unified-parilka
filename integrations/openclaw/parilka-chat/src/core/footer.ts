import { DEFAULT_CONTEXT_WINDOW, type FooterUsage } from "./types.js";

export function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes) return `${minutes}м ${secs}с`;
  return `${secs}с`;
}

export function bareModel(model: string | undefined): string {
  if (!model || !model.trim()) return "?";
  return model.trim().split("/").pop() ?? "?";
}

export function renderFooter(usage: FooterUsage): string {
  const model = bareModel(usage.model);
  const used =
    typeof usage.usedTokens === "number" && Number.isFinite(usage.usedTokens)
      ? compactTokens(Math.max(0, Math.round(usage.usedTokens)))
      : "?";
  const maxRaw =
    typeof usage.maxTokens === "number" && usage.maxTokens > 0
      ? usage.maxTokens
      : DEFAULT_CONTEXT_WINDOW;
  const max = compactTokens(maxRaw);
  const tools = `${usage.toolCalls} tool calls`;
  return `${model} 🧠 · ${used}/${max} · ${tools} · ${formatElapsed(usage.elapsedSeconds)}`;
}

export function appendFooter(text: string, usage: FooterUsage): string {
  const footer = renderFooter(usage);
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.endsWith(footer)) return text;
  if (!trimmed) return footer;
  return `${trimmed}\n\n${footer}`;
}
