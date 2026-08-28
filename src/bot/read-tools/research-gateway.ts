import { request as httpRequest } from "node:http";
import type {
  ResearchGatewayProvider,
  ResearchGatewayResponse,
} from "./contracts.js";
import { researchGatewayResponseSchema } from "./schemas.js";

const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_PATH = "/v1/research/lookup";

export interface UnixSocketResearchGatewayProviderOptions {
  socketPath: string;
  maxResponseBytes?: number;
}

/**
 * The Parilka side knows only a local socket and a narrow JSON envelope. It
 * has no source-root path, file manifest, database handle, or HH credential.
 */
export class UnixSocketResearchGatewayProvider
  implements ResearchGatewayProvider {
  readonly #socketPath: string;
  readonly #maxResponseBytes: number;

  constructor(options: UnixSocketResearchGatewayProviderOptions) {
    if (!options.socketPath.startsWith("/")) {
      throw new TypeError("research gateway socket path must be absolute.");
    }
    this.#socketPath = options.socketPath;
    this.#maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
  }

  async lookup(request: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<ResearchGatewayResponse> {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new Error("Research gateway was aborted.");
    }
    const body = Buffer.from(JSON.stringify({
      query: request.query,
      limit: request.limit,
    }));
    const response = await this.#post(body, request.signal);
    const parsed = researchGatewayResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error("Research gateway returned an invalid disclosure.");
    }
    return parsed.data;
  }

  #post(body: Buffer, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof httpRequest> | undefined;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const rejectOnce = (error: unknown): void => {
        settle(() => reject(error));
      };
      const onAbort = (): void => {
        request?.destroy(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Research gateway was aborted."),
        );
      };

      request = httpRequest(
        {
          socketPath: this.#socketPath,
          method: "POST",
          path: REQUEST_PATH,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
            Accept: "application/json",
          },
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let byteLength = 0;
          response.on("data", (chunk: Buffer | Uint8Array | string) => {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);
            byteLength += buffer.length;
            if (byteLength > this.#maxResponseBytes) {
              response.destroy(new Error("Research gateway response is too large."));
              return;
            }
            chunks.push(buffer);
          });
          response.once("error", rejectOnce);
          response.once("end", () => {
            if (response.statusCode !== 200) {
              rejectOnce(new Error("Research gateway request failed."));
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settle(() => resolve(parsed));
            } catch {
              rejectOnce(new Error("Research gateway returned invalid JSON."));
            }
          });
        },
      );
      request.once("error", rejectOnce);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      request.end(body);
    });
  }
}

function boundedResponseBytes(value: number | undefined): number {
  const maximum = value ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1_024 || maximum > 128 * 1024) {
    throw new TypeError("research gateway maxResponseBytes must be 1024-131072.");
  }
  return maximum;
}
