import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import {
  isPathAllowed,
  isWorkdirAllowed,
  workspaceRoot,
} from "./shared/path-resolver.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const DEFAULT_BASH_TIMEOUT_MS = 120000;
const BASH_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1000;

export function normalizeBashTimeoutMs(value, fallback = DEFAULT_BASH_TIMEOUT_MS) {
  const cap = Number.isFinite(Number(fallback)) && Number(fallback) > 0
    ? Math.floor(Number(fallback))
    : DEFAULT_BASH_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return cap;
  const floored = Math.floor(n);
  const ms = floored <= 600 ? floored * 1000 : floored;
  return Math.max(1000, Math.min(ms, cap));
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try { process.kill(child.pid, signal); } catch { /* already gone */ }
  }
}

function appendChunk(chunks, chunk, state) {
  state.bytes += chunk.length;
  if (state.bytes > state.maxBufferBytes) {
    state.bufferExceeded = true;
    return false;
  }
  chunks.push(chunk);
  return true;
}

function runCommand(commandSpec, { timeoutMs, signal, maxBufferBytes = BASH_MAX_BUFFER_BYTES }) {
  return new Promise((resolve) => {
    const child = spawn(commandSpec.command, commandSpec.args || [], {
      cwd: commandSpec.cwd,
      detached: true,
      env: commandSpec.env ? { ...process.env, ...commandSpec.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const state = {
      aborted: false,
      bufferExceeded: false,
      bytes: 0,
      maxBufferBytes,
      spawnError: null,
      timedOut: false,
    };
    let killTimer = null;
    let settled = false;

    function terminate() {
      killProcessGroup(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    }

    const timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const onAbort = () => {
      state.aborted = true;
      terminate();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      if (!appendChunk(stdout, chunk, state)) terminate();
    });
    child.stderr?.on("data", (chunk) => {
      if (!appendChunk(stderr, chunk, state)) terminate();
    });
    child.once("error", (err) => {
      state.spawnError = err;
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        code,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...state,
      });
    });
  });
}

/**
 * @param {{command: string, timeout?: number, max_output_chars?: number, workdir?: string}} params
 * @param {{signal?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
export async function bashToolImpl({ command, timeout = DEFAULT_BASH_TIMEOUT_MS, max_output_chars, workdir }, { signal, sandboxPolicy, sandboxEngine, ctx } = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const pathOptions = { sandboxPolicy: policy, ctx };
  if (workdir && !isWorkdirAllowed(workdir, pathOptions)) return `Error: Working directory not allowed: ${workdir}`;
  const cwd = workspaceRoot(workdir, ctx);
  if (!isPathAllowed(cwd, workdir, pathOptions)) return `Error: Working directory not allowed: ${cwd}`;
  if (!existsSync(cwd)) return `Error: Working directory not found: ${cwd}`;
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_BASH_OUTPUT_CHARS;
  const timeoutMs = normalizeBashTimeoutMs(timeout);
  let prepared;
  try {
    prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? undefined,
      command: { command: "/bin/bash", args: ["-lc", command], cwd },
    });
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }
  let result;
  try {
    result = await runCommand(prepared, { timeoutMs, signal });
  } finally {
    await prepared.cleanup?.();
  }
  if (result.timedOut) return `Error: Command timed out after ${timeoutMs}ms`;
  if (result.aborted) return "Error: Command aborted";
  if (result.bufferExceeded) return `Error: Command output exceeded ${BASH_MAX_BUFFER_BYTES} bytes`;
  if (result.spawnError) return `Exit code 1:\n${result.spawnError.message}`;
  if (result.code && result.code !== 0) {
    return capChars(`Exit code ${result.code || 1}:\n${result.stdout || ""}${result.stderr || ""}`, {
      label: "Bash",
      maxChars,
      strategy: "head_tail",
      ctx,
    });
  }
  if (result.signal) return `Exit code 1:\nCommand terminated by ${result.signal}`;
  const output = result.stdout && result.stderr
    ? `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    : (result.stdout || result.stderr || "(no output)");
  return capChars(output, { label: "Bash", maxChars, strategy: "head_tail", ctx });
}
