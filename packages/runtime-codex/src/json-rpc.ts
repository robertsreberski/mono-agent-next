import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcMessage {
  readonly id: JsonRpcId;
  readonly method: string;
}

export type JsonRpcServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown>;

export class JsonRpcRequestError extends Error {
  readonly code: number | undefined;
  readonly rpcMessage: string | undefined;

  constructor(value: unknown) {
    const error = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const rpcMessage = typeof error.message === "string" ? error.message : undefined;
    super(rpcMessage === undefined
      ? "Codex app-server request failed"
      : `Codex app-server request failed: ${rpcMessage}`);
    this.name = "JsonRpcRequestError";
    this.code = typeof error.code === "number" && Number.isSafeInteger(error.code)
      ? error.code
      : undefined;
    this.rpcMessage = rpcMessage;
  }
}

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

export interface JsonRpcProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  readonly spawnProcess?: SpawnProcess;
}

const MAX_QUEUED_SERVER_REQUESTS = 16;

function defaultSpawn(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }): ProcessLike {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
}

export class JsonRpcProcess {
  readonly #child: ProcessLike;
  readonly #timeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly #listeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #decoder = new StringDecoder("utf8");
  #serverRequestHandler: JsonRpcServerRequestHandler | undefined;
  #serverRequestQueue: Promise<void> = Promise.resolve();
  #queuedServerRequests = 0;
  #nextId = 1;
  #stdout = "";
  #stderr = "";
  #closed = false;
  #processSettled = false;
  #closePromise: Promise<void> | undefined;
  #resolveProcessClosed!: () => void;
  readonly #processClosed = new Promise<void>((resolve) => { this.#resolveProcessClosed = resolve; });

  constructor(options: JsonRpcProcessOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#maxLineBytes = options.maxLineBytes;
    this.#maxStderrBytes = options.maxStderrBytes;
    const launch = options.spawnProcess ?? defaultSpawn;
    this.#child = launch(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false });
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer | string) => this.#onStderr(chunk));
    this.#child.once("error", (error) => {
      if (this.#child.pid === undefined) this.#settleProcess();
      this.#fail(error);
    });
    this.#child.once("close", (code, signal) => {
      this.#settleProcess();
      if (this.#closed) return;
      const suffix = this.#stderr === "" ? "" : `: ${this.#stderr}`;
      this.#fail(new Error(`Codex app-server exited ${signal ?? code ?? "unknown"}${suffix}`));
    });
  }

  subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  handleServerRequests(handler: JsonRpcServerRequestHandler): () => void {
    if (this.#serverRequestHandler !== undefined) {
      throw new Error("Codex app-server request handler is already registered");
    }
    this.#serverRequestHandler = handler;
    return () => {
      if (this.#serverRequestHandler === handler) this.#serverRequestHandler = undefined;
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("Codex app-server is not running");
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.#write({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.#write({ method, params });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = (async () => {
      this.#closed = true;
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Codex app-server closed"));
      }
      this.#pending.clear();
      this.#child.stdin.end();
      if (this.#processSettled) return;
      this.#child.kill("SIGTERM");
      if (await this.#waitForClose(1_000)) return;
      this.#child.kill("SIGKILL");
      if (!await this.#waitForClose(1_000)) throw new Error("Codex app-server did not exit after SIGKILL");
    })();
    return this.#closePromise;
  }

  async #write(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new Error("Codex app-server is not running");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.#maxLineBytes) throw new Error("Codex app-server request exceeds the configured line limit");
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error?: Error | null) => error == null ? resolve() : reject(error));
    });
  }

  #onStdout(chunk: Buffer | string): void {
    if (this.#closed) return;
    this.#stdout += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#stdout) > this.#maxLineBytes && !this.#stdout.includes("\n")) {
      this.#fail(new Error("Codex app-server output exceeds the configured line limit"));
      return;
    }
    while (true) {
      const newline = this.#stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#maxLineBytes) {
        this.#fail(new Error("Codex app-server output exceeds the configured line limit"));
        return;
      }
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#fail(new Error("Codex app-server emitted malformed JSONL"));
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.#fail(new Error("Codex app-server emitted a malformed JSON-RPC message"));
        return;
      }
      const message = parsed as JsonRpcMessage;
      if (
        message.id !== undefined
        && !(
          (typeof message.id === "number" && Number.isSafeInteger(message.id))
          || (
            typeof message.id === "string"
            && message.id.length > 0
            && message.id.length <= 256
            && !/[\u0000-\u001f\u007f]/u.test(message.id)
          )
        )
      ) {
        this.#fail(new Error("Codex app-server emitted an invalid JSON-RPC id"));
        return;
      }
      if (message.method !== undefined && typeof message.method !== "string") {
        this.#fail(new Error("Codex app-server emitted an invalid JSON-RPC method"));
        return;
      }
      if (
        typeof message.id === "number"
        && ("result" in message || "error" in message)
        && message.method === undefined
      ) {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) pending.reject(new JsonRpcRequestError(message.error));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method !== undefined) {
        const request: JsonRpcServerRequest = {
          id: message.id,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        };
        this.#enqueueServerRequest(request);
        continue;
      }
      for (const listener of this.#listeners) listener(message);
    }
  }

  #enqueueServerRequest(request: JsonRpcServerRequest): void {
    if (this.#queuedServerRequests >= MAX_QUEUED_SERVER_REQUESTS) {
      this.#fail(new Error(
        `Codex app-server exceeded the ${MAX_QUEUED_SERVER_REQUESTS}-request server queue limit`,
      ));
      return;
    }
    this.#queuedServerRequests += 1;
    const run = async (): Promise<void> => {
      try {
        if (this.#closed) return;
        const handler = this.#serverRequestHandler;
        if (handler === undefined) {
          await this.#write({
            id: request.id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${request.method}`,
            },
          });
          return;
        }
        try {
          const result = await handler(request);
          if (!this.#closed) await this.#write({ id: request.id, result });
        } catch {
          if (!this.#closed) {
            await this.#write({
              id: request.id,
              error: {
                code: -32000,
                message: "Codex server request failed closed",
              },
            });
          }
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.#queuedServerRequests -= 1;
      }
    };
    this.#serverRequestQueue = this.#serverRequestQueue.then(run, run);
  }

  #onStderr(chunk: Buffer | string): void {
    this.#stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const bytes = Buffer.byteLength(this.#stderr);
    if (bytes > this.#maxStderrBytes) {
      this.#stderr = Buffer.from(this.#stderr).subarray(bytes - this.#maxStderrBytes).toString("utf8");
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#listeners) {
      listener({ method: "$transport/closed", params: { message: error.message } });
    }
    void this.close();
  }

  #settleProcess(): void {
    if (this.#processSettled) return;
    this.#processSettled = true;
    this.#resolveProcessClosed();
  }

  async #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#processSettled) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const closed = this.#processClosed.then(() => true as const);
    const result = await Promise.race([closed, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }
}
