import type { Server as NodeHttpServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";
import { assertSafeBind } from "@mono-agent/agent-contracts";
import * as z from "zod/v4";

export const DEFAULT_COLLABORATOR_TOOL_NAME = "AskCollaborator";
export const DEFAULT_COLLABORATOR_MCP_SERVER_NAME = "collaborators";
export const DEFAULT_COLLABORATOR_MAX_CALLS = 6;

export interface OrchestratorCollaborator {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly responder: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>;
  readonly timeoutMs?: number;
}

// The index signature is load-bearing: it makes this assignable to the harness's
// `Omit<RuntimeRunOptions, …>` runtime-options shape (which has an index signature).
export interface CollaboratorToolRuntimeOptions extends Record<string, unknown> {
  readonly allowedTools: readonly string[];
  readonly mcpServers: Record<string, CollaboratorToolMcpServerConfig>;
}

export interface CollaboratorToolMcpServerConfig {
  readonly type: "http";
  readonly url: string;
}

export interface CollaboratorToolRuntimeExtension {
  readonly url: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly runtimeOptions: CollaboratorToolRuntimeOptions;
  cleanup(): Promise<void>;
}

export interface CreateCollaboratorToolRuntimeExtensionOptions {
  readonly collaborators: readonly OrchestratorCollaborator[];
  readonly conversationId: string;
  readonly originalUserMessage: string;
  readonly abortSignal: AbortSignal;
  readonly maxCalls?: number;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly toolName?: string;
  readonly serverName?: string;
  /** Allow binding a non-loopback host. Fail-closed (loopback-only) by default. */
  readonly allowNonLoopback?: boolean;
}

interface NormalizedCollaborator {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly responder: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>;
  readonly timeoutMs?: number;
}

interface AskCollaboratorArgs {
  readonly id: string;
  readonly message: string;
  readonly reason?: string;
}

export async function createCollaboratorToolRuntimeExtension(
  options: CreateCollaboratorToolRuntimeExtensionOptions,
): Promise<CollaboratorToolRuntimeExtension> {
  const host = normalizeHost(options.host);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new Error(
      `Collaborator MCP server refuses to bind a non-loopback host (${boundHost}) unless allowNonLoopback is true.`,
    ));
  const port = normalizePort(options.port);
  const path = normalizeMcpPath(options.path);
  const toolName = normalizeIdentifier(options.toolName ?? DEFAULT_COLLABORATOR_TOOL_NAME, "toolName");
  const serverName = normalizeIdentifier(options.serverName ?? DEFAULT_COLLABORATOR_MCP_SERVER_NAME, "serverName");
  const maxCalls = normalizeMaxCalls(options.maxCalls);
  const conversationId = normalizeNonEmpty(options.conversationId, "conversationId");
  const originalUserMessage = normalizeNonEmpty(options.originalUserMessage, "originalUserMessage");
  const collaborators = normalizeCollaborators(options.collaborators);
  let callCount = 0;

  // Passing host to createMcpExpressApp enables the MCP SDK's DNS-rebinding protection.
  const app = createMcpExpressApp({ host });
  app.post(path, async (req, res) => {
    const server = createRequestMcpServer({
      toolName,
      collaborators,
      maxCalls,
      conversationId,
      originalUserMessage,
      parentAbortSignal: options.abortSignal,
      incrementCallCount: () => {
        callCount += 1;
        return callCount;
      },
    });
    const transport = new StreamableHTTPServerTransport(
      { sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
    );
    try {
      await server.connect(transport as unknown as Transport);
      res.on("close", () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.get(path, (_req, res) => {
    res.status(405).json({ error: "method_not_allowed" });
  });
  app.delete(path, (_req, res) => {
    res.status(405).json({ error: "method_not_allowed" });
  });

  const httpServer = await listen(app, host, port);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Collaborator MCP server did not expose a TCP address.");
  }
  const url = `http://${host}:${address.port}${path}`;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await closeHttpServer(httpServer);
  };

  return {
    url,
    toolName,
    serverName,
    runtimeOptions: {
      allowedTools: [toolName],
      mcpServers: {
        [serverName]: { type: "http", url },
      },
    },
    cleanup,
  };
}

function createRequestMcpServer(input: {
  readonly toolName: string;
  readonly collaborators: ReadonlyMap<string, NormalizedCollaborator>;
  readonly maxCalls: number;
  readonly conversationId: string;
  readonly originalUserMessage: string;
  readonly parentAbortSignal: AbortSignal;
  readonly incrementCallCount: () => number;
}): McpServer {
  const server = new McpServer({ name: "mono-agent-collaborators", version: "0.1.0" });
  server.registerTool(
    input.toolName,
    {
      title: "Ask collaborator",
      description: collaboratorToolDescription(input.collaborators),
      inputSchema: {
        id: z.string().min(1).describe("Collaborator id to ask."),
        message: z.string().min(1).describe("Specific request for the collaborator."),
        reason: z.string().min(1).optional().describe("Why this collaborator is being asked."),
      },
    },
    async (args, extra) => {
      const callIndex = input.incrementCallCount();
      if (callIndex > input.maxCalls) {
        return visibleToolError(`Collaborator call limit of ${input.maxCalls} was reached.`);
      }

      const parsed = normalizeAskArgs(args);
      const collaborator = input.collaborators.get(parsed.id);
      if (collaborator === undefined) {
        return visibleToolError(
          `Unknown collaborator "${parsed.id}". Available collaborators: ${[...input.collaborators.keys()].join(", ")}.`,
        );
      }

      const signal = composeAbortSignal({
        signals: [input.parentAbortSignal, extra.signal],
        ...(collaborator.timeoutMs === undefined ? {} : { timeoutMs: collaborator.timeoutMs }),
      });
      try {
        if (signal.signal.aborted) {
          throw new Error("Collaborator request was cancelled before it started.");
        }
        const result = await askCollaborator({
          collaborator,
          callIndex,
          conversationId: input.conversationId,
          originalUserMessage: input.originalUserMessage,
          ask: parsed,
          abortSignal: signal.signal,
        });
        return result;
      } catch (error) {
        return visibleToolError(formatCollaboratorError(collaborator, error));
      } finally {
        signal.cleanup();
      }
    },
  );
  return server;
}

async function askCollaborator(input: {
  readonly collaborator: NormalizedCollaborator;
  readonly callIndex: number;
  readonly conversationId: string;
  readonly originalUserMessage: string;
  readonly ask: AskCollaboratorArgs;
  readonly abortSignal: AbortSignal;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  const chunks: string[] = [];
  const response = await input.collaborator.responder.respond(
    {
      conversationId: `${input.conversationId}:${input.collaborator.id}`,
      text: collaboratorRequestText(input.originalUserMessage, input.ask),
      abortSignal: input.abortSignal,
      metadata: {
        collaborator: {
          id: input.collaborator.id,
          label: input.collaborator.label,
          callIndex: input.callIndex,
          ...(input.ask.reason === undefined ? {} : { reason: input.ask.reason }),
        },
      },
    },
    {
      append: async (delta) => {
        chunks.push(delta);
      },
    },
  );
  const text = normalizeOptionalText(response.text) ?? normalizeOptionalText(chunks.join(""));
  if (text === undefined) {
    return visibleToolError(`${input.collaborator.label} returned no text.`);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      status: "succeeded",
      collaborator: {
        id: input.collaborator.id,
        label: input.collaborator.label,
      },
      text,
      ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
    },
  };
}

function collaboratorRequestText(originalUserMessage: string, ask: AskCollaboratorArgs): string {
  return [
    "Original user request:",
    originalUserMessage,
    "",
    "Orchestrator request:",
    ask.message,
    ...(ask.reason === undefined ? [] : ["", "Reason:", ask.reason]),
  ].join("\n");
}

function visibleToolError(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      status: "failed",
      error: message,
    },
  };
}

function collaboratorToolDescription(collaborators: ReadonlyMap<string, NormalizedCollaborator>): string {
  const lines = [
    "Ask one named collaborator for help before producing the final answer. You may call this tool multiple times when useful.",
    "Available collaborators:",
  ];
  for (const collaborator of collaborators.values()) {
    lines.push(`- ${collaborator.id}: ${collaborator.label}${collaborator.description === undefined ? "" : ` - ${collaborator.description}`}`);
  }
  return lines.join("\n");
}

function normalizeCollaborators(
  collaborators: readonly OrchestratorCollaborator[],
): ReadonlyMap<string, NormalizedCollaborator> {
  if (!Array.isArray(collaborators) || collaborators.length === 0) {
    throw new TypeError("collaborators must contain at least one collaborator.");
  }
  const out = new Map<string, NormalizedCollaborator>();
  for (const collaborator of collaborators) {
    const id = normalizeIdentifier(collaborator.id, "collaborator.id");
    if (out.has(id)) {
      throw new TypeError(`Duplicate collaborator id "${id}".`);
    }
    if (typeof collaborator.responder?.respond !== "function") {
      throw new TypeError(`Collaborator "${id}" must expose responder.respond().`);
    }
    out.set(id, {
      id,
      label: normalizeNonEmpty(collaborator.label, "collaborator.label"),
      ...(collaborator.description === undefined
        ? {}
        : { description: normalizeNonEmpty(collaborator.description, "collaborator.description") }),
      responder: collaborator.responder,
      ...(collaborator.timeoutMs === undefined ? {} : { timeoutMs: normalizeTimeoutMs(collaborator.timeoutMs) }),
    });
  }
  return out;
}

function normalizeAskArgs(value: unknown): AskCollaboratorArgs {
  if (!isRecord(value)) {
    throw new TypeError("AskCollaborator arguments must be an object.");
  }
  const normalized: { id: string; message: string; reason?: string } = {
    id: normalizeIdentifier(value.id, "id"),
    message: normalizeNonEmpty(value.message, "message"),
  };
  if (value.reason !== undefined) {
    normalized.reason = normalizeNonEmpty(value.reason, "reason");
  }
  return normalized;
}

function normalizeIdentifier(value: unknown, field: string): string {
  const normalized = normalizeNonEmpty(value, field);
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new TypeError(`${field} may only contain letters, numbers, underscores, and hyphens.`);
  }
  return normalized;
}

function normalizeNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
  return normalized;
}

function normalizeHost(value: string | undefined): string {
  return value === undefined ? "127.0.0.1" : normalizeNonEmpty(value, "host");
}

function normalizePort(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new TypeError("port must be an integer from 0 to 65535.");
  }
  return value;
}

function normalizeMaxCalls(value: number | undefined): number {
  const normalized = value ?? DEFAULT_COLLABORATOR_MAX_CALLS;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new TypeError("maxCalls must be a positive integer.");
  }
  return normalized;
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("timeoutMs must be a positive integer.");
  }
  return value;
}

function normalizeMcpPath(value: string | undefined): string {
  const normalized = value === undefined ? "/mcp" : normalizeNonEmpty(value, "path");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function composeAbortSignal(input: {
  readonly signals: readonly AbortSignal[];
  readonly timeoutMs?: number;
}): { readonly signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const cleanupCallbacks: Array<() => void> = [];
  for (const signal of input.signals) {
    if (signal.aborted) {
      abort();
      continue;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanupCallbacks.push(() => signal.removeEventListener("abort", abort));
  }
  let timeout: NodeJS.Timeout | undefined;
  if (input.timeoutMs !== undefined) {
    timeout = setTimeout(abort, input.timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

async function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  host: string,
  port: number,
): Promise<NodeHttpServer> {
  return await new Promise<NodeHttpServer>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

async function closeHttpServer(server: NodeHttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function formatCollaboratorError(collaborator: NormalizedCollaborator, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${collaborator.label} failed: ${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
