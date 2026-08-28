import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { UnixSocketResearchGatewayProvider } from "../src/bot/read-tools.js";

test("UnixSocketResearchGatewayProvider uses only the local socket contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-hh-research-"));
  const socketPath = join(directory, "gateway.sock");
  const requests: Array<{ path?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "done",
        policy: "anonymized_research_only",
        notice: "safe",
        findings: [{ text: "Агрегированный вывод без персональных данных.", as_of: "2026-07-31" }],
        limitations: ["Снимок датирован."],
      }));
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(async () => {
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  });

  const provider = new UnixSocketResearchGatewayProvider({ socketPath });
  const response = await provider.lookup({
    query: "рынок ML",
    limit: 2,
    signal: new AbortController().signal,
  });

  assert.deepEqual(requests, [{
    path: "/v1/research/lookup",
    body: { query: "рынок ML", limit: 2 },
  }]);
  assert.deepEqual(response, {
    status: "done",
    policy: "anonymized_research_only",
    notice: "safe",
    findings: [{ text: "Агрегированный вывод без персональных данных.", as_of: "2026-07-31" }],
    limitations: ["Снимок датирован."],
  });
});

test("UnixSocketResearchGatewayProvider rejects undeclared gateway fields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-hh-research-"));
  const socketPath = join(directory, "gateway.sock");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      status: "empty",
      policy: "anonymized_research_only",
      notice: "safe",
      source_path: "/private/source",
    }));
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(async () => {
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  });

  const provider = new UnixSocketResearchGatewayProvider({ socketPath });
  await assert.rejects(
    provider.lookup({
      query: "рынок",
      limit: 1,
      signal: new AbortController().signal,
    }),
    /invalid disclosure/u,
  );
});

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
