// @ts-check

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { passthroughSandbox } from "../sandbox-seam.js";
import { capChars } from "./shared/output-truncation.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const DEFAULT_NODE_REPL_TIMEOUT_MS = 120_000;
const NODE_REPL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

// Kept self-contained so the sandboxed child can start from `node --eval`
// without needing read access to agent-runtime's installed package directory.
function nodeReplWorkerMain() {
  const repl = require("node:repl");
  const { PassThrough } = require("node:stream");
  const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  const input = new PassThrough();
  const output = new PassThrough();
  const server = repl.start({
    input,
    output,
    prompt: "",
    terminal: false,
    useGlobal: false,
  });
  const replServer = /** @type {any} */ (server);
  let active = null;

  function send(message) {
    try {
      process.send?.(message);
    } catch {
      process.exit(1);
    }
  }

  function errorText(error) {
    const cause = error?.err ?? error;
    return String(cause?.stack || cause?.message || cause || "Node REPL evaluation failed.");
  }

  function finish(ok, text, reset = false) {
    const request = active;
    if (!request) return;
    active = null;
    const value = String(text || "");
    const responseBytes = Buffer.byteLength(value, "utf8")
      + Buffer.byteLength(request.stdout, "utf8")
      + Buffer.byteLength(request.stderr, "utf8");
    if (responseBytes > MAX_BUFFER_BYTES) {
      send({
        type: "result",
        id: request.id,
        ok: false,
        reset: true,
        text: `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`,
        stdout: request.stdout,
        stderr: request.stderr,
      });
      setImmediate(() => process.exit(1));
      return;
    }
    send({
      type: "result",
      id: request.id,
      ok,
      reset,
      text: value,
      stdout: request.stdout,
      stderr: request.stderr,
    });
  }

  function captureProcessWrite(field, originalWrite) {
    return function capturedWrite(chunk, encoding, callback) {
      if (!active) return originalWrite(chunk, encoding, callback);
      const resolvedEncoding = typeof encoding === "string" ? encoding : "utf8";
      const resolvedCallback = typeof encoding === "function" ? encoding : callback;
      const buffer = typeof chunk === "string"
        ? Buffer.from(chunk, /** @type {any} */ (resolvedEncoding))
        : Buffer.from(/** @type {any} */ (chunk));
      active.bytes += buffer.length;
      if (active.bytes > MAX_BUFFER_BYTES) {
        finish(false, `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`, true);
        setImmediate(() => process.exit(1));
        return false;
      }
      active[field] += buffer.toString("utf8");
      if (typeof resolvedCallback === "function") queueMicrotask(resolvedCallback);
      return true;
    };
  }

  process.stdout.write = captureProcessWrite("stdout", process.stdout.write.bind(process.stdout));
  process.stderr.write = captureProcessWrite("stderr", process.stderr.write.bind(process.stderr));

  output.on("data", (chunk) => {
    if (!active) return;
    active.bytes += chunk.length;
    if (active.bytes > MAX_BUFFER_BYTES) {
      finish(false, `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`, true);
      setImmediate(() => process.exit(1));
      return;
    }
    active.output += chunk.toString("utf8");
  });

  // Runtime exceptions from the default evaluator are printed through the
  // REPL output stream and completed by displayPrompt(), rather than passed to
  // eval's callback. Intercept that public completion point while retaining the
  // default evaluator's `_error` behavior.
  replServer.displayPrompt = () => {
    if (!active) return;
    finish(false, active.output.trimEnd() || "Node REPL evaluation failed.");
  };

  process.on("message", (message) => {
    const requestMessage = /** @type {any} */ (message);
    if (!requestMessage || requestMessage.type !== "evaluate") return;
    if (active) {
      send({ type: "result", id: requestMessage.id, ok: false, text: "Node REPL is already evaluating code." });
      return;
    }
    if (typeof requestMessage.code !== "string" || requestMessage.code.trim().length === 0) {
      send({ type: "result", id: requestMessage.id, ok: false, text: "Node REPL code must not be empty." });
      return;
    }
    active = { id: requestMessage.id, output: "", stdout: "", stderr: "", bytes: 0 };
    try {
      replServer.eval(requestMessage.code, replServer.context, "<mono-agent-node-repl>", (error, value) => {
        if (!active || active.id !== requestMessage.id) return;
        if (error) {
          if (!replServer.underscoreErrAssigned) replServer.lastError = error;
          finish(false, [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"));
          return;
        }
        if (!replServer.underscoreAssigned) replServer.last = value;
        let rendered;
        try {
          rendered = replServer.writer(value);
        } catch (writerError) {
          finish(false, [active.output.trimEnd(), errorText(writerError)].filter(Boolean).join("\n"));
          return;
        }
        finish(true, `${active.output}${rendered}`.trimEnd());
      });
    } catch (error) {
      finish(false, [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"));
    }
  });

  process.on("disconnect", () => {
    server.close();
    process.exit(0);
  });
}

const NODE_REPL_WORKER_SOURCE = `(${nodeReplWorkerMain.toString()})();`;

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try { process.kill(child.pid, signal); } catch { /* already gone */ }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function appendChunk(record, target, chunk) {
  record.directOutputBytes += chunk.length;
  if (record.directOutputBytes > NODE_REPL_MAX_BUFFER_BYTES) {
    record.failureReason = `Node REPL output exceeded ${NODE_REPL_MAX_BUFFER_BYTES} bytes.`;
    void terminateRecord(record);
    return;
  }
  target.push(chunk);
}

function directOutput(record, capturedStdout = "", capturedStderr = "") {
  const sections = [];
  const stdout = `${capturedStdout}${Buffer.concat(record.stdout).toString("utf8")}`.trimEnd();
  const stderr = `${capturedStderr}${Buffer.concat(record.stderr).toString("utf8")}`.trimEnd();
  if (stdout) sections.push(`STDOUT:\n${stdout}`);
  if (stderr) sections.push(`STDERR:\n${stderr}`);
  return sections.join("\n");
}

function clearRequestOutput(record) {
  record.stdout = [];
  record.stderr = [];
  record.directOutputBytes = 0;
  record.failureReason = null;
}

function resultText(record, text, stdout, stderr) {
  return [directOutput(record, stdout, stderr), String(text || "").trimEnd()].filter(Boolean).join("\n");
}

async function cleanupPrepared(record) {
  if (record.cleaned) return;
  record.cleaned = true;
  try { await record.prepared.cleanup?.(); } catch { /* best-effort teardown */ }
}

async function terminateRecord(record) {
  if (record.closed) {
    await record.done;
    return;
  }
  killProcessGroup(record.child, "SIGTERM");
  if (!record.killTimer) {
    record.killTimer = setTimeout(() => killProcessGroup(record.child, "SIGKILL"), KILL_GRACE_MS);
    record.killTimer.unref?.();
  }
  await record.done;
}

/**
 * One lazy Node REPL process owned by a single Pi run.
 * @param {{cwd?: string, maxOutputChars?: number, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
export function createNodeReplController({
  cwd,
  maxOutputChars,
  sandboxPolicy,
  sandboxEngine,
  ctx,
} = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const workdir = resolve(cwd || resolvedCtx.workspace || process.cwd());
  let current = null;
  let starting = null;
  let permanentlyClosed = false;
  let nextRequestId = 0;

  async function startChild() {
    const prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: process.execPath,
        args: ["--eval", NODE_REPL_WORKER_SOURCE],
        cwd: workdir,
      },
    });
    if (permanentlyClosed) {
      await prepared.cleanup?.();
      throw new Error("Node REPL run has already ended.");
    }

    let child;
    try {
      child = spawn(prepared.command, prepared.args || [], {
        cwd: prepared.cwd,
        detached: true,
        env: prepared.env ? { ...process.env, ...prepared.env } : process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      await prepared.cleanup?.();
      throw error;
    }

    let resolveDone = () => {};
    const done = new Promise((resolveDonePromise) => { resolveDone = () => resolveDonePromise(); });
    const record = {
      child,
      prepared,
      done,
      resolveDone,
      closed: false,
      cleaned: false,
      killTimer: null,
      spawnError: null,
      failureReason: null,
      pending: null,
      stdout: [],
      stderr: [],
      directOutputBytes: 0,
    };
    current = record;

    child.stdout?.on("data", (chunk) => appendChunk(record, record.stdout, chunk));
    child.stderr?.on("data", (chunk) => appendChunk(record, record.stderr, chunk));
    child.once("error", (error) => { record.spawnError = error; });
    child.on("message", (message) => {
      const result = /** @type {any} */ (message);
      const pending = record.pending;
      if (!pending || !result || result.type !== "result" || result.id !== pending.id) return;
      record.pending = null;
      clearTimeout(pending.timeoutTimer);
      pending.signal?.removeEventListener?.("abort", pending.onAbort);
      setImmediate(async () => {
        const text = resultText(record, result.text, result.stdout, result.stderr);
        if (result.reset) await terminateRecord(record);
        if (result.ok) {
          pending.resolve(capChars(text || "(no output)", {
            label: "NodeRepl",
            maxChars: maxOutputChars,
            strategy: "head_tail",
            ctx: resolvedCtx,
          }));
        } else {
          pending.reject(new Error(text || "Node REPL evaluation failed."));
        }
      });
    });
    child.once("close", (code, closeSignal) => {
      record.closed = true;
      if (record.killTimer) clearTimeout(record.killTimer);
      if (current === record) current = null;
      const pending = record.pending;
      record.pending = null;
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        pending.signal?.removeEventListener?.("abort", pending.onAbort);
        const reason = record.failureReason
          || (record.spawnError ? errorMessage(record.spawnError) : null)
          || `Node REPL process exited before evaluation completed${closeSignal ? ` (${closeSignal})` : ` (code ${code ?? "unknown"})`}.`;
        pending.reject(new Error(`${reason} Session state was reset.`));
      }
      void cleanupPrepared(record).finally(() => record.resolveDone());
    });
    return record;
  }

  async function ensureChild() {
    if (permanentlyClosed) throw new Error("Node REPL run has already ended.");
    if (current && !current.closed) return current;
    starting ??= startChild().finally(() => { starting = null; });
    return await starting;
  }

  async function resetForFailure(record, pending, message) {
    if (record.pending === pending) record.pending = null;
    clearTimeout(pending.timeoutTimer);
    pending.signal?.removeEventListener?.("abort", pending.onAbort);
    await terminateRecord(record);
    pending.reject(new Error(`${message} Session state was reset.`));
  }

  return {
    /** @param {{code: string}} params @param {{signal?: AbortSignal}} [execution] */
    async execute({ code }, { signal } = {}) {
      if (typeof code !== "string" || code.trim().length === 0) {
        throw new Error("Node REPL code must not be empty.");
      }
      if (signal?.aborted) throw new Error("Node REPL execution aborted.");
      const record = await ensureChild();
      if (signal?.aborted) {
        await terminateRecord(record);
        throw new Error("Node REPL execution aborted. Session state was reset.");
      }
      if (record.pending) throw new Error("Node REPL is already evaluating code.");
      clearRequestOutput(record);
      const id = `node-repl-${++nextRequestId}`;

      return await new Promise((resolveResult, rejectResult) => {
        const pending = {
          id,
          resolve: resolveResult,
          reject: rejectResult,
          signal,
          onAbort: null,
          timeoutTimer: null,
        };
        pending.onAbort = () => {
          void resetForFailure(record, pending, "Node REPL execution aborted.");
        };
        pending.timeoutTimer = setTimeout(() => {
          void resetForFailure(
            record,
            pending,
            `Node REPL execution timed out after ${DEFAULT_NODE_REPL_TIMEOUT_MS}ms.`,
          );
        }, DEFAULT_NODE_REPL_TIMEOUT_MS);
        pending.timeoutTimer.unref?.();
        record.pending = pending;
        signal?.addEventListener?.("abort", pending.onAbort, { once: true });
        record.child.send({ type: "evaluate", id, code }, (error) => {
          if (error && record.pending === pending) {
            void resetForFailure(record, pending, `Node REPL IPC failed: ${errorMessage(error)}.`);
          }
        });
      });
    },

    async close() {
      if (permanentlyClosed) return;
      permanentlyClosed = true;
      if (starting) {
        try { await starting; } catch { /* start failure already surfaced */ }
      }
      if (current) await terminateRecord(current);
    },
  };
}
