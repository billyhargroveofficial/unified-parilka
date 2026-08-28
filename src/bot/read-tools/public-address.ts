import { lookup as dnsLookup } from "node:dns/promises";
import { type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

type Ipv6Prefix = readonly [readonly number[], number];

// Static snapshot of IANA's IPv6 unicast allocation table. Unlisted space
// fails closed rather than assuming every address in a global-unicast block is
// public. Special-purpose destinations are rejected separately below.
const ALLOCATED_PUBLIC_IPV6_PREFIXES: readonly Ipv6Prefix[] = [
  [[0x2001, 0x0000], 23], [[0x2001, 0x0200], 23],
  [[0x2001, 0x0400], 23], [[0x2001, 0x0600], 23],
  [[0x2001, 0x0800], 22], [[0x2001, 0x0c00], 23],
  [[0x2001, 0x0e00], 23], [[0x2001, 0x1200], 23],
  [[0x2001, 0x1400], 22], [[0x2001, 0x1800], 23],
  [[0x2001, 0x1a00], 23], [[0x2001, 0x1c00], 22],
  [[0x2001, 0x2000], 19], [[0x2001, 0x4000], 23],
  [[0x2001, 0x4200], 23], [[0x2001, 0x4400], 23],
  [[0x2001, 0x4600], 23], [[0x2001, 0x4800], 23],
  [[0x2001, 0x4a00], 23], [[0x2001, 0x4c00], 23],
  [[0x2001, 0x5000], 20], [[0x2001, 0x8000], 19],
  [[0x2001, 0xa000], 20], [[0x2001, 0xb000], 20],
  [[0x2002], 16], [[0x2003, 0x0000], 18],
  [[0x2400], 12], [[0x2410], 12], [[0x2600], 12],
  [[0x2610, 0x0000], 23], [[0x2620, 0x0000], 23],
  [[0x2630], 12], [[0x2800], 12], [[0x2a00], 12],
  [[0x2a10], 12], [[0x2c00], 12],
];

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export class PublicAddressError extends Error {
  readonly code = "unsafe_url";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Sync validation of a public HTTPS URL: scheme, credentials, port, private
 * hostnames and literal IPs. DNS resolution is checked separately via
 * `lookupPublicAddresses` + `isPublicAddress` before any connection.
 */
export function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicAddressError(
      "URL must be an absolute public HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    isPrivateHostname(url.hostname) ||
    isIP(policyHostname(url.hostname)) !== 0
  ) {
    throw new PublicAddressError(
      "URL must use a public hostname and default HTTPS port without credentials.",
    );
  }
  return url;
}

/**
 * Non-throwing sync check used for untrusted URL projection (search results,
 * crawl pages, image URLs). Same policy as `validatePublicHttpsUrl` without
 * DNS resolution: scheme, credentials, port, private hostnames, literal IPs.
 */
export function isPublicHttpsCandidate(value: string): boolean {
  try {
    validatePublicHttpsUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function isPrivateHostname(value: string): boolean {
  const hostname = policyHostname(value);
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan");
}

export function policyHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/u, "");
}

export function isPublicAddress(value: ResolvedAddress): boolean {
  if (isIP(value.address) !== value.family) {
    return false;
  }
  if (value.family === 6) {
    return isPublicIpv6Address(value.address);
  }
  return isPublicIpv4Address(value.address);
}

export async function lookupPublicAddresses(
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.flatMap((row) =>
    row.family === 4 || row.family === 6
      ? [{ address: row.address, family: row.family }]
      : [],
  );
}

export interface PinnedHttpsRequest {
  url: URL;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
  accept?: string;
  userAgent?: string;
}

export interface PinnedHttpsResponse {
  status: number;
  statusText?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class PinnedHttpsError extends Error {
  constructor(
    readonly code: "response_too_large" | "transport",
    message: string,
  ) {
    super(message);
  }
}

/**
 * DNS-pinned HTTPS request: connects directly to a pre-resolved public
 * address while sending the original hostname as Host header and SNI. Never
 * follows redirects, shares cookies, or sends credentials. The caller is
 * responsible for rejecting private DNS answers before calling this.
 */
export function requestPinnedHttps(
  input: PinnedHttpsRequest,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const onAbort = (): void => {
      request?.destroy(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Request was aborted."),
      );
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const rejectOnce = (error: unknown): void => {
      settle(() => reject(error));
    };
    request = httpsRequest(
      {
        protocol: "https:",
        hostname: input.address.address,
        family: input.address.family,
        port: 443,
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        headers: {
          Host: input.url.host,
          ...(input.accept === undefined ? {} : { Accept: input.accept }),
          ...(input.userAgent === undefined
            ? {}
            : { "User-Agent": input.userAgent }),
        },
        servername: input.url.hostname,
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
          if (byteLength > input.maxBytes) {
            response.destroy(
              new PinnedHttpsError(
                "response_too_large",
                "Response exceeded the byte limit.",
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", rejectOnce);
        response.once("end", () => {
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              ...(response.statusMessage === undefined
                ? {}
                : { statusText: response.statusMessage }),
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        });
      },
    );
    request.once("error", rejectOnce);
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    input.signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function isPublicIpv4Address(value: string): boolean {
  const octets = value.split(".").map(Number);
  const [first, second, third] = octets;
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) {
    return false;
  }
  return first !== undefined && second !== undefined && third !== undefined &&
    first > 0 && first < 224 && first !== 10 && first !== 127 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && (
      second === 0 || second === 2 || second === 168 ||
      (second === 88 && third === 99)
    )) &&
    !(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) &&
    !(first === 203 && second === 0 && third === 113);
}

function isPublicIpv6Address(value: string): boolean {
  const hextets = parseIpv6Hextets(value);
  if (hextets === undefined) {
    return false;
  }
  return ALLOCATED_PUBLIC_IPV6_PREFIXES.some(([prefix, bits]) =>
    hasIpv6Prefix(hextets, prefix, bits),
  ) && !isSpecialIpv6Address(hextets);
}

function parseIpv6Hextets(value: string): readonly number[] | undefined {
  // DNS returns unbracketed addresses. Deliberately reject IPv4-embedded
  // spelling too: it cannot establish that the mapped IPv4 target is public.
  if (value.includes(".")) {
    return undefined;
  }
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = parseIpv6Half(halves[0]!);
  const tail = parseIpv6Half(halves[1] ?? "");
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const omitted = 8 - head.length - tail.length;
  return omitted > 0
    ? [...head, ...Array<number>(omitted).fill(0), ...tail]
    : undefined;
}

function parseIpv6Half(value: string): number[] | undefined {
  if (!value) {
    return [];
  }
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) {
    return undefined;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function isSpecialIpv6Address(hextets: readonly number[]): boolean {
  return (
    // IETF protocol assignments, including 2001:0000::/32 Teredo.
    hasIpv6Prefix(hextets, [0x2001, 0x0000], 23) ||
    // Documentation address space.
    hasIpv6Prefix(hextets, [0x2001, 0x0db8]) ||
    // 6to4 and the AS112 special-use service.
    hasIpv6Prefix(hextets, [0x2002]) ||
    hasIpv6Prefix(hextets, [0x2620, 0x004f, 0x8000]) ||
    // Documentation space added beyond the original 2001:db8::/32 block.
    hasIpv6Prefix(hextets, [0x3fff, 0x0000], 20)
  );
}

function hasIpv6Prefix(
  address: readonly number[],
  prefix: readonly number[],
  bits = prefix.length * 16,
): boolean {
  const wholeHextets = Math.floor(bits / 16);
  const partialBits = bits % 16;
  if (prefix.length < wholeHextets + (partialBits === 0 ? 0 : 1)) {
    return false;
  }
  for (let index = 0; index < wholeHextets; index += 1) {
    if (address[index] !== prefix[index]) {
      return false;
    }
  }
  if (partialBits === 0) {
    return true;
  }
  const mask = (0xffff << (16 - partialBits)) & 0xffff;
  return (address[wholeHextets]! & mask) ===
    (prefix[wholeHextets]! & mask);
}
