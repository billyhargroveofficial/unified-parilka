import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CACHE_TOOL_NAMES,
  LoopbackMcpClient,
  SourceMessageLedger,
  TOOL_SCHEMAS,
  VISION_BLOCK_MESSAGE,
  VisionBudget,
  appendFooter,
  assertAllowedTurn,
  countInboundImages,
  dispatchCacheTool,
  gateWriteTool,
  hasLiteralBotMention,
  isCacheToolName,
  isVisionTool,
  chatIdFromSessionKey,
  loadPluginEnv,
  normalizeBotUsername,
  parseTelegramMessageId,
  SessionRejectedError,
  type PluginEnv,
  type TurnIdentity,
} from "./core/index.js";

type PluginConfig = {
  botUsername?: string;
};

const sharedLedger = new SourceMessageLedger();
const sharedVision = new VisionBudget();
let sharedMcp: LoopbackMcpClient | undefined;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractChatId(ctx: unknown, event: unknown): string {
  const context = asRecord(ctx);
  const payload = asRecord(event);
  return (
    stringField(context.conversationId) ??
    stringField(context.nativeChannelId) ??
    stringField(payload.to) ??
    stringField(payload.from) ??
    ""
  );
}

function extractChannel(ctx: unknown, event: unknown, fallback?: string): string {
  const context = asRecord(ctx);
  const payload = asRecord(event);
  return (
    stringField(context.channelId) ??
    stringField(payload.channel) ??
    fallback ??
    "telegram"
  );
}

function payloadText(payload: unknown): string {
  const record = asRecord(payload);
  return typeof record.text === "string" ? record.text : "";
}

export default definePluginEntry({
  id: "parilka-chat",
  name: "Parilka Chat",
  description:
    "Trusted cache-read bridge from OpenClaw to parilka-unified loopback MCP.",
  configSchema: Type.Object({
    botUsername: Type.Optional(Type.String()),
  }),
  register(api) {
    let env: PluginEnv;
    try {
      env = loadPluginEnv(process.env);
    } catch {
      api.logger.error("parilka-chat disabled: PARILKA_TELEGRAM_CHAT_ID missing");
      return;
    }

    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const botUsername = normalizeBotUsername(pluginConfig.botUsername);
    const ledger = sharedLedger;
    const vision = sharedVision;
    sharedMcp ??= new LoopbackMcpClient(env.mcpUrl);
    const mcp = sharedMcp;

    const rememberTurn = (
      ctx: unknown,
      event: unknown,
      extras: Partial<TurnIdentity> = {},
    ): TurnIdentity | undefined => {
      const context = asRecord(ctx);
      const payload = asRecord(event);
      const messageId = parseTelegramMessageId(
        extras.messageId ??
          payload.messageId ??
          context.messageId,
      );
      if (messageId === undefined) return undefined;
      const identity: TurnIdentity = {
        agentId: stringField(context.agentId) ?? env.agentId,
        channel: extractChannel(ctx, event, extras.channel),
        accountId: stringField(context.accountId) ?? extras.accountId,
        chatId:
          extras.chatId ||
          extractChatId(ctx, event) ||
          chatIdFromSessionKey(
            extras.sessionKey ||
              stringField(asRecord(ctx).sessionKey) ||
              stringField(asRecord(event).sessionKey),
          ),
        senderId:
          extras.senderId ??
          stringField(context.senderId) ??
          stringField(payload.senderId),
        messageId,
        sessionKey:
          extras.sessionKey ??
          stringField(context.sessionKey) ??
          stringField(payload.sessionKey),
        runId:
          extras.runId ??
          stringField(context.runId) ??
          stringField(payload.runId),
        botUsername,
      };
      try {
        assertAllowedTurn(env, identity);
      } catch (error) {
        if (error instanceof SessionRejectedError) {
          api.logger.warn(
            `parilka-chat capture skipped agent=${identity.agentId} channel=${identity.channel} chat=${identity.chatId}`,
          );
          return undefined;
        }
        throw error;
      }
      ledger.capture(identity);
      api.logger.info(
        `parilka-chat captured messageId=${identity.messageId} session=${identity.sessionKey ?? ""}`,
      );
      return identity;
    };

    for (const name of CACHE_TOOL_NAMES) {
      const schema = TOOL_SCHEMAS[name];
      api.registerTool(
        (toolContext) => ({
          name: schema.name,
          description: schema.description,
          catalogMode: "direct-only",
          parameters: Type.Unsafe(schema.parameters),
          async execute(_id, params, signal) {
            const result = await dispatchCacheTool({
              name: schema.name,
              args: params,
              env,
              ledger,
              mcp,
              sessionKey: toolContext.sessionKey,
              runId: stringField(asRecord(toolContext).runId),
              signal,
            });
            return {
              content: [{ type: "text", text: result.text }],
            };
          },
        }),
        { name: schema.name },
      );
    }

    api.on("message_received", (event, ctx) => {
      const identity = rememberTurn(ctx, event);
      if (!identity) return;
      const media = (event as { media?: Array<{ kind?: string; contentType?: string }> }).media;
      const inbound = countInboundImages(media);
      if (inbound > 0) {
        const key = identity.runId ?? identity.sessionKey ?? String(identity.messageId);
        vision.consume(key, inbound);
      }
    });

    api.on("before_dispatch", (event, ctx) => {
      const identity = rememberTurn(ctx, event, {
        senderId: event.senderId,
        sessionKey: event.sessionKey,
        messageId: parseTelegramMessageId(event.messageId),
        channel: event.channel,
      });
      if (!identity) return;
      const body = event.body ?? event.content;
      if (!hasLiteralBotMention(body, botUsername)) {
        return { handled: true };
      }
    });

    api.on("before_tool_call", (event, ctx) => {
      if (ctx.agentId && ctx.agentId !== env.agentId) return;
      const identity = ledger.remember(ctx.sessionKey, ctx.runId);
      if (!identity) {
        return;
      }
      try {
        assertAllowedTurn(env, identity);
      } catch {
        return;
      }

      const senderId = ctx.requester?.senderId ?? identity.senderId;
      const write = gateWriteTool({
        name: event.toolName,
        params: event.params,
        env,
        senderId,
      });
      if (write.block) {
        return { block: true, blockReason: write.reason };
      }

      if (isVisionTool(event.toolName)) {
        const key =
          ctx.runId ?? ctx.sessionKey ?? String(identity?.messageId ?? "");
        const result = vision.consume(key, 1);
        if (!result.allowed) {
          return { block: true, blockReason: VISION_BLOCK_MESSAGE };
        }
      }

      // Cache tools are counted in dispatchCacheTool. Native tools (web_search,
      // web_fetch, memory, …) only go through this hook.
      const toolName = event.toolName ?? "";
      if (!isCacheToolName(toolName) && !/^tool[-_]?search$/iu.test(toolName)) {
        ledger.recordToolCall(
          ctx.sessionKey ?? identity.sessionKey,
          ctx.runId ?? identity.runId,
        );
      }
    });

    api.on("reply_payload_sending", (event, ctx) => {
      const identity = ledger.remember(
        event.sessionKey ?? ctx.sessionKey,
        event.runId ?? ctx.runId,
      );
      if (!identity) return;
      try {
        assertAllowedTurn(env, identity);
      } catch {
        return;
      }
      const text = payloadText(event.payload);
      if (!text.trim()) return;
      const started = ledger.startedAt(event.sessionKey ?? ctx.sessionKey, event.runId ?? ctx.runId);
      const usage = event.usageState;
      const elapsedSeconds =
        typeof usage?.durationMs === "number"
          ? usage.durationMs / 1000
          : started
            ? (Date.now() - started) / 1000
            : 0;
      const footer = appendFooter(text, {
        model: usage?.resolvedRef ?? usage?.model,
        usedTokens: usage?.contextUsedTokens ?? usage?.lastUsage?.input,
        maxTokens: usage?.contextTokenBudget,
        toolCalls: ledger.toolCalls(
          event.sessionKey ?? ctx.sessionKey,
          event.runId ?? ctx.runId,
        ),
        elapsedSeconds,
      });
      if (footer === text) return;
      return {
        payload: {
          ...event.payload,
          text: footer,
        },
      };
    });
  },
});
