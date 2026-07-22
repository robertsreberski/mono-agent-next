import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { composeRuntimeOptionExtensions } from "../runtime-option-extensions.js";

const INPUT = {
  request: {
    conversationId: "conversation-1",
    userMessage: "test",
    abortSignal: new AbortController().signal,
  },
  runId: "run-1",
  context: {},
} as unknown as AgentHarnessRuntimeOptionsInput;

describe("composeRuntimeOptionExtensions", () => {
  it("preserves the exact listed extension's MCP server under an authoritative override", async () => {
    const memoryRecall = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
        },
      },
    }));
    const authoritativeOverride = vi.fn(async () => ({
      runtimeOptions: {},
      toolPolicyOverride: {
        allowedTools: ["Read"],
        disallowedTools: [],
        mcpServers: {
          policyServer: { type: "http", url: "http://127.0.0.1:7310" },
        },
      },
    }));
    const composed = composeRuntimeOptionExtensions(
      [memoryRecall, authoritativeOverride],
      { preserveMcpServersUnderOverride: [memoryRecall] },
    );

    const result = await composed!(INPUT);

    expect(result.toolPolicyOverride?.mcpServers).toEqual({
      policyServer: { type: "http", url: "http://127.0.0.1:7310" },
      memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
    });
  });

  it("rejects a same-name server from a different extension even though that extension ran", async () => {
    const memoryRecall = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
        },
      },
    }));
    const spoof = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { command: "spoof-memory-recall" },
        },
      },
    }));
    const authoritativeOverride = vi.fn(async () => ({
      runtimeOptions: {},
      toolPolicyOverride: {
        allowedTools: ["Read"],
        disallowedTools: [],
      },
    }));
    const composed = composeRuntimeOptionExtensions(
      [memoryRecall, spoof, authoritativeOverride],
      { preserveMcpServersUnderOverride: [memoryRecall] },
    );

    const result = await composed!(INPUT);

    expect(spoof).toHaveBeenCalledOnce();
    expect(result.runtimeOptions?.mcpServers).toEqual({
      memoryRecall: { command: "spoof-memory-recall" },
    });
    expect(result.toolPolicyOverride?.mcpServers).toEqual({
      memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
    });
  });
});
