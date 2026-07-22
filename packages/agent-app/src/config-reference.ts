import type { JsonEnvFieldSpec, SettingsJsonValue } from "@mono-agent/agent-contracts";
import {
  ALLOW_ALL_TOOLS,
  CONFIG_ENV_KEYS,
  EFFORT_LEVELS,
  MEMORY_BACKENDS,
  MEMORY_EMBEDDINGS_PROVIDERS,
  MEMORY_LLM_PROVIDERS,
  MEMORY_MODES,
  MEMORY_WRITE_MODES,
  MonoAgentConfigError,
  ROUTE_SAFETY_MODES,
} from "@mono-agent/config";
import type { ConfigViewFieldId, MonoAgentConfigJson } from "@mono-agent/config";
import {
  PI_TRANSPORTS,
  SANDBOX_FALLBACKS,
  SANDBOX_MODES,
  SANDBOX_NETWORK_MODES,
} from "@mono-agent/runtime-adapter";
import { CRON_CONFIG_FIELDS } from "@mono-agent/cron-adapter";
import { OPENAI_API_CONFIG_FIELDS } from "@mono-agent/openai-api-adapter";
import { TUI_CONFIG_FIELDS } from "@mono-agent/operator-adapter";
import { SLACK_CONFIG_FIELDS } from "@mono-agent/slack-adapter";
import { TELEGRAM_CONFIG_FIELDS } from "@mono-agent/telegram-adapter";
import { WEBHOOK_CONFIG_FIELDS } from "@mono-agent/webhook-adapter";

export const MONO_AGENT_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/robertsreberski/mono-agent/main/packages/agent-app/schema/mono-agent.config.schema.json";

const CORE_FIELDS: readonly ConfigReferenceField[] = Object.entries(CONFIG_ENV_KEYS).map(([jsonPath, env]) =>
  referenceField({
    jsonPath,
    env,
    type: inferType(jsonPath),
    defaultLabel: defaultLabelFor(jsonPath),
    defaultValue: defaultValueFor(jsonPath),
    example: exampleFor(jsonPath),
    description: descriptionFor(jsonPath),
  }),
);

const CHANNEL_FIELD_GROUPS: readonly (readonly JsonEnvFieldSpec[])[] = [
  TELEGRAM_CONFIG_FIELDS,
  SLACK_CONFIG_FIELDS,
  WEBHOOK_CONFIG_FIELDS,
  OPENAI_API_CONFIG_FIELDS,
  CRON_CONFIG_FIELDS,
  TUI_CONFIG_FIELDS,
];

const CHANNEL_FIELDS: readonly ConfigReferenceField[] = CHANNEL_FIELD_GROUPS.flatMap((fields) =>
  fields.map((field) =>
    referenceField({
      jsonPath: field.id,
      env: field.env,
      type: typeFromKind(field.kind, field.id),
      defaultLabel: defaultLabelFor(field.id),
      defaultValue: defaultValueFor(field.id),
      example: exampleFor(field.id),
      description: descriptionFor(field.id),
      secret: field.secret === true,
    }),
  ),
);

const APP_FIELDS: readonly ConfigReferenceField[] = [
  {
    jsonPath: "interaction.bridge.host",
    env: "MONO_AGENT_INTERACTION_BRIDGE_HOST",
    type: "string",
    defaultLabel: "127.0.0.1",
    defaultValue: "127.0.0.1",
    example: "127.0.0.1",
    description: "Bind host for the app-owned AskUser/tool-progress bridge. Defaults to loopback; keep it local because non-loopback values are not rejected.",
  },
  {
    jsonPath: "interaction.bridge.port",
    env: "MONO_AGENT_INTERACTION_BRIDGE_PORT",
    type: "integer",
    defaultLabel: "0",
    defaultValue: 0,
    example: 0,
    description: "Bridge port. 0 chooses an ephemeral port.",
  },
  {
    jsonPath: "interaction.askUser.timeoutMs",
    env: "MONO_AGENT_ASK_USER_TIMEOUT_MS",
    type: "integer",
    defaultLabel: "600000",
    defaultValue: 600_000,
    example: 600_000,
    description: "Maximum wait for one AskUser interaction (one to five questions).",
  },
  {
    jsonPath: "interaction.progress.enabled",
    env: "MONO_AGENT_PROGRESS_ENABLED",
    type: "boolean",
    defaultLabel: "true",
    defaultValue: true,
    example: true,
    description: "Whether tool progress posts are relayed to channel status messages.",
  },
  {
    jsonPath: "continuations.enabled",
    env: "--",
    type: "boolean",
    defaultLabel: "true",
    defaultValue: true,
    example: true,
    description: "Enables the host-owned durable continuation service when the block is configured.",
  },
  {
    jsonPath: "continuations.host",
    env: "--",
    type: "string",
    defaultLabel: "127.0.0.1",
    defaultValue: "127.0.0.1",
    example: "127.0.0.1",
    description: "Loopback bind host; non-loopback values are rejected.",
  },
  {
    jsonPath: "continuations.port",
    env: "--",
    type: "integer",
    defaultLabel: "4319",
    defaultValue: 4319,
    example: 4319,
    description: "Fixed loopback continuation service port (1-65535); persisted result/status URLs and the operator CLI remain valid across restarts.",
  },
  {
    jsonPath: "continuations.stateDir",
    env: "--",
    type: "string",
    defaultLabel: ".mono-agent/continuations",
    defaultValue: ".mono-agent/continuations",
    example: ".mono-agent/continuations",
    description: "Owner-only per-record continuation store and token-derivation secret.",
  },
  {
    jsonPath: "continuations.namedRoutes",
    env: "--",
    type: "object",
    defaultLabel: "{}",
    defaultValue: {},
    example: { verification: { mode: "capture", conversationId: "slack:D123" } },
    description: "Host-owned detached delivery policies: notify_if_actionable, capture, or silent.",
  },
  {
    jsonPath: "continuations.detachedServices",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ name: "work-control", tokenEnv: "WORK_CONTROL_CONTINUATION_TOKEN" }],
    description: "Detached service names and the environment variable holding each bearer; raw tokens never belong in config.",
  },
  {
    jsonPath: "continuations.limits.maxActiveRecords",
    env: "--",
    type: "integer",
    defaultLabel: "10000",
    defaultValue: 10_000,
    example: 10_000,
    description: "Global admission ceiling for non-terminal durable continuations.",
  },
  {
    jsonPath: "continuations.limits.maxActivePerOrigin",
    env: "--",
    type: "integer",
    defaultLabel: "500",
    defaultValue: 500,
    example: 500,
    description: "Admission ceiling for one immutable run or detached-route claim origin.",
  },
  {
    jsonPath: "continuations.limits.maxConcurrent",
    env: "--",
    type: "integer",
    defaultLabel: "16",
    defaultValue: 16,
    example: 16,
    description: "Maximum independently tracked continuation workers; one hung provider cannot occupy the whole service.",
  },
  {
    jsonPath: "continuations.limits.synthesisTimeoutMs",
    env: "--",
    type: "integer",
    defaultLabel: "600000",
    defaultValue: 600_000,
    example: 600_000,
    description: "Hard synthesis timeout; an ambiguous timeout is dead-lettered and never synthesized twice.",
  },
  {
    jsonPath: "continuations.limits.deliveryTimeoutMs",
    env: "--",
    type: "integer",
    defaultLabel: "120000",
    defaultValue: 120_000,
    example: 120_000,
    description: "Hard native-delivery and history-only commit timeout; ambiguous sends are never replayed automatically.",
  },
  {
    jsonPath: "continuations.limits.operatorPageSize",
    env: "--",
    type: "integer",
    defaultLabel: "100",
    defaultValue: 100,
    example: 100,
    description: "Maximum keyset-paginated records returned by one operator list request.",
  },
  {
    jsonPath: "continuations.retention.terminalMaxRecords",
    env: "--",
    type: "integer",
    defaultLabel: "50000",
    defaultValue: 50_000,
    example: 50_000,
    description: "Maximum retained terminal metadata/idempotency tombstones after payload compaction.",
  },
  {
    jsonPath: "continuations.retention.terminalMaxAgeMs",
    env: "--",
    type: "integer",
    defaultLabel: "31536000000",
    defaultValue: 31_536_000_000,
    example: 31_536_000_000,
    description: "Maximum age in milliseconds for terminal continuation tombstones.",
  },
  {
    jsonPath: "continuations.retention.capturedTextMaxRecords",
    env: "--",
    type: "integer",
    defaultLabel: "1000",
    defaultValue: 1_000,
    example: 1_000,
    description: "Maximum delivered capture continuations whose synthesized text remains retrievable.",
  },
  {
    jsonPath: "continuations.retention.capturedTextMaxAgeMs",
    env: "--",
    type: "integer",
    defaultLabel: "2592000000",
    defaultValue: 2_592_000_000,
    example: 2_592_000_000,
    description: "Maximum age in milliseconds for retained captured synthesis text.",
  },
  {
    jsonPath: "channels.plugins",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ package: "@mono-agent/whatsapp-adapter", config: { enabled: true } }],
    description: "External channel plugin envelopes loaded by package name.",
  },
  {
    jsonPath: "cron.jobs",
    env: "MONO_AGENT_CRON_JOBS_JSON",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ id: "daily", expression: "0 8 * * *", prompt: "Summarize the overnight queue." }],
    description: "Inline scheduled jobs. Folder-based cron jobs still merge from cron.dir.",
  },
  {
    jsonPath: "webhook.endpoints",
    env: "MONO_AGENT_WEBHOOK_ENDPOINTS_JSON",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ name: "triage", path: "/webhook/triage", prompt: "Triage this payload." }],
    description: "Named webhook endpoints with per-endpoint prompt, model/effort, and maxRunMs overrides.",
  },
  {
    jsonPath: "slack.shortcuts",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ callbackId: "triage", prompt: "Prepare the daily support triage checklist.", channelId: "C0123" }],
    description: "JSON-only global/message Slack shortcut bindings; there is no environment-variable form.",
  },
  {
    jsonPath: "slack.homeTab",
    env: "--",
    type: "object",
    defaultLabel: "unset",
    example: {
      enabled: true,
      headerText: "*Quick actions*",
      buttons: [{ actionId: "triage", label: "Triage", prompt: "Triage today's requests.", channelId: "C0123" }],
    },
    description: "JSON-only Slack App Home configuration; enabled is optional (default false), buttons is optional (default []), and there is no environment-variable form.",
  },
  {
    jsonPath: "telegram.commands",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ command: "status", prompt: "Report current status." }],
    description: "Telegram command definitions handled by the Telegram adapter.",
  },
  {
    jsonPath: "telegram.reactions",
    env: "MONO_AGENT_TELEGRAM_REACTIONS",
    type: "object",
    defaultLabel: "unset",
    example: { working: true, done: true, error: true },
    description: "Telegram lifecycle reactions. The env override is boolean and toggles all states.",
  },
  {
    jsonPath: "telegram.quietHours",
    env: "--",
    type: "object",
    defaultLabel: "unset",
    example: { timezone: "Europe/Amsterdam", start: "22:00", end: "07:00" },
    description: "Quiet-hours rules for Telegram notifications.",
  },
  {
    jsonPath: "telegram.sendTools.scope",
    env: "--",
    type: "string",
    defaultLabel: "unset",
    example: "producing-conversation",
    description: "Bind Telegram send tools to the chat that produced the current run.",
  },
  {
    jsonPath: "telegram.sendTools.pathScope",
    env: "--",
    type: "string",
    defaultLabel: "unset",
    example: "run-output",
    description: "Confine Telegram path uploads to the current run output directory.",
  },
];

export interface ConfigReferenceField {
  readonly jsonPath: string;
  readonly env: string;
  readonly type: ConfigReferenceType;
  readonly defaultLabel: string;
  readonly defaultValue?: SettingsJsonValue;
  readonly example: SettingsJsonValue;
  readonly description: string;
  readonly secret?: boolean;
}

export type ConfigReferenceType = "string" | "number" | "integer" | "boolean" | "string[]" | "object" | "array";

interface JsonSchema {
  readonly [key: string]: unknown;
}

function referenceField(input: Omit<ConfigReferenceField, "defaultValue" | "secret"> & {
  readonly defaultValue?: SettingsJsonValue | undefined;
  readonly secret?: boolean | undefined;
}): ConfigReferenceField {
  return {
    jsonPath: input.jsonPath,
    env: input.env,
    type: input.type,
    defaultLabel: input.defaultLabel,
    example: input.example,
    description: input.description,
    ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
    ...(input.secret === true ? { secret: true } : {}),
  };
}

export function monoAgentConfigWithSchema(config: MonoAgentConfigJson): MonoAgentConfigJson {
  return { $schema: MONO_AGENT_CONFIG_SCHEMA_URL, ...config } as MonoAgentConfigJson;
}

export function allConfigReferenceFields(): readonly ConfigReferenceField[] {
  return [...CORE_FIELDS, ...APP_FIELDS, ...CHANNEL_FIELDS];
}

export function buildMonoAgentConfigSchema(): JsonSchema {
  const root: Record<string, JsonSchema> = {};
  for (const field of allConfigReferenceFields()) {
    setSchemaPath(root, field.jsonPath.split("."), schemaForField(field));
  }
  setRequired(root, ["runtime"], ["model"]);
  setRequired(root, ["context"], ["identityPath"]);
  setMemoryTierSchema(root);
  setContinuationSchema(root);
  setStructuredAppSchemas(root);
  setRemovedConfigSchemas(root);
  setSchemaPath(root, ["channels", "plugins"], {
    type: "array",
    description: "External channel plugins loaded by package name.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["package"],
      properties: {
        package: { type: "string", description: "Package name exporting createChannelDriver(options)." },
        id: { type: "string", description: "Optional channel id override." },
        label: { type: "string", description: "Optional operator-facing label." },
        config: { type: "object", description: "Plugin-owned config payload.", additionalProperties: true },
      },
    },
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MONO_AGENT_CONFIG_SCHEMA_URL,
    title: "mono-agent.config.json",
    type: "object",
    required: ["runtime", "context"],
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      ...root,
    },
  };
}

/**
 * Complex app-owned config is modeled here instead of left as an open object.
 * This keeps editor completion, generated docs, and the runtime unknown-key
 * check on the same schema. Only plugin-owned payloads and explicitly
 * extensible capability/pricing/header maps remain open.
 */
function setStructuredAppSchemas(root: Record<string, JsonSchema>): void {
  setSchemaPath(root, ["observability", "exporters"], {
    type: "array",
    maxItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "phoenix" },
        endpoint: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
        includeSensitiveData: { type: "boolean" },
        contentPatternRedaction: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
        projectName: { type: "string", minLength: 1 },
      },
    },
  });
  setSchemaPath(root, ["providers", "local"], {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { enum: ["ollama", "lmstudio", "openai_compat"] },
        baseUrl: { type: "string" },
        enabled: { type: "boolean" },
        trustPublicUrl: { type: "boolean" },
        apiKey: { type: "string" },
        apiKeyEnv: { type: "string" },
        models: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1 },
              alias: { type: "string", minLength: 1 },
              displayName: { type: "string", minLength: 1 },
              enabled: { type: "boolean" },
              capabilities: { type: "object", additionalProperties: true },
              pricing: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  });
  setSchemaPath(root, ["cron", "jobs"], {
    type: "array",
    items: cronJobSchema(),
  });
  setSchemaPath(root, ["webhook", "endpoints"], {
    type: "array",
    items: webhookEndpointSchema(),
  });
  setSchemaPath(root, ["slack", "shortcuts"], {
    type: "array",
    items: slackActionSchema("callbackId", false),
  });
  setSchemaPath(root, ["slack", "homeTab"], {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      headerText: { type: "string", minLength: 1 },
      buttons: {
        type: "array",
        items: slackActionSchema("actionId", true),
      },
    },
  });
  setSchemaPath(root, ["telegram", "commands"], {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["command", "description"],
      properties: {
        command: { type: "string", pattern: "^[a-z0-9_]{1,32}$" },
        description: { type: "string", minLength: 1, maxLength: 256 },
        prompt: { type: "string", minLength: 1 },
      },
    },
  });
  setSchemaPath(root, ["telegram", "reactions"], {
    oneOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          working: { type: "boolean" },
          done: { type: "boolean" },
          error: { type: "boolean" },
        },
      },
    ],
  });
  setSchemaPath(root, ["telegram", "quietHours"], {
    type: "object",
    additionalProperties: false,
    required: ["start", "end", "timezone"],
    properties: {
      start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      timezone: { type: "string", minLength: 1 },
    },
  });
}

function cronJobSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "expression", "prompt"],
    properties: {
      id: { type: "string", minLength: 1 },
      enabled: { type: "boolean" },
      expression: { type: "string", minLength: 1 },
      timezone: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      conversationId: { type: "string", minLength: 1 },
      maxRunMs: { type: "integer", minimum: 1 },
      notify: { type: "boolean" },
      notifyConversationId: { type: "string", minLength: 1 },
      notifyFailureCooldownHours: { type: "integer", minimum: 1 },
      model: { type: "string", minLength: 1 },
      effort: { type: "string", minLength: 1 },
    },
  };
}

function webhookEndpointSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      name: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      mode: { enum: ["sync", "async"] },
      enabled: { type: "boolean" },
      prompt: { type: "string", minLength: 1 },
      notify: { type: "boolean" },
      notifyConversationId: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      effort: { type: "string", minLength: 1 },
      maxRunMs: { type: "integer", minimum: 0, maximum: 86_400_000 },
    },
  };
}

function slackActionSchema(idKey: "callbackId" | "actionId", requireLabel: boolean): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [idKey, ...(requireLabel ? ["label"] : []), "prompt"],
    properties: {
      [idKey]: { type: "string", minLength: 1 },
      ...(requireLabel ? { label: { type: "string", minLength: 1 } } : {}),
      prompt: { type: "string", minLength: 1 },
      channelId: { type: "string", minLength: 1 },
      ackText: { type: "string", minLength: 1 },
      threadReply: { type: "boolean" },
    },
  };
}

function setRemovedConfigSchemas(root: Record<string, JsonSchema>): void {
  for (const key of ["reflection", "migration"] as const) {
    setSchemaPath(root, ["memory", key], {
      type: "object",
      deprecated: true,
      additionalProperties: true,
      description: `Removed memory.${key} settings are tolerated only to emit a migration warning.`,
    });
  }
}

function setContinuationSchema(root: Record<string, JsonSchema>): void {
  root.continuations = {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        default: true,
        description: "Enable the durable continuation service when continuation functionality is configured.",
      },
      host: {
        type: "string",
        enum: ["127.0.0.1", "::1", "localhost"],
        default: "127.0.0.1",
        description: "Loopback-only continuation service host.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65_535,
        default: 4319,
        description: "Fixed continuation service port; 0 is intentionally invalid.",
      },
      stateDir: {
        type: "string",
        minLength: 1,
        default: ".mono-agent/continuations",
        description: "Owner-only durable continuation state directory.",
      },
      namedRoutes: {
        type: "object",
        default: {},
        propertyNames: { minLength: 1, maxLength: 128 },
        additionalProperties: {
          oneOf: [
            continuationDestinationRouteSchema("notify_if_actionable"),
            continuationDestinationRouteSchema("capture"),
            {
              type: "object",
              additionalProperties: false,
              required: ["mode"],
              properties: { mode: { const: "silent" } },
            },
          ],
        },
      },
      detachedServices: {
        type: "array",
        default: [],
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "tokenEnv"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            tokenEnv: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          },
        },
      },
      limits: {
        type: "object",
        additionalProperties: false,
        default: {},
        properties: {
          maxActiveRecords: { type: "integer", minimum: 1, maximum: 1_000_000, default: 10_000 },
          maxActivePerOrigin: { type: "integer", minimum: 1, maximum: 1_000_000, default: 500 },
          maxConcurrent: { type: "integer", minimum: 1, maximum: 256, default: 16 },
          synthesisTimeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000, default: 600_000 },
          deliveryTimeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000, default: 120_000 },
          operatorPageSize: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
      },
      retention: {
        type: "object",
        additionalProperties: false,
        default: {},
        properties: {
          terminalMaxRecords: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 50_000 },
          terminalMaxAgeMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 31_536_000_000 },
          capturedTextMaxRecords: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 1_000 },
          capturedTextMaxAgeMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 2_592_000_000 },
        },
      },
    },
  };
}

function continuationDestinationRouteSchema(mode: "notify_if_actionable" | "capture"): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["mode", "conversationId"],
    properties: {
      mode: { const: mode },
      conversationId: { type: "string", minLength: 1 },
    },
  };
}

function setMemoryTierSchema(root: Record<string, JsonSchema>): void {
  const memory = schemaAt(root, ["memory"]);
  if (memory === undefined) {
    return;
  }
  // An omitted backend means the built-in BuJo store, so these conditions
  // intentionally do not require `backend`. Explicit external backends bypass
  // the tier matrix because they own extraction and capture server-side.
  (memory as Record<string, unknown>).allOf = [
    memoryTierRule("lite", {
      not: {
        anyOf: [
          propertyPresentSchema("embeddings"),
          propertyPresentSchema("llm"),
          propertyPresentSchema("consolidation"),
          captureWriteModeSchema(),
        ],
      },
    }),
    memoryTierRule("journal", {
      required: ["embeddings"],
      properties: {
        embeddings: { type: "object", minProperties: 1 },
      },
      not: {
        anyOf: [
          propertyPresentSchema("llm"),
          propertyPresentSchema("consolidation"),
          captureWriteModeSchema(),
        ],
      },
    }),
    memoryTierRule("bujo", {
      required: ["embeddings", "llm"],
      properties: {
        embeddings: { type: "object", minProperties: 1 },
        llm: {
          type: "object",
          properties: { model: {} },
          required: ["model"],
        },
      },
    }),
    {
      if: {
        properties: {
          backend: { const: "bujo" },
          writeMode: { const: "capture" },
        },
        required: ["writeMode"],
      },
      then: {
        properties: { mode: { const: "bujo" } },
        required: ["mode"],
      },
    },
  ];
}

function memoryTierRule(mode: "lite" | "journal" | "bujo", then: JsonSchema): JsonSchema {
  return {
    if: {
      properties: {
        backend: { const: "bujo" },
        mode: { const: mode },
      },
      ...(mode === "lite" ? {} : { required: ["mode"] }),
    },
    then,
  };
}

function captureWriteModeSchema(): JsonSchema {
  return {
    properties: { writeMode: { const: "capture" } },
    required: ["writeMode"],
  };
}

function propertyPresentSchema(property: string): JsonSchema {
  return {
    properties: { [property]: {} },
    required: [property],
  };
}

export function buildGeneratedConfigReferenceMarkdown(): string {
  const rows = allConfigReferenceFields()
    .slice()
    .sort((a, b) => a.jsonPath.localeCompare(b.jsonPath))
    .map((field) => `| \`${field.jsonPath}\` | \`${field.type}\` | \`${field.env}\` | ${escapeCell(field.defaultLabel)} | \`${jsonInline(field.example)}\` | ${escapeCell(field.description)} |`)
    .join("\n");
  return `---
title: "Generated config reference"
description: "Complete generated reference for mono-agent.config.json fields, environment overrides, defaults, examples, and plugin-channel envelopes."
sidebar:
  order: 4
---

This page is generated from the same config field registries that power \`mono-agent config\`, recipe output, and the JSON Schema. Do not edit this table by hand; run \`pnpm run generate:config-reference\`.

Schema: \`${MONO_AGENT_CONFIG_SCHEMA_URL}\`

| JSON key | Type | Env override | Default | Example | Notes |
| --- | --- | --- | --- | --- | --- |
${rows}

## Plugin channels

\`channels.plugins[]\` entries are intentionally open at \`config\`: the plugin package owns that nested payload. The host validates the plugin envelope (\`package\`, optional \`id\`, optional \`label\`, and \`config\`) and each loaded plugin reports its own config warnings.
`;
}

/** Return raw JSON paths that the generated schema would reject as unknown. */
export function findUnknownAppConfigPaths(json: object): readonly string[] {
  return [...unknownPathsForSchema(json, buildMonoAgentConfigSchema(), "")].sort();
}

/** Fail before config values are flattened so misspelled settings cannot be ignored. */
export function assertKnownAppConfigKeys(json: object): void {
  const paths = findUnknownAppConfigPaths(json);
  if (paths.length === 0) {
    return;
  }
  const message = `mono-agent.config.json contains unknown ${paths.length === 1 ? "key" : "keys"}: ${paths.join(", ")}. Remove or correct ${paths.length === 1 ? "it" : "them"}; unknown keys are not ignored.`;
  throw new MonoAgentConfigError("invalid_json", message, {
    path: paths[0],
    paths,
    reason: message,
  });
}

function unknownPathsForSchema(value: unknown, schema: JsonSchema, path: string): ReadonlySet<string> {
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf.filter(isPlainObject) : [];
  if (alternatives.length > 0) {
    const results = alternatives.map((candidate) => unknownPathsForSchema(value, candidate, path));
    if (results.length === 0) {
      return new Set();
    }
    return new Set([...results[0]!].filter((entry) => results.every((result) => result.has(entry))));
  }

  if (Array.isArray(value)) {
    const items = isPlainObject(schema.items) ? schema.items : undefined;
    if (items === undefined) {
      return new Set();
    }
    const paths = new Set<string>();
    value.forEach((entry, index) => {
      addAll(paths, unknownPathsForSchema(entry, items, `${path}[${index}]`));
    });
    return paths;
  }
  if (!isPlainObject(value)) {
    return new Set();
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const additional = schema.additionalProperties;
  const paths = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path.length === 0 ? key : `${path}.${key}`;
    const propertySchema = properties[key];
    if (isPlainObject(propertySchema)) {
      addAll(paths, unknownPathsForSchema(entry, propertySchema, entryPath));
    } else if (additional === false) {
      paths.add(entryPath);
    } else if (isPlainObject(additional)) {
      addAll(paths, unknownPathsForSchema(entry, additional, entryPath));
    }
  }
  return paths;
}

function addAll(target: Set<string>, source: ReadonlySet<string>): void {
  for (const value of source) {
    target.add(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setSchemaPath(root: Record<string, JsonSchema>, parts: readonly string[], schema: JsonSchema): void {
  const [head, ...tail] = parts;
  if (head === undefined) {
    return;
  }
  if (tail.length === 0) {
    root[head] = schema;
    return;
  }
  const existing = root[head];
  const objectSchema = isSchemaObject(existing) ? existing : { type: "object", additionalProperties: false, properties: {} };
  const properties = objectSchema.properties as Record<string, JsonSchema>;
  setSchemaPath(properties, tail, schema);
  root[head] = objectSchema;
}

function setRequired(root: Record<string, JsonSchema>, parts: readonly string[], required: readonly string[]): void {
  const schema = schemaAt(root, parts);
  if (schema !== undefined) {
    (schema as Record<string, unknown>).required = required;
  }
}

function schemaAt(root: Record<string, JsonSchema>, parts: readonly string[]): JsonSchema | undefined {
  const [head, ...tail] = parts;
  if (head === undefined) {
    return undefined;
  }
  const schema = root[head];
  if (schema === undefined || tail.length === 0) {
    return schema;
  }
  if (!isSchemaObject(schema)) {
    return undefined;
  }
  return schemaAt(schema.properties, tail);
}

function isSchemaObject(value: unknown): value is JsonSchema & { properties: Record<string, JsonSchema> } {
  return isPlainObject(value) && isPlainObject(value.properties);
}

export function schemaForField(field: ConfigReferenceField): JsonSchema {
  const schema: Record<string, unknown> = {
    description: field.description,
    examples: [field.example],
  };
  switch (field.type) {
    case "number":
      schema.type = "number";
      break;
    case "integer":
      schema.type = "integer";
      break;
    case "boolean":
      schema.type = "boolean";
      break;
    case "string[]":
      schema.type = "array";
      schema.items = { type: "string" };
      break;
    case "array":
      schema.type = "array";
      schema.items = arrayItemSchemaForField(field);
      break;
    case "object":
      schema.type = "object";
      schema.additionalProperties = true;
      break;
    case "string":
    default:
      schema.type = "string";
      break;
  }
  if (field.defaultValue !== undefined) {
    schema.default = field.defaultValue;
  }
  if (field.jsonPath === "agent.name") {
    schema.minLength = 1;
    schema.maxLength = 80;
    schema.pattern = "^[^\\u0000-\\u001f\\u007f]+$";
  } else if (field.jsonPath === "runtime.effort") {
    schema.enum = EFFORT_LEVELS;
  } else if (field.jsonPath === "runtime.routeSafety") {
    schema.enum = ROUTE_SAFETY_MODES;
  } else if (field.jsonPath === "memory.backend") {
    schema.enum = MEMORY_BACKENDS;
  } else if (field.jsonPath === "memory.mode") {
    schema.enum = MEMORY_MODES;
  } else if (field.jsonPath === "memory.writeMode") {
    schema.enum = MEMORY_WRITE_MODES;
  } else if (field.jsonPath === "memory.embeddings.provider") {
    schema.enum = MEMORY_EMBEDDINGS_PROVIDERS;
  } else if (field.jsonPath === "memory.llm.provider") {
    schema.enum = MEMORY_LLM_PROVIDERS;
  } else if (field.jsonPath === "sandbox.mode") {
    schema.enum = SANDBOX_MODES;
  } else if (field.jsonPath === "sandbox.network.mode") {
    // SRT 0.0.64 cannot enforce `all`; deliberate unrestricted execution is
    // represented by sandbox.mode=off rather than a pretend sandbox policy.
    schema.enum = SANDBOX_NETWORK_MODES.filter((mode) => mode !== "all");
  } else if (field.jsonPath === "sandbox.fallback") {
    schema.enum = SANDBOX_FALLBACKS;
  } else if (field.jsonPath === "providers.piNative.transport") {
    schema.enum = PI_TRANSPORTS;
  } else if (field.jsonPath === "telegram.sendTools.scope") {
    schema.enum = ["producing-conversation"];
  } else if (field.jsonPath === "telegram.sendTools.pathScope") {
    schema.enum = ["run-output"];
  }
  const numericBounds: Record<string, { readonly minimum: number; readonly maximum: number }> = {
    "runtime.compaction.triggerRatio": { minimum: 0.2, maximum: 0.95 },
    "runtime.compaction.keepRecentTokens": { minimum: 4_000, maximum: 200_000 },
    "runtime.compaction.summaryMaxTokens": { minimum: 1_000, maximum: 64_000 },
    "runtime.compaction.minSavingsTokens": { minimum: 0, maximum: 500_000 },
    "runtime.compaction.contextWindowOverride": { minimum: 32_000, maximum: 10_000_000 },
  };
  const bounds = numericBounds[field.jsonPath];
  if (bounds !== undefined) {
    schema.minimum = bounds.minimum;
    schema.maximum = bounds.maximum;
  }
  if (field.jsonPath === "tools.mcpRequestContextServers") {
    schema.uniqueItems = true;
    schema.items = { type: "string", minLength: 1 };
  }
  return schema;
}

function arrayItemSchemaForField(field: ConfigReferenceField): JsonSchema {
  if (field.jsonPath === "runtime.fallbacks") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: {
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: EFFORT_LEVELS },
      },
    };
  }
  if (field.jsonPath === "cron.jobs") {
    return {
      type: "object",
      additionalProperties: true,
      required: ["id", "expression", "prompt"],
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        expression: { type: "string" },
        timezone: { type: "string" },
        prompt: { type: "string" },
        conversationId: { type: "string" },
        maxRunMs: { type: "integer" },
        notify: { type: "boolean" },
        notifyConversationId: { type: "string" },
        notifyFailureCooldownHours: { type: "integer" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    };
  }
  if (field.jsonPath === "webhook.endpoints") {
    return {
      type: "object",
      additionalProperties: true,
      required: ["path"],
      properties: {
        name: { type: "string" },
        path: { type: "string" },
        mode: { enum: ["sync", "async"] },
        enabled: { type: "boolean" },
        prompt: { type: "string" },
        notify: { type: "boolean" },
        notifyConversationId: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        maxRunMs: { type: "integer", minimum: 0, maximum: 86_400_000 },
      },
    };
  }
  return { type: "object", additionalProperties: true };
}

function typeFromKind(kind: JsonEnvFieldSpec["kind"], id: string): ConfigReferenceType {
  if (kind === "boolean") {
    return "boolean";
  }
  if (kind === "integer") {
    return "integer";
  }
  if (kind === "csv") {
    return "string[]";
  }
  return inferType(id);
}

function inferType(id: string): ConfigReferenceType {
  if (id === "runtime.fallbacks") {
    return "array";
  }
  if (id === "providers.piNative.transport") {
    return "string";
  }
  if (id === "runtime.compaction.triggerRatio") {
    return "number";
  }
  if ([
    "runtime.compaction.keepRecentTokens",
    "runtime.compaction.summaryMaxTokens",
    "runtime.compaction.minSavingsTokens",
    "runtime.compaction.contextWindowOverride",
  ].includes(id)) {
    return "integer";
  }
  if (id === "runtime.compaction.fixedOverheadEnabled") {
    return "boolean";
  }
  if (id.endsWith("Models") || id.endsWith("Tools") || id.endsWith("Servers") || id.endsWith("Roots") || id.endsWith("allowlist") || id.endsWith("denyWrite") || id.endsWith("selectedSkills") || id.endsWith("Ids") || id.endsWith("Aliases")) {
    return "string[]";
  }
  if (id.endsWith("enabled") || id.endsWith("allowAllChats") || id.endsWith("allowAllChannels") || id.endsWith("allowNonLoopback") || id.endsWith("dryRun") || id.endsWith("globalDiscovery") || id.endsWith("rolloverNotice") || id.endsWith("isolateProactive") || id.endsWith("unsafeAllowHostProcess") || id.endsWith("trace") || id.endsWith("exposeMcpServer")) {
    return "boolean";
  }
  if (/(Ms|Bytes|Count|Days|Turns|Retries|Delay|port|dim|threshold|Hours|Runs)$/iu.test(id) || id.endsWith(".port")) {
    return "integer";
  }
  if (id === "providers.local" || id === "observability.exporters") {
    return "array";
  }
  return "string";
}

function defaultLabelFor(id: string): string {
  if ([
    "runtime.compaction.keepRecentTokens",
    "runtime.compaction.summaryMaxTokens",
    "runtime.compaction.minSavingsTokens",
  ].includes(id)) {
    return "adaptive by model";
  }
  if (id === "runtime.compaction.contextWindowOverride") {
    return "auto-detected";
  }
  if (id === "slack.stripMentionText") {
    return "conditional";
  }
  const value = defaultValueFor(id);
  if (value !== undefined) {
    return jsonInline(value);
  }
  if (id === "runtime.model" || id === "context.identityPath") {
    return "required";
  }
  return "unset";
}

function defaultValueFor(id: string): SettingsJsonValue | undefined {
  const defaults: Record<string, SettingsJsonValue> = {
    "runtime.fallbackModels": [],
    "runtime.fallbacks": [],
    "runtime.routeSafety": "uniform",
    "runtime.compaction.enabled": true,
    "runtime.compaction.triggerRatio": 0.70,
    "runtime.compaction.fixedOverheadEnabled": true,
    "runtime.executionMode": "inferred",
    "runtime.workspace": ".",
    "runtime.session.mode": "continuous",
    "runtime.session.idleTimeoutMs": 1_800_000,
    "runtime.session.rollover": "none",
    "runtime.session.rolloverNotice": false,
    "runtime.session.isolateProactive": false,
    "context.selectedSkills": [],
    "context.skillMaxBytes": 48_000,
    "context.skillDisclosure": "full",
    "memory.backend": "bujo",
    "memory.mode": "lite",
    "memory.maxBytes": 64_000,
    "memory.writeMode": "disabled",
    "memory.supermemory.timeoutMs": 10_000,
    "memory.supermemory.exposeMcpServer": false,
    "memory.embeddings.timeoutMs": 10_000,
    "memory.embeddings.circuitBreaker.failureThreshold": 3,
    "memory.embeddings.circuitBreaker.cooldownMs": 30_000,
    "memory.llm.trace": true,
    "memory.llm.timeoutMs": 60_000,
    "memory.recallTool.enabled": true,
    "memory.consolidation.enabled": true,
    "memory.consolidation.cron": "0 */2 * * *",
    "tools.allowedTools": [ALLOW_ALL_TOOLS],
    "tools.disallowedTools": [],
    "tools.mcpRequestContextServers": [],
    "tools.mcpCallTimeoutMs": 120_000,
    "tools.mcpCallMaxTotalTimeoutMs": 2_700_000,
    "sandbox.network.mode": "none",
    "sandbox.fallback": "fail-closed",
    "sandbox.unsafeAllowHostProcess": false,
    "artifacts.dir": ".mono-agent/artifacts",
    "artifacts.retention.maxAgeDays": 365,
    "artifacts.retention.maxCount": 50_000,
    "artifacts.retention.dryRun": false,
    "artifacts.memoryRetention.maxAgeDays": 7,
    "artifacts.memoryRetention.maxCount": 5_000,
    "artifacts.memoryRetention.dryRun": false,
    "traceability.registryDir": ".mono-agent/trace-sources",
    "traceability.heartbeatMs": 10_000,
    "traceability.staleAfterMs": 30_000,
    "traceability.globalDiscovery": true,
    "providers.piNative.piMaxRetries": 2,
    "providers.piNative.maxRetryDelayMs": 60_000,
    "providers.piNative.transport": "auto",
    "telegram.enabled": false,
    "telegram.allowAllChats": false,
    "slack.enabled": false,
    "slack.allowAllChannels": false,
    "webhook.enabled": false,
    "webhook.host": "127.0.0.1",
    "webhook.port": 0,
    "webhook.path": "/webhook/invoke",
    "webhook.dir": "webhook",
    "webhook.defaultMode": "sync",
    "webhook.retentionMs": 300_000,
    "webhook.maxStoredRequests": 100,
    "cron.enabled": false,
    "cron.dir": "cron",
    "cron.timezone": "UTC",
    "cron.notify": false,
    "cron.notifyFailureCooldownHours": 6,
    "openaiApi.enabled": false,
    "openaiApi.host": "127.0.0.1",
    "openaiApi.port": 0,
    "openaiApi.basePath": "/v1",
    "openaiApi.allowNonLoopback": false,
    "openaiApi.modelId": "agent",
    "tui.enabled": true,
    "tui.host": "127.0.0.1",
    "tui.port": 0,
    "tui.basePath": "/gui",
    "tui.allowNonLoopback": false,
  };
  return defaults[id];
}

function exampleFor(id: string): SettingsJsonValue {
  const examples: Record<string, SettingsJsonValue> = {
    "agent.name": "Research Partner",
    "runtime.model": "codex:gpt-5.6-terra",
    "runtime.fallbackModels": ["pi:ollama:gemma4:31b"],
    "runtime.fallbacks": [
      { model: "codex:gpt-5.6-sol" },
      { model: "pi:openai-codex:gpt-5.6-terra", effort: "high" },
    ],
    "runtime.routeSafety": "per-route-native",
    "runtime.effort": "medium",
    "runtime.permissionMode": "default",
    "runtime.compaction.triggerRatio": 0.70,
    "runtime.compaction.keepRecentTokens": 12_800,
    "runtime.compaction.summaryMaxTokens": 5_120,
    "runtime.compaction.minSavingsTokens": 12_800,
    "runtime.compaction.contextWindowOverride": 128_000,
    "context.identityPath": "./IDENTITY.md",
    "memory.mode": "journal",
    "memory.path": "./.mono-agent/memory",
    "memory.embeddings.provider": "ollama",
    "memory.embeddings.model": "nomic-embed-text:v1.5",
    "memory.llm.provider": "agent-host",
    "memory.llm.model": "pi:openai-codex:gpt-5.6-terra",
    "sandbox.mode": "native",
    "traceability.sourceId": "my-agent",
    "traceability.sourceLabel": "My Agent",
    "tools.mcpRequestContextServers": ["transcribe"],
    "providers.piAuthPath": "~/.pi/agent/auth.json",
    "providers.piNative.transport": "sse",
    "telegram.botToken": "env:MONO_AGENT_TELEGRAM_BOT_TOKEN",
    "slack.botToken": "env:MONO_AGENT_SLACK_BOT_TOKEN",
    "slack.appToken": "env:MONO_AGENT_SLACK_APP_TOKEN",
    "slack.stripMentionText": false,
    "webhook.apiKey": "set-via-MONO_AGENT_WEBHOOK_API_KEY",
    "openaiApi.apiKey": "env:MONO_AGENT_OPENAI_API_KEY",
  };
  if (examples[id] !== undefined) {
    return examples[id];
  }
  if (id.endsWith("enabled") || inferType(id) === "boolean") {
    return true;
  }
  if (inferType(id) === "integer") {
    return defaultValueFor(id) ?? 1;
  }
  if (inferType(id) === "number") {
    return defaultValueFor(id) ?? 0.5;
  }
  if (inferType(id) === "string[]") {
    return id.endsWith("Tools") ? ["Read", "Grep"] : ["example"];
  }
  if (inferType(id) === "array") {
    return [];
  }
  return String(defaultValueFor(id) ?? "example");
}

function descriptionFor(id: string): string {
  const section = id.split(".")[0] ?? "config";
  const name = id.split(".").slice(1).join(".");
  if (id === "slack.stripMentionText") {
    return "When unset, defaults to `true` when `botUserIds` or `mentionTextAliases` is non-empty; otherwise `false`.";
  }
  const compactionDescriptions: Record<string, string> = {
    "runtime.compaction.enabled": "Enables adaptive proactive compaction and one-shot reactive overflow recovery.",
    "runtime.compaction.triggerRatio": "Fraction of the effective model context window used for the proactive trigger, additionally capped by adaptive safety headroom.",
    "runtime.compaction.keepRecentTokens": "Explicit recent-context retention override; omitted derives 10% of the effective context window, clamped to 4,000-20,000 tokens.",
    "runtime.compaction.summaryMaxTokens": "Explicit combined summary-output budget override; omitted derives 4% of the effective context window, clamped to 2,000-12,000 tokens.",
    "runtime.compaction.minSavingsTokens": "Minimum verified token reduction required for proactive compaction; omitted derives 10% of the effective window, clamped to 4,000-20,000. Reactive recovery accepts any positive reduction.",
    "runtime.compaction.fixedOverheadEnabled": "Includes system instructions, tool schemas, and the current user turn in proactive request-size estimates.",
    "runtime.compaction.contextWindowOverride": "Persistent correction for inaccurate provider context-window metadata; learned overflow ceilings may lower it process-locally.",
  };
  if (compactionDescriptions[id] !== undefined) {
    return compactionDescriptions[id];
  }
  if (id === "memory.embeddings.provider") {
    return "Embedding service used by Journal/BuJo memory: ollama, lmstudio, or openai.";
  }
  if (id === "memory.embeddings.endpoint") {
    return "Provider service root. LM Studio uses <root>/v1/embeddings and defaults to http://localhost:1234.";
  }
  if (id === "memory.embeddings.apiKeyEnv") {
    return "Environment-variable name containing an optional provider bearer token; an explicitly declared name must resolve before memory starts.";
  }
  if (id.includes("apiKey") || id.includes("Token")) {
    return `Secret value for ${id}; prefer the env override.`;
  }
  if (id.endsWith("enabled")) {
    return `Enables the ${section} capability.`;
  }
  if (id === "agent.name") {
    return "Public display identity used for trace labels and default A2A metadata; never used in paths or service ids.";
  }
  if (id === "runtime.fallbacks") {
    return "Canonical ordered fallback routes. Omitted per-route effort means that provider's default.";
  }
  if (id === "runtime.fallbackModels") {
    return "Legacy fallback list whose routes inherit runtime.effort. Prefer runtime.fallbacks for new configs.";
  }
  if (id === "runtime.routeSafety") {
    return "Uniform preserves one shared safety contract; per-route-native uses and reports each provider's explicit contract.";
  }
  if (id === "runtime.effort") {
    return "Route-specific effort. Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF. Direct codex:* forwards ultra unchanged. Mono-agent rejects ultra on its Claude SDK route because the pinned SDK public contract ends at max (the SDK JavaScript itself forwards the value). The Claude CLI route passes --effort ultra, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above max only prevents keyword downgrade.";
  }
  if (id === "tools.mcpRequestContextServers") {
    return "Configured stdio MCP server names that receive trusted per-request conversation, run, output-directory, and scoped progress context.";
  }
  if (id === "providers.piNative.transport") {
    return "Preferred Pi provider transport: auto, sse, websocket, or websocket-cached. Providers without multiple transports ignore it.";
  }
  return `Configures ${name.length > 0 ? name : id} for the ${section} section.`;
}

function jsonInline(value: SettingsJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}
