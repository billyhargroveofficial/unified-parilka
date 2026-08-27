import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CODEX_SUBSCRIPTION_REFRESH_URL = "https://auth.openai.com/oauth/token";
export const CODEX_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_SKEW_MS = 5 * 60_000;
const MAX_REFRESH_ERROR_CHARS = 4096;
const MAX_AUTH_FILE_BYTES = 128 * 1024;
const MAX_REFRESH_RESPONSE_BYTES = 32 * 1024;
const REFRESH_LOCK_WAIT_MS = 4_000;
const REFRESH_LOCK_STALE_MS = 30_000;
const MALFORMED_REFRESH_LOCK_STALE_MS = 5 * 60_000;
const REFRESH_LOCK_RETRY_MS = 50;

export interface CodexSubscriptionAuthSnapshot {
  readonly accessToken: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
}

export interface CodexSubscriptionAuthOptions {
  /** `authFile` is the production-facing spelling; path is retained for tests. */
  readonly authFile?: string;
  readonly authFilePath?: string;
  readonly refreshUrl?: string;
  readonly clientId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Test seam for independent Node runtimes sharing one auth file. */
  readonly processState?: CodexSubscriptionAuthProcessState;
}

export class CodexSubscriptionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSubscriptionAuthError";
  }
}

interface AuthFileTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  account_id?: unknown;
}

interface AuthFilePayload {
  auth_mode?: unknown;
  tokens?: AuthFileTokens;
  last_refresh?: unknown;
  [key: string]: unknown;
}

interface LoadedAuth {
  readonly payload: AuthFilePayload;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId?: string;
  readonly expiresAtMs?: number;
}

interface SharedAuthState {
  queue: Promise<void>;
}

/** Injectable only for isolated-runtime tests; production keeps one queue map. */
export class CodexSubscriptionAuthProcessState {
  readonly queues = new Map<string, SharedAuthState>();
}

const defaultProcessState = new CodexSubscriptionAuthProcessState();

/**
 * Redacts both supplied credentials and the common OAuth/JWT forms before an
 * error reaches systemd or Telegram diagnostics.
 */
export function redactCodexSubscriptionSecrets(value: string, secrets: readonly (string | undefined)[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/gu, "[redacted]");
}

/** A direct ChatGPT-subscription credential reader; it never invokes Codex. */
export class CodexSubscriptionAuthStore {
  readonly #authFilePath: string;
  readonly #refreshUrl: string;
  readonly #clientId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #shared: SharedAuthState;

  constructor(options: CodexSubscriptionAuthOptions) {
    const authFile = options.authFile ?? options.authFilePath;
    if (!authFile?.trim()) throw new CodexSubscriptionAuthError("Codex auth file path is required.");
    this.#authFilePath = resolve(authFile);
    this.#refreshUrl = options.refreshUrl ?? CODEX_SUBSCRIPTION_REFRESH_URL;
    this.#clientId = options.clientId ?? CODEX_SUBSCRIPTION_CLIENT_ID;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    const processState = options.processState ?? defaultProcessState;
    this.#shared = processState.queues.get(this.#authFilePath) ?? { queue: Promise.resolve() };
    processState.queues.set(this.#authFilePath, this.#shared);
  }

  /** Returns a current token, refreshing it under a process-wide per-file lock. */
  async snapshot(signal?: AbortSignal): Promise<CodexSubscriptionAuthSnapshot> {
    return this.#locked(async () => {
      throwIfAborted(signal);
      const auth = await this.#readAuthFile();
      if (!needsRefresh(auth, this.#now())) return publicSnapshot(auth);
      return publicSnapshot(await this.#refreshLocked(auth, signal));
    });
  }

  /** Retry path for exactly one upstream 401; callers own the one-retry limit. */
  async refreshAfterUnauthorized(signal?: AbortSignal): Promise<CodexSubscriptionAuthSnapshot> {
    return this.#locked(async () => {
      throwIfAborted(signal);
      return publicSnapshot(await this.#refreshLocked(await this.#readAuthFile(), signal));
    });
  }

  /**
   * Before rotating a token rejected by the backend, observe the shared auth
   * file once more. A concurrent Codex/maintenance refresh wins immediately.
   */
  async recoverAfterUnauthorized(rejectedAccessToken: string, signal?: AbortSignal): Promise<CodexSubscriptionAuthSnapshot> {
    return this.#locked(async () => {
      throwIfAborted(signal);
      const latest = await this.#readAuthFile();
      if (latest.accessToken !== rejectedAccessToken) return publicSnapshot(latest);
      return publicSnapshot(await this.#refreshLocked(latest, signal));
    });
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#shared.queue;
    let release: (() => void) | undefined;
    this.#shared.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #readAuthFile(): Promise<LoadedAuth> {
    const body = await readSecureAuthFile(this.#authFilePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new CodexSubscriptionAuthError(`Cannot parse Codex auth file: ${safeError(error)}.`);
    }
    if (!isRecord(parsed) || parsed.auth_mode !== "chatgpt" || !isRecord(parsed.tokens)) {
      throw new CodexSubscriptionAuthError("Codex auth file must contain chatgpt OAuth tokens.");
    }
    const payload = parsed as AuthFilePayload;
    const tokens = payload.tokens as AuthFileTokens;
    const accessToken = stringValue(tokens.access_token);
    if (!accessToken) throw new CodexSubscriptionAuthError("Codex auth file has no access token.");
    const refreshToken = stringValue(tokens.refresh_token);
    const idToken = stringValue(tokens.id_token);
    const accountId = firstDefined(stringValue(tokens.account_id), accountIdFromJwt(idToken), accountIdFromJwt(accessToken));
    if (!accountId) throw new CodexSubscriptionAuthError("Codex auth file has no ChatGPT account id.");
    const expiresAtMs = expirationFromJwt(accessToken);
    return {
      payload,
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      accountId,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  }

  async #refreshLocked(auth: LoadedAuth, signal?: AbortSignal): Promise<LoadedAuth> {
    if (!auth.refreshToken) throw new CodexSubscriptionAuthError("Codex access token needs refresh but no refresh token is available.");
    throwIfAborted(signal);
    try {
      const lease = await acquireRefreshLease(this.#authFilePath, signal);
      try {
        // Bot and maintenance can be different Node processes. Once this process
        // owns the lease, re-read the file: a prior owner may already have won.
        const beforeRequest = await this.#readAuthFile();
        if (beforeRequest.accessToken !== auth.accessToken) return beforeRequest;
        return await this.#performRefreshLocked(beforeRequest, signal);
      } finally {
        await lease.release();
      }
    } catch (error) {
      // Release before observing a peer: a peer blocked on this lock cannot
      // publish a replacement token while we still own it.
      const winner = await this.#waitForCrossProcessWinner(auth, signal);
      if (winner) return winner;
      throw error;
    }
  }

  async #performRefreshLocked(auth: LoadedAuth, signal?: AbortSignal): Promise<LoadedAuth> {
    let response: Response;
    try {
      response = await this.#fetch(this.#refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.#clientId, grant_type: "refresh_token", refresh_token: auth.refreshToken }),
        signal,
      });
    } catch (error) {
      throw new CodexSubscriptionAuthError(`Codex token refresh failed: ${safeError(error)}.`);
    }
    const raw = await readBoundedResponseText(
      response,
      response.ok ? MAX_REFRESH_RESPONSE_BYTES : MAX_REFRESH_ERROR_CHARS,
      signal,
    );
    if (!response.ok) {
      throw new CodexSubscriptionAuthError(`Codex token refresh HTTP ${response.status}: ${redactCodexSubscriptionSecrets(raw, [auth.accessToken, auth.refreshToken])}`);
    }
    let refreshed: unknown;
    try {
      refreshed = JSON.parse(raw);
    } catch {
      throw new CodexSubscriptionAuthError("Codex token refresh returned invalid JSON.");
    }
    if (!isRecord(refreshed) || !stringValue(refreshed.access_token)) {
      throw new CodexSubscriptionAuthError("Codex token refresh returned no access token.");
    }

    // Do not overwrite a concurrently refreshed CLI auth file with a stale
    // refresh-token lineage. The next request will use the external update.
    const latest = await this.#readAuthFile();
    if (latest.refreshToken !== auth.refreshToken) return latest;

    const tokens = { ...(latest.payload.tokens as AuthFileTokens) };
    tokens.access_token = stringValue(refreshed.access_token);
    tokens.refresh_token = stringValue(refreshed.refresh_token) ?? auth.refreshToken;
    if (stringValue(refreshed.id_token)) tokens.id_token = stringValue(refreshed.id_token);
    const accountId = firstDefined(
      stringValue(tokens.account_id),
      accountIdFromJwt(stringValue(refreshed.id_token)),
      accountIdFromJwt(stringValue(refreshed.access_token)),
      latest.accountId,
    );
    if (accountId) tokens.account_id = accountId;
    const nextPayload: AuthFilePayload = { ...latest.payload, tokens, last_refresh: new Date(this.#now()).toISOString() };
    await writeAuthFileAtomically(this.#authFilePath, nextPayload);
    return this.#readAuthFile();
  }

  async #waitForCrossProcessWinner(previous: LoadedAuth, signal?: AbortSignal): Promise<LoadedAuth | undefined> {
    for (const delayMs of [0, 75, 175]) {
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      const candidate = await this.#readAuthFile();
      if (candidate.accessToken !== previous.accessToken && !needsRefresh(candidate, this.#now())) return candidate;
    }
    return undefined;
  }
}

/** Backward-compatible short name for direct consumers of this isolated seam. */
export { CodexSubscriptionAuthStore as CodexSubscriptionAuth };

function publicSnapshot(auth: LoadedAuth): CodexSubscriptionAuthSnapshot {
  return {
    accessToken: auth.accessToken,
    ...(auth.accountId === undefined ? {} : { accountId: auth.accountId }),
    ...(auth.expiresAtMs === undefined ? {} : { expiresAtMs: auth.expiresAtMs }),
  };
}

function needsRefresh(auth: LoadedAuth, now: number): boolean {
  return auth.expiresAtMs === undefined || auth.expiresAtMs <= now + REFRESH_SKEW_MS;
}

async function assertSecureAuthFile(path: string): Promise<void> {
  const file = await openSecureAuthFile(path);
  try {
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function readSecureAuthFile(path: string): Promise<string> {
  const file = await openSecureAuthFile(path);
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function openSecureAuthFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  await assertSecureAuthDirectory(dirname(path));
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeErrorCode(error, "ELOOP")) {
      throw new CodexSubscriptionAuthError("Codex auth path must be a regular file, not a symlink.");
    }
    throw new CodexSubscriptionAuthError(`Cannot read Codex auth file: ${safeError(error)}.`);
  }
  let info: Awaited<ReturnType<typeof file.stat>>;
  try {
    info = await file.stat();
  } catch (error) {
    await file.close().catch(() => undefined);
    throw new CodexSubscriptionAuthError(`Cannot stat Codex auth file: ${safeError(error)}.`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    await file.close().catch(() => undefined);
    throw new CodexSubscriptionAuthError("Codex auth path must be a regular file, not a symlink.");
  }
  if (info.size > MAX_AUTH_FILE_BYTES) {
    await file.close().catch(() => undefined);
    throw new CodexSubscriptionAuthError("Codex auth file exceeds its safe size limit.");
  }
  if ((info.mode & 0o077) !== 0) {
    await file.close().catch(() => undefined);
    throw new CodexSubscriptionAuthError("Codex auth file must not be readable or writable by group or other users.");
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    await file.close().catch(() => undefined);
    throw new CodexSubscriptionAuthError("Codex auth file must be owned by the current user.");
  }
  return file;
}

async function assertSecureAuthDirectory(path: string): Promise<void> {
  const directoryInfo = await lstat(path).catch((error: unknown) => {
    throw new CodexSubscriptionAuthError(`Cannot inspect Codex auth directory: ${safeError(error)}.`);
  });
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o022) !== 0) {
    throw new CodexSubscriptionAuthError("Codex auth directory is not secure for credential reads.");
  }
}

async function writeAuthFileAtomically(path: string, payload: AuthFilePayload): Promise<void> {
  await assertSecureAuthFile(path);
  const directory = dirname(path);
  await assertSecureAuthDirectory(directory);
  const mode = 0o600;
  const temporaryPath = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporaryPath, "wx", mode);
    await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new CodexSubscriptionAuthError("Codex auth file permissions changed unexpectedly.");
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof CodexSubscriptionAuthError) throw error;
    throw new CodexSubscriptionAuthError(`Cannot persist refreshed Codex auth: ${safeError(error)}.`);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throwIfAborted(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      rejectDelay(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RefreshLease {
  release(): Promise<void>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function identityFrom(info: { dev: number; ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(info: { dev: number; ino: number }, expected: FileIdentity): boolean {
  return info.dev === expected.dev && info.ino === expected.ino;
}

async function acquireRefreshLease(authPath: string, signal: AbortSignal | undefined): Promise<RefreshLease> {
  const lockPath = `${authPath}.refresh.lock`;
  await assertSecureAuthDirectory(dirname(authPath));
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    throwIfAborted(signal);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(`${process.pid}:${randomBytes(12).toString("hex")}:${Date.now()}\n`, "utf8");
      await file.sync();
      const identity = identityFrom(await file.stat());
      await file.close();
      file = undefined;
      return { release: async () => { await unlinkIfIdentityMatches(lockPath, identity); } };
    } catch (error) {
      if (file) await file.close().catch(() => undefined);
      if (!isNodeErrorCode(error, "EEXIST")) {
        if (isNodeErrorCode(error, "ELOOP")) throw new CodexSubscriptionAuthError("Codex refresh lock must not be a symlink.");
        throw new CodexSubscriptionAuthError(`Cannot acquire Codex refresh lock: ${safeError(error)}.`);
      }
      const existing = await inspectRefreshLock(lockPath);
      if (refreshLockMayBeReclaimed(existing, Date.now())) {
        await unlinkIfIdentityMatches(lockPath, existing);
        continue;
      }
      if (Date.now() >= deadline) throw new CodexSubscriptionAuthError("Timed out waiting for the shared Codex refresh lock.");
      await abortableDelay(REFRESH_LOCK_RETRY_MS, signal);
    }
  }
}

interface RefreshLockInspection extends FileIdentity {
  readonly mtimeMs: number;
  readonly ownerPid?: number;
}

async function inspectRefreshLock(path: string): Promise<RefreshLockInspection> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { dev: -1, ino: -1, mtimeMs: 0 };
    if (isNodeErrorCode(error, "ELOOP")) throw new CodexSubscriptionAuthError("Codex refresh lock must not be a symlink.");
    throw new CodexSubscriptionAuthError(`Cannot inspect Codex refresh lock: ${safeError(error)}.`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 || (info.mode & 0o077) !== 0) {
      throw new CodexSubscriptionAuthError("Codex refresh lock is not an owner-only regular file.");
    }
    const getuid = process.getuid;
    if (typeof getuid === "function" && info.uid !== getuid()) {
      throw new CodexSubscriptionAuthError("Codex refresh lock must be owned by the current user.");
    }
    const contents = await file.readFile("utf8");
    return {
      ...identityFrom(info),
      mtimeMs: info.mtimeMs,
      ...(ownerPidFromRefreshLock(contents) === undefined ? {} : { ownerPid: ownerPidFromRefreshLock(contents) }),
    };
  } finally {
    await file.close().catch(() => undefined);
  }
}

function refreshLockMayBeReclaimed(lock: RefreshLockInspection, now: number): boolean {
  const age = now - lock.mtimeMs;
  if (lock.ownerPid === undefined) return age >= MALFORMED_REFRESH_LOCK_STALE_MS;
  // A long model/backend refresh is legitimate. Only a positively dead owner
  // permits reclaim; EPERM and every unknown process state fail closed.
  return age >= REFRESH_LOCK_STALE_MS && processIsDefinitelyDead(lock.ownerPid);
}

function ownerPidFromRefreshLock(value: string): number | undefined {
  const match = /^(?<pid>[1-9]\d{0,9}):[a-f0-9]{24}:\d+\n$/u.exec(value);
  if (!match?.groups?.pid) return undefined;
  const pid = Number(match.groups.pid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeErrorCode(error, "ESRCH");
  }
}

/** Verify inode/device immediately before unlinking; never clean a replacement lock. */
async function unlinkIfIdentityMatches(path: string, expected: FileIdentity): Promise<void> {
  if (expected.dev < 0 || expected.ino < 0) return;
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (current.isSymbolicLink() || !sameIdentity(current, expected)) return;
  await unlink(path).catch((error: unknown) => {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  });
}

async function readBoundedResponseText(response: Response, maximum: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await readReaderWithAbort(reader, signal);
      if (next.done) return text + decoder.decode();
      const remaining = maximum - bytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return `${text}…[truncated]`;
      }
      const accepted = next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value;
      text += decoder.decode(accepted, { stream: true });
      bytes += accepted.byteLength;
      if (accepted.byteLength !== next.value.byteLength) {
        await reader.cancel().catch(() => undefined);
        return `${text}${decoder.decode()}…[truncated]`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readReaderWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal?.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    throwIfAborted(signal);
  }
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>((resolveRead, rejectRead) => {
    const onAbort = (): void => {
      void reader.cancel(signal?.reason).catch(() => undefined);
      rejectRead(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => { signal?.removeEventListener("abort", onAbort); resolveRead(result); },
      (error: unknown) => { signal?.removeEventListener("abort", onAbort); rejectRead(error); },
    );
  });
}

function accountIdFromJwt(token: string | undefined): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  return firstDefined(
    stringValue(claims.chatgpt_account_id),
    stringValue(claims["https://api.openai.com/auth.chatgpt_account_id"]),
    isRecord(claims["https://api.openai.com/auth"])
      ? stringValue(claims["https://api.openai.com/auth"].chatgpt_account_id)
      : undefined,
    Array.isArray(claims.organizations) && isRecord(claims.organizations[0]) ? stringValue(claims.organizations[0].id) : undefined,
  );
}

function expirationFromJwt(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  const seconds = typeof exp === "number" ? exp : typeof exp === "string" ? Number(exp) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined;
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const [, encoded] = token.split(".", 3);
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return redactCodexSubscriptionSecrets(error instanceof Error ? error.message : String(error));
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
