import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_ENV_KEYS } from "@mono-agent/config";
import type { ConfigViewFieldId } from "@mono-agent/config";
import { loadSlackAdapterConfig } from "@mono-agent/slack-adapter";
import { describe, expect, it } from "vitest";

import {
  allConfigReferenceFields,
  assertKnownAppConfigKeys,
  buildGeneratedConfigReferenceMarkdown,
  buildMonoAgentConfigSchema,
  findUnknownAppConfigPaths,
  MONO_AGENT_CONFIG_SCHEMA_URL,
  schemaForField,
} from "../config-reference.js";
import type { ConfigReferenceType } from "../config-reference.js";

const here = dirname(fileURLToPath(import.meta.url));

const EXPECTED_CORE_FIELD_TYPES: Record<ConfigViewFieldId, ConfigReferenceType> = {
  "agent.name": "string",
  "runtime.model": "string",
  "runtime.fallbackModels": "string[]",
  "runtime.fallbacks": "array",
  "runtime.routeSafety": "string",
  "runtime.executionMode": "string",
  "runtime.effort": "string",
  "runtime.permissionMode": "string",
  "runtime.maxTurns": "integer",
  "runtime.compaction.enabled": "boolean",
  "runtime.compaction.triggerRatio": "number",
  "runtime.compaction.keepRecentTokens": "integer",
  "runtime.compaction.summaryMaxTokens": "integer",
  "runtime.compaction.minSavingsTokens": "integer",
  "runtime.compaction.fixedOverheadEnabled": "boolean",
  "runtime.compaction.contextWindowOverride": "integer",
  "runtime.workspace": "string",
  "runtime.session.mode": "string",
  "runtime.session.idleTimeoutMs": "integer",
  "runtime.session.rollover": "string",
  "runtime.session.rolloverTimezone": "string",
  "runtime.session.rolloverNotice": "boolean",
  "runtime.session.isolateProactive": "boolean",
  "concurrency.maxConcurrentRuns": "integer",
  "concurrency.maxPendingRuns": "integer",
  "context.identityPath": "string",
  "context.soulPath": "string",
  "context.skillsRoot": "string",
  "context.selectedSkills": "string[]",
  "context.skillMaxBytes": "integer",
  "context.skillDisclosure": "string",
  "memory.backend": "string",
  "memory.mode": "string",
  "memory.path": "string",
  "memory.maxBytes": "integer",
  "memory.writeMode": "string",
  "memory.supermemory.baseUrl": "string",
  "memory.supermemory.apiKey": "string",
  "memory.supermemory.apiKeyEnv": "string",
  "memory.supermemory.container": "string",
  "memory.supermemory.timeoutMs": "integer",
  "memory.supermemory.exposeMcpServer": "boolean",
  "memory.embeddings.provider": "string",
  "memory.embeddings.model": "string",
  "memory.embeddings.endpoint": "string",
  "memory.embeddings.apiKey": "string",
  "memory.embeddings.apiKeyEnv": "string",
  "memory.embeddings.dim": "integer",
  "memory.embeddings.timeoutMs": "integer",
  "memory.embeddings.circuitBreaker.failureThreshold": "integer",
  "memory.embeddings.circuitBreaker.cooldownMs": "integer",
  "memory.llm.provider": "string",
  "memory.llm.model": "string",
  "memory.llm.executionMode": "string",
  "memory.llm.trace": "boolean",
  "memory.llm.timeoutMs": "integer",
  "memory.llm.endpoint": "string",
  "memory.recallTool.enabled": "boolean",
  "memory.consolidation.enabled": "boolean",
  "memory.consolidation.cron": "string",
  "tools.allowedTools": "string[]",
  "tools.disallowedTools": "string[]",
  "tools.mcpConfigPath": "string",
  "tools.mcpRequestContextServers": "string[]",
  "tools.continuationServers": "string[]",
  "tools.mcpCallTimeoutMs": "integer",
  "tools.mcpCallMaxTotalTimeoutMs": "integer",
  "sandbox.mode": "string",
  "sandbox.network.mode": "string",
  "sandbox.network.allowlist": "string[]",
  "sandbox.readableRoots": "string[]",
  "sandbox.writableRoots": "string[]",
  "sandbox.denyWrite": "string[]",
  "sandbox.fallback": "string",
  "sandbox.unsafeAllowHostProcess": "boolean",
  "artifacts.dir": "string",
  "artifacts.retention.maxAgeDays": "integer",
  "artifacts.retention.maxCount": "integer",
  "artifacts.retention.dryRun": "boolean",
  "artifacts.memoryRetention.maxAgeDays": "integer",
  "artifacts.memoryRetention.maxCount": "integer",
  "artifacts.memoryRetention.dryRun": "boolean",
  "traceability.registryDir": "string",
  "traceability.sourceId": "string",
  "traceability.sourceLabel": "string",
  "traceability.heartbeatMs": "integer",
  "traceability.staleAfterMs": "integer",
  "traceability.globalDiscovery": "boolean",
  "observability.exporters": "array",
  "providers.piAuthPath": "string",
  "providers.piNative.transport": "string",
  "providers.piNative.piMaxRetries": "integer",
  "providers.piNative.maxRetryDelayMs": "integer",
  "providers.piNative.piSessionsRoot": "string",
  "providers.local": "array",
};

interface SchemaNode {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly const?: string;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly examples?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minProperties?: number;
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly allOf?: readonly SchemaNode[];
  readonly anyOf?: readonly SchemaNode[];
  readonly oneOf?: readonly SchemaNode[];
  readonly if?: SchemaNode;
  readonly then?: SchemaNode;
  readonly not?: SchemaNode;
}

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

describe("config reference", () => {
  it("rejects unknown top-level and nested keys from the generated schema", () => {
    const json = {
      $schema: MONO_AGENT_CONFIG_SCHEMA_URL,
      runtime: {
        model: "codex:gpt-5.5",
        session: {
          idleMs: 5_000,
        },
      },
      context: { identityPath: "./IDENTITY.md" },
      traceability: {
        heartBeatMs: 10_000,
        heartbeatMs: 10_000,
      },
      console: { enabled: true, port: 4400 },
      webhook: {
        enabled: true,
        endpoints: [{ name: "ok", path: "/ok", extraPluginOwnedShape: true }],
      },
      channels: {
        plugins: [
          {
            package: "@mono-agent/a2a-adapter",
            config: { provider: { enabled: false, pluginOwned: true } },
          },
        ],
      },
      continuations: {
        port: 4319,
        namedRoutes: {
          owner: { mode: "notify_if_actionable", conversationId: "slack:D1" },
        },
        retryForever: true,
      },
    };

    expect(findUnknownAppConfigPaths(json)).toEqual([
      "console",
      "continuations.retryForever",
      "runtime.session.idleMs",
      "traceability.heartBeatMs",
      "webhook.endpoints[0].extraPluginOwnedShape",
    ]);
    expect(() => assertKnownAppConfigKeys(json)).toThrow(
      /unknown keys: console, continuations\.retryForever, runtime\.session\.idleMs, traceability\.heartBeatMs, webhook\.endpoints\[0\]\.extraPluginOwnedShape/u,
    );
  });

  it("keeps only explicitly plugin-owned and extensible maps open", () => {
    expect(findUnknownAppConfigPaths({
      runtime: { model: "codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      channels: {
        plugins: [{ package: "@mono-agent/a2a-adapter", config: { nested: { pluginOwned: true } } }],
      },
      providers: {
        local: [{
          id: "local",
          type: "openai_compat",
          models: [{ name: "model", capabilities: { vendor_extension: true } }],
        }],
      },
      observability: {
        exporters: [{ type: "phoenix", headers: { "x-vendor-token": "secret" } }],
      },
      memory: { reflection: { removedLegacyShape: true } },
    })).toEqual([]);

    expect(findUnknownAppConfigPaths({
      runtime: { model: "codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: { jobs: [{ id: "daily", expression: "0 8 * * *", prompt: "Run", retryForever: true }] },
      channels: { plugins: [{ package: "pkg", typo: true, config: {} }] },
    })).toEqual(["channels.plugins[0].typo", "cron.jobs[0].retryForever"]);
  });

  it("keeps the committed schema generated from the current registry", () => {
    const root = repoRoot();
    const schema = readFileSync(join(root, "packages/agent-app/schema/mono-agent.config.schema.json"), "utf8");
    expect(schema).toBe(`${JSON.stringify(buildMonoAgentConfigSchema(), null, 2)}\n`);
  });

  it("keeps every core field's inferred type aligned with the hand-written fidelity table", () => {
    const registryIds = Object.keys(CONFIG_ENV_KEYS).sort() as ConfigViewFieldId[];
    const expectedIds = Object.keys(EXPECTED_CORE_FIELD_TYPES).sort();
    expect(expectedIds).toEqual(registryIds);

    const coreFields = allConfigReferenceFields().filter((field) =>
      Object.prototype.hasOwnProperty.call(CONFIG_ENV_KEYS, field.jsonPath),
    );
    expect(coreFields).toHaveLength(registryIds.length);
    const fieldsById = new Map(coreFields.map((field) => [field.jsonPath, field]));

    for (const id of registryIds) {
      const field = fieldsById.get(id);
      expect(field, `missing config reference field for ${id}`).toBeDefined();
      const expectedType = EXPECTED_CORE_FIELD_TYPES[id];
      expect(field?.type, `${id} inferred ConfigReferenceType`).toBe(expectedType);
      expect(schemaForField(field!).type, `${id} generated JSON-Schema type`).toBe(
        jsonSchemaTypeFor(expectedType),
      );
    }
  });

  it("models required core keys and important numeric/object shapes in the schema", () => {
    const schema = buildMonoAgentConfigSchema() as SchemaNode;

    expect(schema.required).toEqual(["runtime", "context"]);
    expect(schemaNode(schema, "runtime").required).toEqual(["model"]);
    expect(schemaNode(schema, "context").required).toEqual(["identityPath"]);
    expect(schemaNode(schema, "concurrency", "maxConcurrentRuns").type).toBe("integer");
    expect(schemaNode(schema, "concurrency", "maxPendingRuns").type).toBe("integer");
    expect(schemaNode(schema, "memory", "embeddings", "circuitBreaker", "failureThreshold").type).toBe("integer");
    expect(schemaNode(schema, "cron", "jobs").items?.required).toEqual(["id", "expression", "prompt"]);
    expect(schemaNode(schema, "webhook", "endpoints").items?.required).toEqual(["path"]);
    expect(schemaNode(schema, "webhook", "endpoints").items?.properties?.maxRunMs).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 86_400_000,
    });
    expect(schemaNode(schema, "agent", "name")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    });
    expect(schemaNode(schema, "runtime", "fallbacks").items?.required).toEqual(["model"]);
    expect(schemaNode(schema, "runtime", "fallbacks").items?.properties?.effort?.enum)
      .toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(schemaNode(schema, "runtime", "routeSafety").enum).toEqual(["uniform", "per-route-native"]);
    expect(schemaNode(schema, "runtime", "compaction", "enabled")).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(schemaNode(schema, "runtime", "compaction", "triggerRatio")).toMatchObject({
      type: "number",
      default: 0.7,
      minimum: 0.2,
      maximum: 0.95,
    });
    expect(schemaNode(schema, "runtime", "compaction", "keepRecentTokens")).toMatchObject({
      type: "integer",
      minimum: 4_000,
      maximum: 200_000,
    });
    expect(schemaNode(schema, "runtime", "compaction", "summaryMaxTokens")).toMatchObject({
      type: "integer",
      minimum: 1_000,
      maximum: 64_000,
    });
    expect(schemaNode(schema, "runtime", "compaction", "minSavingsTokens")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 500_000,
    });
    expect(schemaNode(schema, "runtime", "compaction", "fixedOverheadEnabled")).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(schemaNode(schema, "runtime", "compaction", "contextWindowOverride")).toMatchObject({
      type: "integer",
      minimum: 32_000,
      maximum: 10_000_000,
    });
    expect(schemaNode(schema, "memory", "backend").enum).toEqual(["bujo", "supermemory"]);
    expect(schemaNode(schema, "memory", "mode").enum).toEqual(["lite", "journal", "bujo"]);
    expect(schemaNode(schema, "memory", "writeMode").enum).toEqual(["disabled", "append-host-summary", "capture"]);
    expect(schemaNode(schema, "memory", "embeddings", "provider").enum).toEqual(["ollama", "lmstudio", "openai"]);
    expect(schemaNode(schema, "memory", "llm", "provider").enum).toEqual(["ollama", "agent-host"]);
    expect(schemaNode(schema, "sandbox", "mode").enum).toEqual(["native", "off"]);
    expect(schemaNode(schema, "sandbox", "network", "mode").enum).toEqual(["none", "localhost", "allowlist"]);
    expect(schemaNode(schema, "sandbox", "fallback").enum).toEqual(["fail-closed", "unsafe-host-process"]);
    expect(schemaNode(schema, "providers", "piNative", "transport")).toMatchObject({
      type: "string",
      default: "auto",
      enum: ["auto", "sse", "websocket", "websocket-cached"],
    });
  });

  it("models durable continuations as a strict fixed-port host-owned block", () => {
    const schema = buildMonoAgentConfigSchema() as SchemaNode;
    const continuations = schemaNode(schema, "continuations");
    const port = schemaNode(continuations, "port");
    const routes = schemaNode(continuations, "namedRoutes") as SchemaNode & {
      readonly additionalProperties?: SchemaNode;
    };
    const detached = schemaNode(continuations, "detachedServices");

    expect((continuations as SchemaNode & { readonly additionalProperties?: boolean }).additionalProperties).toBe(false);
    expect(schemaNode(continuations, "host").enum).toEqual(["127.0.0.1", "::1", "localhost"]);
    expect(port).toMatchObject({ type: "integer", minimum: 1, maximum: 65_535, default: 4319 });
    expect(routes.additionalProperties?.oneOf).toHaveLength(3);
    expect(routes.additionalProperties?.oneOf?.[0]?.required).toEqual(["mode", "conversationId"]);
    expect(routes.additionalProperties?.oneOf?.[1]?.required).toEqual(["mode", "conversationId"]);
    expect(routes.additionalProperties?.oneOf?.[2]?.required).toEqual(["mode"]);
    expect(detached.items?.required).toEqual(["name", "tokenEnv"]);
  });

  it("models the strict built-in memory tier prerequisites and incompatibilities", () => {
    const schema = buildMonoAgentConfigSchema() as SchemaNode;
    const memory = schemaNode(schema, "memory");
    const lite = memoryTierRule(memory, "lite");
    const journal = memoryTierRule(memory, "journal");
    const bujo = memoryTierRule(memory, "bujo");

    expect(lite.if?.required).toBeUndefined();
    expect(rejectedMemoryProperties(lite)).toEqual(["embeddings", "llm", "consolidation", "capture"]);

    expect(journal.then?.required).toEqual(["embeddings"]);
    expect(journal.then?.properties?.embeddings?.minProperties).toBe(1);
    expect(rejectedMemoryProperties(journal)).toEqual(["llm", "consolidation", "capture"]);

    expect(bujo.then?.required).toEqual(["embeddings", "llm"]);
    expect(bujo.then?.properties?.embeddings?.minProperties).toBe(1);
    expect(bujo.then?.properties?.llm?.required).toEqual(["model"]);

    const capture = memory.allOf?.find((rule) => rule.if?.properties?.writeMode?.const === "capture");
    expect(capture?.if?.required).toEqual(["writeMode"]);
    expect(capture?.then).toMatchObject({
      required: ["mode"],
      properties: { mode: { const: "bujo" } },
    });
  });

  it("shares the runtime memory defaults with the schema and generated reference registry", () => {
    const fields = new Map(allConfigReferenceFields().map((field) => [field.jsonPath, field]));
    expect(fields.get("memory.mode")?.defaultValue).toBe("lite");
    expect(fields.get("memory.writeMode")?.defaultValue).toBe("disabled");
    expect(fields.get("memory.recallTool.enabled")?.defaultValue).toBe(true);

    const schema = buildMonoAgentConfigSchema() as SchemaNode;
    expect(schemaNode(schema, "memory", "mode").default).toBe("lite");
    expect(schemaNode(schema, "memory", "writeMode").default).toBe("disabled");
    expect(schemaNode(schema, "memory", "recallTool", "enabled").default).toBe(true);
  });

  it("uses loader-valid examples for generated complex fields", () => {
    const cronJobs = allConfigReferenceFields().find((field) => field.jsonPath === "cron.jobs");
    expect(cronJobs?.example).toEqual([
      { id: "daily", expression: "0 8 * * *", prompt: "Summarize the overnight queue." },
    ]);

    const webhookEndpoints = allConfigReferenceFields().find((field) => field.jsonPath === "webhook.endpoints");
    expect(webhookEndpoints?.example).toEqual([
      { name: "triage", path: "/webhook/triage", prompt: "Triage this payload." },
    ]);

    const slackShortcuts = allConfigReferenceFields().find((field) => field.jsonPath === "slack.shortcuts");
    expect(slackShortcuts?.example).toEqual([
      { callbackId: "triage", prompt: "Prepare the daily support triage checklist.", channelId: "C0123" },
    ]);

    const slackHomeTab = allConfigReferenceFields().find((field) => field.jsonPath === "slack.homeTab");
    expect(slackHomeTab?.example).toEqual({
      enabled: true,
      headerText: "*Quick actions*",
      buttons: [
        { actionId: "triage", label: "Triage", prompt: "Triage today's requests.", channelId: "C0123" },
      ],
    });
  });

  it("does not advertise unsupported env-reference syntax for the webhook API key", () => {
    const webhookApiKey = allConfigReferenceFields().find(
      (field) => field.jsonPath === "webhook.apiKey",
    );
    expect(webhookApiKey?.example).toBe("set-via-MONO_AGENT_WEBHOOK_API_KEY");
    expect(String(webhookApiKey?.example)).not.toMatch(/^env:/u);

    const schema = buildMonoAgentConfigSchema() as SchemaNode;
    expect(schemaNode(schema, "webhook", "apiKey").examples).toEqual([
      "set-via-MONO_AGENT_WEBHOOK_API_KEY",
    ]);
  });

  it("keeps JSON-only Slack interaction config discoverable across canonical and consumer docs", () => {
    const root = repoRoot();
    const fields = allConfigReferenceFields().filter(
      (field) => field.jsonPath === "slack.shortcuts" || field.jsonPath === "slack.homeTab",
    );
    expect(fields.map((field) => [field.jsonPath, field.env])).toEqual([
      ["slack.shortcuts", "--"],
      ["slack.homeTab", "--"],
    ]);

    const surfaces = [
      "docs/channels/slack.md",
      "docs/reference/feature-registry.md",
      "docs/reference/feature-matrix.md",
      "packages/slack-adapter/README.md",
      "packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md",
      "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
    ];
    for (const surface of surfaces) {
      const contents = readFileSync(join(root, surface), "utf8");
      for (const field of fields) {
        expect(contents, `${surface} must mention ${field.jsonPath}`).toContain(field.jsonPath);
      }
    }
  });

  it("keeps the canonical Slack shortcuts and App Home examples loader-valid", async () => {
    const guide = readFileSync(join(repoRoot(), "docs/channels/slack.md"), "utf8");
    const jsonBlocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
    const loadExample = async (field: "shortcuts" | "homeTab") => {
      const source = jsonBlocks.find((block) => block.includes(`"${field}"`));
      expect(source, `Slack guide must include a JSON example for ${field}`).toBeDefined();
      return loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_BOT_TOKEN: "test-bot-token",
          MONO_AGENT_SLACK_APP_TOKEN: "test-app-token",
        },
        json: JSON.parse(source ?? "{}"),
      });
    };

    const shortcuts = await loadExample("shortcuts");
    expect(shortcuts.shortcuts).toHaveLength(1);

    const homeTab = await loadExample("homeTab");
    expect(homeTab.homeTab).toMatchObject({ enabled: true });
    expect(homeTab.homeTab.buttons).toHaveLength(1);
  });

  it("keeps the committed generated config reference in sync", () => {
    const root = repoRoot();
    const reference = readFileSync(join(root, "docs/config/reference.md"), "utf8");
    expect(reference).toBe(buildGeneratedConfigReferenceMarkdown());
  });
});

function schemaNode(schema: SchemaNode, ...path: readonly string[]): SchemaNode {
  let current = schema;
  for (const segment of path) {
    const next = current.properties?.[segment];
    if (next === undefined) {
      throw new Error(`missing schema node ${path.join(".")}`);
    }
    current = next;
  }
  return current;
}

function jsonSchemaTypeFor(type: ConfigReferenceType): Exclude<ConfigReferenceType, "string[]"> {
  return type === "string[]" ? "array" : type;
}

function memoryTierRule(memory: SchemaNode, mode: string): SchemaNode {
  const rule = memory.allOf?.find((candidate) => candidate.if?.properties?.mode?.const === mode);
  if (rule === undefined) {
    throw new Error(`missing memory tier rule for ${mode}`);
  }
  expect(rule.if?.properties?.backend?.const).toBe("bujo");
  return rule;
}

function rejectedMemoryProperties(rule: SchemaNode): readonly string[] {
  return (rule.then?.not?.anyOf ?? []).map((candidate) => {
    if (candidate.required?.[0] !== undefined && candidate.required[0] !== "writeMode") {
      return candidate.required[0];
    }
    if (candidate.properties?.writeMode?.const === "capture") {
      return "capture";
    }
    throw new Error("unknown rejected memory schema shape");
  });
}
