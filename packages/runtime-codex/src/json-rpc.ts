import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
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
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.#fail(new Error("Codex app-server emitted malformed JSONL"));
        return;
      }
      if (message.id !== undefined && ("result" in message || "error" in message) && message.method === undefined) {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) pending.reject(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method !== undefined) {
        void this.#write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } })
          .catch((error: unknown) => this.#fail(error instanceof Error ? error : new Error(String(error))));
      }
      for (const listener of this.#listeners) listener(message);
    }
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
