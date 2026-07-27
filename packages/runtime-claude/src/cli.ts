// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RuntimeUsage } from "@mono-agent/module-sdk";

import { record, usage } from "./jsonl.js";
import {
  ClaudeSessionUnavailableError,
  isClaudeSessionUnavailable,
  type ClaudeTransport,
  type ClaudeTransportEvents,
  type ClaudeTransportRequest,
  type ClaudeTransportResult,
} from "./transport.js";

export interface ProcessLike {
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

export interface ClaudeCliTransportOptions {
  readonly binary: string;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  readonly terminationGraceMs?: number;
  readonly dataDirectory?: string;
  readonly spawnProcess?: SpawnProcess;
}

export class ClaudeCliProcessTerminationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ClaudeCliProcessTerminationError";
  }
}

function defaultSpawn(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }): ProcessLike {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
}

function appendBoundedTail(
  current: Buffer,
  chunk: string | Uint8Array,
  maxBytes: number,
): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const bytes = typeof chunk === "string"
    ? Buffer.from(chunk, "utf8")
    : Buffer.from(chunk);
  if (bytes.length >= maxBytes) {
    return Buffer.from(bytes.subarray(bytes.length - maxBytes));
  }
  const retainedBytes = Math.min(current.length, maxBytes - bytes.length);
  const retained = current.subarray(current.length - retainedBytes);
  return Buffer.concat([retained, bytes], retainedBytes + bytes.length);
}

export async function prepareClaudeSandboxDataDirectory(
  authoredPath: string,
): Promise<string> {
  if (!isAbsolute(authoredPath) || resolve(authoredPath) !== authoredPath) {
    throw new Error("runtime-claude sandbox data directory must be absolute");
  }
  const root = resolve(authoredPath);
  const missing: string[] = [];
  let cursor = root;
  let info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  while (info === undefined) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("runtime-claude sandbox data directory has no existing parent");
    }
    cursor = parent;
    info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }
  assertSafeDirectory(info, cursor, false);
  if (await realpath(cursor) !== cursor) {
    throw new Error("runtime-claude sandbox data directory ancestors must be canonical");
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
    assertSafeDirectory(await lstat(path), path, true);
    if (await realpath(path) !== path) {
      throw new Error("runtime-claude sandbox data directory must be canonical");
    }
  }
  assertSafeDirectory(await lstat(root), root, true);
  return root;
}

function assertSafeDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
  ownerPrivate: boolean,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${path} must be a canonical directory`);
  }
  if (typeof process.getuid !== "function" || info.uid !== process.getuid()) {
    throw new Error(`${path} must be owned by the current user`);
  }
  const mode = Number(info.mode) & 0o777;
  if (ownerPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Error(ownerPrivate
      ? `${path} must have mode 0700`
      : `${path} must not be group/world writable`);
  }
}

async function systemPromptFile(
  dataDirectory: string | undefined,
  systemPrompt: string | undefined,
): Promise<{
  readonly path?: string;
  cleanup(): Promise<void>;
}> {
  if (systemPrompt === undefined) return { async cleanup() {} };
  const root = dataDirectory === undefined
    ? tmpdir()
    : await prepareClaudeSandboxDataDirectory(dataDirectory);
  const directory = await mkdtemp(join(root, "claude-prompt-"));
  const path = join(directory, "system-prompt.txt");
  try {
    await writeFile(path, systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

export function createClaudeCliTransport(options: ClaudeCliTransportOptions): ClaudeTransport {
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  if (
    !Number.isSafeInteger(terminationGraceMs)
    || terminationGraceMs <= 0
  ) {
    throw new TypeError(
      "Claude CLI terminationGraceMs must be a positive safe integer",
    );
  }
  return {
    async run(request: ClaudeTransportRequest, events: ClaudeTransportEvents): Promise<ClaudeTransportResult> {
      if (request.signal.aborted) {
        throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const promptFile = await systemPromptFile(
        options.dataDirectory,
        request.systemPrompt,
      );
      if (request.signal.aborted) {
        await promptFile.cleanup();
        throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const args = [
        "--print",
        "--input-format", "text",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode", "dontAsk",
        "--setting-sources", "",
        "--tools", "",
        "--model", request.model,
        ...(promptFile.path === undefined ? [] : ["--system-prompt-file", promptFile.path]),
        ...(request.sessionId === undefined ? [] : ["--resume", request.sessionId]),
        ...(request.maxTurns === undefined ? [] : ["--max-turns", String(request.maxTurns)]),
        ...(request.effort === undefined ? [] : ["--effort", request.effort]),
        ...(request.responseSchema === undefined ? [] : ["--json-schema", JSON.stringify(request.responseSchema)]),
      ];
      const launch = options.spawnProcess ?? defaultSpawn;
      let child: ProcessLike;
      try {
        child = launch(options.binary, args, { cwd: request.cwd, env: request.env, shell: false });
      } catch (error) {
        await promptFile.cleanup();
        throw error;
      }
      const decoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr: Buffer = Buffer.alloc(0);
      let streamed = "";
      let finalText = "";
      let sessionId: string | undefined;
      let finalUsage: RuntimeUsage | undefined;
      let structuredOutput: unknown;
      let providerError: string | undefined;
      let providerSessionUnavailable = false;
      let acceptEvents = true;
      let runFinalized = false;
      let promptCleanup: Promise<void> | undefined;
      const cleanupPrompt = (): Promise<void> => {
        promptCleanup ??= promptFile.cleanup();
        return promptCleanup;
      };
      let chain = Promise.resolve();
      const processLine = (line: string): void => {
        if (!acceptEvents) return;
        if (Buffer.byteLength(line) > options.maxLineBytes) throw new Error("Claude CLI output exceeds the configured line limit");
        if (line.trim() === "") return;
        let message: Record<string, unknown>;
        try { message = record(JSON.parse(line)); } catch { throw new Error("Claude CLI emitted malformed JSONL"); }
        const next = chain.then(async () => {
          if (!acceptEvents) return;
          if (typeof message.session_id === "string" && message.session_id !== sessionId) {
            sessionId = message.session_id;
            if (acceptEvents) await events.session(sessionId);
          }
          if (message.type === "stream_event") {
            const event = record(message.event);
            if (event.type === "content_block_delta") {
              const delta = record(event.delta);
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                streamed += delta.text;
                if (acceptEvents) await events.text(delta.text);
              } else if (
                delta.type === "thinking_delta"
                && typeof delta.thinking === "string"
                && acceptEvents
              ) {
                await events.thinking(delta.thinking);
              }
            }
          } else if (message.type === "result") {
            if (typeof message.result === "string") finalText = message.result;
            if (message.structured_output !== undefined) structuredOutput = message.structured_output;
            const measured = usage(message.usage);
            if (measured !== undefined) {
              finalUsage = measured;
              if (acceptEvents) await events.usage(measured);
            }
            if (message.subtype !== "success") {
              const failures = Array.isArray(message.errors)
                ? message.errors.filter((value): value is string => typeof value === "string")
                : [];
              providerSessionUnavailable = failures.length === 1
                && isClaudeSessionUnavailable(failures[0], request.sessionId);
              providerError = failures.length > 0
                ? failures.join("; ")
                : "Claude CLI turn failed";
            }
          }
        });
        chain = next;
        void next.catch((error: unknown) => rejectRun(error));
      };
      let forceTimer: NodeJS.Timeout | undefined;
      let reapTimer: NodeJS.Timeout | undefined;
      let processClosed = false;
      let terminationStarted = false;
      let terminalCause: unknown;
      let resolveTermination!: () => void;
      let rejectTermination!: (error: ClaudeCliProcessTerminationError) => void;
      const termination = new Promise<void>((resolve, reject) => {
        resolveTermination = resolve;
        rejectTermination = reject;
      });
      void termination.catch(() => undefined);
      const kill = (signal: NodeJS.Signals): void => {
        try {
          child.kill(signal);
        } catch {
          // A close event or the bounded post-SIGKILL deadline is authoritative.
        }
      };
      const terminate = (): Promise<void> => {
        if (processClosed) return termination;
        if (terminationStarted) return termination;
        terminationStarted = true;
        try {
          child.stdin.end();
        } catch {
          // Continue with bounded signal escalation.
        }
        kill("SIGTERM");
        forceTimer = setTimeout(() => {
          if (processClosed) return;
          kill("SIGKILL");
          reapTimer = setTimeout(() => {
            if (processClosed) return;
            rejectTermination(new ClaudeCliProcessTerminationError(
              "Claude CLI did not exit after SIGKILL",
              terminalCause === undefined ? {} : { cause: terminalCause },
            ));
          }, terminationGraceMs);
          reapTimer.unref?.();
        }, terminationGraceMs);
        forceTimer.unref?.();
        return termination;
      };
      let rejectExit!: (error: unknown) => void;
      let terminalFailure = false;
      const rejectRun = (error: unknown): void => {
        if (!acceptEvents || terminalFailure) return;
        terminalFailure = true;
        terminalCause = error;
        acceptEvents = false;
        rejectExit(error);
        void terminate();
      };
      const exit = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
        rejectExit = reject;
        child.stdout.on("data", (chunk: Buffer | string) => {
          if (!acceptEvents) return;
          stdout += typeof chunk === "string" ? chunk : decoder.write(chunk);
          if (Buffer.byteLength(stdout) > options.maxLineBytes && !stdout.includes("\n")) {
            rejectRun(new Error("Claude CLI output exceeds the configured line limit"));
            return;
          }
          try {
            while (true) {
              const index = stdout.indexOf("\n");
              if (index < 0) break;
              processLine(stdout.slice(0, index));
              stdout = stdout.slice(index + 1);
            }
          } catch (error) {
            rejectRun(error);
          }
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr = appendBoundedTail(stderr, chunk, options.maxStderrBytes);
        });
        child.stdout.on("error", rejectRun);
        child.stderr.on("error", rejectRun);
        child.once("error", rejectRun);
        child.once("close", (code, signal) => {
          processClosed = true;
          if (forceTimer !== undefined) clearTimeout(forceTimer);
          if (reapTimer !== undefined) clearTimeout(reapTimer);
          resolveTermination();
          resolve({ code: code ?? 1, signal });
          if (runFinalized) {
            void cleanupPrompt().catch(() => undefined);
          }
        });
      });
      void exit.catch(() => undefined);
      child.stdin.on("error", rejectRun);
      const onAbort = (): void => {
        rejectRun(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        try {
          events.control({
            async interrupt() {
              rejectRun(new DOMException("Claude CLI interrupted", "AbortError"));
              await Promise.all([exit.catch(() => undefined), termination]);
            },
          });
        } catch (error) {
          rejectRun(error);
          throw error;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
        timer = setTimeout(() => {
          rejectRun(new Error(`Claude CLI timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        timer.unref?.();
        if (acceptEvents) {
          try {
            child.stdin.end(request.prompt);
          } catch (error) {
            rejectRun(error);
          }
        }
        const settled = await exit;
        const tail = stdout + decoder.end();
        if (tail.trim() !== "") processLine(tail);
        await chain;
        if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        const stderrText = stderr.toString("utf8").trim();
        const processFailure = providerError
          ?? (stderrText || `Claude CLI exited ${settled.signal ?? settled.code}`);
        if (
          providerSessionUnavailable
          || (
            settled.code !== 0
            && isClaudeSessionUnavailable(processFailure, request.sessionId)
          )
        ) {
          throw new ClaudeSessionUnavailableError();
        }
        if (settled.code !== 0 || providerError !== undefined) {
          throw new Error(processFailure);
        }
        if (sessionId === undefined) throw new Error("Claude CLI completed without a session id");
        return {
          text: streamed === "" ? finalText : streamed,
          sessionId,
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
          ...(structuredOutput === undefined ? {} : { structuredOutput: structuredOutput as never }),
        };
      } finally {
        acceptEvents = false;
        if (timer !== undefined) clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        try {
          if (terminalFailure) await termination;
          else await chain.catch(() => undefined);
        } finally {
          runFinalized = true;
          if (processClosed) await cleanupPrompt();
        }
      }
    },
  };
}
