import { describe, expect, it, vi } from "vitest";

const dependencyImports = vi.hoisted(() => ({
  piCodingAgent: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  dependencyImports.piCodingAgent();
  throw new Error("pi-coding-agent must be lazy-loaded after package import");
});

describe("runtime-pi module import", () => {
  it("validates model syntax synchronously without loading effectful coding tools", async () => {
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
      capabilities: [],
    });
    expect(validation).toEqual({
      supported: true,
      nativeTools: [{
        id: "NodeRepl",
        displayName: "Node REPL",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Read",
        displayName: "Read",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Write",
        displayName: "Write",
        effects: ["write"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Edit",
        displayName: "Edit",
        effects: ["read", "write"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Glob",
        displayName: "Glob",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Grep",
        displayName: "Grep",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Bash",
        displayName: "Bash",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "WebFetch",
        displayName: "Web Fetch",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "WebSearch",
        displayName: "Web Search",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }],
    });
    expect(validation).not.toBeInstanceOf(Promise);
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
    expect(dependencyImports.piCodingAgent).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
