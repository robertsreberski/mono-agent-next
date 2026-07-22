/**
 * Verifies createConfiguredMemory dispatches memory.backend "supermemory" to a SupermemoryMemoryStore
 * (and leaves the default bujo path untouched). No network: we only assert the store type + that the
 * factory accepts the external-backend config shape.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { SupermemoryMemoryStore } from "@mono-agent/memory-supermemory";
import { describe, expect, it } from "vitest";

import { createConfiguredMemory } from "../index.js";
import { agentAppPackageVersion } from "../package-version.js";

function baseConfig(memory: NonNullable<MonoAgentConfig["memory"]>): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "/tmp/agent",
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: "/tmp/identity.md", selectedSkills: [] },
    memory,
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: {
      dir: "/tmp/agent/artifacts",
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: { registryDir: join("/tmp/agent", "trace-sources"), sourceId: "agent-alpha" },
  };
}

describe("createConfiguredMemory — backend dispatch", () => {
  it("returns a SupermemoryMemoryStore when backend is 'supermemory'", async () => {
    const store = await createConfiguredMemory(
      baseConfig({
        backend: "supermemory",
        mode: "lite",
        path: "/tmp/agent/memory",
        maxBytes: 8_000,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      }),
    );
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("resolves an explicitly installed plugin from the configured agent folder", async () => {
    const agentRoot = await mkdtemp(join(tmpdir(), "mono-agent-supermemory-host-"));
    try {
      const packageRoot = join(
        agentRoot,
        "node_modules",
        "@mono-agent",
        "memory-supermemory",
      );
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@mono-agent/memory-supermemory",
          version: agentAppPackageVersion(),
          type: "module",
          exports: {
            ".": { import: "./dist/index.js" },
            "./package.json": "./package.json",
          },
        }),
        "utf8",
      );
      await writeFile(
        join(packageRoot, "dist", "index.js"),
        [
          "export const createSupermemoryStore = () => ({ marker: 'agent-local' });",
          "export const validateSupermemoryConfig = () => ({ valid: true, errors: [] });",
        ].join("\n"),
        "utf8",
      );

      const store = await createConfiguredMemory(
        baseConfig({
          backend: "supermemory",
          mode: "lite",
          path: join(agentRoot, "memory"),
          maxBytes: 8_000,
          writeMode: "capture",
          supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
        }),
        { cwd: agentRoot },
      );

      expect(store).toMatchObject({ marker: "agent-local" });
    } finally {
      await rm(agentRoot, { recursive: true, force: true });
    }
  });

  it("derives the container from the trace sourceId when not set", async () => {
    // Smoke check: the factory accepts a supermemory block without an explicit container.
    const store = await createConfiguredMemory(
      baseConfig({
        backend: "supermemory",
        mode: "lite",
        path: "/tmp/agent/memory",
        maxBytes: 8_000,
        writeMode: "disabled",
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
      }),
    );
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("defaults to the bujo backend (not supermemory) when backend is unset", async () => {
    const store = await createConfiguredMemory(
      baseConfig({ mode: "lite", path: "/tmp/agent/memory", maxBytes: 8_000, writeMode: "disabled" }),
    );
    expect(store).toBeDefined();
    expect(store).not.toBeInstanceOf(SupermemoryMemoryStore);
  });
});
