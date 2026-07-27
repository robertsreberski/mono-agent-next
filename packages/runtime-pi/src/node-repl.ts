// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import type { SandboxProcess } from "@mono-agent/module-sdk/internal";

const NODE_REPL_TIMEOUT_MS = 120_000;
export const NODE_REPL_MAX_CODE_BYTES = 256 * 1024;
const NODE_REPL_MAX_OUTPUT_BYTES = 256 * 1024;
const NODE_REPL_MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const NODE_REPL_KILL_GRACE_MS = 1_000;
const NODE_REPL_CONTROL_PREFIX = "\u001eMONO_AGENT_NODE_REPL_V1:";
const NODE_REPL_CONTROL_PREFIX_BYTES = Buffer.from(NODE_REPL_CONTROL_PREFIX, "utf8");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
  readonly child: SandboxProcess;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly sandboxOwned: boolean;
  readonly terminationGraceMs: number;
  readonly quarantine: (error: NodeReplTerminationError) => void;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  closed: boolean;
  spawnError?: Error;
  failureReason?: string;
  pending?: PendingEvaluation;
  protocolBuffer: Buffer;
  directOutputBytes: number;
  terminationPromise?: Promise<void>;
}

export interface NodeReplController {
  execute(input: { readonly code: string }, options?: { readonly signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

export interface NodeReplControllerOptions {
  /**
   * Supplying this factory transfers child creation and process ownership
   * to the selected Core sandbox. Without it, runtime-pi uses its host child.
   */
  readonly spawnProcess?: () => SandboxProcess;
  /** Internal lifecycle bound used by focused process-facade tests. */
  readonly terminationGraceMs?: number;
}

export class NodeReplTerminationError extends Error {
  constructor() {
    super("Node REPL process did not close after SIGKILL; controller is quarantined.");
    this.name = "NodeReplTerminationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directNodeReplProcess(cwd: string, workerPath: string): SandboxProcess {
  const child = spawn(
    process.execPath,
    [
      ...(workerPath.endsWith(".ts")
        ? ["--no-warnings", "--experimental-strip-types"]
        : []),
      workerPath,
    ],
    {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("Node REPL stdio is unavailable.");
  }
  return child as unknown as SandboxProcess;
}

function selectedNodeReplProcess(value: unknown): SandboxProcess {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Selected sandbox returned an invalid Node REPL process facade.");
  }
  const child = value as Partial<SandboxProcess>;
  if (
    child.stdin === null
    || typeof child.stdin !== "object"
    || typeof child.stdin.write !== "function"
    || typeof child.stdin.end !== "function"
    || typeof child.stdin.on !== "function"
    || child.stdout === null
    || typeof child.stdout !== "object"
    || typeof child.stdout.on !== "function"
    || child.stderr === null
    || typeof child.stderr !== "object"
    || typeof child.stderr.on !== "function"
    || typeof child.once !== "function"
    || typeof child.kill !== "function"
  ) {
    throw new Error("Selected sandbox returned an invalid Node REPL process facade.");
  }
  return child as SandboxProcess;
}

function terminateProcess(record: ReplProcess, signal: NodeJS.Signals): void {
  if (record.closed) return;
  if (record.sandboxOwned) {
    try {
      record.child.kill(signal);
    } catch {
      // The close event remains authoritative.
    }
    return;
  }
  if (record.child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-record.child.pid, signal);
      return;
    } catch {
      // Fall back to the direct host child facade below.
    }
  }
  try {
    record.child.kill(signal);
  } catch {
    // The close event remains authoritative.
  }
}

function clearPending(record: ReplProcess, pending: PendingEvaluation): void {
  if (record.pending === pending) delete record.pending;
  clearTimeout(pending.timeout);
  pending.signal?.removeEventListener("abort", pending.onAbort);
}

function clearSettledOutput(record: ReplProcess): void {
  record.stdout.length = 0;
  record.stderr.length = 0;
  record.directOutputBytes = 0;
}

function appendDirectOutput(
  record: ReplProcess,
  target: Buffer[],
  chunk: Buffer,
): void {
  record.directOutputBytes += chunk.byteLength;
  if (record.directOutputBytes > NODE_REPL_MAX_OUTPUT_BYTES) {
    record.failureReason =
      `Node REPL output exceeded ${String(NODE_REPL_MAX_OUTPUT_BYTES)} bytes.`;
    void terminateRecord(record).catch(() => undefined);
    return;
  }
  target.push(Buffer.from(chunk));
}

function combinedOutput(
  record: ReplProcess,
  result: WorkerResult,
): string {
  const sections: string[] = [];
  const stdout = `${result.stdout ?? ""}${
    Buffer.concat(record.stdout).toString("utf8")
  }`.trimEnd();
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) =>
    !["type", "id", "ok", "reset", "text", "stdout", "stderr"].includes(key))) {
    return false;
  }
  return Reflect.get(value, "type") === "result"
    && Reflect.get(value, "id") === id
    && typeof Reflect.get(value, "ok") === "boolean"
    && typeof Reflect.get(value, "text") === "string"
    && (Reflect.get(value, "reset") === undefined || typeof Reflect.get(value, "reset") === "boolean")
    && (Reflect.get(value, "stdout") === undefined || typeof Reflect.get(value, "stdout") === "string")
    && (Reflect.get(value, "stderr") === undefined || typeof Reflect.get(value, "stderr") === "string");
}

function waitForDone(record: ReplProcess): Promise<boolean> {
  return new Promise<boolean>((resolveDone) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveDone(false);
    }, record.terminationGraceMs);
    timer.unref();
    void record.done.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone(true);
    });
  });
}

async function terminateRecord(record: ReplProcess): Promise<void> {
  if (record.closed) {
    await record.done;
    return;
  }
  record.terminationPromise ??= (async () => {
    terminateProcess(record, "SIGTERM");
    if (await waitForDone(record)) return;
    terminateProcess(record, "SIGKILL");
    if (await waitForDone(record)) return;
    const failure = new NodeReplTerminationError();
    record.quarantine(failure);
    const pending = record.pending;
    if (pending !== undefined) {
      clearPending(record, pending);
      pending.reject(new Error(`${failure.message} Session state was reset.`));
    }
    throw failure;
  })();
  return record.terminationPromise;
}

/**
 * Create one lazily started, run-scoped Node REPL.
 *
 * With `spawnProcess`, the persistent worker runs through Core's selected
 * sandbox executor. Without it, runtime-pi owns an ordinary host child.
 */
export function createNodeReplController(
  workspaceDirectory: string,
  options: NodeReplControllerOptions = {},
): NodeReplController {
  const cwd = resolve(workspaceDirectory);
  const workerPath = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./node-repl-worker.ts" : "./node-repl-worker.js",
    import.meta.url,
  ));
  const terminationGraceMs =
    options.terminationGraceMs ?? NODE_REPL_KILL_GRACE_MS;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new Error("Node REPL termination grace must be a positive safe integer.");
  }
  let current: ReplProcess | undefined;
  let starting: Promise<ReplProcess> | undefined;
  let permanentlyClosed = false;
  let quarantineFailure: NodeReplTerminationError | undefined;
  let closePromise: Promise<void> | undefined;
  let nextRequestId = 0;

  async function handleWorkerResult(
    record: ReplProcess,
    message: WorkerResult,
    pending: PendingEvaluation,
  ): Promise<void> {
    clearPending(record, pending);
    let output: string;
    try {
      output = combinedOutput(record, message);
    } catch (error) {
      await terminateRecord(record);
      pending.reject(new Error(`${errorMessage(error)} Session state was reset.`));
      return;
    }
    clearSettledOutput(record);
    if (message.reset === true) await terminateRecord(record);
    if (message.ok) pending.resolve(output);
    else pending.reject(new Error(output));
  }

  function failProtocol(record: ReplProcess, message: string): void {
    if (record.failureReason === undefined) record.failureReason = message;
    void terminateRecord(record).catch(() => undefined);
  }

  function acceptProtocolOutput(record: ReplProcess, chunk: Buffer): void {
    if (record.closed || record.failureReason !== undefined) return;
    record.protocolBuffer = Buffer.concat([record.protocolBuffer, chunk]);
    for (;;) {
      const prefix = record.protocolBuffer.indexOf(NODE_REPL_CONTROL_PREFIX_BYTES);
      if (prefix < 0) {
        const retainedBytes = Math.min(
          record.protocolBuffer.byteLength,
          NODE_REPL_CONTROL_PREFIX_BYTES.byteLength - 1,
        );
        const flushBytes = record.protocolBuffer.byteLength - retainedBytes;
        if (flushBytes > 0) {
          appendDirectOutput(
            record,
            record.stdout,
            record.protocolBuffer.subarray(0, flushBytes),
          );
          record.protocolBuffer = record.protocolBuffer.subarray(flushBytes);
        }
        return;
      }
      if (prefix > 0) {
        appendDirectOutput(
          record,
          record.stdout,
          record.protocolBuffer.subarray(0, prefix),
        );
        record.protocolBuffer = record.protocolBuffer.subarray(prefix);
        if (record.failureReason !== undefined) return;
      }
      const newline = record.protocolBuffer.indexOf(
        0x0a,
        NODE_REPL_CONTROL_PREFIX_BYTES.byteLength,
      );
      if (newline < 0) {
        if (record.protocolBuffer.byteLength > NODE_REPL_MAX_PROTOCOL_LINE_BYTES) {
          failProtocol(record, "Node REPL protocol output exceeded its bounded line limit.");
        }
        return;
      }
      const line = record.protocolBuffer.subarray(
        NODE_REPL_CONTROL_PREFIX_BYTES.byteLength,
        newline,
      );
      record.protocolBuffer = record.protocolBuffer.subarray(newline + 1);
      const pending = record.pending;
      if (pending === undefined || line.byteLength === 0) {
        failProtocol(record, "Node REPL worker returned an unexpected protocol message.");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(UTF8_DECODER.decode(line)) as unknown;
      } catch {
        failProtocol(record, "Node REPL worker returned malformed protocol JSON.");
        return;
      }
      if (!isWorkerResult(decoded, pending.id)) {
        failProtocol(record, "Node REPL worker returned an invalid protocol result.");
        return;
      }
      void handleWorkerResult(record, decoded, pending).catch((error: unknown) => {
        pending.reject(new Error(`${errorMessage(error)} Session state was reset.`));
      });
    }
  }

  async function startChild(): Promise<ReplProcess> {
    if (permanentlyClosed) throw new Error("Node REPL run has already ended.");
    const child = options.spawnProcess === undefined
      ? directNodeReplProcess(cwd, workerPath)
      : selectedNodeReplProcess(options.spawnProcess());
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    const record: ReplProcess = {
      child,
      done,
      resolveDone,
      sandboxOwned: options.spawnProcess !== undefined,
      terminationGraceMs,
      quarantine(error) {
        quarantineFailure ??= error;
      },
      stdout: [],
      stderr: [],
      closed: false,
      protocolBuffer: Buffer.alloc(0),
      directOutputBytes: 0,
    };
    current = record;

    child.stdout.on("data", (chunk) => {
      acceptProtocolOutput(record, Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      appendDirectOutput(record, record.stderr, Buffer.from(chunk));
    });
    child.stdin.on("error", (error) => {
      record.spawnError = error;
      if (record.pending !== undefined) {
        void terminateRecord(record).catch(() => undefined);
      }
    });
    child.stdout.on("error", (error) => {
      record.spawnError = error;
      void terminateRecord(record).catch(() => undefined);
    });
    child.stderr.on("error", (error) => {
      record.spawnError = error;
      void terminateRecord(record).catch(() => undefined);
    });
    child.once("error", (error) => {
      record.spawnError = error;
    });
    child.once("close", (code, signal) => {
      record.closed = true;
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
    if (quarantineFailure !== undefined) throw quarantineFailure;
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
    try {
      await terminateRecord(record);
      pending.reject(new Error(`${message} Session state was reset.`));
    } catch (error) {
      pending.reject(new Error(
        `${message} ${errorMessage(error)} Session state was reset.`,
      ));
    }
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
      if (Boolean(execution.signal?.aborted)) {
        throw execution.signal?.reason
          ?? new DOMException("Node REPL execution aborted.", "AbortError");
      }
      const record = await ensureChild();
      if (execution.signal?.aborted === true) {
        await terminateRecord(record);
        throw new Error("Node REPL execution aborted. Session state was reset.");
      }
      if (record.pending !== undefined) {
        throw new Error("Node REPL is already evaluating code.");
      }
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
        try {
          record.child.stdin.write(
            `${JSON.stringify({ type: "evaluate", id, code } satisfies WorkerRequest)}\n`,
          );
        } catch (error) {
          void resetForFailure(
            record,
            pending,
            `Node REPL protocol write failed: ${errorMessage(error)}.`,
          );
        }
      });
    },

    close() {
      closePromise ??= (async () => {
        permanentlyClosed = true;
        if (starting !== undefined) {
          try {
            await starting;
          } catch {
            // A start failure is already reported to the active evaluation.
          }
        }
        const record = current;
        if (record !== undefined) {
          try {
            record.child.stdin.end();
          } catch (error) {
            record.spawnError = error instanceof Error
              ? error
              : new Error(String(error));
          }
          await terminateRecord(record);
        } else if (quarantineFailure !== undefined) {
          throw quarantineFailure;
        }
      })();
      return closePromise;
    },
  };
}
