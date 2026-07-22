import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  appendGraphBatch,
  createBujoMemoryStore,
  resolveActiveMemoryDbPath,
  safeRebuildMemoryIndex,
} from "@mono-agent/memory/bujo";
import type { BujoMemoryStore } from "@mono-agent/memory/bujo";
import type { MonoAgentConfig } from "@mono-agent/config";
import { SupermemoryMemoryStore } from "@mono-agent/memory-supermemory";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import { openMemoryDb } from "@mono-agent/memory/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_RECALL_MCP_SERVER_NAME,
  createMemoryEmbeddingProvider,
  createMemoryRecallServer,
  createRecallStore,
  memoryRecallSettingsFromEnv,
  resolveMemoryRecallSettings,
} from "../memory-recall.js";
import type { MemoryRecallBujoSettings, MemoryRecallSettings } from "../memory-recall.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-memory-recall-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** Build a MonoAgentConfig whose only meaningful field for recall is the memory block. */
function configWithMemory(memory: MonoAgentConfig["memory"]): MonoAgentConfig {
  return { memory } as unknown as MonoAgentConfig;
}

/** Narrow recall settings to the bujo shape (asserts it is not the supermemory backend). */
function bujo(settings: MemoryRecallSettings | undefined): MemoryRecallBujoSettings {
  if (settings === undefined || "supermemory" in settings) {
    throw new Error("expected bujo recall settings");
  }
  return settings;
}

describe("resolveMemoryRecallSettings", () => {
  it("returns undefined when memory is unconfigured", () => {
    expect(resolveMemoryRecallSettings(configWithMemory(undefined))).toBeUndefined();
  });

  it("bypasses only the live tool gate for previews and preserves built-in secret precedence", () => {
    const memory = {
      mode: "journal",
      path: "/memory",
      maxBytes: 64_000,
      writeMode: "append-host-summary",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "resolved-secret",
        apiKeyEnv: "MEMORY_EMBEDDINGS_KEY",
        dim: 768,
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    } satisfies NonNullable<MonoAgentConfig["memory"]>;
    const liveConfig = configWithMemory({ ...memory, recallTool: { enabled: true } });
    const previewConfig = configWithMemory({ ...memory, recallTool: { enabled: false } });

    expect(resolveMemoryRecallSettings(previewConfig)).toBeUndefined();
    const previewSettings = resolveMemoryRecallSettings(previewConfig, { ignoreRecallToolGate: true });
    expect(previewSettings).toEqual(resolveMemoryRecallSettings(liveConfig));
    expect(previewSettings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "resolved-secret",
        apiKeyEnv: "MEMORY_EMBEDDINGS_KEY",
        dim: 768,
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    });
  });

  it("defaults the recall tool on for a programmatic memory config that omits recallTool", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
      }),
    );
    expect(settings).toEqual({ root: "/memory", tier: "lite" });
  });

  it("returns root WITHOUT embeddings when explicitly enabled on a no-embeddings (lite) store", () => {
    // F12: the operator opts in to FTS-only recall despite no embeddings default.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({ root: "/memory", tier: "lite" });
    expect(bujo(settings).embeddings).toBeUndefined();
  });

  it("carries embeddings timeout + circuit-breaker tuning into the recall settings", () => {
    // F11: the resilience knobs must reach the recall store, not be dropped.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          timeoutMs: 4_000,
          circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings).toMatchObject({
      timeoutMs: 4_000,
      circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
    });
  });

  it("forwards the apiKeyEnv NAME instead of the resolved secret value (F13)", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "resolved-secret",
          apiKeyEnv: "MY_OPENAI_KEY",
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings?.apiKeyEnv).toBe("MY_OPENAI_KEY");
  });

  it("returns root + embeddings when enabled with embeddings", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          endpoint: "https://api.openai.com/v1",
          apiKey: "secret",
          dim: 1536,
        },
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "secret",
        dim: 1536,
      },
    });
  });

  it("preserves the exact LM Studio embedding identity and service root", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          dim: 4,
        },
      }),
    );

    expect(settings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "lmstudio",
        model: "text-embedding-test",
        endpoint: "http://localhost:1234",
        dim: 4,
      },
    });
  });
});

describe("memoryRecallSettingsFromEnv", () => {
  const settings = {
    root: "/memory",
    tier: "bujo" as const,
    embeddings: {
      provider: "ollama" as const,
      model: "nomic-embed-text:v1.5",
      endpoint: "http://localhost:11434",
      dim: 768,
    },
  };

  it("hydrates built-in settings from the standalone binary environment", () => {
    const env = {
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_MODE: "bujo",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5",
      MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: "http://localhost:11434",
      MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "768",
    };
    expect(memoryRecallSettingsFromEnv(env)).toEqual(settings);
  });

  it("rejects env missing the required memory path", () => {
    expect(() => memoryRecallSettingsFromEnv({})).toThrow(/missing required environment/u);
  });

  it("hydrates embeddings timeout + circuit-breaker tuning from the env (F11)", () => {
    const tuned: MemoryRecallSettings = {
      root: "/memory",
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text:v1.5",
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    };
    const env = {
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5",
      MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: "4000",
      MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: "7",
      MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: "12000",
    };
    expect(memoryRecallSettingsFromEnv(env)).toEqual(tuned);
  });

  it("resolves a declared apiKeyEnv from the inherited standalone-binary environment (F13)", () => {
    const env = {
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "MY_OPENAI_KEY",
    };
    const resolved = bujo(memoryRecallSettingsFromEnv({ ...env, MY_OPENAI_KEY: "resolved-secret" }));
    expect(resolved.embeddings?.apiKey).toBe("resolved-secret");
    expect(resolved.embeddings?.apiKeyEnv).toBe("MY_OPENAI_KEY");
  });

  it("hydrates LM Studio settings with a named secret", () => {
    const env = {
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_MODE: "journal",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-test",
      MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: "http://localhost:1234",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
      MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "4",
    };

    expect(memoryRecallSettingsFromEnv({ ...env, LM_STUDIO_API_KEY: "child-secret" })).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "lmstudio",
        model: "text-embedding-test",
        endpoint: "http://localhost:1234",
        apiKey: "child-secret",
        apiKeyEnv: "LM_STUDIO_API_KEY",
        dim: 4,
      },
    });
  });

  it("rejects a missing declared recall credential instead of falling back to a literal or keyless request", () => {
    expect(() => memoryRecallSettingsFromEnv({
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-test",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "must-not-fallback",
    })).toThrow(/LM_STUDIO_API_KEY.*no non-empty value/iu);
  });

  it("accepts a literal apiKey when no apiKeyEnv is declared (F13 residual)", () => {
    const env = {
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "inline-secret",
    };
    expect(bujo(memoryRecallSettingsFromEnv(env)).embeddings?.apiKey).toBe("inline-secret");
  });

  it("resolves FTS-only settings from an env carrying only the memory path (F12)", () => {
    expect(memoryRecallSettingsFromEnv({ MONO_AGENT_MEMORY_PATH: "/memory" })).toEqual({ root: "/memory" });
  });
});

describe("MemoryRecall MCP tool (FTS, hermetic)", () => {
  it("routes last-message questions to active history without searching durable memory", async () => {
    let recallCalls = 0;
    const store = {
      async recall() {
        recallCalls += 1;
        return [{ score: 0.99, record: { id: "old", text: "an unrelated old message" } }];
      },
      async close() {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools[0]?.description).toMatch(/Do not use it.*current or last message/iu);
      for (const query of [
        "What did you send in the last message?",
        "What was your previous reply?",
        "What was the last message?",
        "What did you say?",
        "What did you just send?",
        "What happened in this conversation?",
      ]) {
        const result = (await client.callTool({ name: "MemoryRecall", arguments: { query } })) as {
          content: Array<{ type: string; text: string }>;
          structuredContent?: { hits: unknown[]; conversationRelative?: boolean };
        };
        expect(result.structuredContent, query).toMatchObject({ hits: [], conversationRelative: true });
        expect(result.content[0]?.text, query).toMatch(/active conversation|current conversation history/iu);
      }
      expect(recallCalls).toBe(0);

      for (const query of [
        "What did you send Casey for her birthday last year?",
        "What did you say our durable deployment policy was?",
        "What did Alice's last message say?",
        "What was the last message from the deploy bot?",
      ]) {
        const result = await client.callTool({ name: "MemoryRecall", arguments: { query } });
        expect(result.structuredContent, query).toMatchObject({
          hits: [expect.objectContaining({ id: "old" })],
        });
      }
      expect(recallCalls).toBe(4);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("answers a tools/call against a lite (FTS-only) store", async () => {
    // No embeddings → lite tier → FTS-only recall, so the test needs no Ollama/OpenAI.
    const store = createBujoMemoryStore({ root: dir });
    await store.appendHostSummary("conv-1", "The deploy pipeline uses blue-green releases on Fridays.");
    await store.appendHostSummary("conv-1", "Lunch preferences are irrelevant noise.");

    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["MemoryRecall"]);

      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "deploy pipeline releases" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };

      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("blue-green releases");
      expect(result.structuredContent?.hits.some((hit) => hit.text.includes("blue-green releases"))).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("returns a no-match message when nothing matches", async () => {
    const store = createBujoMemoryStore({ root: dir });
    await store.appendHostSummary("conv-1", "An unrelated note about gardening.");
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "quantum chromodynamics lattice gauge" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: unknown[] } };
      expect(result.content[0]?.text).toMatch(/No memories matched/u);
      expect(result.structuredContent?.hits).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("keeps a non-BuJo tier on the direct limit without graph prefetch", async () => {
    const recalls: Array<{ readonly topK?: number; readonly trackAccess?: boolean }> = [];
    let expansions = 0;
    const store = {
      async recall(_query: string, options?: { readonly topK?: number; readonly trackAccess?: boolean }) {
        recalls.push(options ?? {});
        return [{ score: 0.9, record: { id: "direct", text: "Morgan prefers cobalt." } }];
      },
      supportsGraphExpansion: () => false,
      expandGraph() {
        expansions += 1;
        return [];
      },
      async close() {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "MemoryRecall", arguments: { query: "Morgan preference", limit: 3 } });
      expect(recalls).toEqual([{ topK: 3, trackAccess: false }]);
      expect(expansions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("createRecallStore", () => {
  it("builds a keyless LM Studio provider with the exact root and identity", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const provider = await createMemoryEmbeddingProvider({
      provider: "lmstudio",
      model: "text-embedding-test",
      endpoint: "http://localhost:1234",
    });
    await expect(provider.embed(["remember this"])).resolves.toEqual([[1, 0, 0, 0]]);

    expect(provider.id).toBe("lmstudio:text-embedding-test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/Authorization|11434|ollama/iu);
  });

  it("fails before provider construction when a declared credential has no resolved value", async () => {
    await expect(createMemoryEmbeddingProvider({
      provider: "lmstudio",
      model: "text-embedding-test",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    })).rejects.toThrow(/LM_STUDIO_API_KEY.*no resolved value/iu);
  });

  it("builds an FTS-only store when settings carry no embeddings (F12)", async () => {
    // No embeddings → lite tier → FTS recall answers without any Ollama/OpenAI backend.
    await seedRecallMemory(dir, "The deploy pipeline uses blue-green releases on Fridays.");
    const store = (await createRecallStore({ root: dir })) as unknown as BujoMemoryStore;
    try {
      expect(store.tier()).toBe("lite");
      const hits = await store.recall("deploy pipeline releases");
      expect(hits.some((hit) => hit.record.text.includes("blue-green releases"))).toBe(true);
      await expect(store.appendHostSummary("conv-2", "Recall must not write.")).rejects.toThrow(/read.?only/iu);
    } finally {
      await store.close();
    }
  });

  it("opens the managed active generation instead of a stale legacy database", async () => {
    await seedRecallMemory(dir, "The active generation contains the cobalt launch plan.");
    await safeRebuildMemoryIndex({ root: dir, tier: "lite" });
    const activePath = await resolveActiveMemoryDbPath(dir);
    expect(activePath).not.toBe(join(dir, "memory.db"));

    const legacy = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      legacy.upsertLexical(memoryRecord("LEGACY-ONLY", "Stale legacy database sentinel."));
    } finally {
      legacy.close();
    }

    const store = await createRecallStore({ root: dir });
    try {
      const activeHits = await store.recall("cobalt launch plan", { trackAccess: false });
      expect(activeHits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const staleHits = await store.recall("stale legacy database sentinel", { trackAccess: false });
      expect(staleHits).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("applies the embeddings timeout + circuit breaker so a dead backend fast-fails (F11)", async () => {
    // Unreachable endpoint + tiny timeout + a one-failure breaker: the first embed fails and trips
    // the breaker OPEN, so a subsequent recall fast-fails (no 30s hang, no inner provider call).
    await seedRecallMemory(dir, "Anything that needs an embedding.");
    const store = await createRecallStore({
      root: dir,
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text:v1.5",
        endpoint: "http://127.0.0.1:1",
        timeoutMs: 50,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      },
    }) as unknown as BujoMemoryStore;
    try {
      // The recall-only store never writes; the first lookup trips the breaker.
      await expect(store.recall("anything")).rejects.toThrow();
      // With the breaker OPEN, a subsequent recall fast-fails without re-hitting the dead backend.
      await expect(store.recall("anything")).rejects.toThrow(/circuit is open/u);
    } finally {
      await store.close();
    }
  });

  it("opens managed BuJo generations for semantic and pinned FTS recall without losing graph capability", async () => {
    await seedRecallMemory(dir, "The cobalt launch plan uses blue-green deployment.");
    await seedRecallMemory(dir, "Taylor owns the incident checklist for midnight incidents.");
    const legacy = openMemoryDb({ path: join(dir, "memory.db") });
    const records = legacy.topSalient(10);
    legacy.close();
    const launch = records.find((record) => record.text.includes("cobalt launch plan"))!;
    const incident = records.find((record) => record.text.includes("incident checklist"))!;
    appendGraphBatch(dir, {
      entities: [
        { id: "project:launch", name: "Launch", type: "project", createdAt: "2026-07-11T09:00:00.000Z" },
        { id: "person:taylor", name: "Taylor", type: "person", createdAt: "2026-07-11T09:00:00.000Z" },
      ],
      relations: [{
        src: "project:launch",
        dst: "person:taylor",
        relation: "supported by",
        createdAt: "2026-07-11T09:00:00.000Z",
      }],
      associations: [
        { memoryId: launch.id, entityId: "project:launch", provenance: "capture", createdAt: "2026-07-11T09:00:00.000Z" },
        { memoryId: incident.id, entityId: "person:taylor", provenance: "capture", createdAt: "2026-07-11T09:00:00.000Z" },
      ],
    });
    const embeddings = deterministicEmbeddings("ollama:test-embed", 8);
    await safeRebuildMemoryIndex({ root: dir, tier: "bujo", embeddings, dim: 8 });
    const activePath = await resolveActiveMemoryDbPath(dir);

    let fetchCalls = 0;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        embeddings: body.input.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const semantic = await createRecallStore({
      root: dir,
      tier: "bujo",
      dbPath: activePath,
      embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
    }) as BujoMemoryStore;
    try {
      expect(semantic.tier()).toBe("bujo");
      expect(semantic.supportsGraphExpansion()).toBe(true);
      const hits = await semantic.recall("cobalt launch plan", { trackAccess: false });
      expect(hits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const expanded = semantic.expandGraph("Who is Launch supported by?", [{ record: launch, score: 0.9 }], { topK: 5 });
      expect(expanded.some((hit) => hit.record.text.includes("incident checklist"))).toBe(true);
      expect(fetchCalls).toBeGreaterThan(0);
    } finally {
      await semantic.close();
    }

    const fallback = await createRecallStore({
      root: dir,
      tier: "bujo",
      dbPath: activePath,
      ftsOnlyFallback: true,
    }) as BujoMemoryStore;
    try {
      expect(fallback.tier()).toBe("bujo");
      expect(fallback.supportsGraphExpansion()).toBe(true);
      const hits = await fallback.recall("cobalt launch plan", { trackAccess: false });
      expect(hits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const expanded = fallback.expandGraph("Who is Launch supported by?", [{ record: launch, score: 0.9 }], { topK: 5 });
      expect(expanded.some((hit) => hit.record.text.includes("incident checklist"))).toBe(true);
      expect(await resolveActiveMemoryDbPath(dir)).toBe(activePath);
    } finally {
      await fallback.close();
    }
  });
});

async function seedRecallMemory(root: string, text: string): Promise<void> {
  const store = createBujoMemoryStore({ root });
  try {
    await store.appendHostSummary("conv-1", text);
  } finally {
    await store.close();
  }
}

function memoryRecord(id: string, text: string) {
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

function supermemoryConfig(overrides: {
  readonly recallEnabled?: boolean;
  readonly container?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
  readonly sourceId?: string;
}): MonoAgentConfig {
  return {
    memory: {
      backend: "supermemory",
      mode: "lite",
      path: "/memory",
      maxBytes: 64_000,
      writeMode: "capture",
      recallTool: { enabled: overrides.recallEnabled ?? true },
      supermemory: {
        baseUrl: "http://127.0.0.1:6767",
        ...(overrides.container === undefined ? {} : { container: overrides.container }),
        ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
        ...(overrides.apiKeyEnv === undefined ? {} : { apiKeyEnv: overrides.apiKeyEnv }),
        ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
      },
    },
    traceability: { registryDir: "/trace", ...(overrides.sourceId === undefined ? {} : { sourceId: overrides.sourceId }) },
  } as unknown as MonoAgentConfig;
}

describe("supermemory backend recall", () => {
  it("defaults recall on when a programmatic Supermemory config omits recallTool", () => {
    const config = supermemoryConfig({ sourceId: "agent-alpha" });
    const memory = { ...config.memory };
    delete memory.recallTool;

    expect(resolveMemoryRecallSettings({ ...config, memory } as MonoAgentConfig)).toEqual({
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
    });
  });

  it("resolves supermemory recall settings with the container derived from the trace sourceId", () => {
    const settings = resolveMemoryRecallSettings(supermemoryConfig({ sourceId: "agent-alpha" }));
    expect(settings).toEqual({
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
    });
  });

  it("honors an explicit container over the trace identity", () => {
    const settings = resolveMemoryRecallSettings(supermemoryConfig({ sourceId: "agent-alpha", container: "custom" }));
    expect(settings).toEqual({
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "custom" },
    });
  });

  it("bypasses only the live tool gate for previews and preserves Supermemory precedence", () => {
    const shared = {
      container: "explicit-container",
      sourceId: "trace-container",
      apiKey: "resolved-sm-secret",
      apiKeyEnv: "SUPERMEMORY_KEY",
      timeoutMs: 4_500,
    } as const;
    const previewConfig = supermemoryConfig({
      ...shared,
      recallEnabled: false,
    });
    const liveConfig = supermemoryConfig({ ...shared, recallEnabled: true });

    expect(resolveMemoryRecallSettings(previewConfig)).toBeUndefined();
    const previewSettings = resolveMemoryRecallSettings(previewConfig, { ignoreRecallToolGate: true });
    expect(previewSettings).toEqual(resolveMemoryRecallSettings(liveConfig));
    expect(previewSettings).toEqual({
      supermemory: {
        baseUrl: "http://127.0.0.1:6767",
        container: "explicit-container",
        apiKey: "resolved-sm-secret",
        timeoutMs: 4_500,
      },
    });
  });

  it("hydrates a resolved Supermemory apiKey value from the standalone-binary env", () => {
    const settings: MemoryRecallSettings = {
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha", apiKey: "sm-secret", timeoutMs: 5_000 },
    };
    const env = {
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: "agent-alpha",
      MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: "sm-secret",
      MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: "5000",
    };
    expect(memoryRecallSettingsFromEnv(env)).toEqual(settings);
  });

  it("hydrates a keyless (local, no-auth) Supermemory recall config", () => {
    const keyless: MemoryRecallSettings = {
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
    };
    const env = {
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: "agent-alpha",
    };
    expect(memoryRecallSettingsFromEnv(env)).toEqual(keyless);
  });

  it("fails loud when the child env is missing the container (wiring bug, not a default)", () => {
    expect(() =>
      memoryRecallSettingsFromEnv({
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      }),
    ).toThrow(/SUPERMEMORY_CONTAINER/);
  });

  it("builds a SupermemoryMemoryStore from supermemory settings", async () => {
    const store = await createRecallStore({ supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" } });
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("answers a tools/call against a recall-capable store (backend-agnostic server)", async () => {
    const fakeStore = {
      recall: async () => [{ score: 0.9, record: { id: "m1", text: "user prefers dark mode" } }],
      close: async () => {},
    };
    const server = createMemoryRecallServer(fakeStore);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "preferences" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };
      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("user prefers dark mode");
      expect(result.structuredContent?.hits[0]?.text).toBe("user prefers dark mode");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MEMORY_RECALL_MCP_SERVER_NAME", () => {
  it("is the stable server name the app injects", () => {
    expect(MEMORY_RECALL_MCP_SERVER_NAME).toBe("mono-agent-memory");
  });
});
