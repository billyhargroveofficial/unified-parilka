import assert from "node:assert/strict";
import test from "node:test";
import { LoopbackMcpServer } from "../src/mcp-loopback.js";
import type { ParilkaToolRegistry } from "../src/mcp-protocol.js";
import {
  LoopbackMcpClient,
  SourceMessageLedger,
  dispatchCacheTool,
  type PluginEnv,
} from "../integrations/openclaw/parilka-chat/src/core/index.js";

test(
  "loopback MCP client injects source_message_id through dispatch",
  { timeout: 10_000 },
  async () => {
    const seen: Record<string, unknown>[] = [];
    const owner = new LoopbackMcpServer({
      registry: cacheRegistry(seen),
      testPort: 0,
    });
    const url = await owner.start();
    const client = new LoopbackMcpClient(url.href);
    const ledger = new SourceMessageLedger();
    ledger.capture({
      agentId: "parilka",
      channel: "telegram",
      chatId: "-1003179772905",
      messageId: 77,
      sessionKey: "s1",
    });
    const env: PluginEnv = {
      chatId: "-1003179772905",
      agentId: "parilka",
      writeSenderIds: new Set(),
      mcpUrl: url.href,
    };
    try {
      const result = await dispatchCacheTool({
        name: "rag_bm25_search",
        args: { query: "ping" },
        env,
        ledger,
        sessionKey: "s1",
        mcp: client,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(JSON.parse(result.text), {
        ok: true,
        tool: "rag_bm25_search",
        query: "ping",
        source_message_id: 77,
      });
      assert.equal(seen[0]?.source_message_id, 77);
    } finally {
      await client.close();
      await owner.close();
    }
  },
);

function cacheRegistry(seen: Record<string, unknown>[]): ParilkaToolRegistry {
  return {
    listTools() {
      return [
        {
          name: "rag_bm25_search",
          description: "test",
          inputSchema: { type: "object", additionalProperties: true },
        },
      ];
    },
    async callTool(name, rawArgs) {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      seen.push(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              tool: name,
              query: args.query,
              source_message_id: args.source_message_id,
            }),
          },
        ],
      };
    },
  };
}
