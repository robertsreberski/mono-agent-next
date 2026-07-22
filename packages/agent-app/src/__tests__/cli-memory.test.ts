import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBujoMemoryStore,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
} from "@mono-agent/memory/bujo";
import * as bujoMemory from "@mono-agent/memory/bujo";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import { openMemoryDb } from "@mono-agent/memory/store";
import { listTraceSources } from "@mono-agent/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppTraceRegistryDir } from "../app-config.js";
import { parseCliArgs, renderHelp, renderHelpTopic, runCli } from "../cli.js";

/** Resolve a help topic to its rendered detail text. */
function helpTopicText(topic: string): string {
  const result = renderHelpTopic(topic);
  if (!result.ok) {
    throw new Error(`expected help topic \`${topic}\` to resolve, got: ${result.message}`);
  }
  return result.text;
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseCliArgs memory", () => {
  it("parses memory subcommands and limit/json flags", () => {
    expect(parseCliArgs(["memory", "search", "deploy", "pipeline", "--limit", "3", "--json"])).toMatchObject({
      command: "memory",
      positionals: ["search", "deploy", "pipeline"],
      limit: 3,
      json: true,
    });
    expect(() => parseCliArgs(["runs", "--limit", "3"])).toThrow(/--limit/u);
    // The grouped summary lists memory once; subcommand detail is in `help memory`.
    expect(renderHelp()).toContain("memory <subcommand>");
    const memoryDetail = helpTopicText("memory");
    expect(memoryDetail).toContain("mono-agent memory");
    expect(memoryDetail).toContain("audit");
    expect(memoryDetail).toContain("adopt-replay");
    expect(parseCliArgs(["memory", "audit", "--strict", "--json"])).toMatchObject({ strict: true, json: true });
    expect(() => parseCliArgs(["memory", "inspect", "--strict"])).toThrow(/memory audit/iu);
    expect(parseCliArgs([
      "memory", "forget", "prepare", "--ids-file", "ids.txt", "--reason", "noise_cleanup", "--plan", "forget.json",
    ])).toMatchObject({
      command: "memory",
      positionals: ["forget", "prepare"],
      idsFile: "ids.txt",
      reason: "noise_cleanup",
      planPath: "forget.json",
    });
    expect(parseCliArgs(["memory", "forget", "restore", "--backup", "backup"])).toMatchObject({
      backupPath: "backup",
    });
    expect(() => parseCliArgs(["status", "--plan", "private.json"])).toThrow(/memory forget/iu);
  });
});

describe("runCli memory", () => {
  it("prints a clear no-memory message", async () => {
    const dir = await agentDir({ memory: undefined });

    const { code, stdout, stderr } = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats"]))));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("No memory configured");
  });

  it("emits the closed strict-health JSON contract for unconfigured and remote memory", async () => {
    const unconfiguredDir = await agentDir({ memory: undefined });
    const unconfigured = await captureCli(() => withCwd(unconfiguredDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "audit", "--strict", "--json"]))));
    expect(unconfigured.code).toBe(0);
    expect(unconfigured.stderr).toBe("");
    expect(JSON.parse(unconfigured.stdout)).toEqual({
      schemaVersion: 1,
      backend: "none",
      status: "not_configured",
      checkedAt: expect.any(String),
      issues: [],
      counts: {
        pending: 0,
        due: 0,
        dead: 0,
        outbox: 0,
        temporary: 0,
        memories: 0,
        vectors: 0,
        missingVectors: 0,
      },
    });
    expect(unconfigured.stdout).not.toContain(unconfiguredDir);

    const remoteDir = await agentDir({
      memory: {
        backend: "supermemory",
        mode: "lite",
        writeMode: "capture",
        supermemory: { baseUrl: "https://memory.invalid", container: "strict-agent" },
      },
    });
    const remote = await captureCli(() => withCwd(remoteDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "audit", "--strict", "--json"]))));
    expect(remote.code).toBe(1);
    expect(remote.stderr).toBe("");
    expect(JSON.parse(remote.stdout)).toMatchObject({
      schemaVersion: 1,
      backend: "supermemory",
      status: "unknown",
      issues: [],
    });
  });

  it("audits a real Lite store exactly and exits one for degraded and unhealthy states", async () => {
    const memoryRoot = join(await tempDir(), "private-memory-root");
    const dir = await agentDir({
      memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" },
    });
    const privateConversation = "private-conversation-sentinel";
    const privateText = "private memory payload sentinel";
    const store = createBujoMemoryStore({ root: memoryRoot });
    let closed = false;
    try {
      await store.appendHostSummary(privateConversation, privateText);

      const healthy = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "audit", "--strict", "--json"]))));
      expect(healthy.code).toBe(0);
      expect(healthy.stderr).toBe("");
      expect(JSON.parse(healthy.stdout)).toEqual({
        schemaVersion: 1,
        backend: "bujo",
        mode: "lite",
        status: "healthy",
        checkedAt: expect.any(String),
        issues: [],
        counts: {
          pending: 0,
          due: 0,
          dead: 0,
          outbox: 0,
          temporary: 0,
          memories: 1,
          vectors: 0,
          missingVectors: 0,
        },
      });
      expect(healthy.stdout).not.toContain(memoryRoot);
      expect(healthy.stdout).not.toContain(privateConversation);
      expect(healthy.stdout).not.toContain(privateText);

      await store.close();
      closed = true;
      const degraded = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "audit", "--strict", "--json"]))));
      expect(degraded.code).toBe(1);
      expect(degraded.stderr).toBe("");
      expect(JSON.parse(degraded.stdout)).toMatchObject({
        backend: "bujo",
        mode: "lite",
        status: "degraded",
        issues: expect.arrayContaining(["runtime_stale"]),
        counts: { memories: 1 },
      });

      await rm(memoryRoot, { recursive: true, force: true });
      const unhealthy = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "audit", "--strict", "--json"]))));
      expect(unhealthy.code).toBe(1);
      expect(unhealthy.stderr).toBe("");
      expect(JSON.parse(unhealthy.stdout)).toMatchObject({
        backend: "bujo",
        mode: "lite",
        status: "unhealthy",
        issues: expect.arrayContaining(["database_missing", "runtime_missing"]),
      });
      expect(`${degraded.stdout}${unhealthy.stdout}`).not.toContain(memoryRoot);
      expect(`${degraded.stdout}${unhealthy.stdout}`).not.toContain(privateText);
    } finally {
      if (!closed) await store.close();
    }
  });

  it("sanitizes unexpected strict built-in audit failures as health_check_failed", async () => {
    const memoryRoot = join(await tempDir(), "private-failing-root");
    const dir = await agentDir({
      memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" },
    });
    const privateSentinel = "unexpected audit detail /private/sentinel";
    const auditSpy = vi.spyOn(bujoMemory, "auditBujoMemoryHealth").mockImplementation(() => {
      throw new Error(privateSentinel);
    });
    let result: Awaited<ReturnType<typeof captureCli>>;
    try {
      result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "audit", "--strict", "--json"]))));
    } finally {
      auditSpy.mockRestore();
    }

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      backend: "bujo",
      mode: "lite",
      status: "unknown",
      checkedAt: expect.any(String),
      issues: ["health_check_failed"],
      counts: {
        pending: 0,
        due: 0,
        dead: 0,
        outbox: 0,
        temporary: 0,
        memories: 0,
        vectors: 0,
        missingVectors: 0,
      },
    });
    expect(result.stdout).not.toContain(memoryRoot);
    expect(result.stdout).not.toContain(privateSentinel);
  });

  it("keeps intake inspection and no-op mutations content-free with exit zero", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({ memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" } });
    await seedLocalStore(memoryRoot);

    const inspected = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "inspect", "--json"]))));
    expect(inspected.code).toBe(0);
    expect(inspected.stderr).toBe("");
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      schemaVersion: 1,
      operation: "inspect",
      matched: 0,
      items: [],
    });
    expect(inspected.stdout).not.toContain("Deploy pipeline uses blue green releases.");

    const retried = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "retry", "--json"]))));
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual({
      schemaVersion: 1,
      operation: "retry",
      changed: false,
      retried: 0,
    });

    const absentId = "0".repeat(64);
    const resolved = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "resolve", absentId, "operator_accepted", "--json"]))));
    expect(resolved.code).toBe(0);
    expect(JSON.parse(resolved.stdout)).toEqual({
      schemaVersion: 1,
      operation: "resolve",
      changed: false,
      resolved: false,
    });

    const misuse = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "resolve", absentId, "NOT VALID", "--json"]))));
    expect(misuse.code).toBe(2);
    expect(misuse.stdout).toBe("");
    expect(misuse.stderr).toMatch(/reason.*slug/iu);
  });

  it("blocks intake mutation while the configured agent process is live", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" },
      traceability: { registryDir: ".trace-registry" },
    });
    await mkdir(memoryRoot, { recursive: true });
    await writeLiveTraceManifest(join(dir, ".trace-registry"), dir, "intake-writer");

    const result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "retry", "--json"]))));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("intake-writer");
  });

  it("previews local stats, today, search, and top even when the live recall tool is disabled", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "lite",
        path: memoryRoot,
        writeMode: "append-host-summary",
        recallTool: { enabled: false },
      },
    });
    await seedLocalStore(memoryRoot);

    const stats = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats", "--limit", "5"]))));
    expect(stats.code).toBe(0);
    expect(stats.stdout).toContain("2 total, 2 live");
    expect(stats.stdout).toContain("mono-agent");

    const today = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "today"]))));
    expect(today.code).toBe(0);
    expect(today.stdout).toContain("Deploy pipeline uses blue green releases.");

    const beforeSearch = accessSnapshot(memoryRoot);
    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "deploy", "releases"]))));
    expect(search.code).toBe(0);
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
    expect(search.stdout).toContain("source:");
    expect(search.stdout).toMatch(/\d+\.\d{3}/u);
    expect(accessSnapshot(memoryRoot)).toEqual(beforeSearch);

    const top = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "top", "--limit", "1"]))));
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/Deploy pipeline uses blue green releases|Memory preview should show source metadata/u);
    expect(top.stdout).toContain("salience");

    const audit = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "audit", "--json"]))));
    expect(audit.code).toBe(0);
    const auditJson = JSON.parse(audit.stdout) as Record<string, unknown>;
    expect(auditJson).toMatchObject({
      metadataOnly: true,
      counts: { total: 2, live: 2 },
      bytes: expect.any(Object),
      duplicates: expect.any(Object),
      vectorCoverage: expect.any(Object),
      accessConcentration: expect.any(Object),
      backlog: expect.any(Object),
      latency: expect.any(Object),
      cost: expect.any(Object),
    });
    expect(audit.stdout).not.toContain("Deploy pipeline uses blue green releases.");
    expect(audit.stdout).not.toContain("mono-agent\"");
  });

  it("reads metadata-only live queue and model-call telemetry from the runtime snapshot", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
        llm: { provider: "ollama", model: "test-capture" },
      },
      traceability: { registryDir: ".trace-registry" },
    });
    const embeddings: EmbeddingProvider = {
      id: "ollama:test-embed",
      embed: async (texts) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings,
      dim: 8,
      llm: {
        id: "ollama:test-capture",
        complete: async () => JSON.stringify({
          memories: [{ type: "note", text: "Private sentinel durable fact", salience: 0.7, isInsight: false, entityIds: [] }],
          entities: [],
          relations: [],
        }),
      },
    });
    try {
      store.scheduleCapture("telegram:live", "private sentinel input");
      await store.flush();

      const audit = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "audit", "--json"]))));
      expect(audit.code).toBe(0);
      expect(JSON.parse(audit.stdout)).toMatchObject({
        backlog: { captureQueue: 0 },
        runtime: {
          available: true,
          stale: false,
          processAlive: true,
          state: "running",
          queues: { capture: { completed: 1, queued: 0, inFlight: 0 } },
        },
        cost: { known: true, embeddingCalls: 2, embeddingTexts: 2, llmCalls: 1 },
      });
      expect(audit.stdout).not.toContain("Private sentinel");
      expect(audit.stdout).not.toContain("private sentinel input");
      expect(audit.stdout).not.toContain("telegram:live");
    } finally {
      await store.close();
    }
  });

  it("falls back to FTS-only when configured embeddings are down", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const endpoint = await closedLoopbackEndpoint();
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint,
          timeoutMs: 20,
          circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        },
      },
    });
    await seedLocalStore(memoryRoot);

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(0);
    expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
    expect(search.stdout).toContain("FTS-only");
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
  });

  it("falls back to FTS-only for an Undici-shaped TypeError with a network cause", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    });
    await seedLocalStore(memoryRoot);
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause })));

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(0);
    expect(search.stderr).toBe("");
    expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
    expect(search.stdout).toContain("FTS-only");
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
  });

  it("falls back to FTS-only when a successful embedding response contains malformed JSON", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    });
    await seedLocalStore(memoryRoot);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(0);
    expect(search.stderr).toBe("");
    expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
    expect(search.stdout).toContain("FTS-only");
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
  });

  it("reviewer honesty matrix surfaces a native disturbed response as a hard memory search failure", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    });
    await seedLocalStore(memoryRoot);
    const disturbed = new Response(JSON.stringify({ embeddings: [[1]] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await disturbed.text();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(disturbed));

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(1);
    expect(search.stdout).toBe("");
    expect(search.stderr).toContain("memory search failed:");
    expect(search.stderr).not.toContain("Semantic embeddings unavailable");
    expect(search.stderr).not.toContain("FTS-only");
  });

  it.each([
    [
      "a programming TypeError whose message mentions ECONNREFUSED",
      () => new TypeError("Cannot read properties of undefined (reading 'ECONNREFUSED')"),
    ],
    [
      "an invariant Error whose message mentions embedding",
      () => new Error("embedding adapter invariant violated"),
    ],
  ] as const)("surfaces %s instead of relabeling it as embedding unavailability", async (_label, failure) => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    });
    await seedLocalStore(memoryRoot);
    const error = failure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(1);
    expect(search.stdout).toBe("");
    expect(search.stderr).toContain(`memory search failed: ${error.message}`);
    expect(search.stderr).not.toContain("Semantic embeddings unavailable");
    expect(search.stderr).not.toContain("FTS-only");
  });

  it("keeps a managed BuJo generation pinned while semantic search falls back to graph-capable FTS", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const endpoint = await closedLoopbackEndpoint();
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: memoryRoot,
        writeMode: "capture",
        embeddings: {
          provider: "ollama",
          model: "test-embed",
          endpoint,
          dim: 8,
          timeoutMs: 20,
          circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        },
        llm: { provider: "ollama", model: "test-capture" },
      },
    });
    await seedLocalStore(memoryRoot);
    await safeRebuildMemoryIndex({
      root: memoryRoot,
      tier: "bujo",
      embeddings: deterministicEmbeddings("ollama:test-embed", 8),
      dim: 8,
    });
    const activeBefore = await resolveActiveMemoryDbPath(memoryRoot);

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "search", "deploy", "releases"]))));

    expect(search.code).toBe(0);
    expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
    expect(search.stdout).toContain("FTS-only");
    expect(search.stdout).toContain("Deploy pipeline uses blue green releases.");
    expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(activeBefore);
  });

  it("rebuilds and rolls back the configured built-in store without an LLM", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({ memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" } });
    await seedLocalStore(memoryRoot);
    const legacyPath = await resolveActiveMemoryDbPath(memoryRoot);

    const rebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "rebuild", "--json"]))));
    expect(rebuild.code).toBe(0);
    expect(rebuild.stderr).toBe("");
    const rebuilt = JSON.parse(rebuild.stdout) as {
      operation: string;
      activeDatabase: string;
      details: { rollback?: string };
    };
    expect(rebuilt.operation).toBe("rebuild");
    expect(rebuilt.activeDatabase).not.toBe(legacyPath);
    expect(rebuilt.details.rollback).toBeUndefined();
    expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(rebuilt.activeDatabase);

    // A divergent legacy database is preserved as memory.db, but is not
    // advertised as a safe rollback target. Rebuild the managed generation
    // once more so rollback retains a validated immutable snapshot.
    const managedRebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "rebuild", "--json"]))));
    expect(managedRebuild.code, managedRebuild.stderr).toBe(0);
    expect(managedRebuild.stderr).toBe("");
    const managed = JSON.parse(managedRebuild.stdout) as {
      operation: string;
      activeDatabase: string;
      details: { rollback?: string };
    };
    expect(managed.operation).toBe("rebuild");
    expect(managed.activeDatabase).not.toBe(rebuilt.activeDatabase);
    expect(managed.details.rollback).toBeDefined();
    expect(managed.details.rollback).not.toBe(rebuilt.activeDatabase);

    const rollback = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "rollback", "--json"]))));
    expect(rollback.code, rollback.stderr).toBe(0);
    expect(rollback.stderr).toBe("");
    const rolledBack = JSON.parse(rollback.stdout) as { operation: string; activeDatabase: string };
    expect(rolledBack.operation).toBe("rollback");
    expect(rolledBack.activeDatabase).toBe(managed.details.rollback);
    expect(rolledBack.activeDatabase).not.toBe(managed.activeDatabase);
    expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(rolledBack.activeDatabase);
  }, 15_000);

  it("rebuilds managed memory with the exact LM Studio provider identity and no Ollama request", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          dim: 4,
        },
      },
    });
    await seedLocalStore(memoryRoot);
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: [text.length || 1, 0, 0, 0],
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const rebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "rebuild", "--json"]))));

    expect(rebuild.code, rebuild.stderr).toBe(0);
    expect(rebuild.stderr).toBe("");
    expect(readManagedIndexManifest(memoryRoot)?.active).toMatchObject({
      tier: "journal",
      embeddingModel: "lmstudio:text-embedding-test",
      dimension: 4,
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.every((call) => String(call[0]) === "http://localhost:1234/v1/embeddings")).toBe(true);
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/Authorization|11434|ollama/iu);
  });

  it("fails rebuild before any request when LM Studio apiKeyEnv is declared but unresolved", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "journal",
        path: memoryRoot,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          apiKeyEnv: "LM_STUDIO_API_KEY",
          dim: 4,
        },
      },
    });
    await seedLocalStore(memoryRoot);
    const before = await resolveActiveMemoryDbPath(memoryRoot);
    const fetchSpy = vi.fn().mockRejectedValue(new Error("must not make a keyless request"));
    vi.stubGlobal("fetch", fetchSpy);

    const rebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "rebuild"]))));

    expect(rebuild.code).toBe(1);
    expect(rebuild.stdout).toBe("");
    expect(rebuild.stderr).toMatch(/LM_STUDIO_API_KEY.*no resolved value/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(before);
  });

  it("refuses a stale-trace live legacy writer before embeddings and leaves the index unchanged", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const server = await failingEmbeddingServer(async () => {});
    try {
      const dir = await agentDir({
        memory: {
          mode: "journal",
          path: memoryRoot,
          writeMode: "append-host-summary",
          embeddings: {
            provider: "ollama",
            model: "test-embed",
            endpoint: server.baseUrl,
            dim: 8,
          },
        },
        traceability: { registryDir: ".trace-registry" },
      });
      await seedLocalStore(memoryRoot);
      const before = await resolveActiveMemoryDbPath(memoryRoot);
      const registryDir = join(dir, ".trace-registry");
      await writeLiveTraceManifest(registryDir, dir, "legacy-writer");
      expect((await listTraceSources({ registryDir })).sources).toEqual([
        expect.objectContaining({
          sourceId: "legacy-writer",
          pid: process.pid,
          health: "stale",
          configPath: join(dir, "mono-agent.config.json"),
        }),
      ]);
      await expect(withCleanMonoAgentEnv(() => resolveAppTraceRegistryDir({
        env: process.env,
        cwd: dir,
        configPath: join(dir, "mono-agent.config.json"),
      }))).resolves.toBe(registryDir);
      expect(() => process.kill(process.pid, 0)).not.toThrow();

      const rebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
        "memory", "rebuild",
      ]))));

      expect(rebuild.code).toBe(1);
      expect(rebuild.stdout).toBe("");
      expect(rebuild.stderr).toContain("trace health: stale");
      expect(rebuild.stderr).toContain(`mono-agent stop --config ${await realpath(join(dir, "mono-agent.config.json"))}`);
      expect(server.requests).toBe(0);
      expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(before);
    } finally {
      await server.close();
    }
  });

  it("finds a live writer in the global mirror when the current CLI registry env differs", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const server = await failingEmbeddingServer(async () => {});
    try {
      const dir = await agentDir({
        memory: {
          mode: "journal",
          path: memoryRoot,
          writeMode: "append-host-summary",
          embeddings: {
            provider: "ollama",
            model: "test-embed",
            endpoint: server.baseUrl,
            dim: 8,
          },
        },
      });
      await seedLocalStore(memoryRoot);
      const before = await resolveActiveMemoryDbPath(memoryRoot);
      const globalRegistryDir = join(dir, ".global-trace-registry");
      const currentCliRegistryDir = join(dir, ".different-current-cli-registry");
      await writeLiveTraceManifest(globalRegistryDir, dir, "globally-mirrored-writer");

      const rebuild = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(async () => {
        process.env.MONO_AGENT_TRACE_REGISTRY_DIR = currentCliRegistryDir;
        process.env.MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR = globalRegistryDir;
        return await runCli(["memory", "rebuild"]);
      })));

      expect(rebuild.code).toBe(1);
      expect(rebuild.stdout).toBe("");
      expect(rebuild.stderr).toContain("globally-mirrored-writer");
      expect(rebuild.stderr).toContain(`mono-agent stop --config ${await realpath(join(dir, "mono-agent.config.json"))}`);
      expect(server.requests).toBe(0);
      expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(before);
    } finally {
      await server.close();
    }
  });

  it("reads stats, audit, search, and top from the managed active generation", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({ memory: { mode: "lite", path: memoryRoot, writeMode: "append-host-summary" } });
    await seedLocalStore(memoryRoot);
    await safeRebuildMemoryIndex({ root: memoryRoot, tier: "lite" });
    const activePath = await resolveActiveMemoryDbPath(memoryRoot);
    expect(activePath).not.toBe(join(memoryRoot, "memory.db"));

    const legacy = openMemoryDb({ path: join(memoryRoot, "memory.db") });
    try {
      legacy.upsertLexical(record("LEGACY-ONLY", "Stale legacy split brain sentinel."));
    } finally {
      legacy.close();
    }

    const stats = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats", "--json"]))));
    expect(stats.code).toBe(0);
    expect(JSON.parse(stats.stdout)).toMatchObject({ database: activePath, counts: { total: 2, live: 2 } });

    const audit = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "audit", "--json"]))));
    expect(audit.code).toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({ counts: { total: 2, live: 2 } });

    const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "stale", "legacy", "sentinel", "--json"]))));
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({ hits: [] });

    const top = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "top", "--json"]))));
    expect(top.code).toBe(0);
    expect(top.stdout).not.toContain("Stale legacy split brain sentinel.");
  });

  it("pins semantic search and its FTS fallback to one active generation", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    await seedLocalStore(memoryRoot);
    const embeddings = deterministicEmbeddings("ollama:test-embed", 8);

    await safeRebuildMemoryIndex({ root: memoryRoot, tier: "journal", embeddings, dim: 8 });
    const firstManagedPath = await resolveActiveMemoryDbPath(memoryRoot);

    const rebuilt = await safeRebuildMemoryIndex({ root: memoryRoot, tier: "journal", embeddings, dim: 8 });
    const activePath = await resolveActiveMemoryDbPath(memoryRoot);
    expect(activePath).not.toBe(firstManagedPath);
    expect(rebuilt.rollback).toBeDefined();
    expect(rebuilt.rollback).not.toBe(firstManagedPath);
    await upsertIndexed(activePath, embeddings, 8, record("ACTIVE-SENTINEL", "Pinned active beta sentinel."));

    let switched = false;
    const server = await failingEmbeddingServer(async () => {
      if (switched) return;
      switched = true;
      await rollbackMemoryIndex({ root: memoryRoot, tier: "journal", embeddings, dim: 8 });
    });
    try {
      const dir = await agentDir({
        memory: {
          mode: "journal",
          path: memoryRoot,
          writeMode: "append-host-summary",
          embeddings: {
            provider: "ollama",
            model: "test-embed",
            endpoint: server.baseUrl,
            dim: 8,
            timeoutMs: 2_000,
          },
        },
      });

      const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
        "memory", "search", "pinned", "active", "beta", "sentinel",
      ]))));

      expect(search.code).toBe(0);
      expect(search.stdout).toContain("[WARN] Semantic embeddings unavailable");
      expect(search.stdout).toContain("Pinned active beta sentinel.");
      expect(server.requests).toBe(1);
      expect(await resolveActiveMemoryDbPath(memoryRoot)).toBe(rebuilt.rollback);
    } finally {
      await server.close();
    }
  });

  it("prepares, applies, and restores a content-free explicit BuJo forget plan", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: memoryRoot,
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
        llm: { provider: "ollama", model: "test-capture" },
      },
      traceability: { registryDir: ".trace-registry" },
    });
    await seedLocalStore(memoryRoot);
    await safeRebuildMemoryIndex({
      root: memoryRoot,
      tier: "bujo",
      embeddings: deterministicEmbeddings("ollama:test-embed", 8),
      dim: 8,
    });
    const dailyName = (await readdir(join(memoryRoot, "daily"))).sort()[0]!;
    const dailyRelative = join("daily", dailyName);
    const originalRecords = bujoMemory.parseDailyFile(await readFile(join(memoryRoot, dailyRelative), "utf8")).bullets;
    const target = originalRecords[0]!;
    const untouched = originalRecords[1]!;
    const idsFile = join(dir, "forget-ids.txt");
    const planPath = join(dir, "forget-plan.json");
    await writeFile(idsFile, `${target.id}\n`, "utf8");
    expect(bujoMemory.previewCanonicalExplicitForgetMemories(memoryRoot, [target.id])).toEqual({ eligible: 1 });
    const beforePrepare = await testTreeFingerprint(memoryRoot);

    const prepared = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
      "memory", "forget", "prepare",
      "--ids-file", idsFile,
      "--reason", "noise_cleanup",
      "--plan", planPath,
      "--json",
    ]))));
    expect(prepared.code, `${prepared.stdout}${prepared.stderr}`).toBe(0);
    expect(prepared.stderr).toBe("");
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      schemaVersion: 1,
      operation: "forget-prepare",
      status: "prepared",
      count: 1,
      planPath: await realpath(planPath),
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const planBytes = await readFile(planPath, "utf8");
    expect(planBytes).toContain(target.id);
    expect(planBytes).not.toContain(target.text);
    expect(planBytes).not.toContain(untouched.text);
    expect((await stat(planPath)).mode & 0o077).toBe(0);
    expect(await testTreeFingerprint(memoryRoot)).toBe(beforePrepare);

    const ignoredDryRun = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
      "memory", "forget", "apply", "--plan", planPath, "--dry-run", "--json",
    ]))));
    expect(ignoredDryRun.code).toBe(2);
    expect(JSON.parse(ignoredDryRun.stdout)).toMatchObject({ code: "forget_usage", status: "failed" });
    expect(await testTreeFingerprint(memoryRoot)).toBe(beforePrepare);

    const unsafePlanPath = join(memoryRoot, "unsafe-plan.json");
    const unsafe = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
      "memory", "forget", "prepare", "--ids-file", idsFile, "--reason", "unsafe_test", "--plan", unsafePlanPath, "--json",
    ]))));
    expect(unsafe.code).toBe(1);
    expect(JSON.parse(unsafe.stdout)).toMatchObject({ code: "forget_prepare_failed" });
    await expect(stat(unsafePlanPath)).rejects.toThrow();

    const copiedPlanPath = join(memoryRoot, "copied-plan.json");
    await writeFile(copiedPlanPath, planBytes, { encoding: "utf8", mode: 0o600 });
    const copiedPlan = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", copiedPlanPath, "--json"]))));
    expect(copiedPlan.code).toBe(1);
    expect(JSON.parse(copiedPlan.stdout)).toMatchObject({ code: "forget_apply_failed" });
    await rm(copiedPlanPath);

    const hardLinkedPlanPath = join(dir, "hard-linked-plan.json");
    await link(planPath, hardLinkedPlanPath);
    const hardLinkedPlan = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", hardLinkedPlanPath, "--json"]))));
    expect(hardLinkedPlan.code).toBe(1);
    expect(JSON.parse(hardLinkedPlan.stdout)).toMatchObject({ code: "forget_apply_failed" });
    await rm(hardLinkedPlanPath);

    const registryDir = join(dir, ".trace-registry");
    await writeLiveTraceManifest(registryDir, dir, "forget-live-writer");
    const liveRefusal = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", planPath, "--json"]))));
    expect(liveRefusal.code).toBe(1);
    expect(JSON.parse(liveRefusal.stdout)).toMatchObject({ code: "forget_apply_failed" });
    expect(liveRefusal.stdout).not.toContain(target.text);
    await rm(registryDir, { recursive: true, force: true });

    const originalDaily = await readFile(join(memoryRoot, dailyRelative), "utf8");
    await writeFile(join(memoryRoot, dailyRelative), `${originalDaily}\n`, "utf8");
    const staleRefusal = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", planPath, "--json"]))));
    expect(staleRefusal.code).toBe(1);
    expect(JSON.parse(staleRefusal.stdout)).toMatchObject({ code: "forget_apply_failed" });
    expect(staleRefusal.stdout).not.toContain(target.text);
    await writeFile(join(memoryRoot, dailyRelative), originalDaily, "utf8");

    stubOllamaEmbeddings(8);
    const applied = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", planPath, "--json"]))));
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stderr).toBe("");
    const appliedResult = JSON.parse(applied.stdout) as {
      readonly status: string;
      readonly count: number;
      readonly backupPath: string;
    };
    expect(appliedResult).toMatchObject({ status: "applied", count: 1 });
    expect(appliedResult.backupPath.startsWith(`${memoryRoot}-`)).toBe(false);
    expect(appliedResult.backupPath.startsWith(memoryRoot)).toBe(false);
    expect(applied.stdout).not.toContain(target.text);
    expect((await stat(appliedResult.backupPath)).mode & 0o077).toBe(0);

    const canonical = bujoMemory.parseDailyFile(await readFile(join(memoryRoot, dailyRelative), "utf8"));
    expect(canonical.bullets.find((bullet) => bullet.id === target.id)?.status).toBe("dropped");
    expect(canonical.bullets.find((bullet) => bullet.id === untouched.id)?.status).not.toBe("dropped");
    const appliedDb = openMemoryDb({ path: await resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
    expect(appliedDb.get(target.id)).toMatchObject({ status: "dropped", validTo: expect.any(String) });
    appliedDb.close();
    expect(readManagedIndexManifest(memoryRoot)?.active.sourceFingerprint).toEqual(
      bujoMemory.readBujoCanonicalSourceFingerprint(memoryRoot),
    );
    const strict = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "audit", "--strict", "--json"]))));
    const strictResult = JSON.parse(strict.stdout) as { readonly status: string; readonly issues: readonly string[] };
    // The fixture intentionally has no live runtime heartbeat; the stopped
    // store may be runtime_stale, but every durable authority surface is clean.
    expect(strictResult, strict.stdout).toMatchObject({ status: "degraded", issues: ["runtime_stale"] });
    expect(strict.code).toBe(1);

    await writeFile(join(memoryRoot, "operator-notes-shm"), "must block restore\n", "utf8");
    const refused = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "restore", "--backup", appliedResult.backupPath, "--json"]))));
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: "forget_restore_failed" });
    expect(await readFile(join(memoryRoot, "operator-notes-shm"), "utf8")).toBe("must block restore\n");
    await rm(join(memoryRoot, "operator-notes-shm"));

    const restored = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "restore", "--backup", appliedResult.backupPath, "--json"]))));
    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ status: "restored" });
    const restoredDb = openMemoryDb({ path: await resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
    expect(restoredDb.get(target.id)?.status).not.toBe("dropped");
    expect(restoredDb.get(untouched.id)?.status).not.toBe("dropped");
    restoredDb.close();
  }, 30_000);

  it("refuses an authoritative shared-root writer lease without changing memory", async () => {
    const memoryRoot = join(await tempDir(), "memory");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: memoryRoot,
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
        llm: { provider: "ollama", model: "test-capture" },
      },
    });
    await seedLocalStore(memoryRoot);
    await safeRebuildMemoryIndex({
      root: memoryRoot,
      tier: "bujo",
      embeddings: deterministicEmbeddings("ollama:test-embed", 8),
      dim: 8,
    });
    const active = openMemoryDb({ path: await resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
    const target = active.topSalient(1)[0]!;
    active.close();
    const idsFile = join(dir, "recover-ids.txt");
    const planPath = join(dir, "recover-plan.json");
    await writeFile(idsFile, `${target.id}\n`, "utf8");
    const prepared = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli([
      "memory", "forget", "prepare", "--ids-file", idsFile, "--reason", "failure_test", "--plan", planPath, "--json",
    ]))));
    expect(prepared.code, prepared.stderr).toBe(0);
    const beforeSource = bujoMemory.readBujoCanonicalSourceFingerprint(memoryRoot);
    const beforeDb = openMemoryDb({ path: await resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
    const beforeIntegrity = beforeDb.logicalIntegrityDigest();
    beforeDb.close();
    const competing = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: deterministicEmbeddings("ollama:test-embed", 8),
      dim: 8,
      llm: { id: "test", complete: async () => "[]" },
    });
    stubOllamaEmbeddings(8);
    let refused: Awaited<ReturnType<typeof captureCli>>;
    try {
      refused = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "forget", "apply", "--plan", planPath, "--json"]))));
    } finally {
      await competing.close();
    }
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: "forget_apply_failed" });
    expect(refused.stdout).not.toContain(target.text);
    expect(bujoMemory.readBujoCanonicalSourceFingerprint(memoryRoot)).toBe(beforeSource);
    const unchanged = openMemoryDb({ path: await resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
    expect(unchanged.get(target.id)?.status).not.toBe("dropped");
    expect(unchanged.logicalIntegrityDigest()).toBe(beforeIntegrity);
    unchanged.close();
    expect((await readdir(join(memoryRoot, ".."))).some((name) => name.includes("forget-backup"))).toBe(false);
  }, 30_000);

  it("rejects rebuild and rollback for Supermemory", async () => {
    const dir = await agentDir({
      memory: {
        backend: "supermemory",
        mode: "lite",
        writeMode: "capture",
        supermemory: { baseUrl: "https://memory.invalid", container: "agent-alpha" },
      },
    });

    for (const operation of ["rebuild", "rollback"]) {
      const result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", operation]))));
      expect(result.code, operation).toBe(1);
      expect(result.stdout, operation).toBe("");
      expect(result.stderr, operation).toMatch(/Supermemory.*remote index/iu);
    }
  });

  it("runs explicit BuJo replay adoption with an aggregate-only JSON contract", async () => {
    const privateRoot = join(await tempDir(), "private-memory-root");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: privateRoot,
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "private-embed", dim: 8 },
        llm: { provider: "ollama", model: "private-capture" },
      },
    });
    const authorityDigest = "a".repeat(64);
    const privatePayload = "private-memory-payload-sentinel";
    const privateIntentId = "private-intent-id-sentinel";
    const adoptionResult = {
      backend: "bujo",
      mode: "bujo",
      status: "adopted",
      counts: { terminals: 2, supersedes: 3, threads: 4 },
      authorityDigest,
      rebuildRequired: true,
      privatePayload,
      privateIntentId,
      privatePath: privateRoot,
    } as ReturnType<typeof bujoMemory.adoptLegacyReplayProjection> & {
      readonly privatePayload: string;
      readonly privateIntentId: string;
      readonly privatePath: string;
    };
    const adoption = vi.spyOn(bujoMemory, "adoptLegacyReplayProjection").mockReturnValue(adoptionResult);
    let result: Awaited<ReturnType<typeof captureCli>>;
    let adoptionCalls: unknown[][] = [];
    try {
      result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay", "--json"]))));
      adoptionCalls = adoption.mock.calls.map((call) => [...call]);
    } finally {
      adoption.mockRestore();
    }

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      backend: "bujo",
      mode: "bujo",
      status: "adopted",
      counts: { terminals: 2, supersedes: 3, threads: 4 },
      authorityDigest,
      rebuildRequired: true,
    });
    expect(result.stdout).not.toContain(privateRoot);
    expect(result.stdout).not.toContain("private-embed");
    expect(result.stdout).not.toContain("private-capture");
    expect(result.stdout).not.toContain(privatePayload);
    expect(result.stdout).not.toContain(privateIntentId);
    expect(adoptionCalls).toEqual([[{
      root: privateRoot,
      mode: "bujo",
      embeddingModel: "ollama:private-embed",
      dimension: 8,
    }]]);
  });

  it("returns closed parseable errors for replay-adoption usage and invalid/private configs", async () => {
    const usageDir = await agentDir({
      memory: {
        mode: "bujo",
        path: join(await tempDir(), "usage-private-root"),
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "private-embed", dim: 8 },
        llm: { provider: "ollama", model: "private-capture" },
      },
    });
    const privateArgument = "private-intent-id-sentinel";
    const usage = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay", privateArgument, "--json"]))));
    expectClosedReplayAdoptionFailure(usage, "replay_adoption_usage", [
      usageDir,
      privateArgument,
      "private-embed",
      "private-capture",
    ]);
    expect(usage.code).toBe(2);

    const privateFlag = "--private-payload-flag-sentinel";
    const parseFailure = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay", privateFlag, "--json"]))));
    expectClosedReplayAdoptionFailure(parseFailure, "replay_adoption_usage", [
      usageDir,
      privateFlag,
      "private-embed",
      "private-capture",
    ]);
    expect(parseFailure.code).toBe(2);

    const adoption = vi.spyOn(bujoMemory, "adoptLegacyReplayProjection");
    try {
      for (const foreignFlags of [
        ["--dry-run"],
        ["--force"],
        ["--foreground"],
        ["--include-memory"],
        ["--all"],
        ["--model", "private-model-flag-value"],
        ["--host", "0.0.0.0"],
        ["--port", "4599"],
        ["--strict"],
        ["--limit", "1"],
      ]) {
        const rejected = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
          runCli(["memory", "adopt-replay", ...foreignFlags, "--json"]))));
        expectClosedReplayAdoptionFailure(rejected, "replay_adoption_usage", [
          usageDir,
          "private-model-flag-value",
          "private-embed",
          "private-capture",
        ]);
        expect(rejected.code).toBe(2);
      }
      expect(adoption).not.toHaveBeenCalled();
    } finally {
      adoption.mockRestore();
    }

    const humanUsage = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay", privateArgument]))));
    expectClosedReplayAdoptionHumanFailure(humanUsage, "replay_adoption_usage", [
      usageDir,
      privateArgument,
      "private-embed",
      "private-capture",
    ]);
    expect(humanUsage.code).toBe(2);

    const privateConfigRoot = join(await tempDir(), "private-config-path-sentinel");
    await mkdir(privateConfigRoot, { recursive: true });
    await writeFile(join(privateConfigRoot, "mono-agent.config.json"), "{ private-memory-payload-sentinel", "utf8");
    const invalid = await captureCli(() => withCwd(privateConfigRoot, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay", "--json"]))));
    expectClosedReplayAdoptionFailure(invalid, "replay_adoption_config_invalid", [
      privateConfigRoot,
      "private-memory-payload-sentinel",
    ]);
    const invalidHuman = await captureCli(() => withCwd(privateConfigRoot, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay"]))));
    expectClosedReplayAdoptionHumanFailure(invalidHuman, "replay_adoption_config_invalid", [
      privateConfigRoot,
      "private-memory-payload-sentinel",
    ]);

    const forgetUsage = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "prepare", "--ids-file", privateArgument, "--plan", "private-plan", "--json"]))));
    expect(forgetUsage.code).toBe(2);
    expect(forgetUsage.stderr).toBe("");
    expect(JSON.parse(forgetUsage.stdout)).toMatchObject({ code: "forget_usage", status: "failed" });
    expect(forgetUsage.stdout).not.toContain(privateArgument);

    const forgetParse = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", "private-plan", privateFlag, "--json"]))));
    expect(forgetParse.code).toBe(2);
    expect(forgetParse.stderr).toBe("");
    expect(JSON.parse(forgetParse.stdout)).toMatchObject({ code: "forget_usage", status: "failed" });
    expect(forgetParse.stdout).not.toContain(privateFlag);

    const privateOperation = "private-operation-payload-sentinel";
    const unknownForget = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", privateOperation, "--json"]))));
    expect(unknownForget.code).toBe(2);
    expect(JSON.parse(unknownForget.stdout)).toMatchObject({
      operation: "forget-unknown",
      code: "forget_usage",
      status: "failed",
    });
    expect(`${unknownForget.stdout}${unknownForget.stderr}`).not.toContain(privateOperation);

    const unknownForgetHuman = await captureCli(() => withCwd(usageDir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", privateOperation]))));
    expect(unknownForgetHuman.code).toBe(2);
    expect(`${unknownForgetHuman.stdout}${unknownForgetHuman.stderr}`).not.toContain(privateOperation);

    const forgetConfig = await captureCli(() => withCwd(privateConfigRoot, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "forget", "apply", "--plan", "private-plan", "--json"]))));
    expect(forgetConfig.code).toBe(1);
    expect(forgetConfig.stderr).toBe("");
    expect(JSON.parse(forgetConfig.stdout)).toMatchObject({ code: "forget_config_invalid", status: "failed" });
    expect(forgetConfig.stdout).not.toContain("private-memory-payload-sentinel");
  });

  it("rejects non-BuJo replay adoption with a closed metadata-only contract", async () => {
    for (const memory of [
      undefined,
      { mode: "lite", path: join(await tempDir(), "private-lite-memory"), writeMode: "append-host-summary" },
      {
        mode: "journal",
        path: join(await tempDir(), "private-journal-memory"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "private-test-embed", dim: 8 },
      },
      {
        backend: "supermemory",
        mode: "bujo",
        writeMode: "capture",
        supermemory: { baseUrl: "https://memory.invalid", container: "private-container" },
      },
    ]) {
      const dir = await agentDir({ memory });
      const result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay", "--json"]))));
      expectClosedReplayAdoptionFailure(result, "replay_adoption_requires_bujo", [
        dir,
        "private-lite-memory",
        "private-journal-memory",
        "private-test-embed",
        "private-container",
      ]);

      const human = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay"]))));
      expectClosedReplayAdoptionHumanFailure(human, "replay_adoption_requires_bujo", [
        dir,
        "private-lite-memory",
        "private-journal-memory",
        "private-test-embed",
        "private-container",
      ]);
    }
  });

  it("redacts live-agent metadata from replay-adoption errors", async () => {
    const privateRoot = join(await tempDir(), "live-private-memory");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: privateRoot,
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
        llm: { provider: "ollama", model: "test-capture" },
      },
      traceability: { registryDir: ".trace-registry" },
    });
    const privateSourceId = "private-adoption-writer-id";
    await writeLiveTraceManifest(join(dir, ".trace-registry"), dir, privateSourceId);
    const adoption = vi.spyOn(bujoMemory, "adoptLegacyReplayProjection");
    let result: Awaited<ReturnType<typeof captureCli>>;
    try {
      result = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay", "--json"]))));
    } finally {
      adoption.mockRestore();
    }
    expectClosedReplayAdoptionFailure(result, "replay_adoption_agent_running", [
      dir,
      privateRoot,
      privateSourceId,
      String(process.pid),
      "test-embed",
      "test-capture",
    ]);
    const humanResult = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
      runCli(["memory", "adopt-replay"]))));
    expectClosedReplayAdoptionHumanFailure(humanResult, "replay_adoption_agent_running", [
      dir,
      privateRoot,
      privateSourceId,
      String(process.pid),
      "test-embed",
      "test-capture",
    ]);
    expect(adoption).not.toHaveBeenCalled();
  });

  it("never exposes replay-adoption package failures or malformed private results", async () => {
    const privateRoot = join(await tempDir(), "private-adoption-root");
    const dir = await agentDir({
      memory: {
        mode: "bujo",
        path: privateRoot,
        writeMode: "capture",
        embeddings: { provider: "ollama", model: "private-embed", dim: 8 },
        llm: { provider: "ollama", model: "private-capture" },
      },
    });
    const sentinels = [
      privateRoot,
      "private-memory-payload-sentinel",
      "private-memory-id-sentinel",
      "private-intent-id-sentinel",
      "private-decision-id-sentinel",
      "private-db-marker-detail-sentinel",
      "private-embed",
      "private-capture",
    ];
    const privateFailure = sentinels.join(" | ");
    const adoption = vi.spyOn(bujoMemory, "adoptLegacyReplayProjection");
    try {
      adoption.mockImplementationOnce(() => {
        throw new Error(privateFailure);
      });
      const jsonFailure = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay", "--json"]))));
      expectClosedReplayAdoptionFailure(jsonFailure, "replay_adoption_failed", sentinels);

      adoption.mockImplementationOnce(() => {
        throw new Error(privateFailure);
      });
      const humanFailure = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay"]))));
      expect(humanFailure.code).toBe(1);
      expect(humanFailure.stdout).toBe("");
      expect(humanFailure.stderr).toContain("[replay_adoption_failed]");
      for (const sentinel of sentinels) expect(humanFailure.stderr).not.toContain(sentinel);

      adoption.mockReturnValueOnce({
        backend: "bujo",
        mode: "bujo",
        status: "adopted",
        counts: { terminals: 1, supersedes: 1, threads: 1 },
        authorityDigest: privateFailure,
        rebuildRequired: true,
      } as ReturnType<typeof bujoMemory.adoptLegacyReplayProjection>);
      const malformed = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() =>
        runCli(["memory", "adopt-replay", "--json"]))));
      expectClosedReplayAdoptionFailure(malformed, "replay_adoption_failed", sentinels);
    } finally {
      adoption.mockRestore();
    }
  });

  it("previews Supermemory with the live recall tool disabled and marks local stats unavailable", async () => {
    const server = await supermemoryServer();
    try {
      const dir = await agentDir({
        memory: {
          backend: "supermemory",
          mode: "lite",
          writeMode: "capture",
          recallTool: { enabled: false },
          supermemory: { baseUrl: server.baseUrl, container: "agent-alpha" },
        },
      });

      const stats = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "stats"]))));
      expect(stats.code).toBe(0);
      expect(stats.stdout).toContain("Remote-only fields not known locally");
      expect(stats.stdout).toContain("agent-alpha");

      const search = await captureCli(() => withCwd(dir, () => withCleanMonoAgentEnv(() => runCli(["memory", "search", "coffee"]))));
      expect(search.code).toBe(0);
      expect(search.stdout).toContain("Supermemory remembers coffee preference.");
      expect(server.searchBodies).toHaveLength(1);
      expect(server.searchBodies[0]).toMatchObject({ containerTag: "agent-alpha", q: "coffee" });
    } finally {
      await server.close();
    }
  });
});

async function seedLocalStore(root: string): Promise<void> {
  const store = createBujoMemoryStore({ root });
  try {
    await store.appendHostSummary("conv-1", "Deploy pipeline uses blue green releases.");
    await store.appendHostSummary("conv-2", "Memory preview should show source metadata.");
  } finally {
    await store.close();
  }
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    db.upsertEntity({
      id: "project:mono-agent",
      name: "mono-agent",
      type: "project",
      summary: "Config-first agent framework.",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
  } finally {
    db.close();
  }
}

function accessSnapshot(root: string): readonly {
  readonly text: string;
  readonly accessCount: number;
  readonly lastAccessedAt?: string;
}[] {
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    return db.topSalient(20).map((record) => ({
      text: record.text,
      accessCount: record.accessCount,
      ...(record.lastAccessedAt === undefined ? {} : { lastAccessedAt: record.lastAccessedAt }),
    }));
  } finally {
    db.close();
  }
}

function record(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-07-11T09:00:00.000Z",
    accessCount: 0,
    tags: [] as readonly string[],
    source: {},
  };
}

function deterministicEmbeddings(id: string, dim: number): EmbeddingProvider {
  return {
    id,
    embed: async (texts) => texts.map((text) => {
      const vector = new Array<number>(dim).fill(0);
      for (const [index, byte] of Buffer.from(text).entries()) {
        vector[index % dim] = (vector[index % dim] ?? 0) + byte / 255;
      }
      return vector;
    }),
  };
}

function stubOllamaEmbeddings(dim: number): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://localhost:11434/api/embed");
    const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
    return new Response(JSON.stringify({
      embeddings: body.input.map((_text, index) => {
        const vector = new Array<number>(dim).fill(0.01);
        vector[index % dim] = 1;
        return vector;
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

async function testTreeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    hash.update(`${path}\0${info.mode & 0o777}\0`);
    if (info.isFile()) hash.update(await readFile(absolute));
    else if (info.isSymbolicLink()) hash.update(await readlink(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function upsertIndexed(
  path: string,
  embeddings: EmbeddingProvider,
  dim: number,
  item: ReturnType<typeof record>,
): Promise<void> {
  const db = openMemoryDb({ path, embeddings, dim });
  try {
    await db.upsert(item);
  } finally {
    db.close();
  }
}

async function writeLiveTraceManifest(registryDir: string, dir: string, sourceId: string): Promise<void> {
  const stale = "2020-01-01T00:00:00.000Z";
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(registryDir, `${sourceId}.json`), `${JSON.stringify({
    schema: "agent-runtime.trace-source.v1",
    sourceId,
    label: "Legacy writer",
    artifactDir: join(dir, ".mono-agent", "artifacts"),
    pid: process.pid,
    status: "running",
    startedAt: stale,
    updatedAt: stale,
    configPath: join(dir, "mono-agent.config.json"),
  }, null, 2)}\n`, "utf8");
}

async function agentDir(input: { readonly memory: unknown; readonly traceability?: unknown }): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "IDENTITY.md"), "# Test Agent\n", "utf8");
  const config: Record<string, unknown> = {
    runtime: { model: "pi:ollama:test-model" },
    context: { identityPath: "./IDENTITY.md" },
  };
  if (input.memory !== undefined) {
    config.memory = input.memory;
  }
  if (input.traceability !== undefined) {
    config.traceability = input.traceability;
  }
  await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return dir;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-memory-"));
  tempDirs.push(dir);
  return dir;
}

async function captureCli(run: () => Promise<number>): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function expectClosedReplayAdoptionFailure(
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  code: string,
  sentinels: readonly string[],
): void {
  expect(result.code).toBeGreaterThan(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    operation: "adopt-replay",
    status: "failed",
    code,
    message: expect.any(String),
  });
  expect(JSON.parse(result.stdout).message).not.toBe("");
  for (const sentinel of sentinels) {
    expect(result.stdout).not.toContain(sentinel);
  }
}

function expectClosedReplayAdoptionHumanFailure(
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  code: string,
  sentinels: readonly string[],
): void {
  expect(result.code).toBeGreaterThan(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`[${code}]`);
  for (const sentinel of sentinels) {
    expect(result.stderr).not.toContain(sentinel);
  }
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function withCleanMonoAgentEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previous.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of previous) {
      process.env[key] = value;
    }
  }
}

async function supermemoryServer(): Promise<{
  readonly baseUrl: string;
  readonly searchBodies: Record<string, unknown>[];
  readonly close: () => Promise<void>;
}> {
  const searchBodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v4/search") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      searchBodies.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { id: "sm-1", memory: "Supermemory remembers coffee preference.", similarity: 0.88 },
        ],
      }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    searchBodies,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
  };
}

async function closedLoopbackEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function failingEmbeddingServer(beforeFailure: () => Promise<void>): Promise<{
  readonly baseUrl: string;
  readonly requests: number;
  readonly close: () => Promise<void>;
}> {
  let requests = 0;
  const server = createServer((req, res) => {
    void (async () => {
      requests += 1;
      await beforeFailure();
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forced embedding failure" }));
    })().catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
