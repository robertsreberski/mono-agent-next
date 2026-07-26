// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  SandboxExecutor,
  SandboxProcess,
  SandboxResult,
} from "@mono-agent/module-sdk/internal";

// Pi's accepted image payload can occupy 4.5 MiB before the small, content-only
// worker JSON envelope is added. Keep the transport bounded while preserving
// the same accepted-image behavior as direct execution.
export const RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

interface SandboxWorkerSuccess {
  readonly ok: true;
  readonly result: AgentToolResult<unknown>;
}

interface SandboxWorkerFailure {
  readonly ok: false;
  readonly error: string;
}

type SandboxWorkerResponse = SandboxWorkerSuccess | SandboxWorkerFailure;

export class RuntimePiSandboxTools {
  readonly #executor: SandboxExecutor;
  readonly #workspaceDirectory: string;
  readonly #workerPath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(executor: SandboxExecutor, workspaceDirectory: string) {
    this.#executor = executor;
    this.#workspaceDirectory = workspaceDirectory;
    this.#workerPath = fileURLToPath(new URL(
      import.meta.url.endsWith(".ts")
        ? "./sandbox-tools-worker.ts"
        : "./sandbox-tools-worker.js",
      import.meta.url,
    ));
  }

  spawnNodeRepl(): SandboxProcess {
    return this.#executor.spawn({
      command: process.execPath,
      arguments: nodeArguments(this.#nodeReplWorkerPath()),
      workingDirectory: this.#workspaceDirectory,
    });
  }

  async execute(
    toolId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    if (toolId !== "Write") {
      return this.#execute(toolId, params, signal);
    }
    const predecessor = this.#writeQueue;
    let release = (): void => undefined;
    const slot = new Promise<void>((resolveSlot) => {
      release = resolveSlot;
    });
    this.#writeQueue = predecessor.then(() => slot);
    try {
      await abortableWait(predecessor, signal);
      return await this.#execute(toolId, params, signal);
    } finally {
      release();
    }
  }

  async #execute(
    toolId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const stdin = Buffer.from(JSON.stringify({
      toolId,
      params,
      workspaceDirectory: this.#workspaceDirectory,
    }), "utf8");
    const result = await this.#executor.execute({
      command: process.execPath,
      arguments: nodeArguments(this.#workerPath),
      workingDirectory: this.#workspaceDirectory,
      stdin,
      signal,
    });
    const response = workerResponse(result);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  #nodeReplWorkerPath(): string {
    return fileURLToPath(new URL(
      import.meta.url.endsWith(".ts")
        ? "./node-repl-worker.ts"
        : "./node-repl-worker.js",
      import.meta.url,
    ));
  }
}

async function abortableWait(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let rejectAborted = (_reason?: unknown): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    rejectAborted(
      signal.reason ?? new DOMException("Sandboxed Pi tool aborted.", "AbortError"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([promise, aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function nodeArguments(path: string): readonly string[] {
  return Object.freeze([
    ...(path.endsWith(".ts")
      ? [
          "--no-warnings",
          "--experimental-strip-types",
          "--experimental-loader",
          fileURLToPath(new URL("./typescript-source-loader.mjs", import.meta.url)),
        ]
      : []),
    path,
  ]);
}

function workerResponse(result: SandboxResult): SandboxWorkerResponse {
  if (result.timedOut) throw new Error("Sandboxed Pi tool timed out.");
  if (result.signal !== undefined) {
    throw new Error(`Sandboxed Pi tool exited on ${result.signal}.`);
  }
  if (result.exitCode !== 0) {
    throw new Error("Sandboxed Pi tool worker failed.");
  }
  if (
    result.stdout.byteLength === 0
    || result.stdout.byteLength > RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES
    || result.stderr.byteLength !== 0
  ) {
    throw new Error("Sandboxed Pi tool worker returned an invalid response.");
  }
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Sandboxed Pi tool worker returned malformed JSON.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Sandboxed Pi tool worker returned an invalid response.");
  }
  const keys = Object.keys(decoded).sort();
  const ok = Reflect.get(decoded, "ok");
  if (ok === false) {
    if (
      keys.length !== 2
      || keys[0] !== "error"
      || keys[1] !== "ok"
      || typeof Reflect.get(decoded, "error") !== "string"
    ) {
      throw new Error("Sandboxed Pi tool worker returned an invalid failure.");
    }
    return {
      ok: false,
      error: (Reflect.get(decoded, "error") as string).slice(0, 4_096),
    };
  }
  if (
    ok !== true
    || keys.length !== 2
    || keys[0] !== "ok"
    || keys[1] !== "result"
  ) {
    throw new Error("Sandboxed Pi tool worker returned an invalid success.");
  }
  return {
    ok: true,
    result: agentToolResult(Reflect.get(decoded, "result")),
  };
}

function agentToolResult(value: unknown): AgentToolResult<unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandboxed Pi tool worker returned an invalid tool result.");
  }
  const authoredContent = Reflect.get(value, "content");
  if (!Array.isArray(authoredContent) || authoredContent.length > 1_024) {
    throw new Error("Sandboxed Pi tool worker returned invalid tool content.");
  }
  const content = authoredContent.map((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("Sandboxed Pi tool worker returned an invalid content part.");
    }
    const type = Reflect.get(part, "type");
    if (type === "text" && typeof Reflect.get(part, "text") === "string") {
      return {
        type: "text" as const,
        text: Reflect.get(part, "text") as string,
      };
    }
    if (
      type === "image"
      && typeof Reflect.get(part, "data") === "string"
      && typeof Reflect.get(part, "mimeType") === "string"
    ) {
      return {
        type: "image" as const,
        data: Reflect.get(part, "data") as string,
        mimeType: Reflect.get(part, "mimeType") as string,
      };
    }
    throw new Error("Sandboxed Pi tool worker returned an unsupported content part.");
  });
  return { content, details: undefined };
}
