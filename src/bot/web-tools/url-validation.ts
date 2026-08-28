import { isIP } from "node:net";

/**
 * Validates a credential-free loopback HTTP origin (no path, query,
 * fragment, or credentials). Used for SearXNG and Firecrawl endpoints.
 */
export function requireLoopbackHttpOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      "Endpoint must be an absolute loopback HTTP URL.",
    );
  }
  if (url.protocol !== "http:") {
    throw new Error(
      "Endpoint must use HTTP (loopback only).",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Endpoint must be a credential-free origin without path, query, or fragment.",
    );
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      "Endpoint hostname must resolve to loopback.",
    );
  }
  return url.origin;
}

function isLoopbackHost(rawHostname: string): boolean {
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    return normalized.split(".")[0] === "127";
  }
  return (
    version === 6 &&
    (normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:1")
  );
}
