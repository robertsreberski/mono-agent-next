// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_REPL_TIMEOUT_MS = 120_000;
export const NODE_REPL_MAX_CODE_BYTES = 256 * 1024;
const NODE_REPL_MAX_OUTPUT_BYTES = 256 * 1024;
const NODE_REPL_KILL_GRACE_MS = 1_000;

interface WorkerRequest {
  readonly type: "evaluate";
  readonly id: string;
  readonly code: string;
}

interface WorkerResult {
  readonly type: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly reset?: boolean;
  readonly text: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface PendingEvaluation {
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
  readonly timeout: NodeJS.Timeout;
}

interface ReplProcess {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  closed: boolean;
  killTimer?: NodeJS.Timeout;
  spawnError?: Error;
  failureReason?: string;
  pending?: PendingEvaluation;
  directOutputBytes: number;
}

export interface NodeReplController {
  execute(input: { readonly code: string }, options?: { readonly signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try {
      process.kill(child.pid, signal);
    } catch {
      // The child already exited.
    }
  }
}

function clearPending(record: ReplProcess, pending: PendingEvaluation): void {
  if (record.pending === pending) delete record.pending;
  clearTimeout(pending.timeout);
  pending.signal?.removeEventListener("abort", pending.onAbort);
}

function clearRequestOutput(record: ReplProcess): void {
  record.stdout.length = 0;
  record.stderr.length = 0;
  record.directOutputBytes = 0;
  delete record.failureReason;
}

function appendDirectOutput(record: ReplProcess, target: Buffer[], chunk: Buffer): void {
  record.directOutputBytes += chunk.byteLength;
  if (record.directOutputBytes > NODE_REPL_MAX_OUTPUT_BYTES) {
    record.failureReason =
      `Node REPL output exceeded ${String(NODE_REPL_MAX_OUTPUT_BYTES)} bytes.`;
    void terminateRecord(record);
    return;
  }
  target.push(Buffer.from(chunk));
}

function combinedOutput(
  record: ReplProcess,
  result: WorkerResult,
): string {
  const sections: string[] = [];
  const stdout = `${result.stdout ?? ""}${Buffer.concat(record.stdout).toString("utf8")}`.trimEnd();
  const stderr = `${result.stderr ?? ""}${Buffer.concat(record.stderr).toString("utf8")}`.trimEnd();
  if (stdout !== "") sections.push(`STDOUT:\n${stdout}`);
  if (stderr !== "") sections.push(`STDERR:\n${stderr}`);
  const text = result.text.trimEnd();
  if (text !== "") sections.push(text);
  const output = sections.join("\n") || "(no output)";
  if (Buffer.byteLength(output, "utf8") > NODE_REPL_MAX_OUTPUT_BYTES) {
    throw new Error(
      `Node REPL output exceeded ${String(NODE_REPL_MAX_OUTPUT_BYTES)} bytes.`,
    );
  }
  return output;
}

function isWorkerResult(value: unknown, id: string): value is WorkerResult {
  return value !== null
    && typeof value === "object"
    && Reflect.get(value, "type") === "result"
    && Reflect.get(value, "id") === id
    && typeof Reflect.get(value, "ok") === "boolean"
    && typeof Reflect.get(value, "text") === "string"
    && (Reflect.get(value, "reset") === undefined || typeof Reflect.get(value, "reset") === "boolean")
    && (Reflect.get(value, "stdout") === undefined || typeof Reflect.get(value, "stdout") === "string")
    && (Reflect.get(value, "stderr") === undefined || typeof Reflect.get(value, "stderr") === "string");
}

async function terminateRecord(record: ReplProcess): Promise<void> {
  if (record.closed) {
    await record.done;
    return;
  }
  killProcessGroup(record.child, "SIGTERM");
  record.killTimer ??= setTimeout(
    () => killProcessGroup(record.child, "SIGKILL"),
    NODE_REPL_KILL_GRACE_MS,
  );
  record.killTimer.unref();
  await record.done;
}

/**
 * Create one lazily started, run-scoped Node REPL.
 *
 * This executor is intentionally not a sandbox boundary. Callers must expose it
 * only after Core accepts the native-tool descriptor with sandbox mode off.
 */
export function createNodeReplController(
  workspaceDirectory: string,
): NodeReplController {
  const cwd = resolve(workspaceDirectory);
  const workerPath = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./node-repl-worker.ts" : "./node-repl-worker.js",
    import.meta.url,
  ));
  let current: ReplProcess | undefined;
  let starting: Promise<ReplProcess> | undefined;
  let permanentlyClosed = false;
  let nextRequestId = 0;

  async function startChild(): Promise<ReplProcess> {
    if (permanentlyClosed) throw new Error("Node REPL run has already ended.");
    const child = spawn(
      process.execPath,
      [...(workerPath.endsWith(".ts") ? ["--no-warnings"] : []), workerPath],
      {
        cwd,
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    const record: ReplProcess = {
      child,
      done,
      resolveDone,
      stdout: [],
      stderr: [],
      closed: false,
      directOutputBytes: 0,
    };
    current = record;

    child.stdout?.on("data", (chunk: Buffer) => {
      appendDirectOutput(record, record.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendDirectOutput(record, record.stderr, chunk);
    });
    child.once("error", (error) => {
      record.spawnError = error;
    });
    child.on("message", (message: unknown) => {
      const pending = record.pending;
      if (pending === undefined || !isWorkerResult(message, pending.id)) return;
      clearPending(record, pending);
      setImmediate(async () => {
        let output: string;
        try {
          output = combinedOutput(record, message);
        } catch (error) {
          await terminateRecord(record);
          pending.reject(new Error(`${errorMessage(error)} Session state was reset.`));
          return;
        }
        if (message.reset === true) await terminateRecord(record);
        if (message.ok) pending.resolve(output);
        else pending.reject(new Error(output));
      });
    });
    child.once("close", (code, signal) => {
      record.closed = true;
      if (record.killTimer !== undefined) clearTimeout(record.killTimer);
      if (current === record) current = undefined;
      const pending = record.pending;
      if (pending !== undefined) {
        clearPending(record, pending);
        const reason = record.failureReason
          ?? (record.spawnError === undefined ? undefined : errorMessage(record.spawnError))
          ?? `Node REPL process exited before evaluation completed${
            signal === null ? ` (code ${String(code ?? "unknown")})` : ` (${signal})`
          }.`;
        pending.reject(new Error(`${reason} Session state was reset.`));
      }
      record.resolveDone();
    });
    return record;
  }

  async function ensureChild(): Promise<ReplProcess> {
    if (permanentlyClosed) throw new Error("Node REPL run has already ended.");
    if (current !== undefined && !current.closed) return current;
    starting ??= startChild().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function resetForFailure(
    record: ReplProcess,
    pending: PendingEvaluation,
    message: string,
  ): Promise<void> {
    clearPending(record, pending);
    await terminateRecord(record);
    pending.reject(new Error(`${message} Session state was reset.`));
  }

  return {
    async execute({ code }, execution = {}) {
      if (typeof code !== "string" || code.trim().length === 0) {
        throw new Error("Node REPL code must not be empty.");
      }
      if (Buffer.byteLength(code, "utf8") > NODE_REPL_MAX_CODE_BYTES) {
        throw new Error(
          `Node REPL code exceeds ${String(NODE_REPL_MAX_CODE_BYTES)} bytes.`,
        );
      }
      if (execution.signal?.aborted === true) {
        throw execution.signal.reason
          ?? new DOMException("Node REPL execution aborted.", "AbortError");
      }
      const record = await ensureChild();
      if (Boolean(execution.signal?.aborted)) {
        await terminateRecord(record);
        throw new Error("Node REPL execution aborted. Session state was reset.");
      }
      if (record.pending !== undefined) {
        throw new Error("Node REPL is already evaluating code.");
      }
      clearRequestOutput(record);
      nextRequestId += 1;
      const id = `node-repl-${String(nextRequestId)}-${randomUUID()}`;

      return new Promise<string>((resolveResult, rejectResult) => {
        let pending: PendingEvaluation;
        const onAbort = (): void => {
          void resetForFailure(record, pending, "Node REPL execution aborted.");
        };
        const timeout = setTimeout(() => {
          void resetForFailure(
            record,
            pending,
            `Node REPL execution timed out after ${String(NODE_REPL_TIMEOUT_MS)}ms.`,
          );
        }, NODE_REPL_TIMEOUT_MS);
        timeout.unref();
        pending = {
          id,
          ...(execution.signal === undefined ? {} : { signal: execution.signal }),
          resolve: resolveResult,
          reject: rejectResult,
          onAbort,
          timeout,
        };
        record.pending = pending;
        execution.signal?.addEventListener("abort", onAbort, { once: true });
        if (execution.signal?.aborted === true) {
          onAbort();
          return;
        }
        if (record.child.send === undefined) {
          void resetForFailure(record, pending, "Node REPL IPC is unavailable.");
          return;
        }
        record.child.send(
          { type: "evaluate", id, code } satisfies WorkerRequest,
          (error) => {
            if (error !== null && record.pending === pending) {
              void resetForFailure(
                record,
                pending,
                `Node REPL IPC failed: ${errorMessage(error)}.`,
              );
            }
          },
        );
      });
    },

    async close() {
      if (permanentlyClosed) return;
      permanentlyClosed = true;
      if (starting !== undefined) {
        try {
          await starting;
        } catch {
          // A start failure is already reported to the active evaluation.
        }
      }
      if (current !== undefined) await terminateRecord(current);
    },
  };
}
