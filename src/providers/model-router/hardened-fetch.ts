import { ModelProviderResponseTooLargeError } from "./errors.js";

const MAX_MODEL_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;

export function createHardenedProviderFetch(
  options: {
    transport?: typeof globalThis.fetch;
    maxResponseBytes?: number;
  } = {},
): typeof globalThis.fetch {
  const transport = options.transport ?? globalThis.fetch;
  const maxResponseBytes =
    options.maxResponseBytes ??
    MAX_MODEL_PROVIDER_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new TypeError(
      "maxResponseBytes must be a positive safe integer.",
    );
  }

  return async (input, init) => {
    const response = await transport(input, {
      ...init,
      // Provider credentials and prompts must never be replayed to a
      // redirect target. The configured base URL is the only allowed origin.
      redirect: "error",
    });
    return boundProviderResponse(response, maxResponseBytes);
  };
}

export const hardenedProviderFetch = createHardenedProviderFetch();

function boundProviderResponse(
  response: Response,
  maxResponseBytes: number,
): Response {
  const contentLength = response.headers.get("content-length");
  if (/^\d+$/u.test(contentLength ?? "")) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared > maxResponseBytes
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new ModelProviderResponseTooLargeError(
        maxResponseBytes,
      );
    }
  }
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  let bytesRead = 0;
  let released = false;
  const releaseReader = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          releaseReader();
          return;
        }
        bytesRead += chunk.value.byteLength;
        if (bytesRead > maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          releaseReader();
          controller.error(
            new ModelProviderResponseTooLargeError(
              maxResponseBytes,
            ),
          );
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
