// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  codexProcessConfigArguments,
  INERT_CODEX_MCP_COMMAND,
  INERT_CODEX_MCP_URL,
  tomlBasicString,
  type EffectiveCodexMcpServer,
} from "./containment.js";
import {
  JsonRpcProcessTerminationError,
  type ProcessLike,
  type SpawnProcess,
} from "./json-rpc.js";

const SUPPORTED_CODEX_VERSION = "codex-cli 0.145.0";
const PREFLIGHT_OUTPUT_MAX_BYTES = 65_536;
const PREFLIGHT_TERMINATION_GRACE_MS = 1_000;
const MAX_EFFECTIVE_MCP_SERVERS = 64;
const MAX_MCP_SERVER_NAME_BYTES = 256;

export class CodexPreflightTerminationError
  extends JsonRpcProcessTerminationError {
  readonly closed: Promise<void>;

  constructor(
    message: string,
    closed: Promise<void>,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CodexPreflightTerminationError";
    this.closed = closed;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("runtime-codex requires POSIX ownership checks");
  }
  return process.getuid();
}

function assertOwnedDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
  exactPrivate: boolean,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${path} must be a regular directory, not a symbolic link`);
  }
  if (info.uid !== currentUid()) {
    throw new Error(`${path} must be owned by the current user`);
  }
  const mode = Number(info.mode) & 0o777;
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Error(exactPrivate
      ? `${path} must have mode 0700`
      : `${path} must not be group/world writable`);
  }
}

async function prepareDataDirectory(authoredPath: string): Promise<string> {
  const root = resolve(authoredPath);
  const missing: string[] = [];
  let cursor = root;
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  while (existing === undefined) {
    existing = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) {
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("runtime-codex data directory has no existing parent");
      }
      missing.unshift(cursor);
      cursor = parent;
    }
  }
  assertOwnedDirectory(existing, cursor, false);
  if (await realpath(cursor) !== cursor) {
    throw new Error(
      "runtime-codex data directory ancestors must not traverse symbolic links",
    );
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
    const created = await lstat(path);
    assertOwnedDirectory(created, path, true);
    if (await realpath(path) !== path) {
      throw new Error(
        "runtime-codex data directory creation crossed a symbolic link",
      );
    }
  }
  return root;
}

export async function prepareSandboxDataDirectory(
  authoredPath: string,
): Promise<string> {
  if (!isAbsolute(authoredPath) || resolve(authoredPath) !== authoredPath) {
    throw new Error(
      "runtime-codex sandbox data directory must be a canonical absolute path",
    );
  }
  const root = await prepareDataDirectory(authoredPath);
  const prepared = await lstat(root);
  assertOwnedDirectory(prepared, root, true);
  if (await realpath(root) !== root) {
    throw new Error(
      "runtime-codex sandbox data directory must be a canonical non-symlink path",
    );
  }
  return root;
}

export async function preparePersistentCodexHome(
  dataDirectory: string,
): Promise<string> {
  const root = await prepareDataDirectory(dataDirectory);
  const codexHome = join(root, "codex-home");
  const existing = await lstat(codexHome).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing === undefined) {
    await mkdir(codexHome, { mode: 0o700 });
  }
  const prepared = await lstat(codexHome);
  assertOwnedDirectory(prepared, codexHome, true);
  if (await realpath(codexHome) !== codexHome) {
    throw new Error(
      "runtime-codex contained home must be a canonical non-symlink path",
    );
  }
  const config = await lstat(join(codexHome, "config.toml")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (config !== undefined) {
    throw new Error("runtime-codex contained home must not contain config.toml");
  }
  return codexHome;
}

export async function resolveNativeCodexHome(): Promise<string> {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const userHome = process.env.HOME?.trim();
  const authored = configuredHome !== undefined && configuredHome !== ""
    ? configuredHome
    : userHome === undefined || userHome === ""
      ? undefined
      : join(userHome, ".codex");
  if (authored === undefined) {
    throw new Error("runtime-codex native auth requires CODEX_HOME or HOME");
  }
  const canonical = await realpath(resolve(authored));
  const info = await lstat(canonical);
  assertOwnedDirectory(info, canonical, false);
  return canonical;
}

export async function createProcessWorkingDirectory(
  dataDirectory?: string,
): Promise<{
  readonly directory: string;
  cleanup(): Promise<void>;
}> {
  const root = dataDirectory === undefined
    ? undefined
    : await prepareSandboxDataDirectory(dataDirectory);
  const directory = await mkdtemp(
    root === undefined
      ? join(tmpdir(), "mono-agent-codex-process-")
      : join(root, "process-"),
  );
  try {
    const info = await lstat(directory);
    assertOwnedDirectory(info, directory, true);
    if (
      root !== undefined
      && dirname(await realpath(directory)) !== root
    ) {
      throw new Error(
        "runtime-codex process directory escaped the sandbox data directory",
      );
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    directory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface DirectProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function defaultDirectSpawn(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
  },
): ProcessLike {
  return spawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

export function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex turn was cancelled");
}

async function runBoundedProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnProcess?: SpawnProcess;
}): Promise<DirectProcessResult> {
  if (options.signal.aborted) throw cancellationError(options.signal);
  const launch = options.spawnProcess ?? defaultDirectSpawn;
  const child = launch(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });
  return new Promise<DirectProcessResult>((resolveResult, rejectResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closed = false;
    let failure: Error | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let resolveClosed!: () => void;
    const processClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = (
      result: DirectProcessResult | undefined,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) rejectResult(error);
      else if (result !== undefined) resolveResult(result);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // Close or the bounded post-SIGKILL deadline remains authoritative.
      }
    };
    const terminate = (error: Error): void => {
      if (settled || failure !== undefined) return;
      failure = error;
      try {
        child.stdin.end();
      } catch {
        // Signal escalation remains authoritative.
      }
      if (closed) {
        finish(undefined, error);
        return;
      }
      kill("SIGTERM");
      if (closed || settled) return;
      terminateTimer = setTimeout(() => {
        if (closed || settled) return;
        kill("SIGKILL");
        if (closed || settled) return;
        forceTimer = setTimeout(() => {
          if (closed || settled) return;
          finish(
            undefined,
            new CodexPreflightTerminationError(
              "Codex preflight process did not exit after SIGKILL",
              processClosed,
              { cause: error },
            ),
          );
        }, PREFLIGHT_TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }, PREFLIGHT_TERMINATION_GRACE_MS);
      terminateTimer.unref?.();
    };
    const append = (
      stream: "stdout" | "stderr",
      chunk: Uint8Array,
    ): void => {
      if (failure !== undefined) return;
      const bytes = Buffer.from(chunk);
      if (stream === "stdout") {
        stdoutBytes += bytes.length;
        if (stdoutBytes <= PREFLIGHT_OUTPUT_MAX_BYTES) {
          stdout.push(bytes);
        }
      } else {
        stderrBytes += bytes.length;
        if (stderrBytes <= PREFLIGHT_OUTPUT_MAX_BYTES) {
          stderr.push(bytes);
        }
      }
      if (
        (stream === "stdout" ? stdoutBytes : stderrBytes)
        > PREFLIGHT_OUTPUT_MAX_BYTES
      ) {
        terminate(
          new Error(`Codex ${stream} exceeded the preflight output limit`),
        );
      }
    };
    const onAbort = (): void => {
      terminate(cancellationError(options.signal));
    };
    const timer = setTimeout(() => {
      terminate(new Error("Codex preflight timed out"));
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on(
      "data",
      (chunk) => append("stdout", chunk),
    );
    child.stderr.on(
      "data",
      (chunk) => append("stderr", chunk),
    );
    child.stdout.on("error", (error) => terminate(error));
    child.stderr.on("error", (error) => terminate(error));
    child.stdin.on("error", (error) => {
      terminate(error);
    });
    child.once("error", (error) => {
      if (child.pid === undefined) {
        finish(undefined, error);
        return;
      }
      terminate(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      resolveClosed();
      if (failure !== undefined) {
        finish(undefined, failure);
        return;
      }
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin.end();
    } catch (error) {
      terminate(error instanceof Error ? error : new Error(String(error)));
    }
    if (options.signal.aborted) onAbort();
  });
}

export function codexAppServerArguments(
  mcpServers: readonly EffectiveCodexMcpServer[],
): readonly string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    ...codexProcessConfigArguments(mcpServers),
  ];
}

function assertCleanProcessResult(
  result: DirectProcessResult,
  operation: string,
): void {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${operation} exited unsuccessfully`);
  }
  if (result.stderr.trim() !== "") {
    throw new Error(`${operation} emitted stderr`);
  }
}

function parseEffectiveMcpServers(
  output: string,
  operation: string,
): readonly EffectiveCodexMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${operation} emitted malformed JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${operation} did not return a server array`);
  }
  if (parsed.length > MAX_EFFECTIVE_MCP_SERVERS) {
    throw new Error(`${operation} exceeded the MCP server-count limit`);
  }
  const names = new Set<string>();
  const servers: EffectiveCodexMcpServer[] = [];
  for (const candidate of parsed) {
    const entry = record(candidate);
    const name = entry.name;
    const enabled = entry.enabled;
    const transport = record(entry.transport).type;
    if (
      typeof name !== "string"
      || Buffer.byteLength(name, "utf8") > MAX_MCP_SERVER_NAME_BYTES
      || typeof enabled !== "boolean"
      || (transport !== "stdio" && transport !== "streamable_http")
    ) {
      throw new Error(`${operation} returned an invalid MCP server entry`);
    }
    if (names.has(name)) {
      throw new Error(`${operation} returned duplicate MCP server names`);
    }
    // Exercise the same encoder used in the frozen CLI override now, before
    // any provider process is allowed to start.
    tomlBasicString(name);
    names.add(name);
    servers.push({ name, enabled, transport });
  }
  return servers.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export async function preflightCodexProcess(options: {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnProcess?: SpawnProcess;
  readonly probeStrictConfig: boolean;
}): Promise<readonly EffectiveCodexMcpServer[]> {
  const run = async (args: readonly string[]): Promise<DirectProcessResult> =>
    runBoundedProcess({ ...options, args });
  const version = await run(["--version"]);
  assertCleanProcessResult(version, "Codex version preflight");
  if (version.stdout.trim() !== SUPPORTED_CODEX_VERSION) {
    throw new Error(`runtime-codex requires exactly ${SUPPORTED_CODEX_VERSION}`);
  }

  const discovery = await run([
    "mcp",
    "list",
    "--json",
    ...codexProcessConfigArguments(),
  ]);
  assertCleanProcessResult(discovery, "Codex MCP discovery preflight");
  const configuredServers = parseEffectiveMcpServers(
    discovery.stdout,
    "Codex MCP discovery preflight",
  );

  if (options.probeStrictConfig) {
    const strictConfig = await run(codexAppServerArguments(configuredServers));
    assertCleanProcessResult(strictConfig, "Codex strict-config preflight");
    if (strictConfig.stdout.trim() !== "") {
      throw new Error("Codex strict-config preflight emitted unexpected output");
    }
  }

  const mcp = await run([
    "mcp",
    "list",
    "--json",
    ...codexProcessConfigArguments(configuredServers),
  ]);
  assertCleanProcessResult(mcp, "Codex MCP preflight");
  const verifiedServers = parseEffectiveMcpServers(
    mcp.stdout,
    "Codex MCP preflight",
  );
  if (
    verifiedServers.length !== configuredServers.length
    || verifiedServers.some((server, index) =>
      server.name !== configuredServers[index]?.name
      || server.transport !== configuredServers[index]?.transport
    )
  ) {
    throw new Error("Codex MCP server set changed during containment preflight");
  }
  if (verifiedServers.some((server) => server.enabled)) {
    throw new Error(
      "runtime-codex could not disable every effective Codex MCP server",
    );
  }
  return verifiedServers;
}

export function assertFrozenAppServerMcpConfig(
  value: unknown,
  expected: readonly EffectiveCodexMcpServer[],
): void {
  const response = record(value);
  if (
    response.config === null
    || typeof response.config !== "object"
    || Array.isArray(response.config)
  ) {
    throw new Error("Codex app-server returned malformed effective config");
  }
  const config = response.config as Record<string, unknown>;
  if (
    config.mcp_servers === null
    || typeof config.mcp_servers !== "object"
    || Array.isArray(config.mcp_servers)
  ) {
    throw new Error("Codex app-server returned malformed effective MCP config");
  }
  const mcpServers = config.mcp_servers as Record<string, unknown>;
  const actualNames = Object.keys(mcpServers).sort();
  const expectedNames = expected.map((server) => server.name).sort();
  if (
    actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "Codex app-server MCP config changed after containment preflight",
    );
  }
  const expectedByName = new Map(expected.map((server) => [
    server.name,
    server,
  ]));
  for (const name of actualNames) {
    const server = expectedByName.get(name);
    const actual = record(mcpServers[name]);
    if (
      server === undefined
      || actual.enabled !== false
      || actual.required === true
    ) {
      throw new Error("Codex app-server exposed an enabled MCP server");
    }
    if (
      server.transport === "stdio"
      && (
        actual.command !== INERT_CODEX_MCP_COMMAND
        || !Array.isArray(actual.args)
        || actual.args.length !== 0
        || actual.url !== undefined
      )
    ) {
      throw new Error("Codex app-server changed an inert MCP transport");
    }
    if (
      server.transport === "streamable_http"
      && (
        actual.url !== INERT_CODEX_MCP_URL
        || actual.command !== undefined
      )
    ) {
      throw new Error("Codex app-server changed an inert MCP transport");
    }
  }
}
