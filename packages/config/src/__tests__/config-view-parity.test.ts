import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadMonoAgentConfig, redactMonoAgentConfig } from "../config.js";
import { buildMonoAgentConfigView, CONFIG_ENV_KEYS } from "../config-view.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** Read the loader sources and collect every `MONO_AGENT_*` literal they reference. */
function loaderEnvKeys(): Set<string> {
  const sources = ["config.ts", "layered-loader.ts"].map((file) =>
    readFileSync(join(srcDir, file), "utf8"),
  );
  const keys = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/MONO_AGENT_[A-Z0-9_]+/gu)) {
      keys.add(match[0]);
    }
  }
  return keys;
}

/**
 * Loader literals that are deliberately NOT discrete view fields:
 * - `MONO_AGENT_LOCAL_PROVIDER` and its single-provider `_*` form are an alternate
 *   input encoding the view summarizes under the `providers.local` field.
 * - The retired pre-v2 memory keys are tolerated (warned, not honored), so they
 *   are intentionally absent from the view.
 */
const LOADER_ONLY_ALLOWLIST = new Set<string>([
  "MONO_AGENT_LOCAL_PROVIDER",
  "MONO_AGENT_LOCAL_PROVIDER_ID",
  "MONO_AGENT_LOCAL_PROVIDER_TYPE",
  "MONO_AGENT_LOCAL_PROVIDER_BASE_URL",
  "MONO_AGENT_LOCAL_PROVIDER_ENABLED",
  "MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL",
  "MONO_AGENT_LOCAL_PROVIDER_API_KEY",
  "MONO_AGENT_MEMORY_GRAPH_PATH",
  "MONO_AGENT_MEMORY_SCOPE",
  "MONO_AGENT_MEMORY_TOOLS_ENABLED",
  "MONO_AGENT_MEMORY_REFLECTION_ENABLED",
  "MONO_AGENT_MEMORY_REFLECTION_CRON",
  "MONO_AGENT_MEMORY_MIGRATION_ENABLED",
  "MONO_AGENT_MEMORY_MIGRATION_CRON",
]);

describe("config view <-> loader parity", () => {
  it("registers an env key for every literal the loader reads", () => {
    const registry = new Set<string>(Object.values(CONFIG_ENV_KEYS));
    const missing = [...loaderEnvKeys()].filter(
      (key) => !registry.has(key) && !LOADER_ONLY_ALLOWLIST.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("never registers a phantom key the loader does not read", () => {
    const loader = loaderEnvKeys();
    const phantom = Object.values(CONFIG_ENV_KEYS).filter((key) => !loader.has(key));
    expect(phantom).toEqual([]);
  });

  it("only emits field ids declared in CONFIG_ENV_KEYS", () => {
    // A broadly-populated config so the view walks every conditional branch.
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
        MONO_AGENT_IDENTITY_PATH: "/repo/IDENTITY.md",
        MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "4",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_PATH: "/repo/memory",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3:8b",
        MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "true",
        MONO_AGENT_SANDBOX_MODE: "native",
      },
    });
    const view = buildMonoAgentConfigView({
      redacted: redactMonoAgentConfig(config),
      json: {},
      env: {},
    });
    const known = new Set<string>(Object.keys(CONFIG_ENV_KEYS));
    const unknown = view
      .flatMap((section) => section.fields)
      .map((fieldEntry) => fieldEntry.id)
      .filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });
});
