import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createEmbeddingProvider } from "../../search/index.js";
import { createBujoMemoryStore } from "../store.js";

const OLLAMA = process.env.MONO_AGENT_OLLAMA_E2E === "1";

describe.skipIf(!OLLAMA)("BujoMemoryStore @ real Ollama", () => {
  it("captures and semantically recalls a fact via nomic-embed-text:v1.5", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-e2e-"));
    const store = createBujoMemoryStore({
      root,
      embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
      dim: 768,
    });
    await store.appendHostSummary("global", "The team decided to adopt opt-in memory with a validate self-check.");
    await store.appendHostSummary("global", "Lunch was pizza on Tuesday.");
    const block = await store.load("memory configuration decision");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  }, 30_000);
});
