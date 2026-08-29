import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseLoopbackMcpUrl } from "./session.js";
import { DEFAULT_MCP_TIMEOUT_MS, type McpToolCaller } from "./types.js";

interface TextContent {
  type: string;
  text?: string;
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as TextContent).type === "text" &&
      typeof (part as TextContent).text === "string"
    ) {
      return (part as TextContent).text;
    }
  }
  return undefined;
}

export class LoopbackMcpClient implements McpToolCaller {
  readonly #url: URL;
  readonly #timeoutMs: number;
  #client: Client | undefined;
  #transport: StreamableHTTPClientTransport | undefined;
  #connecting: Promise<Client> | undefined;

  constructor(rawUrl: string, timeoutMs = DEFAULT_MCP_TIMEOUT_MS) {
    this.#url = parseLoopbackMcpUrl(rawUrl);
    this.#timeoutMs = timeoutMs;
  }

  get url(): URL {
    return new URL(this.#url);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = await this.#ensure();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: this.#timeoutMs },
    );
    const text = firstText(result.content);
    if (typeof text === "string" && text.trim()) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        if (result.isError) {
          throw new Error("mcp tool returned isError");
        }
        throw new Error("mcp tool returned non-json content");
      }
    }
    if (result.isError) {
      throw new Error("mcp tool returned isError");
    }
    throw new Error("mcp tool returned empty content");
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    this.#connecting = undefined;
    if (client) await client.close();
  }

  async #ensure(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.#url);
    const client = new Client(
      { name: "parilka-chat", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.#transport = transport;
    this.#client = client;
    return client;
  }
}
