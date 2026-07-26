// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

describe("runtime-pi module import", () => {
  it("validates model syntax synchronously without network effects", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access during import"));
    const module = await import("../index.js");
    const config = module.monoAgentModule.schema.parse({});
    const validation = module.monoAgentModule.validateModel?.({
      model: "openai:gpt-5",
      config,
    });

    expect(module.monoAgentModule.manifest).toMatchObject({
      packageName: "@mono-agent/runtime-pi",
      apiVersion: 1,
      kind: "runtime",
      capabilities: ["sandbox.execute.v1"],
    });
    expect(validation).toEqual({
      supported: true,
      capabilities: {
        tools: true,
        mcp: true,
        attachments: false,
        approvals: true,
        structuredOutput: true,
        sandbox: true,
        sessions: true,
        maxTurns: true,
        maxOutputTokens: true,
        artifactResults: true,
        liveInput: true,
      },
      // The catalog descriptor is read from Pi's generated model list on the
      // pure path: no credentials, no network, no created instance.
      model: {
        label: "GPT-5",
        efforts: ["minimal", "low", "medium", "high"],
        contextWindow: 400_000,
      },
      nativeTools: [{
        id: "NodeRepl",
        displayName: "Node REPL",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Read",
        displayName: "Read",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Write",
        displayName: "Write",
        effects: ["write"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Edit",
        displayName: "Edit",
        effects: ["read", "write"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Glob",
        displayName: "Glob",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Grep",
        displayName: "Grep",
        effects: ["read", "execute"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "Bash",
        displayName: "Bash",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "WebFetch",
        displayName: "Web Fetch",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "core-executor",
      }, {
        id: "WebSearch",
        displayName: "Web Search",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "core-executor",
      }],
    });
    expect(validation).not.toBeInstanceOf(Promise);
    // An unknown model stays supported (Core and the runtime remain the final
    // validators) but advertises no descriptor rather than a guessed one.
    expect(module.monoAgentModule.validateModel?.({
      model: "openai:not-a-real-model",
      config,
    })).not.toHaveProperty("model");
    expect(module.monoAgentModule.validateModel?.({
      model: "openai/gpt-5",
      config,
    })).toMatchObject({
      supported: false,
      diagnostics: [{ code: "runtime-pi.model", severity: "error" }],
    });
    expect(() => module.monoAgentModule.validateModel?.({
      model: "openai:gpt-5",
      config: { unexpected: true },
    })).toThrow("is not a supported field");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
