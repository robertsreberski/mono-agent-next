// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  ModuleCommand,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type {
  Sandbox,
  SandboxCommand,
  SandboxProcess,
  SandboxResult,
  SandboxSpawnCommand,
} from "@mono-agent/module-sdk/internal";

import { boundLaunch, closeBindings } from "./bound-launch.js";
import {
  isReservedSandboxEnvironmentName,
  parseSandboxSrtConfig,
  type SandboxSrtConfig,
} from "./config.js";
import { SandboxSrtError } from "./errors.js";
import {
  createSandboxSrtStatusCommands,
  type SandboxSrtStatus,
} from "./status-command.js";
import {
  bindTrustedExecutable,
  bindTrustedSettings,
  resolveTrustedExecutable,
  resolveTrustedSettings,
  verifyTrustedExecutable,
  verifyTrustedSettings,
  type TrustedFile,
  type TrustedFileBinding,
} from "./security.js";
import { StreamingSandboxProcess } from "./streaming-process.js";

export interface OpenSandboxSrtOptions {
  readonly config: unknown;
}

interface ActiveChild {
  readonly terminate: (signal: NodeJS.Signals) => void;
  readonly done: Promise<void>;
}

const SIGKILL_GRACE_MS = 100;

export class SandboxSrt implements Sandbox {
  readonly commands: readonly ModuleCommand[];
  readonly config: SandboxSrtConfig;
  readonly executable: TrustedFile;
  readonly settings: TrustedFile;

  readonly #active = new Set<ActiveChild>();
  #closed = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(config: SandboxSrtConfig, executable: TrustedFile, settings: TrustedFile) {
    this.config = config;
    this.executable = executable;
    this.settings = settings;
    this.commands = createSandboxSrtStatusCommands((signal) => this.#status(signal));
  }

  static async open(options: OpenSandboxSrtOptions): Promise<SandboxSrt> {
    const config = parseSandboxSrtConfig(options.config);
    const [executable, settings] = await Promise.all([
      resolveTrustedExecutable(config.executable),
      resolveTrustedSettings(config.settings),
    ]);
    return new SandboxSrt(config, executable, settings);
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    this.#assertOpen();
    throwIfAborted(command.signal);
    const prepared = await this.#prepare(command);
    this.#assertOpen();
    const bindings = await this.#bindSelection();
    let child: ChildProcessWithoutNullStreams;
    try {
      this.#assertOpen();
      throwIfAborted(command.signal);
      const launch = boundLaunch(this.executable, bindings.executable, bindings.settings);
      child = spawn(
        launch.command,
        [...launch.arguments, prepared.command, ...prepared.arguments],
        {
          cwd: prepared.workingDirectory,
          env: prepared.environment,
          shell: false,
          stdio: [
            "pipe",
            "pipe",
            "pipe",
            bindings.executable.descriptor,
            bindings.settings.descriptor,
          ],
          windowsHide: true,
          detached: true,
        },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      await closeBindings(bindings);
      if (error instanceof SandboxSrtError || command.signal.aborted) throw error;
      throw new SandboxSrtError("execution_failed", "SRT process could not be started.");
    }
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    const active = {
      terminate: (signal: NodeJS.Signals) => terminate(child, signal),
      done,
    };
    this.#active.add(active);
    const result = collectChild(
      child,
      command.signal,
      prepared.timeoutMs,
      this.config.limits.maxOutputBytes,
      prepared.stdin,
    );
    try {
      await closeBindings(bindings);
      return await result;
    } finally {
      this.#active.delete(active);
      resolveDone?.();
    }
  }

  spawn(command: SandboxSpawnCommand): SandboxProcess {
    this.#assertOpen();
    const process = new StreamingSandboxProcess({
      maxInputBytes: this.config.limits.maxInputBytes,
      maxOutputBytes: this.config.limits.maxOutputBytes,
      start: async (started) => {
        const prepared = await this.#prepareSpawn(command);
        this.#assertOpen();
        const bindings = await this.#bindSelection();
        try {
          this.#assertOpen();
          const launch = boundLaunch(
            this.executable,
            bindings.executable,
            bindings.settings,
          );
          const child = spawn(
            launch.command,
            [...launch.arguments, prepared.command, ...prepared.arguments],
            {
              cwd: prepared.workingDirectory,
              env: prepared.environment,
              shell: false,
              stdio: [
                "pipe",
                "pipe",
                "pipe",
                bindings.executable.descriptor,
                bindings.settings.descriptor,
              ],
              windowsHide: true,
              detached: true,
            },
          ) as ChildProcessWithoutNullStreams;
          started(child);
        } catch (error) {
          if (error instanceof SandboxSrtError) throw error;
          throw new SandboxSrtError(
            "execution_failed",
            "SRT process could not be started.",
          );
        } finally {
          await closeBindings(bindings);
        }
      },
    });
    const active = {
      terminate: (signal: NodeJS.Signals) => {
        process.kill(signal);
      },
      done: process.done,
    };
    this.#active.add(active);
    void process.done.finally(() => {
      this.#active.delete(active);
    });
    return process;
  }

  async health(context: ModuleHealthContext): Promise<ModuleHealth> {
    if (this.#closed) {
      return health(
        "unhealthy",
        "SRT sandbox is closed.",
        this.#healthDetails("closed"),
      );
    }
    try {
      throwIfAborted(context.signal);
      await this.#verifySelection();
      return health(
        "healthy",
        "Integrity-pinned SRT executable and settings are ready.",
        this.#healthDetails("verified"),
      );
    } catch {
      throwIfAborted(context.signal);
      return health(
        "unhealthy",
        "SRT executable or settings integrity could not be proven.",
        this.#healthDetails("unverified"),
      );
    }
  }

  async diagnostics(
    context: ModuleDiagnosticsContext,
  ): Promise<readonly ModuleDiagnostic[]> {
    const status = await this.#status(context.signal);
    if (status.status === "ready") {
      return Object.freeze([Object.freeze({
        code: "sandbox-srt.integrity",
        severity: "info",
        message: "SRT executable and settings integrity is verified.",
      })]);
    }
    return Object.freeze([Object.freeze({
      code: status.status === "closed"
        ? "sandbox-srt.closed"
        : "sandbox-srt.integrity",
      severity: "error",
      message: status.status === "closed"
        ? "The selected SRT sandbox is closed."
        : "SRT executable or settings integrity could not be proven.",
    })]);
  }

  async #status(signal: AbortSignal): Promise<SandboxSrtStatus> {
    if (this.#closed) {
      return Object.freeze({
        status: "closed",
        mode: "native",
        integrity: "closed",
        networkAvailability: "unavailable",
        activeCommands: this.#active.size,
        executableSha256: this.executable.sha256,
        settingsSha256: this.settings.sha256,
        code: "sandbox_closed",
        message: "The selected SRT sandbox is closed.",
      });
    }
    try {
      throwIfAborted(signal);
      await this.#verifySelection();
      throwIfAborted(signal);
      return Object.freeze({
        status: "ready",
        mode: "native",
        integrity: "verified",
        networkAvailability: "settings-controlled",
        activeCommands: this.#active.size,
        executableSha256: this.executable.sha256,
        settingsSha256: this.settings.sha256,
      });
    } catch {
      throwIfAborted(signal);
      return Object.freeze({
        status: "degraded",
        mode: "native",
        integrity: "unverified",
        networkAvailability: "unavailable",
        activeCommands: this.#active.size,
        executableSha256: this.executable.sha256,
        settingsSha256: this.settings.sha256,
        code: "sandbox_integrity_unverified",
        message: "The selected SRT executable or settings could not be verified.",
      });
    }
  }

  async stop(_context?: ModuleStopContext): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    await this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active];
    for (const child of active) child.terminate("SIGTERM");
    const killTimers = active.map((child) => {
      const timer = setTimeout(
        () => child.terminate("SIGKILL"),
        SIGKILL_GRACE_MS,
      );
      timer.unref();
      return timer;
    });
    try {
      await Promise.allSettled(active.map(({ done }) => done));
    } finally {
      for (const timer of killTimers) clearTimeout(timer);
    }
  }

  async #verifySelection(): Promise<void> {
    await Promise.all([
      verifyTrustedExecutable(this.executable),
      verifyTrustedSettings(this.settings),
    ]);
  }

  async #bindSelection(): Promise<{
    readonly executable: TrustedFileBinding;
    readonly settings: TrustedFileBinding;
  }> {
    const executable = await bindTrustedExecutable(this.executable);
    try {
      const settings = await bindTrustedSettings(this.settings);
      return Object.freeze({ executable, settings });
    } catch (error) {
      await executable.close();
      throw error;
    }
  }

  #healthDetails(integrity: "verified" | "unverified" | "closed"): Readonly<Record<string, string | number>> {
    return Object.freeze({
      integrity,
      activeCommands: this.#active.size,
      executableSha256: this.executable.sha256,
      settingsSha256: this.settings.sha256,
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new SandboxSrtError("closed", "SRT sandbox is closed.");
  }

  async #prepare(command: SandboxCommand): Promise<{
    readonly command: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly stdin: Uint8Array | undefined;
  }> {
    if (typeof command !== "object" || command === null) invalid("Sandbox command must be an object.");
    if (!isAbsolute(command.command) || command.command.includes("\0")) invalid("Sandbox command must be an absolute path without NUL bytes.");
    if (!Array.isArray(command.arguments) || command.arguments.length > this.config.limits.maxArguments) {
      invalid(`Sandbox arguments exceed the configured count of ${this.config.limits.maxArguments}.`);
    }
    let argumentBytes = Buffer.byteLength(command.command, "utf8");
    for (const argument of command.arguments) {
      if (typeof argument !== "string" || argument.includes("\0")) invalid("Sandbox arguments must be strings without NUL bytes.");
      argumentBytes += Buffer.byteLength(argument, "utf8");
    }
    if (argumentBytes > this.config.limits.maxArgumentBytes) invalid("Sandbox arguments exceed their configured byte bound.");
    if (!isAbsolute(command.workingDirectory) || command.workingDirectory.includes("\0")) {
      invalid("Sandbox workingDirectory must be an absolute path without NUL bytes.");
    }
    const workingDirectory = resolve(command.workingDirectory);
    const [canonicalDirectory, directoryStat] = await Promise.all([
      realpath(workingDirectory).catch(() => invalid("Sandbox workingDirectory is absent or inaccessible.")),
      lstat(workingDirectory).catch(() => invalid("Sandbox workingDirectory is absent or inaccessible.")),
    ]);
    if (canonicalDirectory !== workingDirectory || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      invalid("Sandbox workingDirectory must be a canonical non-symlink directory.");
    }
    const timeoutMs = command.timeoutMs ?? this.config.limits.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.config.limits.maxTimeoutMs) {
      invalid(`Sandbox timeoutMs must be from 1 through ${this.config.limits.maxTimeoutMs}.`);
    }
    if (command.stdin !== undefined && (!(command.stdin instanceof Uint8Array)
      || command.stdin.byteLength > this.config.limits.maxInputBytes)) {
      invalid("Sandbox stdin exceeds its configured byte bound.");
    }
    const environment = buildEnvironment(command.environment, this.config);
    return Object.freeze({
      command: command.command,
      arguments: Object.freeze([...command.arguments]),
      workingDirectory,
      environment,
      timeoutMs,
      stdin: command.stdin,
    });
  }

  async #prepareSpawn(command: SandboxSpawnCommand): Promise<{
    readonly command: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly environment: Readonly<Record<string, string>>;
  }> {
    const signal = new AbortController().signal;
    const prepared = await this.#prepare({
      ...command,
      signal,
    });
    return Object.freeze({
      command: prepared.command,
      arguments: prepared.arguments,
      workingDirectory: prepared.workingDirectory,
      environment: prepared.environment,
    });
  }
}

export async function openSandboxSrt(options: OpenSandboxSrtOptions): Promise<SandboxSrt> {
  return await SandboxSrt.open(options);
}

function buildEnvironment(
  supplied: Readonly<Record<string, string>> | undefined,
  config: SandboxSrtConfig,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of config.environment.inherit) {
    if (isReservedSandboxEnvironmentName(name)) {
      invalid("Sandbox environment contains a reserved runtime injection variable.");
    }
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  if (supplied !== undefined) {
    if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)
      || (Object.getPrototypeOf(supplied) !== Object.prototype && Object.getPrototypeOf(supplied) !== null)) {
      invalid("Sandbox environment must be a plain object.");
    }
    const allowed = new Set(config.environment.allow);
    for (const name of Object.keys(supplied).sort()) {
      if (isReservedSandboxEnvironmentName(name)) {
        invalid("Sandbox environment contains a reserved runtime injection variable.");
      }
      if (!allowed.has(name)) invalid(`Sandbox environment variable ${JSON.stringify(name)} is not allowlisted.`);
      const descriptor = Object.getOwnPropertyDescriptor(supplied, name);
      if (descriptor === undefined || !("value" in descriptor)) invalid("Sandbox environment must contain only data properties.");
      const value = descriptor.value as unknown;
      if (typeof value !== "string" || value.includes("\0")) invalid("Sandbox environment values must be strings without NUL bytes.");
      result[name] = value;
    }
  }
  const names = Object.keys(result);
  if (names.length > config.limits.maxEnvironmentVariables) invalid("Sandbox environment exceeds its configured variable count.");
  const bytes = names.reduce((total, name) => total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(result[name]!, "utf8") + 2, 0);
  if (bytes > config.limits.maxEnvironmentBytes) invalid("Sandbox environment exceeds its configured byte bound.");
  return Object.freeze(result);
}

async function collectChild(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
  stdin: Uint8Array | undefined,
): Promise<SandboxResult> {
  return await new Promise<SandboxResult>((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let failure: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const forceKill = (): void => {
      terminate(child, "SIGKILL");
    };
    const beginTermination = (): void => {
      terminate(child, "SIGTERM");
      killTimer ??= setTimeout(forceKill, SIGKILL_GRACE_MS);
      killTimer.unref();
    };
    const onAbort = (): void => {
      failure ??= signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
      beginTermination();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, timeoutMs);
    timeout.unref();

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (failure !== undefined) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        failure = new SandboxSrtError("output_limit_exceeded", `Sandbox output exceeded ${maxOutputBytes} bytes.`);
        beginTermination();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const failOutput = (): void => {
      if (settled || failure !== undefined) return;
      failure = new SandboxSrtError(
        "execution_failed",
        "SRT process output failed.",
      );
      beginTermination();
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdout.once("error", failOutput);
    child.stderr.once("error", failOutput);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once("error", () => {
      failure ??= new SandboxSrtError("execution_failed", "SRT process could not be started.");
    });
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminate(child, "SIGKILL");
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      signal.removeEventListener("abort", onAbort);
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      resolvePromise(Object.freeze({
        exitCode,
        ...(exitSignal === null ? {} : { signal: exitSignal }),
        stdout: Uint8Array.from(Buffer.concat(stdout)),
        stderr: Uint8Array.from(Buffer.concat(stderr)),
        timedOut,
      }));
    });
    child.stdin.on("error", () => {
      // A workload may exit without reading stdin; its process result remains authoritative.
    });
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(Buffer.from(stdin));
    }
  });
}

function terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already gone away.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // Process termination is best effort; the close event settles the operation.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function invalid(message: string): never {
  throw new SandboxSrtError("invalid_command", message);
}

function health(
  status: "healthy" | "unhealthy",
  summary: string,
  details: Readonly<Record<string, string | number>>,
): ModuleHealth {
  return Object.freeze({ status, checkedAt: new Date().toISOString(), summary, details });
}
