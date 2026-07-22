/**
 * Fail-closed host-binding helpers shared by HTTP-serving adapters and
 * operator surfaces. Single-sourcing
 * {@link isLoopbackHost} and {@link assertSafeBind} closes the drift where the
 * loopback predicate had been re-implemented (weaker) in several places and the
 * safe-bind guard was missing entirely in others.
 */
import type { Server, ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";

const DEFAULT_FORCE_CLOSE_AFTER_MS = 250;
const DEFAULT_MAX_PENDING_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_DRAIN_TIMEOUT_MS = 5_000;

/**
 * True only when the host is an exact loopback literal (or the exact conventional
 * `localhost` name). Hostname prefixes such as `127.attacker.example` are never
 * treated as loopback. Bracketed IPv6 and IPv4-mapped IPv6 literals are
 * normalized before classification.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostForBind(host).toLowerCase();
  if (normalized === "localhost") {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return normalized.split(".")[0] === "127";
  }
  if (family !== 6) {
    return false;
  }
  const canonical = canonicalIpv6(normalized);
  if (canonical === "::1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (mapped === null) {
    return false;
  }
  const highWord = Number.parseInt(mapped[1] ?? "", 16);
  return Number.isInteger(highWord) && (highWord >>> 8) === 127;
}

/** Remove URL-only brackets from an IPv6 bind host. Mismatched brackets remain invalid. */
export function normalizeHostForBind(host: string): string {
  if (host.startsWith("[") && host.endsWith("]") && host.length > 2) {
    const inner = host.slice(1, -1);
    return isIP(inner) === 6 ? inner : host;
  }
  return host;
}

/** True for the IPv4 and IPv6 unspecified addresses used to bind all interfaces. */
export function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostForBind(host).toLowerCase();
  if (normalized === "0.0.0.0") {
    return true;
  }
  if (isIP(normalized) !== 6) {
    return false;
  }
  const canonical = canonicalIpv6(normalized);
  if (canonical === "::") {
    return true;
  }
  // Node normalizes the IPv4-mapped unspecified address to an IPv6 wildcard
  // bind on supported dual-stack hosts. Treat it as wildcard before building
  // client URLs so an unspecified address is never advertised as a target.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  return mapped !== null
    && Number.parseInt(mapped[1] ?? "", 16) === 0
    && Number.parseInt(mapped[2] ?? "", 16) === 0;
}

/** Wrap a bare IPv6 host in brackets so it is safe to embed in a URL. */
export function hostForUrl(host: string): string {
  const normalized = normalizeHostForBind(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function canonicalIpv6(host: string): string {
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return host;
  }
}

/**
 * Refuse to bind a non-loopback host unless explicitly allowed. The caller
 * supplies the typed error so each adapter keeps its own error code/message.
 */
export function assertSafeBind(
  host: string,
  allowNonLoopback: boolean,
  onUnsafe: (host: string) => Error,
): void {
  if (allowNonLoopback || isLoopbackHost(host)) {
    return;
  }
  throw onUnsafe(host);
}

export interface ListenErrorFactories {
  /** Build the error raised when the underlying server emits a listen error. */
  readonly listenFailed: (reason: string) => Error;
  /** Build the error raised when no TCP address is available after listen. */
  readonly noAddress: () => Error;
}

/** Promisified `server.listen` that resolves with the bound TCP address. */
export function listen(
  server: Server,
  port: number,
  host: string,
  errors: ListenErrorFactories,
): Promise<AddressInfo> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(errors.listenFailed(error.message));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        rejectPromise(errors.noAddress());
        return;
      }
      resolvePromise(address);
    });
  });
}

/** Promisified `server.close`. */
export function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
  });
}

/**
 * Close an HTTP server without letting keep-alive or stuck request sockets make
 * adapter shutdown unbounded. Active sockets get one grace period before they
 * are force-closed, followed by one final bounded wait for Node's callback.
 */
export async function closeServerBounded(
  server: Server,
  forceCloseAfterMs = DEFAULT_FORCE_CLOSE_AFTER_MS,
): Promise<void> {
  const timeoutMs = positiveInteger(forceCloseAfterMs, DEFAULT_FORCE_CLOSE_AFTER_MS);
  const closePromise = close(server);
  void closePromise.catch(() => undefined);
  server.closeIdleConnections();
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const force = new Promise<"forced">((resolvePromise) => {
    forceTimer = setTimeout(() => {
      server.closeAllConnections();
      resolvePromise("forced");
    }, timeoutMs);
    forceTimer.unref?.();
  });
  const outcome = await Promise.race([closePromise.then(() => "closed" as const), force]);
  if (outcome === "closed") {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    return;
  }
  await Promise.race([
    closePromise.catch(() => undefined),
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export interface BoundedHttpResponseWriterOptions {
  /** Total UTF-8 bytes callers may queue while the socket is backpressured. */
  readonly maxPendingBytes?: number;
  /** Maximum time a single write may wait for the response's `drain` event. */
  readonly drainTimeoutMs?: number;
  /** Called once when the writer becomes unusable so the owning request can abort. */
  readonly onFailure?: (error: Error) => void;
}

/**
 * Serialize response writes and honor Node's writable backpressure signal.
 * This keeps fast model streams from growing the process heap behind a slow or
 * disconnected HTTP client.
 */
export class BoundedHttpResponseWriter {
  private readonly maxPendingBytes: number;
  private readonly drainTimeoutMs: number;
  private readonly onFailure: ((error: Error) => void) | undefined;
  private pendingBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    private readonly response: ServerResponse,
    options: BoundedHttpResponseWriterOptions = {},
  ) {
    this.maxPendingBytes = positiveInteger(options.maxPendingBytes, DEFAULT_MAX_PENDING_RESPONSE_BYTES);
    this.drainTimeoutMs = positiveInteger(options.drainTimeoutMs, DEFAULT_RESPONSE_DRAIN_TIMEOUT_MS);
    this.onFailure = options.onFailure;
  }

  write(frame: string): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const frameBytes = Buffer.byteLength(frame, "utf8");
    if (this.pendingBytes + frameBytes > this.maxPendingBytes) {
      const error = new Error(`HTTP response stream exceeded its ${this.maxPendingBytes}-byte pending-write limit.`);
      this.fail(error);
      return Promise.reject(error);
    }
    this.pendingBytes += frameBytes;
    const operation = this.tail.then(async () => {
      if (this.failure !== undefined) throw this.failure;
      await this.writeFrame(frame);
    });
    this.tail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.pendingBytes -= frameBytes;
    });
  }

  private async writeFrame(frame: string): Promise<void> {
    if (this.response.destroyed || this.response.writableEnded) {
      const error = new Error("HTTP response stream closed before the pending frame was written.");
      this.fail(error);
      throw error;
    }
    try {
      if (this.response.write(frame)) return;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      throw error;
    }
    try {
      await waitForDrain(this.response, this.drainTimeoutMs);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.onFailure?.(error);
  }
}

function waitForDrain(response: ServerResponse, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolvePromise();
    };
    const onClose = (): void => {
      cleanup();
      rejectPromise(new Error("HTTP response stream closed while waiting for writable capacity."));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`HTTP response stream did not drain within ${timeoutMs}ms.`));
    }, timeoutMs);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
