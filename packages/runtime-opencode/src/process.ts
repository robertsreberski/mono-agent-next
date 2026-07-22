import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false },
) => ProcessLike;

export interface JsonlRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  readonly input?: string;
  readonly spawnProcess?: SpawnProcess;
  readonly onJson: (value: unknown) => void | Promise<void>;
}

export interface JsonlRunResult { readonly code: number; readonly stderr: string }

export class OpenCodeProcessTerminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeProcessTerminationError";
  }
}

function launchDefault(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }): ProcessLike {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

const TERMINATION_GRACE_MS = 1_000;

export function runJsonl(options: JsonlRunOptions): Promise<JsonlRunResult> {
  if (options.signal.aborted) return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
  const launch = options.spawnProcess ?? launchDefault;
  const child = launch(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false });
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let chain = Promise.resolve();
  let settled = false;
  let closed = false;

  return new Promise<JsonlRunResult>((resolve, reject) => {
    let failure: { readonly error: unknown } | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    };
    const finish = (error: unknown, result?: JsonlRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(result as JsonlRunResult);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* close/error remains the settlement authority */ }
    };
    const terminate = (error: unknown): void => {
      if (settled || failure !== undefined) return;
      failure = { error };
      try { child.stdin.end(); } catch { /* process termination remains authoritative */ }
      if (closed) return;
      kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        if (closed || settled) return;
        kill("SIGKILL");
        forceTimer = setTimeout(() => {
          finish(new OpenCodeProcessTerminationError("OpenCode process did not exit after SIGKILL"));
        }, TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }, TERMINATION_GRACE_MS);
      terminateTimer.unref?.();
    };
    const abort = (): void => terminate(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const fail = (error: Error): void => terminate(error);
    const line = (raw: string): void => {
      if (Buffer.byteLength(raw) > options.maxLineBytes) {
        fail(new Error("OpenCode output exceeds the configured line limit"));
        return;
      }
      if (raw.trim() === "") return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { fail(new Error("OpenCode emitted malformed JSONL")); return; }
      chain = chain.then(() => options.onJson(parsed));
      void chain.catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    };
    const timer = setTimeout(() => {
      terminate(new Error(`OpenCode process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref?.();
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (Buffer.byteLength(stdout) > options.maxLineBytes && !stdout.includes("\n")) {
        fail(new Error("OpenCode output exceeds the configured line limit"));
        return;
      }
      while (true) {
        const index = stdout.indexOf("\n");
        if (index < 0) break;
        line(stdout.slice(0, index));
        stdout = stdout.slice(index + 1);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const bytes = Buffer.byteLength(stderr);
      if (bytes > options.maxStderrBytes) stderr = Buffer.from(stderr).subarray(bytes - options.maxStderrBytes).toString("utf8");
    });
    child.stdin.once("error", (error: Error) => fail(error));
    child.once("error", (error) => {
      if (child.pid === undefined) finish(error);
      else fail(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (failure === undefined) {
        const tail = stdout + decoder.end();
        if (tail.trim() !== "") line(tail);
      }
      void chain.then(
        () => failure === undefined
          ? finish(undefined, { code: code ?? (signal === null ? 1 : 128), stderr })
          : finish(failure.error),
        (error: unknown) => finish(error),
      );
    });
    if (options.signal.aborted) abort();
    else {
      try { child.stdin.end(options.input ?? ""); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    }
  });
}

export async function capturePlainText(options: Omit<JsonlRunOptions, "onJson">): Promise<string> {
  if (options.signal.aborted) throw options.signal.reason;
  const launch = options.spawnProcess ?? launchDefault;
  const child = launch(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false });
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    let failure: { readonly error: unknown } | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
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
      try { child.kill(signal); } catch { /* close/error remains the settlement authority */ }
    };
    const terminate = (error: unknown): void => {
      if (settled || failure !== undefined) return;
      failure = { error };
      try { child.stdin.end(); } catch { /* process termination remains authoritative */ }
      if (closed) return;
      kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        if (closed || settled) return;
        kill("SIGKILL");
        forceTimer = setTimeout(() => finish(new OpenCodeProcessTerminationError("OpenCode version process did not exit after SIGKILL")), TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }, TERMINATION_GRACE_MS);
      terminateTimer.unref?.();
    };
    const abort = (): void => terminate(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => terminate(new Error("OpenCode version check timed out")), Math.min(options.timeoutMs, 10_000));
    timer.unref?.();
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
      if (Buffer.byteLength(output) > 16_384) terminate(new Error("OpenCode version output is too large"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      const bytes = Buffer.byteLength(stderr);
      if (bytes > options.maxStderrBytes) {
        stderr = Buffer.from(stderr).subarray(bytes - options.maxStderrBytes).toString("utf8");
      }
    });
    child.stdin.once("error", (error: Error) => terminate(error));
    child.once("error", (error) => {
      if (child.pid === undefined) finish(error);
      else terminate(error);
    });
    child.once("close", (code) => {
      closed = true;
      if (failure !== undefined) { finish(failure.error); return; }
      if (code === 0) { finish(); resolve(output.trim()); }
      else finish(new Error(`OpenCode version check failed${stderr === "" ? "" : `: ${stderr.trim()}`}`));
    });
    if (options.signal.aborted) abort();
    else {
      try { child.stdin.end(options.input ?? ""); }
      catch (error) { terminate(error instanceof Error ? error : new Error(String(error))); }
    }
  });
}
