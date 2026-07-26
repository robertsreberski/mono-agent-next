// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type {
  SandboxProcessInput,
  SandboxProcessOutput,
} from "@mono-agent/module-sdk/internal";

export interface ProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: SandboxProcessInput;
  readonly stdout: SandboxProcessOutput;
  readonly stderr: SandboxProcessOutput;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false },
) => ProcessLike;

interface ProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  readonly spawnProcess?: SpawnProcess;
}

export interface OpenCodeServerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface OpenCodeServerProcess {
  readonly url: URL;
  readonly closed: Promise<OpenCodeServerExit>;
  readonly terminationFailed: Promise<OpenCodeProcessTerminationError>;
  readonly stderr: () => { readonly text: string; readonly truncated: boolean };
  readonly isClosing: () => boolean;
  close(): Promise<void>;
}

export class OpenCodeProcessTerminationError extends Error {
  readonly closed: Promise<unknown> | undefined;

  constructor(
    message: string,
    options: ErrorOptions & { readonly closed?: Promise<unknown> } = {},
  ) {
    const { closed, ...errorOptions } = options;
    super(message, errorOptions);
    this.name = "OpenCodeProcessTerminationError";
    this.closed = closed;
  }
}

function launchDefault(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false },
): ProcessLike {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

const TERMINATION_GRACE_MS = 1_000;
const SERVER_LISTEN_PREFIX = "opencode server listening on ";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function appendBoundedTail(
  current: Buffer,
  chunk: Uint8Array,
  maxBytes: number,
): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const bytes = Buffer.from(chunk);
  if (bytes.length >= maxBytes) {
    return Buffer.from(bytes.subarray(bytes.length - maxBytes));
  }
  const retainedBytes = Math.min(current.length, maxBytes - bytes.length);
  const retained = current.subarray(current.length - retainedBytes);
  return Buffer.concat([retained, bytes], retainedBytes + bytes.length);
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    void promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function startOpenCodeServerProcess(
  options: ProcessOptions & { readonly terminationGraceMs?: number },
): Promise<OpenCodeServerProcess> {
  if (options.signal.aborted) throw abortReason(options.signal);
  const launch = options.spawnProcess ?? launchDefault;
  const child = launch(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });
  const decoder = new StringDecoder("utf8");
  const startupOutputLimit = Math.min(options.maxLineBytes * 16, 16 * 1_024 * 1_024);
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;
  let stdout = "";
  let startupBytes = 0;
  let stderrBytes = 0;
  let stderrTruncated = false;
  const stderrChunks: Buffer[] = [];
  let closing = false;
  let closed = false;
  let readySettled = false;
  let terminationPromise: Promise<void> | undefined;
  let processError: Error | undefined;
  let terminationCause: unknown;
  let resolveExit!: (exit: OpenCodeServerExit) => void;
  const closedPromise = new Promise<OpenCodeServerExit>((resolve) => {
    resolveExit = resolve;
  });
  let resolveTerminationFailed!: (
    error: OpenCodeProcessTerminationError,
  ) => void;
  const terminationFailed = new Promise<OpenCodeProcessTerminationError>((resolve) => {
    resolveTerminationFailed = resolve;
  });

  const stderrSnapshot = (): { readonly text: string; readonly truncated: boolean } => ({
    text: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
    truncated: stderrTruncated,
  });
  const kill = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // The close event or bounded escalation remains authoritative.
    }
  };
  const terminate = (): Promise<void> => {
    terminationPromise ??= (async () => {
      try {
        child.stdin.end();
      } catch {
        // Continue with signal escalation.
      }
      kill("SIGTERM");
      if (await waitFor(closedPromise, terminationGraceMs)) return;
      kill("SIGKILL");
      if (await waitFor(closedPromise, terminationGraceMs)) return;
      throw new OpenCodeProcessTerminationError(
        "OpenCode server did not exit after SIGKILL",
        {
          closed: closedPromise,
          ...(terminationCause === undefined
            ? {}
            : { cause: terminationCause }),
        },
      );
    })();
    return terminationPromise;
  };
  const close = (): Promise<void> => {
    closing = true;
    return terminate();
  };

  const ready = new Promise<OpenCodeServerProcess>((resolveReady, rejectReady) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanupReady = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    };
    const failReady = (error: unknown): void => {
      if (readySettled) return;
      readySettled = true;
      terminationCause ??= error;
      cleanupReady();
      void close().then(
        () => rejectReady(error),
        (closeError: unknown) => rejectReady(closeError),
      );
    };
    const acceptReady = (url: URL): void => {
      if (readySettled) return;
      readySettled = true;
      cleanupReady();
      stdout = "";
      resolveReady({
        url,
        closed: closedPromise,
        terminationFailed,
        stderr: stderrSnapshot,
        isClosing: () => closing,
        close,
      });
    };
    const line = (raw: string): void => {
      if (Buffer.byteLength(raw, "utf8") > options.maxLineBytes) {
        failReady(new Error("OpenCode server startup output exceeds the configured line limit"));
        return;
      }
      if (!raw.startsWith(SERVER_LISTEN_PREFIX)) return;
      const candidate = raw.slice(SERVER_LISTEN_PREFIX.length).trim();
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        failReady(new Error("OpenCode server reported an invalid listening URL"));
        return;
      }
      const port = Number(url.port);
      if (
        url.protocol !== "http:"
        || url.hostname !== "127.0.0.1"
        || !Number.isSafeInteger(port)
        || port < 1
        || port > 65_535
        || url.username !== ""
        || url.password !== ""
      ) {
        failReady(new Error("OpenCode server did not bind to an authenticated loopback HTTP endpoint"));
        return;
      }
      acceptReady(url);
    };
    const onAbort = (): void => failReady(abortReason(options.signal));
    const onStdioError = (error: Error): void => {
      if (closed) return;
      processError ??= error;
      if (!readySettled) {
        failReady(error);
        return;
      }
      terminationCause ??= error;
      void terminate().catch((error: unknown) => {
        if (closing) return;
        resolveTerminationFailed(
          error instanceof OpenCodeProcessTerminationError
            ? error
            : new OpenCodeProcessTerminationError(String(error)),
        );
      });
    };
    timer = setTimeout(() => {
      failReady(new Error(`OpenCode server startup timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref?.();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      if (readySettled) return;
      const bytes = Buffer.from(chunk);
      startupBytes += bytes.length;
      if (startupBytes > startupOutputLimit) {
        failReady(new Error("OpenCode server startup output exceeds the configured total limit"));
        return;
      }
      stdout += decoder.write(bytes);
      if (Buffer.byteLength(stdout, "utf8") > options.maxLineBytes && !stdout.includes("\n")) {
        failReady(new Error("OpenCode server startup output exceeds the configured line limit"));
        return;
      }
      while (true) {
        const index = stdout.indexOf("\n");
        if (index < 0) break;
        line(stdout.slice(0, index).replace(/\r$/u, ""));
        stdout = stdout.slice(index + 1);
        if (readySettled) return;
      }
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = options.maxStderrBytes - stderrBytes;
      if (remaining > 0) {
        const selected = bytes.subarray(0, Math.min(remaining, bytes.length));
        stderrChunks.push(Buffer.from(selected));
        stderrBytes += selected.length;
      }
      if (bytes.length > remaining) stderrTruncated = true;
    });
    child.stdin.on("error", onStdioError);
    child.stdout.on("error", onStdioError);
    child.stderr.on("error", onStdioError);
    child.once("error", (error) => {
      processError = error;
      if (readySettled) {
        if (child.pid === undefined && !closed) {
          closed = true;
          resolveExit({ code: null, signal: null, error });
          return;
        }
        onStdioError(error);
        return;
      }
      if (child.pid === undefined && !closed) {
        closed = true;
        resolveExit({ code: null, signal: null, error });
      }
      failReady(error);
    });
    child.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      resolveExit({
        code,
        signal,
        ...(processError === undefined ? {} : { error: processError }),
      });
      if (!readySettled) {
        const captured = stderrSnapshot();
        const detail = captured.text.trim();
        failReady(new Error(
          `OpenCode server exited before reporting readiness`
          + (detail === "" ? "" : `: ${detail}`)
          + (captured.truncated ? " [stderr truncated]" : ""),
        ));
      }
    });
    if (options.signal.aborted) onAbort();
    else {
      try {
        child.stdin.end();
      } catch (error) {
        failReady(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  return ready;
}

export async function capturePlainText(
  options: ProcessOptions & { readonly input?: string },
): Promise<string> {
  if (options.signal.aborted) throw abortReason(options.signal);
  const launch = options.spawnProcess ?? launchDefault;
  const child = launch(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });
  return new Promise<string>((resolve, reject) => {
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let failure: { readonly error: unknown } | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // Close/error remains the settlement authority.
      }
    };
    const terminate = (error: unknown): void => {
      if (settled || failure !== undefined) return;
      failure = { error };
      try {
        child.stdin.end();
      } catch {
        // Process termination remains authoritative.
      }
      if (closed) return;
      kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        if (closed || settled) return;
        kill("SIGKILL");
        forceTimer = setTimeout(() => {
          finish(new OpenCodeProcessTerminationError(
            "OpenCode version process did not exit after SIGKILL",
            {
              closed: closedPromise,
              ...(failure === undefined ? {} : { cause: failure.error }),
            },
          ));
        }, TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }, TERMINATION_GRACE_MS);
      terminateTimer.unref?.();
    };
    const abort = (): void => terminate(abortReason(options.signal));
    const timer = setTimeout(
      () => terminate(new Error("OpenCode version check timed out")),
      Math.min(options.timeoutMs, 10_000),
    );
    timer.unref?.();
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > 16_384) {
        terminate(new Error("OpenCode version output is too large"));
        return;
      }
      outputChunks.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedTail(stderr, chunk, options.maxStderrBytes);
    });
    child.stdin.on("error", (error) => terminate(error));
    child.stdout.on("error", (error) => terminate(error));
    child.stderr.on("error", (error) => terminate(error));
    child.once("error", (error) => {
      if (child.pid === undefined) finish(error);
      else terminate(error);
    });
    child.once("close", (code) => {
      closed = true;
      resolveClosed();
      if (failure !== undefined) {
        finish(failure.error);
        return;
      }
      if (code === 0) {
        finish();
        resolve(Buffer.concat(outputChunks, outputBytes).toString("utf8").trim());
      } else {
        const stderrText = stderr.toString("utf8").trim();
        finish(new Error(
          `OpenCode version check failed${stderrText === "" ? "" : `: ${stderrText}`}`,
        ));
      }
    });
    if (options.signal.aborted) abort();
    else {
      try {
        child.stdin.end(options.input ?? "");
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
