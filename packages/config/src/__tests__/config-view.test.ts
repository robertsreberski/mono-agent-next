import { describe, expect, it } from "vitest";

import { loadMonoAgentConfig, redactMonoAgentConfig } from "../config.js";
import { buildMonoAgentConfigView, findJsonSecretConfigWarnings, findRemovedConfigWarnings, sameJsonValue } from "../config-view.js";
import type { ConfigViewSection } from "../config-view.js";
import type { MonoAgentConfigJson } from "../json-source.js";
import { layerJsonOntoEnv } from "../layered-loader.js";

const baseEnv: Record<string, string | undefined> = {
  MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
  MONO_AGENT_IDENTITY_PATH: "/repo/IDENTITY.md",
};

function buildView(
  env: Record<string, string | undefined>,
  json: MonoAgentConfigJson = {},
): readonly ConfigViewSection[] {
  const config = loadMonoAgentConfig({ cwd: "/repo", env: layerJsonOntoEnv(json, env) });
  const redacted = redactMonoAgentConfig(config);
  return buildMonoAgentConfigView({ redacted, json, env });
}

function field(sections: readonly ConfigViewSection[], id: string) {
  for (const section of sections) {
    const found = section.fields.find((entry) => entry.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`field ${id} not found in view`);
}

function section(sections: readonly ConfigViewSection[], id: string): ConfigViewSection {
  const found = sections.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`section ${id} not found in view`);
  }
  return found;
}

describe("buildMonoAgentConfigView", () => {
  it("compares JSON object defaults structurally while preserving array order", () => {
    expect(sameJsonValue(
      { a: 1, b: { c: true, d: [1, { e: "x", f: "y" }] } },
      { b: { d: [1, { f: "y", e: "x" }], c: true }, a: 1 },
    )).toBe(true);
    expect(sameJsonValue([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("covers every core section exactly once", () => {
    const sections = buildView(baseEnv);
    expect(sections.map((entry) => entry.id)).toEqual([
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
  });

  it("surfaces public identity and canonical fallback effort semantics", () => {
    const sections = buildView(baseEnv, {
      agent: { name: "Research Partner" },
      runtime: {
        fallbacks: [
          { model: "codex:gpt-5.6-sol" },
          { model: "claude:claude-sonnet-4-6", effort: "high" },
        ],
        routeSafety: "per-route-native",
      },
    });

    expect(section(sections, "agent").status).toBe("active");
    expect(field(sections, "agent.name")).toMatchObject({ value: "Research Partner", source: "json" });
    expect(field(sections, "runtime.fallbacks").value).toContain("provider default");
    expect(field(sections, "runtime.fallbacks").value).toContain("high");
    expect(field(sections, "runtime.routeSafety")).toMatchObject({ value: "per-route-native", source: "json" });
  });

  it("does not present a JSON fallback encoding as active when the alternate env encoding wins", () => {
    const sections = buildView(
      { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "claude:claude-sonnet-4-6" },
      { runtime: { fallbacks: [{ model: "codex:gpt-5.6-sol" }] } },
    );

    expect(field(sections, "runtime.fallbackModels")).toMatchObject({
      value: "claude:claude-sonnet-4-6",
      source: "env",
    });
    expect(field(sections, "runtime.fallbacks")).toMatchObject({ value: "—", source: "default" });
  });

  it("reports an empty legacy fallback clear as env-sourced", () => {
    const sections = buildView(
      { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "" },
      { runtime: { fallbackModels: ["claude:claude-sonnet-4-6"] } },
    );

    expect(field(sections, "runtime.fallbackModels")).toMatchObject({ value: "—", source: "env" });
  });

  it("marks an env-sourced field as env", () => {
    const sections = buildView({ ...baseEnv, MONO_AGENT_MAX_TURNS: "5" });
    expect(field(sections, "runtime.maxTurns")).toMatchObject({ value: "5", source: "env" });
  });

  it("marks a json-sourced field as json", () => {
    const sections = buildView(baseEnv, { runtime: { maxTurns: 7 } });
    // The loader resolved from baseEnv (no env max turns), so json presence wins over default.
    expect(field(sections, "runtime.maxTurns").source).toBe("json");
  });

  it("marks an unset field as default", () => {
    const sections = buildView(baseEnv);
    expect(field(sections, "runtime.effort").source).toBe("default");
    expect(field(sections, "runtime.effort").value).toBe("—");
  });

  it("shows adaptive compaction defaults and JSON/env source precedence", () => {
    const defaults = buildView(baseEnv);
    expect(field(defaults, "runtime.compaction.enabled")).toMatchObject({ value: "yes", source: "default" });
    expect(field(defaults, "runtime.compaction.triggerRatio")).toMatchObject({ value: "0.7", source: "default" });
    expect(field(defaults, "runtime.compaction.keepRecentTokens")).toMatchObject({
      value: "adaptive by model",
      source: "default",
    });
    expect(field(defaults, "runtime.compaction.summaryMaxTokens")).toMatchObject({
      value: "adaptive by model",
      source: "default",
    });
    expect(field(defaults, "runtime.compaction.minSavingsTokens")).toMatchObject({
      value: "adaptive by model",
      source: "default",
    });
    expect(field(defaults, "runtime.compaction.fixedOverheadEnabled")).toMatchObject({
      value: "yes",
      source: "default",
    });
    expect(field(defaults, "runtime.compaction.contextWindowOverride")).toMatchObject({
      value: "auto",
      source: "default",
    });

    const overridden = buildView(
      { ...baseEnv, MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS: "12000" },
      { runtime: { compaction: { triggerRatio: 0.8, keepRecentTokens: 9_000 } } },
    );
    expect(field(overridden, "runtime.compaction.triggerRatio")).toMatchObject({ value: "0.8", source: "json" });
    expect(field(overridden, "runtime.compaction.keepRecentTokens")).toMatchObject({ value: "12000", source: "env" });
  });

  it("lets a real env var win over a json-present value", () => {
    const sections = buildView(
      { ...baseEnv, MONO_AGENT_MAX_TURNS: "9" },
      { runtime: { maxTurns: 7 } },
    );
    expect(field(sections, "runtime.maxTurns")).toMatchObject({ value: "9", source: "env" });
  });

  it("marks JSON values that merely restate traceability defaults", () => {
    const sections = buildView(baseEnv, {
      traceability: {
        heartbeatMs: 10_000,
        staleAfterMs: 30_000,
      },
    });

    expect(field(sections, "traceability.heartbeatMs")).toMatchObject({
      value: "10000",
      source: "json",
      restatesDefault: true,
    });
    expect(field(sections, "traceability.staleAfterMs")).toMatchObject({
      value: "30000",
      source: "json",
      restatesDefault: true,
    });
  });

  it("surfaces session rollover notice source and resolved value", () => {
    const defaultSections = buildView(baseEnv);
    expect(field(defaultSections, "runtime.session.rolloverNotice")).toMatchObject({ value: "no", source: "default" });

    const jsonSections = buildView(baseEnv, { runtime: { session: { rolloverNotice: false } } });
    expect(field(jsonSections, "runtime.session.rolloverNotice")).toMatchObject({ value: "no", source: "json" });

    const envSections = buildView(
      { ...baseEnv, MONO_AGENT_SESSION_ROLLOVER_NOTICE: "true" },
      { runtime: { session: { rolloverNotice: false } } },
    );
    expect(field(envSections, "runtime.session.rolloverNotice")).toMatchObject({ value: "yes", source: "env" });
  });

  it("reports the memory section as disabled when memory is unconfigured", () => {
    const memory = section(buildView(baseEnv), "memory");
    expect(memory.status).toBe("disabled");
    expect(memory.fields[0]).toMatchObject({ value: "not configured", source: "default" });
  });

  it("surfaces the observability and local-provider sections the old registry omitted", () => {
    const sections = buildView(baseEnv);
    expect(section(sections, "observability").status).toBe("disabled");
    expect(field(sections, "providers.local")).toBeDefined();
    expect(field(sections, "observability.exporters")).toBeDefined();
  });

  it("shows the Pi transport source and compatibility default", () => {
    expect(field(buildView(baseEnv), "providers.piNative.transport")).toMatchObject({
      value: "auto",
      source: "default",
    });
    expect(field(buildView(baseEnv, { providers: { piNative: { transport: "sse" } } }), "providers.piNative.transport"))
      .toMatchObject({ value: "sse", source: "json" });
    expect(field(
      buildView(
        { ...baseEnv, MONO_AGENT_PI_TRANSPORT: "websocket" },
        { providers: { piNative: { transport: "sse" } } },
      ),
      "providers.piNative.transport",
    )).toMatchObject({ value: "websocket", source: "env" });
  });

  it("redacts the embeddings api key and never leaks the value", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "journal",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-super-secret",
    });
    const apiKey = field(sections, "memory.embeddings.apiKey");
    expect(apiKey.redacted).toBe(true);
    expect(apiKey.value).toBe("set");
    expect(JSON.stringify(sections)).not.toContain("sk-super-secret");
  });

  it("surfaces a keyless LM Studio service root and unresolved credential reference", () => {
    const sections = buildView(baseEnv, {
      memory: {
        mode: "journal",
        path: "/repo/memory",
        embeddings: {
          provider: "lmstudio",
          model: "embed-model",
          endpoint: "http://localhost:1234",
          apiKeyEnv: "LM_STUDIO_API_KEY",
        },
      },
    });

    expect(field(sections, "memory.embeddings.provider")).toMatchObject({ value: "lmstudio", source: "json" });
    expect(field(sections, "memory.embeddings.endpoint")).toMatchObject({
      value: "http://localhost:1234",
      source: "json",
    });
    expect(field(sections, "memory.embeddings.apiKey")).toMatchObject({ value: "unset", redacted: true });
    expect(field(sections, "memory.embeddings.apiKeyEnv")).toMatchObject({
      value: "LM_STUDIO_API_KEY",
      source: "json",
    });
  });

  it("activates the memory section and shows the resolved mode", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "lite",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
    });
    const memory = section(sections, "memory");
    expect(memory.status).toBe("active");
    expect(field(sections, "memory.mode")).toMatchObject({ value: "lite", source: "env" });
  });

  it("surfaces consolidation fields for bujo memory and does not expose removed ritual fields", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "bujo",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
      MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */4 * * *",
    });

    expect(field(sections, "memory.consolidation.enabled")).toMatchObject({ value: "on", source: "default" });
    expect(field(sections, "memory.consolidation.cron")).toMatchObject({ value: "0 */4 * * *", source: "env" });
    expect(sections.flatMap((entry) => entry.fields).map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([
        "memory.reflection.enabled",
        "memory.reflection.cron",
        "memory.migration.enabled",
        "memory.migration.cron",
      ]),
    );
  });

  it("shows artifact retention with default, json, and env sources", () => {
    const defaultSections = buildView(baseEnv);
    expect(field(defaultSections, "artifacts.retention.maxAgeDays")).toMatchObject({ value: "365 day(s)", source: "default" });
    expect(field(defaultSections, "artifacts.retention.maxCount")).toMatchObject({ value: "50000", source: "default" });
    expect(field(defaultSections, "artifacts.retention.dryRun")).toMatchObject({ value: "no", source: "default" });
    expect(field(defaultSections, "artifacts.memoryRetention.maxAgeDays")).toMatchObject({ value: "7 day(s)", source: "default" });
    expect(field(defaultSections, "artifacts.memoryRetention.maxCount")).toMatchObject({ value: "5000", source: "default" });
    expect(field(defaultSections, "artifacts.memoryRetention.dryRun")).toMatchObject({ value: "no", source: "default" });

    const jsonSections = buildView(baseEnv, {
      artifacts: {
        retention: { maxAgeDays: 10, maxCount: 200, dryRun: true },
        memoryRetention: { maxAgeDays: 2, maxCount: 20, dryRun: false },
      },
    });
    expect(field(jsonSections, "artifacts.retention.maxAgeDays")).toMatchObject({ value: "10 day(s)", source: "json" });
    expect(field(jsonSections, "artifacts.retention.maxCount")).toMatchObject({ value: "200", source: "json" });
    expect(field(jsonSections, "artifacts.retention.dryRun")).toMatchObject({ value: "yes", source: "json" });
    expect(field(jsonSections, "artifacts.memoryRetention.maxAgeDays")).toMatchObject({ value: "2 day(s)", source: "json" });
    expect(field(jsonSections, "artifacts.memoryRetention.maxCount")).toMatchObject({ value: "20", source: "json" });
    expect(field(jsonSections, "artifacts.memoryRetention.dryRun")).toMatchObject({ value: "no", source: "json" });

    const envSections = buildView(
      {
        ...baseEnv,
        MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT: "50",
        MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT: "15",
      },
      {
        artifacts: {
          retention: { maxCount: 200 },
          memoryRetention: { maxCount: 20 },
        },
      },
    );
    expect(field(envSections, "artifacts.retention.maxCount")).toMatchObject({ value: "50", source: "env" });
    expect(field(envSections, "artifacts.memoryRetention.maxCount")).toMatchObject({ value: "15", source: "env" });

    const inheritedJsonDryRunSections = buildView(baseEnv, {
      artifacts: {
        retention: { dryRun: true },
      },
    });
    expect(field(inheritedJsonDryRunSections, "artifacts.memoryRetention.dryRun")).toMatchObject({ value: "yes", source: "json" });

    const inheritedEnvDryRunSections = buildView({
      ...baseEnv,
      MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN: "true",
    });
    expect(field(inheritedEnvDryRunSections, "artifacts.memoryRetention.dryRun")).toMatchObject({ value: "yes", source: "env" });
  });

  it("labels the allow-all default, explicit chat-only, and a specific allowlist, mirroring the doctor", () => {
    // Default (no tools block) resolves to ["*"] → the allow-all label, not "default policy".
    expect(field(buildView(baseEnv), "tools.allowedTools")).toMatchObject({
      value: "All tools allowed",
      source: "default",
    });
    // Explicit allow-all sentinel also reads as allow-all.
    expect(field(buildView({ ...baseEnv, MONO_AGENT_ALLOWED_TOOLS: "*" }), "tools.allowedTools").value)
      .toBe("All tools allowed");
    // Explicit empty list (chat-only) — declared as JSON `[]`, which survives the env
    // layering an empty MONO_AGENT_ALLOWED_TOOLS string would be stripped by.
    expect(field(buildView(baseEnv, { tools: { allowedTools: [] } }), "tools.allowedTools")).toMatchObject({
      value: "none (chat-only)",
      source: "json",
    });
    // A specific allowlist renders the joined names.
    expect(field(buildView({ ...baseEnv, MONO_AGENT_ALLOWED_TOOLS: "Read,Bash" }), "tools.allowedTools").value)
      .toBe("Read, Bash");
  });
});

describe("findJsonSecretConfigWarnings", () => {
  it("warns for a JSON-sourced embeddings api key and names its env var", () => {
    const warnings = findJsonSecretConfigWarnings(buildView(baseEnv, {
      memory: {
        mode: "journal",
        path: "./memory",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-json-secret",
        },
      },
    }));

    expect(warnings).toEqual([
      "[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).",
    ]);
  });

  it("does not warn when the embeddings api key is env-sourced", () => {
    const warnings = findJsonSecretConfigWarnings(buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-env-secret",
    }, {
      memory: {
        mode: "journal",
        path: "./memory",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    }));

    expect(warnings).toEqual([]);
  });

  it("warns for a JSON-sourced Supermemory api key and names its env var", () => {
    const warnings = findJsonSecretConfigWarnings(buildView(baseEnv, {
      memory: {
        backend: "supermemory",
        supermemory: {
          baseUrl: "http://127.0.0.1:6767",
          apiKey: "sm-json-secret",
        },
      },
    }));

    expect(warnings).toEqual([
      "[WARN] memory.supermemory.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY).",
    ]);
  });
});

describe("findRemovedConfigWarnings", () => {
  it("warns for removed JSON memory keys without printing values", () => {
    const warnings = findRemovedConfigWarnings({
      json: {
        memory: {
          reflection: { enabled: true, cron: "secret-ish-cron" },
          migration: { enabled: false },
        },
      },
      env: {},
    });

    expect(warnings).toEqual([
      "[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.",
      "[WARN] memory.migration is removed and ignored; use memory.consolidation instead.",
    ]);
    expect(warnings.join("\n")).not.toContain("secret-ish-cron");
  });

  it("warns for removed env memory keys without printing values", () => {
    const warnings = findRemovedConfigWarnings({
      json: {},
      env: {
        MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
        MONO_AGENT_MEMORY_MIGRATION_CRON: "secret-ish-cron",
      },
    });

    expect(warnings).toEqual([
      "[WARN] MONO_AGENT_MEMORY_REFLECTION_ENABLED is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
      "[WARN] MONO_AGENT_MEMORY_MIGRATION_CRON is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
    ]);
    expect(warnings.join("\n")).not.toContain("secret-ish-cron");
  });
});
