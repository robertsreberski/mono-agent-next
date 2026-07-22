import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { AgentConfigError, errorMessage } from "./errors.js";

const MCP_CLOSE_TIMEOUT_MS = 1_000;

export type McpServerConfig =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, McpConfigValue>>;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, McpConfigValue>>;
    };

export type McpConfigValue = string | { readonly $env: string };

export interface ProjectMcpConfig {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

export interface CoreRuntimeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly source:
    | { readonly kind: "mcp"; readonly server: string; readonly tool: string }
    | { readonly kind: "core"; readonly capability: "skills.read" };
  execute(input: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface ConnectedMcpTools {
  readonly tools: readonly CoreRuntimeTool[];
  close(): Promise<void>;
}

export async function loadProjectMcpConfig(
  path: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ProjectMcpConfig> {
  if (path === undefined) return { mcpServers: {} };
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new AgentConfigError(`Could not read project MCP config ${path}`, [
      { path: "context.mcp.configPath", message: errorMessage(error), code: "mcp_config" },
    ]);
  }
  const issues: { path: string; message: string; code: string }[] = [];
  if (!isRecord(candidate)) {
    issues.push({ path: "$", message: "MCP config must be an object", code: "type" });
  } else {
    rejectUnknown(candidate, new Set(["mcpServers"]), "$", issues);
    if (!isRecord(candidate.mcpServers)) {
      issues.push({ path: "mcpServers", message: "must be an object", code: "type" });
    } else {
      for (const [name, server] of Object.entries(candidate.mcpServers)) validateServer(name, server, environment, issues);
    }
  }
  if (issues.length > 0) throw new AgentConfigError(`Invalid project MCP config ${path}`, issues);
  return candidate as unknown as ProjectMcpConfig;
}

export async function connectProjectMcpTools(
  config: ProjectMcpConfig,
  options: {
    readonly configPath?: string;
    readonly projectRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): Promise<ConnectedMcpTools> {
  const connected: { readonly server: string; readonly client: Client; readonly transport: { close(): Promise<void> } }[] = [];
  try {
    for (const server of Object.keys(config.mcpServers).sort()) {
      const entry = config.mcpServers[server];
      if (entry === undefined) continue;
      const client = new Client({ name: `mono-agent-core/${server}`, version: "0.15.0" }, { capabilities: {} });
      const transport = createTransport(entry, options);
      await client.connect(transport as Transport);
      connected.push({ server, client, transport });
    }
    const tools: CoreRuntimeTool[] = [];
    const names = new Set<string>();
    for (const entry of connected) {
      const listed = await entry.client.listTools();
      for (const tool of listed.tools) {
        const name = names.has(tool.name) ? `mcp__${safeName(entry.server)}__${safeName(tool.name)}` : tool.name;
        if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
        names.add(name);
        tools.push({
          name,
          description: tool.description ?? `${entry.server}:${tool.name}`,
          inputSchema: tool.inputSchema,
          source: { kind: "mcp", server: entry.server, tool: tool.name },
          async execute(input, callOptions = {}) {
            if (callOptions.signal?.aborted) throw abortError();
            return entry.client.callTool(
              { name: tool.name, arguments: isRecord(input) ? input : {} },
              undefined,
              {
                ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
                timeout: 120_000,
                maxTotalTimeout: 900_000,
              },
            );
          },
        });
      }
    }
    return {
      tools,
      async close() {
        for (const entry of [...connected].reverse()) {
          await bestEffortClose(entry.client, entry.transport);
        }
      },
    };
  } catch (error) {
    for (const entry of [...connected].reverse()) await bestEffortClose(entry.client, entry.transport);
    throw error;
  }
}

function createTransport(
  config: McpServerConfig,
  options: {
    readonly configPath?: string;
    readonly projectRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.type === "http") {
    const url = new URL(config.url);
    assertSafeMcpHttpUrl(url);
    const headers = resolveMcpValues(config.headers ?? {}, "header", options.environment);
    return new StreamableHTTPClientTransport(
      url,
      Object.keys(headers).length === 0 ? undefined : { requestInit: { headers } },
    );
  }
  const base = options.configPath === undefined ? options.projectRoot : dirname(options.configPath);
  const cwd = config.cwd === undefined
    ? options.projectRoot
    : isAbsolute(config.cwd)
      ? config.cwd
      : resolve(base, config.cwd);
  const env = executionBaseline(options.environment);
  return new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    cwd,
    env: { ...env, ...resolveMcpValues(config.env ?? {}, "environment", options.environment) },
  });
}

function validateServer(
  name: string,
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  issues: { path: string; message: string; code: string }[],
): void {
  const path = `mcpServers.${name}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) {
    issues.push({ path, message: "server name is not path-safe", code: "format" });
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object", code: "type" });
    return;
  }
  if (value.type === "stdio") {
    rejectUnknown(value, new Set(["type", "command", "args", "cwd", "env"]), path, issues);
    nonEmptyString(value.command, `${path}.command`, issues);
    if (value.args !== undefined) stringArray(value.args, `${path}.args`, issues);
    if (value.cwd !== undefined) nonEmptyString(value.cwd, `${path}.cwd`, issues);
    if (value.env !== undefined) {
      configValueRecord(value.env, `${path}.env`, "environment", environment, issues);
    }
    return;
  }
  if (value.type === "http") {
    rejectUnknown(value, new Set(["type", "url", "headers"]), path, issues);
    if (nonEmptyString(value.url, `${path}.url`, issues)) {
      try {
        const url = new URL(value.url);
        if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) {
          issues.push({
            path: `${path}.url`,
            message: "must use HTTPS, or plain HTTP with a literal loopback IP address",
            code: "url_protocol",
          });
        } else if (url.username.length > 0 || url.password.length > 0) {
          issues.push({
            path: `${path}.url`,
            message: "must not contain embedded credentials",
            code: "url_credentials",
          });
        } else if (url.protocol === "http:" && !isLiteralLoopbackHostname(url.hostname)) {
          issues.push({
            path: `${path}.url`,
            message: "plain HTTP is allowed only for a literal loopback IP address",
            code: "insecure_http",
          });
        }
      } catch {
        issues.push({ path: `${path}.url`, message: "must be a valid HTTP(S) URL", code: "url" });
      }
    }
    if (value.headers !== undefined) {
      configValueRecord(value.headers, `${path}.headers`, "header", environment, issues);
    }
    return;
  }
  issues.push({ path: `${path}.type`, message: "must be explicitly stdio or http", code: "enum" });
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: { path: string; message: string; code: string }[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: path === "$" ? key : `${path}.${key}`, message: "is not allowed", code: "unknown" });
  }
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: { path: string; message: string; code: string }[],
): value is string {
  if (typeof value === "string" && value.trim().length > 0) return true;
  issues.push({ path, message: "must be a non-empty string", code: "type" });
  return false;
}

function stringArray(
  value: unknown,
  path: string,
  issues: { path: string; message: string; code: string }[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array", code: "type" });
    return;
  }
  value.forEach((entry, index) => nonEmptyString(entry, `${path}.${index}`, issues));
}

function configValueRecord(
  value: unknown,
  path: string,
  kind: "environment" | "header",
  environment: Readonly<Record<string, string | undefined>>,
  issues: { path: string; message: string; code: string }[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object", code: "type" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (isSecretBearingName(key, kind)) {
        issues.push({
          path: `${path}.${key}`,
          message: "secret-bearing values must use an explicit {$env:NAME} reference",
          code: "inline_secret",
        });
      } else {
        nonEmptyString(entry, `${path}.${key}`, issues);
      }
      continue;
    }
    if (!isEnvironmentReference(entry)) {
      issues.push({ path: `${path}.${key}`, message: "must be a string or {$env:NAME}", code: "type" });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.$env)) {
      issues.push({ path: `${path}.${key}.$env`, message: "must be an environment variable name", code: "env_name" });
      continue;
    }
    const resolved = environment[entry.$env];
    if (typeof resolved !== "string" || resolved.length === 0) {
      issues.push({
        path: `${path}.${key}`,
        message: `environment variable ${entry.$env} is missing or empty`,
        code: "missing_environment",
      });
    }
  }
}

function isLiteralLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return isIP(normalized) === 6 && normalized.toLowerCase() === "::1";
}

function isSecretBearingName(name: string, kind: "environment" | "header"): boolean {
  const normalized = name.toLowerCase();
  if (
    kind === "header" &&
    ["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(normalized)
  ) {
    return true;
  }
  return /(?:^|[^a-z0-9])(?:api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|token|secret|password|credentials?|bearer|cookie)(?:$|[^a-z0-9])/u.test(
    normalized,
  );
}

function resolveMcpValues(
  values: Readonly<Record<string, McpConfigValue>>,
  kind: "environment" | "header",
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      if (isSecretBearingName(key, kind)) {
        throw new Error(`MCP ${kind} value ${key} must use an explicit environment reference`);
      }
      output[key] = value;
      continue;
    }
    const resolved = environment[value.$env];
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error(`MCP environment variable ${value.$env} is missing or empty`);
    }
    output[key] = resolved;
  }
  return output;
}

function assertSafeMcpHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP HTTP transport requires an HTTP(S) URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("MCP HTTP transport URL must not contain credentials");
  }
  if (url.protocol === "http:" && !isLiteralLoopbackHostname(url.hostname)) {
    throw new Error("MCP plain HTTP transport requires a literal loopback IP address");
  }
}

function executionBaseline(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot", "ComSpec", "PATHEXT"]) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0) output[name] = value;
  }
  return output;
}

function isEnvironmentReference(value: unknown): value is { readonly $env: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$env === "string";
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

/** @internal Exported only for focused lifecycle verification. */
export async function bestEffortClose(
  client: { close(): Promise<void> },
  transport: { close(): Promise<void> },
  timeoutMs = MCP_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const clientResult = await closeWithin(() => client.close(), timeoutMs);
  if (clientResult === "closed") return;
  await closeWithin(() => transport.close(), timeoutMs);
}

async function closeWithin(
  close: () => Promise<void>,
  timeoutMs: number,
): Promise<"closed" | "failed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(close).then(
        () => "closed" as const,
        () => "failed" as const,
      ),
      new Promise<"timed_out">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timed_out"), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
