// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

const runtimeEffects = vi.hoisted(() => ({
  create: vi.fn(() => {
    throw new Error("runtime creation must not run during definition validation");
  }),
}));

vi.mock("../runtime.js", () => ({
  RuntimeClaudeError: class RuntimeClaudeError extends Error {},
  createRuntimeClaude: runtimeEffects.create,
}));

import { monoAgentModule } from "../index.js";

describe("runtime-claude model definition", () => {
  it("validates a route synchronously before runtime creation without host effects", () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const sdk = monoAgentModule.validateModel?.({
      model: "claude-opus-4-8",
      config: { mode: "sdk" },
    });
    const cli = monoAgentModule.validateModel?.({
      model: "sonnet",
      config: { mode: "cli" },
    });

    expect(sdk).toEqual({
      supported: true,
      capabilities: {
        tools: false,
        mcp: false,
        attachments: false,
        approvals: false,
        structuredOutput: true,
        sandbox: true,
        sessions: true,
        maxTurns: true,
        maxOutputTokens: false,
        liveInput: true,
      },
      nativeTools: [],
    });
    expect(cli).toMatchObject({
      supported: true,
      capabilities: { liveInput: false },
      nativeTools: [],
    });
    expect(sdk).not.toBeInstanceOf(Promise);
    expect(runtimeEffects.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockRestore();
  });

  it("rejects malformed and unsupported model or config syntax without creating an instance", () => {
    for (const model of [
      "",
      "claude-Opus-4",
      "anthropic/claude-opus-4-8",
      `claude-${"a".repeat(250)}`,
    ]) {
      expect(monoAgentModule.validateModel?.({
        model,
        config: { mode: "sdk" },
      })).toMatchObject({
        supported: false,
        diagnostics: [{ code: "runtime-claude.model", severity: "error" }],
      });
    }

    expect(() => monoAgentModule.validateModel?.({
      model: "claude-opus-4-8",
      config: { mode: "server" },
    })).toThrow("config.mode must be sdk or cli");
    expect(runtimeEffects.create).not.toHaveBeenCalled();
  });
});
