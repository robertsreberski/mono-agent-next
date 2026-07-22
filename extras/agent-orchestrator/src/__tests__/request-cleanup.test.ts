import { EventEmitter } from "node:events";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ToolHandler = (
  args: { readonly id: string; readonly message: string },
  extra: { readonly signal: AbortSignal },
) => Promise<unknown>;
interface ConnectableFakeTransport {
  toolHandler: ToolHandler | undefined;
  start(): Promise<void>;
}
type PostHandler = (request: { readonly body: unknown }, response: FakeResponse) => Promise<void>;

const lifecycle = vi.hoisted(() => ({
  postHandler: undefined as PostHandler | undefined,
  responderCalls: 0,
  serverCloseCalls: 0,
  transportCloseCalls: 0,
}));

vi.mock("@modelcontextprotocol/sdk/server/express.js", () => ({
  createMcpExpressApp: () => ({
    post(_path: string, handler: PostHandler) {
      lifecycle.postHandler = handler;
    },
    get() {},
    delete() {},
    listen(_port: number, _host: string, onListening: () => void) {
      const server = {
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 41_353 }),
        close: (callback: (error?: Error) => void) => callback(),
        off() {
          return this;
        },
        once() {
          return this;
        },
      };
      queueMicrotask(onListening);
      return server;
    },
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class FakeMcpServer {
    private toolHandler: ToolHandler | undefined;

    registerTool(_name: string, _definition: unknown, handler: ToolHandler): void {
      this.toolHandler = handler;
    }

    async connect(transport: ConnectableFakeTransport): Promise<void> {
      transport.toolHandler = this.toolHandler;
      await transport.start();
    }

    async close(): Promise<void> {
      lifecycle.serverCloseCalls += 1;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class FakeTransport {
    toolHandler: ToolHandler | undefined;

    async start(): Promise<void> {}

    async handleRequest(_request: unknown, response: FakeResponse): Promise<void> {
      await this.toolHandler?.(
        { id: "fast", message: "Answer immediately." },
        { signal: new AbortController().signal },
      );
      response.emit("close");
    }

    async close(): Promise<void> {
      lifecycle.transportCloseCalls += 1;
    }
  },
}));

import { createCollaboratorToolRuntimeExtension } from "../index.js";

class FakeResponse extends EventEmitter {
  headersSent = false;
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.headersSent = true;
    this.body = body;
    return this;
  }
}

beforeEach(() => {
  lifecycle.postHandler = undefined;
  lifecycle.responderCalls = 0;
  lifecycle.serverCloseCalls = 0;
  lifecycle.transportCloseCalls = 0;
});

describe("request-scoped MCP cleanup", () => {
  it("closes resources when a fast responder completes and the response closes inside handleRequest", async () => {
    const extension = await createExtension();
    try {
      await invokePostHandler();

      expect(lifecycle.responderCalls).toBe(1);
      expect(lifecycle.transportCloseCalls).toBe(1);
      expect(lifecycle.serverCloseCalls).toBe(1);
    } finally {
      await extension.cleanup();
    }
  });
});

async function createExtension(): Promise<Awaited<ReturnType<typeof createCollaboratorToolRuntimeExtension>>> {
  const responder: AgentResponder = {
    async respond() {
      lifecycle.responderCalls += 1;
      return { text: "Immediate answer" };
    },
  };
  return await createCollaboratorToolRuntimeExtension({
    conversationId: "cleanup-test",
    originalUserMessage: "Test request cleanup.",
    abortSignal: new AbortController().signal,
    collaborators: [{ id: "fast", label: "Fast responder", responder }],
  });
}

async function invokePostHandler(): Promise<FakeResponse> {
  const handler = lifecycle.postHandler;
  if (handler === undefined) {
    throw new Error("POST handler was not registered.");
  }
  const response = new FakeResponse();
  await handler({ body: {} }, response);
  return response;
}
