import { loadMonoAgentConfig, redactMonoAgentConfig } from "@mono-agent/config";
import { describe, expect, it } from "vitest";

import { buildTuiConfigSummary } from "../config/pane.js";

const SECRET_SENTINEL = ["aud-062", "secret", "sentinel"].join("-");

const shellEnv: Record<string, string | undefined> = {
  MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
  MONO_AGENT_IDENTITY_PATH: "/repo/IDENTITY.md",
  MONO_AGENT_MEMORY_MODE: "journal",
  MONO_AGENT_MEMORY_PATH: "/repo/memory",
  MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
  MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
  MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: SECRET_SENTINEL,
};

function findField(
  sections: ReturnType<typeof buildTuiConfigSummary>,
  label: string,
) {
  for (const section of sections) {
    const field = section.fields.find((entry) => entry.label === label);
    if (field !== undefined) {
      return field;
    }
  }
  throw new Error(`field ${label} not found`);
}

describe("buildTuiConfigSummary", () => {
  it("preserves display values, source provenance, and secret redaction from the canonical config view", () => {
    // Resolve the JSON-provided value through the same environment-shaped layer
    // the config loader uses, but omit it from shellEnv so the canonical view
    // correctly classifies it as JSON rather than an environment override.
    const resolved = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...shellEnv, MONO_AGENT_MAX_TURNS: "7" },
    });
    const sections = buildTuiConfigSummary({
      redacted: redactMonoAgentConfig(resolved),
      json: { runtime: { maxTurns: 7 } },
      env: shellEnv,
    });

    expect(sections.map((section) => section.heading)).toEqual([
      "agent",
      "runtime",
      "concurrency",
      "context",
      "memory",
      "tools",
      "sandbox",
      "artifacts",
      "traceability",
      "observability",
      "providers",
    ]);
    expect(findField(sections, "Model")).toMatchObject({
      value: "pi:ollama:qwen3:8b",
      source: "env",
    });
    expect(findField(sections, "Max turns")).toMatchObject({
      value: "7",
      source: "json",
    });
    expect(findField(sections, "Effort")).toEqual({
      label: "Effort",
      value: "—",
      source: "default",
    });
    expect(findField(sections, "Embeddings API key")).toEqual({
      label: "Embeddings API key",
      value: "set",
      source: "env",
      redacted: true,
    });
    expect(JSON.stringify(sections)).not.toContain(SECRET_SENTINEL);
  });
});
