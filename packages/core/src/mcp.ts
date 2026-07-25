// SPDX-License-Identifier: MIT
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  ModuleSlot,
  RuntimeNativeToolEffect,
} from "@mono-agent/module-sdk";
import { AgentConfigError, errorMessage } from "./errors.js";
import type { McpRequestContextV1 } from "./current-run-output.js";
const MCP_CLOSE_TIMEOUT_MS = 1_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_CATALOG_TIMEOUT_MS = 10_000;
const MCP_CALL_TIMEOUT_MS = 120_000;
const MCP_CALL_TOTAL_TIMEOUT_MS = 900_000;
const MCP_REQUEST_CONTEXT_CALL_TOTAL_TIMEOUT_MS = 2_700_000;
const MCP_MAX_SERVERS = 32;
const MCP_MAX_CATALOG_PAGES = 16;
const MCP_MAX_TOOLS_PER_SERVER = 128;
const MCP_MAX_TOOLS_TOTAL = 256;
const MCP_MAX_CURSOR_BYTES = 1_024;
const MCP_MAX_TOOL_NAME_BYTES = 256;
const MCP_MAX_DESCRIPTION_BYTES = 16 * 1_024;
const MCP_MAX_TOOL_SCHEMA_BYTES = 64 * 1_024;
const MCP_MAX_CATALOG_BYTES = 512 * 1_024;
const MCP_MAX_FRAME_BYTES = 1024 * 1024;
const MCP_MAX_PROGRESS_EVENTS = 256;
const MCP_MAX_PROGRESS_BYTES = 256 * 1024;
const MCP_STDERR_CAPTURE_MAX_BYTES = 64 * 1024;
const MCP_STDERR_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const MCP_MAX_REDIRECTS = 3;
const MCP_STDIO_CLOSE_STEP_MS = 250;
const MCP_PORTABLE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;
const MCP_RESERVED_TOOL_PREFIXES = ["core__", "runtime__"] as const;
export const MCP_REQUEST_CONTEXT_META_KEY = "com.mono-agent/request-context";
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
  /** The raw MCP name when it is safe to retain as the model-visible alias. */
  readonly rawAlias?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Present for selected-module tools; other source kinds retain their established authority model. */
  readonly effects?: readonly RuntimeNativeToolEffect[];
  readonly requestContextResult?: boolean;
  readonly source:
    | { readonly kind: "mcp"; readonly server: string; readonly tool: string }
    | { readonly kind: "channel"; readonly instanceId: string; readonly tool: string }
    | {
        readonly kind: "module";
        readonly slot: ModuleSlot;
        readonly instanceId: string;
        readonly packageName: string;
        readonly tool: string;
      }
    | { readonly kind: "core"; readonly capability: "skills.read" | "memory.recall" | "interaction.ask-user" };
  execute(input: unknown, options?: {
    readonly signal?: AbortSignal;
    readonly callId?: string;
    readonly requestContext?: McpRequestContextV1;
    readonly onActivity?: (text: string) => void;
  }): Promise<unknown>;
}
export interface ConnectedMcpTools {
  readonly tools: readonly CoreRuntimeTool[];
  /** Raw source names that cannot be used safely in tool policy. */
  readonly ambiguousAliases?: readonly string[];
  close(): Promise<void>;
}
/**
 * Parse bytes already read through Core's authority-safe configuration path.
 * This function is pure and never opens the source path.
 */
export function parseProjectMcpConfig(
  candidate: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  sourcePath = "project MCP config",
): ProjectMcpConfig {
  const issues: { path: string; message: string; code: string }[] = [];
  if (!isRecord(candidate)) {
    issues.push({ path: "$", message: "MCP config must be an object", code: "type" });
  } else {
    rejectUnknown(candidate, new Set(["mcpServers"]), "$", issues);
    if (!isRecord(candidate.mcpServers)) {
      issues.push({ path: "mcpServers", message: "must be an object", code: "type" });
    } else {
      const servers = Object.entries(candidate.mcpServers);
      if (servers.length > MCP_MAX_SERVERS) {
        issues.push({
          path: "mcpServers",
          message: `must contain at most ${MCP_MAX_SERVERS} servers`,
          code: "limit",
        });
      } else {
        for (const [name, server] of servers) validateServer(name, server, environment, issues);
      }
    }
  }
  if (issues.length > 0) throw new AgentConfigError(`Invalid project MCP config ${sourcePath}`, issues);
  return candidate as unknown as ProjectMcpConfig;
}
export async function connectProjectMcpTools(
  config: ProjectMcpConfig,
  options: {
    readonly configPath?: string;
    readonly projectRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly connectTimeoutMs?: number;
    readonly catalogTimeoutMs?: number;
    readonly callTimeoutMs?: number;
    readonly callTotalTimeoutMs?: number;
    readonly requestContextServers?: readonly string[];
  },
): Promise<ConnectedMcpTools> {
  const connected: { readonly server: string; readonly client: Client; readonly transport: Transport }[] = [];
  const connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, MCP_CONNECT_TIMEOUT_MS, "MCP connect timeout");
  const catalogTimeoutMs = positiveTimeout(options.catalogTimeoutMs, MCP_CATALOG_TIMEOUT_MS, "MCP catalog timeout");
  const callTimeoutMs = Math.min(positiveTimeout(options.callTimeoutMs, MCP_CALL_TIMEOUT_MS, "MCP call timeout"), MCP_CALL_TIMEOUT_MS);
  const callTotalTimeoutMs = Math.min(positiveTimeout(options.callTotalTimeoutMs, MCP_CALL_TOTAL_TIMEOUT_MS, "MCP call total timeout"), MCP_CALL_TOTAL_TIMEOUT_MS);
  const requestContextCallTotalTimeoutMs = Math.min(positiveTimeout(options.callTotalTimeoutMs, MCP_REQUEST_CONTEXT_CALL_TOTAL_TIMEOUT_MS, "MCP call total timeout"), MCP_REQUEST_CONTEXT_CALL_TOTAL_TIMEOUT_MS);
  const requestContextServers = new Set(options.requestContextServers ?? []);
  if (requestContextServers.size !== (options.requestContextServers?.length ?? 0)
    || requestContextServers.size > MCP_MAX_SERVERS) {
    throw new Error("MCP request-context server selection must be unique and bounded");
  }
  for (const server of requestContextServers) {
    if (config.mcpServers[server]?.type !== "stdio") {
      throw new Error(`MCP request-context server ${server} must be a configured stdio server`);
    }
  }
  try {
    const servers = Object.keys(config.mcpServers).sort();
    if (servers.length > MCP_MAX_SERVERS) {
      throw new Error(`MCP server limit exceeded: ${servers.length} > ${MCP_MAX_SERVERS}`);
    }
    for (const server of servers) {
      const entry = config.mcpServers[server];
      if (entry === undefined) continue;
      const client = new Client({ name: `mono-agent-core/${server}`, version: "0.15.0" }, { capabilities: {} });
      const transport = createTransport(entry, options);
      try {
        await runWithDeadline(
          `MCP server ${server} connection`,
          options.signal,
          connectTimeoutMs,
          (signal) => client.connect(transport, {
            signal,
            timeout: connectTimeoutMs,
            maxTotalTimeout: connectTimeoutMs,
          }),
        );
        connected.push({ server, client, transport });
      } catch (error) {
        await bestEffortClose(client, transport);
        throw error;
      }
    }
    const catalog: PendingMcpTool[] = [];
    let catalogBytes = 0;
    for (const entry of connected) {
      const listed = await listAllTools(entry.server, entry.client, options.signal, catalogTimeoutMs);
      for (const tool of listed) {
        catalogBytes += validateCatalogTool(entry.server, tool);
        if (catalogBytes > MCP_MAX_CATALOG_BYTES) {
          throw new Error(`MCP catalog exceeds ${MCP_MAX_CATALOG_BYTES} bytes`);
        }
        catalog.push({ server: entry.server, client: entry.client, tool });
        if (catalog.length > MCP_MAX_TOOLS_TOTAL) {
          throw new Error(`MCP tool limit exceeded: ${catalog.length} > ${MCP_MAX_TOOLS_TOTAL}`);
        }
      }
    }
    catalog.sort(comparePendingTools);
    const resolved = resolveMcpToolNames(catalog.map(({ server, tool }) => ({ server, tool: tool.name })));
    const resolvedBySource = new Map(resolved.tools.map((tool) => [sourceIdentity(tool.server, tool.tool), tool]));
    const tools = catalog.map(({ server, client, tool }): CoreRuntimeTool => {
      const resolvedTool = resolvedBySource.get(sourceIdentity(server, tool.name));
      if (resolvedTool === undefined) throw new Error(`MCP tool identity resolution failed for ${server}:${tool.name}`);
      const requestScoped = requestContextServers.has(server);
      const totalTimeoutMs = requestScoped ? requestContextCallTotalTimeoutMs : callTotalTimeoutMs;
      return {
        name: resolvedTool.name,
        ...(resolvedTool.rawAlias === undefined ? {} : { rawAlias: resolvedTool.rawAlias }),
        description: tool.description ?? `${server}:${tool.name}`,
        inputSchema: tool.inputSchema,
        ...(requestScoped ? { requestContextResult: true } : {}),
        source: { kind: "mcp", server, tool: tool.name },
        async execute(input, callOptions = {}) {
          if (callOptions.signal?.aborted) throw abortError(callOptions.signal.reason);
          const requestContext = requestScoped ? callOptions.requestContext : undefined;
          return runWithDeadline(
            `MCP tool ${server}:${tool.name}`,
            callOptions.signal,
            totalTimeoutMs,
            (signal) => {
              const progress = requestScoped ? createProgressBoundary(signal, callOptions.onActivity) : undefined;
              const operation = client.callTool({
                name: tool.name, arguments: isRecord(input) ? input : {},
                ...(requestContext === undefined ? {} : {
                  _meta: { [MCP_REQUEST_CONTEXT_META_KEY]: requestContext },
                }),
              }, undefined, {
                signal: progress?.signal ?? signal,
                timeout: Math.min(callTimeoutMs, totalTimeoutMs),
                maxTotalTimeout: totalTimeoutMs + callTimeoutMs,
                ...(progress === undefined ? {} : {
                  resetTimeoutOnProgress: true, onprogress: progress.accept,
                }),
              });
              return progress === undefined ? operation : Promise.race([operation, progress.violation]);
            },
          );
        },
      };
    });
    return {
      tools,
      ambiguousAliases: resolved.ambiguousAliases,
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
type ListedMcpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
interface PendingMcpTool {
  readonly server: string;
  readonly client: Client;
  readonly tool: ListedMcpTool;
}
interface McpToolSource {
  readonly server: string;
  readonly tool: string;
}
interface ResolvedMcpToolName extends McpToolSource {
  readonly name: string;
  readonly rawAlias?: string;
}
/**
 * Resolve names from a complete catalog. Exported only for focused security
 * verification; callers should use connectProjectMcpTools.
 */
export function resolveMcpToolNames(
  sources: readonly McpToolSource[],
): { readonly tools: readonly ResolvedMcpToolName[]; readonly ambiguousAliases: readonly string[] } {
  const sourceIdentities = new Set<string>();
  const rawCounts = new Map<string, number>();
  for (const source of sources) {
    const identity = sourceIdentity(source.server, source.tool);
    if (sourceIdentities.has(identity)) {
      throw new Error(`MCP server ${source.server} advertised duplicate tool ${source.tool}`);
    }
    sourceIdentities.add(identity);
    rawCounts.set(source.tool, (rawCounts.get(source.tool) ?? 0) + 1);
  }
  const ambiguousAliases = [...rawCounts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  const resolved = sources.map((source): ResolvedMcpToolName => {
    const canUseRawAlias = rawCounts.get(source.tool) === 1
      && isPortableRawToolName(source.tool);
    if (canUseRawAlias) {
      return { ...source, name: source.tool, rawAlias: source.tool };
    }
    return { ...source, name: canonicalMcpToolName(source) };
  });
  const finalNames = new Set<string>();
  for (const tool of resolved) {
    if (finalNames.has(tool.name)) {
      throw new Error(`MCP final tool name collision: ${tool.name}`);
    }
    finalNames.add(tool.name);
  }
  return { tools: resolved, ambiguousAliases };
}
function canonicalMcpToolName(source: McpToolSource): string {
  const digest = createHash("sha256")
    .update(sourceIdentity(source.server, source.tool), "utf8")
    .digest("base64url");
  return `mcp__${digest}`;
}
function sourceIdentity(server: string, tool: string): string {
  return `mcp-tool-v1\0${Buffer.byteLength(server, "utf8")}:${server}\0${Buffer.byteLength(tool, "utf8")}:${tool}`;
}
function isPortableRawToolName(name: string): boolean {
  return MCP_PORTABLE_TOOL_NAME.test(name)
    && !MCP_RESERVED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
async function listAllTools(
  server: string,
  client: Client,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly ListedMcpTool[]> {
  const output: ListedMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MCP_MAX_CATALOG_PAGES; page += 1) {
    const listed = await runWithDeadline(
      `MCP server ${server} tool catalog page ${page + 1}`,
      signal,
      timeoutMs,
      (requestSignal) => client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: requestSignal, timeout: timeoutMs, maxTotalTimeout: timeoutMs },
      ),
    );
    output.push(...listed.tools);
    if (output.length > MCP_MAX_TOOLS_PER_SERVER) {
      throw new Error(
        `MCP server ${server} tool limit exceeded: ${output.length} > ${MCP_MAX_TOOLS_PER_SERVER}`,
      );
    }
    if (listed.nextCursor === undefined) return output;
    if (listed.nextCursor.length === 0 || Buffer.byteLength(listed.nextCursor, "utf8") > MCP_MAX_CURSOR_BYTES) {
      throw new Error(`MCP server ${server} returned an invalid tools/list cursor`);
    }
    if (seenCursors.has(listed.nextCursor)) {
      throw new Error(`MCP server ${server} repeated tools/list cursor`);
    }
    seenCursors.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }
  throw new Error(`MCP server ${server} exceeded ${MCP_MAX_CATALOG_PAGES} tools/list pages`);
}
function validateCatalogTool(server: string, tool: ListedMcpTool): number {
  const nameBytes = Buffer.byteLength(tool.name, "utf8");
  if (nameBytes === 0 || nameBytes > MCP_MAX_TOOL_NAME_BYTES) {
    throw new Error(`MCP server ${server} returned a tool name outside the byte limit`);
  }
  const descriptionBytes = Buffer.byteLength(tool.description ?? "", "utf8");
  if (descriptionBytes > MCP_MAX_DESCRIPTION_BYTES) {
    throw new Error(`MCP tool ${server}:${tool.name} description exceeds ${MCP_MAX_DESCRIPTION_BYTES} bytes`);
  }
  const schemaBytes = jsonByteLength(tool.inputSchema, `MCP tool ${server}:${tool.name} input schema`);
  if (schemaBytes > MCP_MAX_TOOL_SCHEMA_BYTES) {
    throw new Error(`MCP tool ${server}:${tool.name} input schema exceeds ${MCP_MAX_TOOL_SCHEMA_BYTES} bytes`);
  }
  if (tool.outputSchema !== undefined) {
    const outputSchemaBytes = jsonByteLength(tool.outputSchema, `MCP tool ${server}:${tool.name} output schema`);
    if (outputSchemaBytes > MCP_MAX_TOOL_SCHEMA_BYTES) {
      throw new Error(`MCP tool ${server}:${tool.name} output schema exceeds ${MCP_MAX_TOOL_SCHEMA_BYTES} bytes`);
    }
  }
  return jsonByteLength(tool, `MCP tool ${server}:${tool.name} catalog entry`);
}
function comparePendingTools(left: PendingMcpTool, right: PendingMcpTool): number {
  return compareCodeUnits(left.server, right.server) || compareCodeUnits(left.tool.name, right.tool.name);
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
type McpProgress = {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
};
function rawMcpProgress(progress: McpProgress): string {
  const fallback = progress.total === undefined
    ? `MCP progress ${String(progress.progress)}`
    : `MCP progress ${String(progress.progress)} of ${String(progress.total)}`;
  return progress.message ?? fallback;
}
function createProgressBoundary(
  parentSignal: AbortSignal,
  onActivity: ((text: string) => void) | undefined,
): { readonly signal: AbortSignal; readonly violation: Promise<never>; readonly accept: (progress: McpProgress) => void } {
  const controller = new AbortController();
  let events = 0; let bytes = 0; let rejectViolation!: (error: Error) => void;
  const violation = new Promise<never>((_resolve, reject) => { rejectViolation = reject; });
  const fail = (error: Error): void => {
    if (controller.signal.aborted) return;
    rejectViolation(error); controller.abort(error);
  };
  return {
    signal: AbortSignal.any([parentSignal, controller.signal]), violation,
    accept(progress) {
      if (controller.signal.aborted) return;
      const text = rawMcpProgress(progress);
      events += 1; bytes += Buffer.byteLength(text, "utf8");
      if (events > MCP_MAX_PROGRESS_EVENTS || bytes > MCP_MAX_PROGRESS_BYTES) {
        fail(new Error("MCP progress exceeds the per-call event or byte limit")); return;
      }
      try { onActivity?.(text); } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
function createTransport(
  config: McpServerConfig,
  options: {
    readonly configPath?: string;
    readonly projectRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): Transport {
  if (config.type === "http") {
    const url = new URL(config.url);
    assertSafeMcpHttpUrl(url);
    const headers = resolveMcpValues(config.headers ?? {}, "header", options.environment);
    const transport = new StreamableHTTPClientTransport(
      url,
      {
        ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
        fetch: createCheckedMcpFetch(url),
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 2_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 2,
        },
      },
    );
    return transport as unknown as Transport;
  }
  const base = options.configPath === undefined ? options.projectRoot : dirname(options.configPath);
  const cwd = config.cwd === undefined
    ? options.projectRoot
    : isAbsolute(config.cwd)
      ? config.cwd
      : resolve(base, config.cwd);
  const env = executionBaseline(options.environment);
  const configuredEnv = resolveMcpValues(
    config.env ?? {},
    "environment",
    options.environment,
  );
  return new BoundedStdioMcpTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    cwd,
    env: { ...env, ...configuredEnv },
    redactionValues: Object.values(configuredEnv),
  }) as unknown as Transport;
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
/**
 * Fetch wrapper for MCP HTTP transports. Redirects are followed manually so
 * every hop is revalidated before configured headers can be forwarded.
 * Exported only for focused transport verification.
 */
export function createCheckedMcpFetch(
  configuredUrl: URL,
  baseFetch: FetchLike = globalThis.fetch,
): FetchLike {
  assertSafeMcpHttpUrl(configuredUrl);
  const configuredOrigin = configuredUrl.origin;
  return async (input, init) => {
    assertBoundedHttpRequestBody(init?.body);
    let current = new URL(input.toString());
    for (let redirects = 0; ; redirects += 1) {
      assertSafeMcpHttpUrl(current);
      if (current.origin !== configuredOrigin) {
        throw new Error(`MCP HTTP redirect changed origin from ${configuredOrigin} to ${current.origin}`);
      }
      const response = await baseFetch(current, { ...init, redirect: "manual" });
      if (!isRedirectStatus(response.status)) return boundedMcpResponse(response);
      await response.body?.cancel();
      if (redirects >= MCP_MAX_REDIRECTS) {
        throw new Error(`MCP HTTP redirect limit exceeded (${MCP_MAX_REDIRECTS})`);
      }
      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw new Error(`MCP HTTP redirect ${response.status} omitted Location`);
      }
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && response.status !== 307 && response.status !== 308) {
        throw new Error(`MCP HTTP ${method} rejects method-changing redirect ${response.status}`);
      }
      current = new URL(location, current);
    }
  };
}
function assertBoundedHttpRequestBody(body: RequestInit["body"] | undefined): void {
  if (body === undefined || body === null) return;
  let bytes: number;
  if (typeof body === "string") bytes = Buffer.byteLength(body, "utf8");
  else if (body instanceof URLSearchParams) bytes = Buffer.byteLength(body.toString(), "utf8");
  else if (body instanceof Blob) bytes = body.size;
  else if (body instanceof ArrayBuffer) bytes = body.byteLength;
  else if (ArrayBuffer.isView(body)) bytes = body.byteLength;
  else throw new Error("MCP HTTP transport rejects unsupported streaming request bodies");
  if (bytes > MCP_MAX_FRAME_BYTES) {
    throw new Error(`MCP HTTP request body exceeds ${MCP_MAX_FRAME_BYTES} bytes`);
  }
}
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function boundedMcpResponse(response: Response): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  const contentLength = response.headers.get("content-length");
  if (!isEventStream && contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      void response.body?.cancel();
      throw new Error("MCP HTTP response has an invalid Content-Length");
    }
    if (Number(contentLength) > MCP_MAX_FRAME_BYTES) {
      void response.body?.cancel();
      throw new Error(`MCP HTTP response exceeds ${MCP_MAX_FRAME_BYTES} bytes`);
    }
  }
  const body = response.body === null
    ? null
    : response.body.pipeThrough(isEventStream
      ? boundedSseFrames(MCP_MAX_FRAME_BYTES)
      : boundedByteStream(MCP_MAX_FRAME_BYTES));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function boundedByteStream(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(`MCP HTTP response exceeds ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
function boundedSseFrames(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let frameBytes = 0;
  let lineHasContent = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        frameBytes += 1;
        if (frameBytes > maxBytes) {
          controller.error(new Error(`MCP SSE frame exceeds ${maxBytes} bytes`));
          return;
        }
        if (byte === 0x0a) {
          if (!lineHasContent) frameBytes = 0;
          lineHasContent = false;
        } else if (byte !== 0x0d) {
          lineHasContent = true;
        }
      }
      controller.enqueue(chunk);
    },
  });
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
interface BoundedStdioMcpParameters {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Explicit configured values that must never appear in surfaced diagnostics. */
  readonly redactionValues?: readonly string[];
}
/**
 * Newline-delimited MCP transport that enforces the frame limit before UTF-8
 * decoding or JSON parsing. Exported only for focused transport verification.
 */
export class BoundedStdioMcpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport["onmessage"]>;
  readonly #parameters: BoundedStdioMcpParameters;
  readonly #maxFrameBytes: number;
  readonly #closeStepMs: number;
  readonly #redactionValues: readonly string[];
  #process: ChildProcess | undefined;
  #buffer = Buffer.alloc(0);
  #stderrChunks: Buffer[] = [];
  #stderrBytes = 0;
  #stderrTruncated = false;
  #started = false;
  #failed = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(
    parameters: BoundedStdioMcpParameters,
    maxFrameBytes = MCP_MAX_FRAME_BYTES,
    closeStepMs = MCP_STDIO_CLOSE_STEP_MS,
  ) {
    this.#parameters = parameters;
    this.#maxFrameBytes = positiveTimeout(maxFrameBytes, MCP_MAX_FRAME_BYTES, "MCP stdio frame limit");
    this.#closeStepMs = positiveTimeout(closeStepMs, MCP_STDIO_CLOSE_STEP_MS, "MCP stdio close timeout");
    this.#redactionValues = [...new Set(parameters.redactionValues ?? [])]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
  }
  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP stdio transport already started");
    this.#started = true;
    await new Promise<void>((resolveStart, rejectStart) => {
      let spawned = false;
      const child = spawn(this.#parameters.command, [...this.#parameters.args], {
        cwd: this.#parameters.cwd,
        env: { ...this.#parameters.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.#process = child;
      child.once("spawn", () => {
        spawned = true;
        resolveStart();
      });
      child.on("error", (error) => {
        if (!spawned) rejectStart(error);
        this.#fail(error);
      });
      child.once("close", (code, signal) => {
        if (this.#process === child) this.#process = undefined;
        this.#buffer = Buffer.alloc(0);
        if (!this.#failed && !this.#closed && this.#closePromise === undefined) {
          const status = signal === null
            ? `code ${String(code)}`
            : `signal ${signal}`;
          this.#fail(new Error(`MCP stdio process exited unexpectedly with ${status}`));
          return;
        }
        this.#notifyClose();
      });
      if (child.stdin === null || child.stdout === null || child.stderr === null) {
        const error = new Error("MCP stdio transport did not receive child pipes");
        rejectStart(error);
        this.#fail(error);
        return;
      }
      child.stdin.on("error", (error) => this.#fail(error));
      child.stdout.on("error", (error) => this.#fail(error));
      child.stderr.on("error", (error) => this.#fail(error));
      child.stderr.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        this.#consumeStderr(bytes);
      });
      child.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        this.#consume(bytes);
      });
    });
  }

  async send(
    message: Parameters<Transport["send"]>[0],
    _options?: Parameters<Transport["send"]>[1],
  ): Promise<void> {
    if (this.#failed) throw new Error("MCP stdio transport failed");
    const child = this.#process;
    if (child?.stdin === null || child?.stdin === undefined || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("MCP stdio transport is not connected");
    }
    const serialized = JSON.stringify(message);
    const frameBytes = Buffer.byteLength(serialized, "utf8");
    if (frameBytes > this.#maxFrameBytes) {
      throw new Error(`MCP stdio outbound frame exceeds ${this.#maxFrameBytes} bytes`);
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin!.write(`${serialized}\n`, "utf8", (error) => {
        if (error === null || error === undefined) resolveWrite();
        else rejectWrite(error);
      });
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  #consume(chunk: Buffer): void {
    if (this.#failed || this.#closed || chunk.length === 0) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) {
          const tail = chunk.subarray(offset);
          if (this.#buffer.length + tail.length > this.#maxFrameBytes) {
            throw new Error(`MCP stdio frame exceeds ${this.#maxFrameBytes} bytes before newline`);
          }
          this.#buffer = this.#buffer.length === 0
            ? Buffer.from(tail)
            : Buffer.concat([this.#buffer, tail], this.#buffer.length + tail.length);
          return;
        }
        const segment = chunk.subarray(offset, newline);
        if (this.#buffer.length + segment.length > this.#maxFrameBytes) {
          throw new Error(`MCP stdio frame exceeds ${this.#maxFrameBytes} bytes`);
        }
        let line = this.#buffer.length === 0
          ? segment
          : Buffer.concat([this.#buffer, segment], this.#buffer.length + segment.length);
        this.#buffer = Buffer.alloc(0);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (line.length === 0) throw new Error("MCP stdio emitted an empty frame");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const message = JSONRPCMessageSchema.parse(JSON.parse(text));
        this.onmessage?.(message);
        offset = newline + 1;
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    this.#buffer = Buffer.alloc(0);
    this.#process?.stdout?.pause();
    const safeError = this.#safeProcessError(error);
    try {
      this.onerror?.(safeError);
    } finally {
      void this.close();
    }
  }

  #consumeStderr(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    const remaining = MCP_STDERR_CAPTURE_MAX_BYTES - this.#stderrBytes;
    if (remaining > 0) {
      const selected = chunk.subarray(0, Math.min(remaining, chunk.length));
      this.#stderrChunks.push(Buffer.from(selected));
      this.#stderrBytes += selected.length;
    }
    if (chunk.length > remaining) this.#stderrTruncated = true;
  }

  #safeProcessError(error: Error): Error {
    const message = boundedSafeDiagnostic(
      redactDiagnostic(error.message, this.#redactionValues),
      MCP_STDERR_DIAGNOSTIC_MAX_BYTES,
    );
    const stderr = this.#safeStderrDiagnostic();
    const safe = new Error(boundedSafeDiagnostic(
      stderr === undefined ? message : `${message}; ${stderr}`,
      MCP_STDERR_DIAGNOSTIC_MAX_BYTES,
    ));
    safe.name = error.name;
    return safe;
  }

  #safeStderrDiagnostic(): string | undefined {
    if (this.#stderrBytes === 0 && !this.#stderrTruncated) return undefined;
    const decoded = Buffer.concat(this.#stderrChunks, this.#stderrBytes).toString("utf8");
    let redacted = redactDiagnostic(decoded, this.#redactionValues);
    if (this.#stderrTruncated && this.#redactionValues.length > 0) {
      // A configured value may straddle the retained-prefix boundary. Remove
      // enough trailing characters that no partial suffix can be surfaced.
      const overlap = Math.max(...this.#redactionValues.map((value) => value.length)) - 1;
      if (overlap > 0) redacted = redacted.slice(0, Math.max(0, redacted.length - overlap));
    }
    const bounded = boundedSafeDiagnostic(
      redacted,
      MCP_STDERR_DIAGNOSTIC_MAX_BYTES,
    );
    if (bounded.length === 0) {
      return this.#stderrTruncated
        ? `MCP stderr exceeded the ${String(MCP_STDERR_CAPTURE_MAX_BYTES)}-byte capture limit`
        : "MCP stderr contained no printable text";
    }
    const label = this.#stderrTruncated
      ? `MCP stderr (truncated after ${String(MCP_STDERR_CAPTURE_MAX_BYTES)} bytes)`
      : "MCP stderr";
    return `${label}: ${bounded}`;
  }

  async #closeInternal(): Promise<void> {
    const child = this.#process;
    this.#buffer = Buffer.alloc(0);
    if (child === undefined) {
      this.#notifyClose();
      return;
    }
    try {
      try {
        child.stdin?.end();
      } catch {
        // Continue to bounded signal escalation.
      }
      if (await waitForChildExit(child, this.#closeStepMs)) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to the hard kill.
      }
      if (await waitForChildExit(child, this.#closeStepMs)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Bounded cleanup is best effort once the process cannot be signalled.
      }
      await waitForChildExit(child, this.#closeStepMs);
    } finally {
      if (this.#process === child) this.#process = undefined;
      this.#notifyClose();
    }
  }

  #notifyClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClose = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolveExit(true);
    };
    child.once("close", onClose);
    timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolveExit(false);
    }, timeoutMs);
    timer.unref();
  });
}

function jsonByteLength(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} cannot be serialized: ${errorMessage(error)}`);
  }
  if (serialized === undefined) throw new Error(`${label} cannot be serialized`);
  return Buffer.byteLength(serialized, "utf8");
}

function redactDiagnostic(
  value: string,
  redactionValues: readonly string[],
): string {
  let redacted = value;
  for (const secret of redactionValues) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
}

function boundedSafeDiagnostic(value: string, maxBytes: number): string {
  const printable = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const fallback = printable.length === 0 ? "MCP stdio process failed" : printable;
  if (Buffer.byteLength(fallback, "utf8") <= maxBytes) return fallback;
  const suffix = "...";
  const bytes = Buffer.from(fallback, "utf8");
  let end = maxBytes - Buffer.byteLength(suffix, "utf8");
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, Math.max(0, end)).toString("utf8")}${suffix}`;
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

async function runWithDeadline<T>(
  label: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError(parentSignal.reason);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abortFromParent = () => {
    const error = abortError(parentSignal?.reason);
    controller.abort(error);
    rejectDeadline?.(error);
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  timer = setTimeout(() => {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
    rejectDeadline?.(error);
  }, timeoutMs);
  timer.unref();
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason.length > 0 ? reason : "operation aborted");
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
