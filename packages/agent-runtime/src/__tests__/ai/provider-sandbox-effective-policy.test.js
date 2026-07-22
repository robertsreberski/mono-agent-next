import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(() => {
    throw new Error("Claude SDK query must not start");
  }),
  createOpencode: vi.fn(() => {
    throw new Error("OpenCode server must not start");
  }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("@opencode-ai/sdk", () => ({ createOpencode: mocks.createOpencode }));

import { createRuntime } from "../../runtime.js";

const nativePolicy = {
  mode: "native",
  readableRoots: ["/workspace"],
  writableRoots: ["/workspace"],
  denyWrite: [".env"],
  network: { mode: "localhost" },
};

const providers = [
  {
    name: "Claude",
    model: {
      sdk: "claude",
      model: "claude-sonnet-4-6",
      reference: "claude:claude-sonnet-4-6",
    },
    executionMode: "sdk",
    diagnostic: { claude_error_code: "claude_sandbox_policy_unsupported" },
    startSpy: () => mocks.query,
  },
  {
    name: "Codex",
    model: {
      sdk: "codex",
      model: "gpt-5.6-terra",
      reference: "codex:gpt-5.6-terra",
    },
    executionMode: "cli",
    diagnostic: { codex_error_code: "codex_sandbox_policy_unsupported" },
    startSpy: (runStartSpy) => runStartSpy,
  },
  {
    name: "OpenCode",
    model: {
      sdk: "opencode",
      provider: "github-copilot",
      model: "gpt-5.1",
      reference: "opencode:github-copilot:gpt-5.1",
    },
    executionMode: "cli",
    diagnostic: { opencode_error_code: "opencode_sandbox_policy_unsupported" },
    startSpy: () => mocks.createOpencode,
  },
];

function runProvider(runtime, provider, overrides = {}) {
  const codexClientFactory = vi.fn(() => {
    throw new Error("Codex app-server must not start");
  });
  return {
    result: runtime.run("SYS", {
      model: provider.model,
      executionMode: provider.executionMode,
      messages: [{ role: "user", content: "hi" }],
      codexClientFactory,
      ...overrides,
    }),
    startSpy: provider.startSpy(codexClientFactory),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider sandbox guards use the effective host + run policy", () => {
  it.each(providers)("rejects a host-level native policy before $name starts", async (provider) => {
    const runtime = createRuntime({ sandboxPolicy: nativePolicy });
    const run = runProvider(runtime, provider);

    await expect(run.result).resolves.toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: provider.diagnostic,
    });
    expect(run.startSpy).not.toHaveBeenCalled();
  });

  it.each(providers)("rejects a configureTools native policy before $name starts", async (provider) => {
    const runtime = createRuntime();
    runtime.configureTools({ sandboxPolicy: nativePolicy });
    const run = runProvider(runtime, provider);

    await expect(run.result).resolves.toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: provider.diagnostic,
    });
    expect(run.startSpy).not.toHaveBeenCalled();
  });

  it.each(providers)("does not let a per-run off policy widen $name's native host policy", async (provider) => {
    const runtime = createRuntime({ sandboxPolicy: nativePolicy });
    const run = runProvider(runtime, provider, { sandboxPolicy: { mode: "off" } });

    await expect(run.result).resolves.toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: provider.diagnostic,
    });
    expect(run.startSpy).not.toHaveBeenCalled();
  });
});
