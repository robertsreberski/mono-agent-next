import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(() => {
    throw new Error("Claude SDK query must not start");
  }),
  spawn: vi.fn(() => {
    throw new Error("Claude CLI process must not start");
  }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mocks.spawn,
}));

import { generateCliResponse } from "../../ai/providers/claude-cli.js";
import { generateClaudeResponse } from "../../ai/providers/claude-sdk.js";

const sandboxPolicy = {
  mode: "native",
  readableRoots: ["/workspace"],
  writableRoots: ["/workspace"],
  denyWrite: [".env"],
  network: { mode: "localhost" },
};

describe("Claude mono-agent sandbox guard", () => {
  it("returns a typed capability mismatch before starting an SDK query", async () => {
    const result = await generateClaudeResponse("SYS", {
      model: {
        sdk: "claude",
        model: "claude-sonnet-4-6",
        reference: "claude:claude-sonnet-4-6",
      },
      messages: [{ role: "user", content: "hi" }],
      sandboxPolicy,
    });

    expect(result).toMatchObject({
      model: "claude:claude-sonnet-4-6",
      sdk: "claude",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { claude_error_code: "claude_sandbox_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce mono-agent's native srt sandbox scopes");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns a typed capability mismatch before starting a CLI process", async () => {
    const result = await generateCliResponse("SYS", {
      model: {
        sdk: "claude-code",
        model: "claude-sonnet-4-6",
        reference: "claude:claude-sonnet-4-6",
      },
      messages: [{ role: "user", content: "hi" }],
      sandboxPolicy,
    });

    expect(result).toMatchObject({
      model: "claude:claude-sonnet-4-6",
      sdk: "claude-code",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { claude_error_code: "claude_sandbox_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce mono-agent's native srt sandbox scopes");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("fails Claude Code CLI closed when an explicit empty allowlist would restore defaults", async () => {
    const result = await generateCliResponse("SYS", {
      model: {
        sdk: "claude-code",
        model: "claude-sonnet-4-6",
        reference: "claude:claude-sonnet-4-6",
      },
      messages: [{ role: "user", content: "hi" }],
      allowedTools: [],
      disallowedTools: [],
    });

    expect(result).toMatchObject({
      model: "claude:claude-sonnet-4-6",
      sdk: "claude-code",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { claude_error_code: "claude_cli_empty_tool_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce an explicit empty allowedTools list");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("fails the public legacy Codex CLI export closed on an effective native sandbox", async () => {
    const result = await generateCliResponse("SYS", {
      model: {
        sdk: "codex",
        model: "gpt-5.6-terra",
        reference: "codex:gpt-5.6-terra",
      },
      messages: [{ role: "user", content: "hi" }],
      toolContext: { sandboxPolicy },
      sandboxPolicy: { mode: "off" },
    });

    expect(result).toMatchObject({
      model: "codex:gpt-5.6-terra",
      sdk: "codex",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { codex_error_code: "codex_sandbox_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce mono-agent's native srt sandbox scopes");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("fails the public legacy Codex CLI export closed on restrictive tool policy", async () => {
    const result = await generateCliResponse("SYS", {
      model: {
        sdk: "codex",
        model: "gpt-5.6-terra",
        reference: "codex:gpt-5.6-terra",
      },
      messages: [{ role: "user", content: "hi" }],
      allowedTools: [],
      disallowedTools: [],
    });

    expect(result).toMatchObject({
      model: "codex:gpt-5.6-terra",
      sdk: "codex",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { codex_error_code: "codex_tool_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce allowedTools/disallowedTools");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
