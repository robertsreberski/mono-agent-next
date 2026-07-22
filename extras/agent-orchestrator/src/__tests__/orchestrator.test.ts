import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createCollaboratorToolRuntimeExtension } from "../index.js";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

describe("createCollaboratorToolRuntimeExtension", () => {
  it("exposes a router tool that sends repeated requests to collaborators", async () => {
    const collaboratorCalls: string[] = [];
    const extension = await createCollaboratorToolRuntimeExtension({
      conversationId: "conversation-1",
      originalUserMessage: "Plan the launch.",
      abortSignal: new AbortController().signal,
      collaborators: [
        {
          id: "researcher",
          label: "Researcher",
          description: "Find current external context.",
          responder: fakeResponder("Research report", collaboratorCalls),
        },
        {
          id: "worker",
          label: "Worker",
          description: "Inspect local workspace context.",
          responder: fakeResponder("Worker report", collaboratorCalls),
        },
      ],
    });
    cleanupTasks.push(extension.cleanup);

    expect(extension.runtimeOptions.allowedTools).toEqual(["AskCollaborator"]);
    expect(extension.runtimeOptions.mcpServers).toEqual({
      collaborators: { type: "http", url: extension.url },
    });

    const client = await connectClient(extension.url);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["AskCollaborator"]);

      const first = await client.callTool({
        name: "AskCollaborator",
        arguments: {
          id: "researcher",
          message: "Check market context.",
          reason: "Need a source-backed view.",
        },
      });
      const second = await client.callTool({
        name: "AskCollaborator",
        arguments: {
          id: "worker",
          message: "Inspect local notes.",
        },
      });

      expect(first.isError).not.toBe(true);
      expect(textFromToolResult(first)).toContain("Research report");
      expect(second.isError).not.toBe(true);
      expect(textFromToolResult(second)).toContain("Worker report");
      expect(collaboratorCalls).toEqual([
        "conversation-1:researcher:Original user request:\nPlan the launch.\n\nOrchestrator request:\nCheck market context.\n\nReason:\nNeed a source-backed view.",
        "conversation-1:worker:Original user request:\nPlan the launch.\n\nOrchestrator request:\nInspect local notes.",
      ]);
    } finally {
      await client.close();
    }
  });

  it("returns visible tool errors for unknown collaborators and max-call exhaustion", async () => {
    const extension = await createCollaboratorToolRuntimeExtension({
      conversationId: "conversation-2",
      originalUserMessage: "Decide the route.",
      abortSignal: new AbortController().signal,
      maxCalls: 1,
      collaborators: [
        {
          id: "researcher",
          label: "Researcher",
          responder: fakeResponder("Research report", []),
        },
      ],
    });
    cleanupTasks.push(extension.cleanup);

    const client = await connectClient(extension.url);
    try {
      const unknown = await client.callTool({
        name: "AskCollaborator",
        arguments: { id: "worker", message: "Help." },
      });
      const exhausted = await client.callTool({
        name: "AskCollaborator",
        arguments: { id: "researcher", message: "Try after the cap." },
      });

      expect(unknown.isError).toBe(true);
      expect(textFromToolResult(unknown)).toContain("Unknown collaborator \"worker\".");
      expect(exhausted.isError).toBe(true);
      expect(textFromToolResult(exhausted)).toContain("Collaborator call limit of 1 was reached.");
    } finally {
      await client.close();
    }
  });
});

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "agent-orchestrator-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
  return client;
}

function fakeResponder(text: string, calls: string[]): AgentResponder {
  return {
    async respond(request) {
      calls.push(`${request.conversationId}:${request.text}`);
      return { text };
    },
  };
}

function textFromToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const part = content.find((entry): entry is { type: "text"; text: string } => {
    return isRecord(entry) && entry.type === "text" && typeof entry.text === "string";
  });
  return part?.text ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
