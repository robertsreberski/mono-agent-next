import { describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

const fakeRuntime = {
  run: vi.fn(),
};
const resolvePiApiKey = vi.fn();
const createMonoRuntimeMock = vi.fn((_options: unknown) => fakeRuntime);
const createPiOAuthApiKeyResolverMock = vi.fn((_options: unknown) => resolvePiApiKey);

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createMonoRuntime: (options: unknown) => createMonoRuntimeMock(options),
    createPiOAuthApiKeyResolver: (options: unknown) => createPiOAuthApiKeyResolverMock(options),
  };
});

const { createConfiguredAgentRuntime } = await import("../index.js");

describe("configured agent runtime Pi auth", () => {
  it("passes a configured Pi OAuth resolver into runtime creation", () => {
    const runtime = createConfiguredAgentRuntime(monoConfig("/tmp/pi-auth.json"));

    expect(runtime).toBe(fakeRuntime);
    expect(createPiOAuthApiKeyResolverMock).toHaveBeenCalledWith({ path: "/tmp/pi-auth.json" });
    expect(createMonoRuntimeMock).toHaveBeenCalledWith({
      workspace: "/repo",
      qaOutputDir: "/repo/.mono-agent/artifacts",
      resolvePiApiKey,
    });
  });
});

function monoConfig(piAuthPath: string): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "/repo",
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    context: {
      identityPath: "/repo/IDENTITY.md",
      selectedSkills: [],
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "/repo/.mono-agent/artifacts",
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: {
      registryDir: "/repo/.mono-agent/trace",
    },
    providers: {
      piAuthPath,
      local: [],
    },
  };
}
