import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

export const PROCESS_INCARNATION_SCHEMA = "mono-agent.process-incarnation.v1";

/** Stable OS evidence that distinguishes one use of a PID from every later reuse. */
export interface ProcessIncarnation {
  readonly schema: typeof PROCESS_INCARNATION_SCHEMA;
  readonly bootSessionId: string;
  readonly processStartId: string;
}

export type SameProcessIncarnation = (
  pid: number,
  expected: ProcessIncarnation,
) => boolean | Promise<boolean>;

let bootSessionIdPromise: Promise<string> | undefined;

/** Capture the current process's boot-session and process-birth identity. */
export async function currentProcessIncarnation(): Promise<ProcessIncarnation> {
  const incarnation = await readProcessIncarnation(process.pid);
  if (incarnation === undefined) {
    throw new Error(`Cannot read process incarnation for current pid ${process.pid}.`);
  }
  return incarnation;
}

/**
 * Read one PID incarnation without mistaking `kill(pid, 0)` for owner identity.
 * Linux exposes a boot UUID and per-process start tick directly. Darwin/BSD use
 * the kernel boot time plus `ps`'s stable long-start field. Windows uses native
 * process/OS creation timestamps through PowerShell.
 */
export async function readProcessIncarnation(pid: number): Promise<ProcessIncarnation | undefined> {
  assertPid(pid);
  if (!processExists(pid)) return undefined;
  const [bootSessionId, processStartId] = await Promise.all([
    currentBootSessionId(),
    processStartIdentifier(pid),
  ]);
  if (processStartId === undefined) return undefined;
  return {
    schema: PROCESS_INCARNATION_SCHEMA,
    bootSessionId,
    processStartId,
  };
}

/** True only when PID, boot session, and process birth all still identify the owner. */
export async function isSameProcessIncarnation(
  pid: number,
  expected: ProcessIncarnation,
): Promise<boolean> {
  const actual = await readProcessIncarnation(pid);
  return actual !== undefined && processIncarnationsEqual(actual, expected);
}

export function processIncarnationsEqual(
  left: ProcessIncarnation,
  right: ProcessIncarnation,
): boolean {
  return left.schema === right.schema
    && left.bootSessionId === right.bootSessionId
    && left.processStartId === right.processStartId;
}

/** Fail-closed parser for persisted lock-owner data. */
export function processIncarnationFromJson(value: unknown): ProcessIncarnation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schema === PROCESS_INCARNATION_SCHEMA
    && typeof record.bootSessionId === "string"
    && record.bootSessionId.length > 0
    && typeof record.processStartId === "string"
    && record.processStartId.length > 0
    ? record as unknown as ProcessIncarnation
    : undefined;
}

async function currentBootSessionId(): Promise<string> {
  bootSessionIdPromise ??= readBootSessionId();
  return await bootSessionIdPromise;
}

async function readBootSessionId(): Promise<string> {
  if (process.platform === "linux") {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^[a-zA-Z0-9-]+$/u.test(value)) {
      throw new Error("Linux boot session id is malformed.");
    }
    return `linux:${value}`;
  }
  if (process.platform === "darwin") {
    const output = await execFileText("/usr/sbin/sysctl", ["-n", "kern.boottime"], posixEnvironment());
    const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/u.exec(output);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("Darwin boot session identity is malformed.");
    }
    return `darwin:${match[1]}:${match[2]}`;
  }
  if (process.platform === "win32") {
    const output = await execFileText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
    ]);
    return `win32:${requiredDecimal(output, "Windows boot session identity")}`;
  }

  // PID 1 is recreated once per POSIX boot, so its birth is a stable fallback
  // on BSD-like platforms that lack Linux's boot UUID and Darwin's sysctl path.
  const pidOneStart = await posixProcessStartIdentifier(1);
  if (pidOneStart === undefined) {
    throw new Error(`Cannot determine the ${process.platform} boot session identity.`);
  }
  return `${process.platform}:pid1:${pidOneStart}`;
}

async function processStartIdentifier(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return await linuxProcessStartIdentifier(pid);
  if (process.platform === "win32") return await windowsProcessStartIdentifier(pid);
  return await posixProcessStartIdentifier(pid);
}

async function linuxProcessStartIdentifier(pid: number): Promise<string | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return undefined;
    throw error;
  }
  // `comm` is parenthesized and may itself contain spaces or `)`, so split only
  // after its final close paren. The remaining token at index 19 is field 22,
  // the kernel start tick since boot.
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error(`Linux process stat for pid ${pid} is malformed.`);
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    throw new Error(`Linux process start identity for pid ${pid} is malformed.`);
  }
  return `linux-ticks:${startTicks}`;
}

async function posixProcessStartIdentifier(pid: number): Promise<string | undefined> {
  try {
    const output = await execFileText("/bin/ps", ["-p", String(pid), "-o", "lstart="], posixEnvironment());
    const normalized = output.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) {
      if (!processExists(pid)) return undefined;
      throw new Error(`POSIX process start identity for pid ${pid} is empty.`);
    }
    return `posix-lstart:${normalized}`;
  } catch (error) {
    if (!processExists(pid)) return undefined;
    throw error;
  }
}

async function windowsProcessStartIdentifier(pid: number): Promise<string | undefined> {
  try {
    const output = await execFileText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; $process.StartTime.ToUniversalTime().Ticks`,
    ]);
    return `win32-ticks:${requiredDecimal(output, `Windows process start identity for pid ${pid}`)}`;
  } catch (error) {
    if (!processExists(pid)) return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Process incarnation pid must be a positive safe integer; received ${String(pid)}.`);
  }
}

function posixEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function requiredDecimal(output: string, label: string): string {
  const normalized = output.trim();
  if (!/^\d+$/u.test(normalized)) throw new Error(`${label} is malformed.`);
  return normalized;
}

function execFileText(
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
    }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolvePromise(stdout);
    });
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
