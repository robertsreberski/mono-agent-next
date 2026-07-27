// SPDX-License-Identifier: MIT
import packageManifest from "../package.json" with { type: "json" };

import {
  assertNpmPackageName,
  normalizeNpmName,
} from "./npm-name.ts";

export const PROJECT_TEMPLATES = ["minimal", "personal", "multi-runtime"] as const;

export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

export interface ProjectIdentityOptions {
  projectName: string;
  displayName?: string;
}

export interface ProjectTemplateOptions extends ProjectIdentityOptions {
  template?: ProjectTemplate;
}

/** Backward-compatible options for callers that explicitly render minimal. */
export type MinimalProjectOptions = ProjectIdentityOptions;

export interface RenderedProjectFile {
  path: string;
  contents: string;
  mode: number;
}

const DEFAULT_VERSION = packageManifest.version;
const CORE_DEPENDENCIES = [
  "@mono-agent/cli",
  "@mono-agent/core",
  "@mono-agent/module-sdk",
] as const;

const TEMPLATE_DEPENDENCIES: Readonly<Record<ProjectTemplate, readonly string[]>> = {
  minimal: ["@mono-agent/channel-webhook", "@mono-agent/runtime-pi"],
  personal: [
    "@mono-agent/channel-openai-api",
    "@mono-agent/channel-operator",
    "@mono-agent/channel-telegram",
    "@mono-agent/channel-webhook",
    "@mono-agent/exporter-otlp",
    "@mono-agent/memory-local",
    "@mono-agent/runtime-pi",
    "@mono-agent/state-local",
    "@mono-agent/trigger-cron",
  ],
  "multi-runtime": [
    "@mono-agent/channel-webhook",
    "@mono-agent/runtime-claude",
    "@mono-agent/runtime-pi",
  ],
};

const TEMPLATE_ENVIRONMENT_NAMES: Readonly<Record<ProjectTemplate, readonly string[]>> = {
  minimal: ["WEBHOOK_API_KEY"],
  personal: [
    "MONO_AGENT_OPENAI_API_KEY",
    "MONO_AGENT_OPERATOR_TOKEN",
    "MONO_AGENT_TELEGRAM_BOT_TOKEN",
    "MONO_AGENT_WEBHOOK_API_KEY",
    "MONO_AGENT_WEBHOOK_SIGNATURE_SECRET",
    "PERSONAL_AGENT_TELEGRAM_CHAT_ID",
  ],
  "multi-runtime": ["CLAUDE_CODE_OAUTH_TOKEN", "WEBHOOK_API_KEY"],
};

export function renderProject(options: ProjectTemplateOptions): readonly RenderedProjectFile[] {
  assertNpmPackageName(options.projectName);
  const template = options.template ?? "minimal";
  if (!isProjectTemplate(template)) throw new TypeError(`Unknown project template: ${String(template)}`);

  const agentId = agentIdFor(options.projectName);
  validateAgentId(agentId, template);
  const displayName = options.displayName ?? defaultDisplayName(agentId, template);
  validateDisplayName(displayName);
  const config = configFor(template, agentId, displayName);

  const files: RenderedProjectFile[] = [
    {
      path: ".env.example",
      contents: `${TEMPLATE_ENVIRONMENT_NAMES[template].map((name) => `${name}=`).join("\n")}\n`,
      mode: 0o600,
    },
    {
      path: ".gitignore",
      contents: gitignore(),
      mode: 0o644,
    },
    {
      path: ".mono-agent/mono-agent.config.schema.json",
      contents: `${JSON.stringify(bootstrapSchema(config, template), null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: "AGENTS.md",
      contents: agentInstructions(displayName, template),
      mode: 0o644,
    },
    {
      path: "README.md",
      contents: projectReadme(displayName, template),
      mode: 0o644,
    },
    {
      path: "mono-agent.config.json",
      contents: `${JSON.stringify(config, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: "package.json",
      contents: `${JSON.stringify(projectManifest(options.projectName, template), null, 2)}\n`,
      mode: 0o644,
    },
  ];

  if (template === "personal") {
    files.push(
      {
        path: ".mcp.json",
        contents: `${JSON.stringify({
          mcpServers: {
            "project-status": {
              type: "stdio",
              command: "node",
              args: ["./tools/project-status-mcp.mjs"],
            },
          },
        }, null, 2)}\n`,
        mode: 0o644,
      },
      { path: "cron/morning-briefing.md", contents: personalCronJob(), mode: 0o644 },
      { path: "skills/.gitkeep", contents: "", mode: 0o644 },
      { path: "tools/project-status-mcp.mjs", contents: projectStatusMcpServer(), mode: 0o644 },
      { path: "webhook/invoke.md", contents: personalWebhookRoute(), mode: 0o644 },
    );
  }

  files.sort((left, right) => compareText(left.path, right.path));
  assertSafeRenderedFiles(files);
  return Object.freeze(files.map((file) => Object.freeze(file)));
}

export function renderMinimalProject(options: MinimalProjectOptions): readonly RenderedProjectFile[] {
  return renderProject({ ...options, template: "minimal" });
}

export function renderPersonalProject(options: ProjectIdentityOptions): readonly RenderedProjectFile[] {
  return renderProject({ ...options, template: "personal" });
}

export function renderMultiRuntimeProject(options: ProjectIdentityOptions): readonly RenderedProjectFile[] {
  return renderProject({ ...options, template: "multi-runtime" });
}

export function isProjectTemplate(value: unknown): value is ProjectTemplate {
  return typeof value === "string" && (PROJECT_TEMPLATES as readonly string[]).includes(value);
}

function projectManifest(projectName: string, template: ProjectTemplate): Record<string, unknown> {
  const packages = [...CORE_DEPENDENCIES, ...TEMPLATE_DEPENDENCIES[template]].sort(compareText);
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    engines: { node: ">=22.19.0" },
    scripts: {
      validate: "mono-agent validate --config ./mono-agent.config.json",
      schema: "mono-agent config schema --config ./mono-agent.config.json --write",
      start: "mono-agent start --config ./mono-agent.config.json",
    },
    dependencies: Object.fromEntries(packages.map((packageName) => [packageName, DEFAULT_VERSION])),
  };
}

function configFor(
  template: ProjectTemplate,
  agentId: string,
  displayName: string,
): Record<string, unknown> {
  if (template === "personal") return personalConfig(agentId, displayName);
  if (template === "multi-runtime") return multiRuntimeConfig(agentId, displayName);
  return minimalConfig(agentId, displayName);
}

function minimalConfig(agentId: string, displayName: string): Record<string, unknown> {
  return {
    $schema: "./.mono-agent/mono-agent.config.schema.json",
    configVersion: 1,
    agent: {
      id: agentId,
      name: displayName,
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: { path: "./.secrets/pi/auth.json" },
      },
    },
    routing: {
      primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
      fallbacks: [],
      effort: "high",
    },
    session: { mode: "continuous" },
    channels: {
      inbound: {
        $use: "@mono-agent/channel-webhook",
        listen: { host: "127.0.0.1", port: 3210 },
        apiKey: env("WEBHOOK_API_KEY"),
      },
    },
    policy: {
      tools: { default: "deny", allow: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    },
  };
}

function multiRuntimeConfig(agentId: string, displayName: string): Record<string, unknown> {
  return {
    $schema: "./.mono-agent/mono-agent.config.schema.json",
    configVersion: 1,
    agent: {
      id: agentId,
      name: displayName,
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: { path: "./.secrets/pi/auth.json" },
      },
      "claude-sdk": {
        $use: "@mono-agent/runtime-claude",
        mode: "sdk",
        auth: {
          method: "oauth-token",
          token: env("CLAUDE_CODE_OAUTH_TOKEN"),
        },
      },
    },
    routing: {
      primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
      fallbacks: [
        { runtime: "claude-sdk", model: "claude-opus-4-8" },
        { runtime: "pi", model: "anthropic:claude-opus-4-8" },
      ],
      effort: "high",
    },
    session: { mode: "continuous" },
    channels: {
      inbound: {
        $use: "@mono-agent/channel-webhook",
        listen: { host: "127.0.0.1", port: 3210 },
        apiKey: env("WEBHOOK_API_KEY"),
      },
    },
    policy: {
      tools: { default: "deny", allow: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    },
  };
}

function personalConfig(agentId: string, displayName: string): Record<string, unknown> {
  return {
    $schema: "./.mono-agent/mono-agent.config.schema.json",
    configVersion: 1,
    agent: {
      id: agentId,
      name: displayName,
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: { path: "./.secrets/pi/auth.json" },
        sessions: { root: "./.mono-agent/sessions" },
        retry: { maxDelayMs: 30_000 },
        localProviders: [{ id: "ollama", baseUrl: "http://127.0.0.1:11434" }],
      },
    },
    routing: {
      primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
      fallbacks: [
        { runtime: "pi", model: "github-copilot:gemini-3.1-pro-preview" },
        { runtime: "pi", model: "github-copilot:gemini-3.5-flash" },
        { runtime: "pi", model: "opencode-go:kimi-k2.7-code" },
        { runtime: "pi", model: "opencode-go:glm-5.2" },
        { runtime: "pi", model: "anthropic:claude-opus-4-8" },
        { runtime: "pi", model: "anthropic:claude-fable-5" },
        { runtime: "pi", model: "opencode-go:kimi-k2.6" },
        { runtime: "pi", model: "opencode-go:glm-5.1" },
        { runtime: "pi", model: "openai-codex:gpt-5.6-terra" },
      ],
      effort: "high",
    },
    session: {
      mode: "continuous",
      idleTimeoutMs: 1_800_000,
      rollover: "daily",
      timezone: "Europe/Rome",
      isolateProactiveRuns: true,
    },
    context: {
      skills: {
        roots: ["./skills"],
        load: "all",
        disclosure: "index",
        maxBytes: 256_000,
      },
      mcp: { configPath: "./.mcp.json" },
    },
    memory: {
      $use: "@mono-agent/memory-local",
      root: "./.mono-agent/memory",
      maxBytes: 96_000,
      capture: {
        enabled: true,
        model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
        timeoutMs: 360_000,
      },
      embeddings: {
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "nomic-embed-text:v1.5",
        dimensions: 768,
      },
      recallTool: { enabled: true },
    },
    state: {
      $use: "@mono-agent/state-local",
      root: "./.mono-agent/state",
      runs: {
        artifactsDirectory: "./.mono-agent/artifacts",
        retentionDays: 30,
      },
      discovery: {
        registryDirectory: "./.mono-agent/trace-sources",
        sourceId: agentId,
        sourceLabel: displayName,
      },
    },
    policy: {
      tools: { default: "allow", deny: [] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    },
    channels: {
      telegram: {
        $use: "@mono-agent/channel-telegram",
        botToken: env("MONO_AGENT_TELEGRAM_BOT_TOKEN"),
        allowedChatIds: [env("PERSONAL_AGENT_TELEGRAM_CHAT_ID")],
        allowAllChats: false,
        defaultDestination: env("PERSONAL_AGENT_TELEGRAM_CHAT_ID"),
        reactions: { working: true, done: false, error: true },
        quietHours: {
          start: "23:00",
          end: "07:00",
          timezone: "Europe/Rome",
        },
        transcription: {
          endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
          model: "large-v3-v20240930",
        },
      },
      webhook: {
        $use: "@mono-agent/channel-webhook",
        listen: { host: "100.64.0.10", port: 4313 },
        allowNonLoopback: true,
        apiKey: env("MONO_AGENT_WEBHOOK_API_KEY"),
        signatureSecret: env("MONO_AGENT_WEBHOOK_SIGNATURE_SECRET"),
        routesDirectory: "./webhook",
        defaultMode: "async",
        retentionMs: 300_000,
        maxStoredRequests: 100,
      },
      "openai-api": {
        $use: "@mono-agent/channel-openai-api",
        listen: { host: "0.0.0.0", port: 4312 },
        allowNonLoopback: true,
        basePath: "/v1",
        apiKey: env("MONO_AGENT_OPENAI_API_KEY"),
        modelId: agentId,
      },
      operator: {
        $use: "@mono-agent/channel-operator",
        listen: { host: "127.0.0.1", port: 0 },
        auth: { token: env("MONO_AGENT_OPERATOR_TOKEN") },
      },
    },
    triggers: {
      cron: {
        $use: "@mono-agent/trigger-cron",
        jobsDirectory: "./cron",
        timezone: "Europe/Rome",
      },
    },
    observability: {
      exporters: {
        phoenix: {
          $use: "@mono-agent/exporter-otlp",
          endpoint: "http://127.0.0.1:6006/v1/traces",
          projectName: agentId,
          includeSensitiveData: false,
        },
      },
    },
  };
}

function bootstrapSchema(config: Record<string, unknown>, template: ProjectTemplate): Record<string, unknown> {
  const schema = schemaForSeed(config, []);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://mono-agent.dev/schemas/${DEFAULT_VERSION}/scaffold-${template}.json`,
    title: `${template} mono-agent bootstrap configuration`,
    $comment: "This validates the generated seed. Run the schema package script after install to compose all selected-module options.",
    ...schema,
    $defs: {
      envReference: {
        type: "object",
        additionalProperties: false,
        required: ["$env"],
        properties: {
          $env: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
        },
      },
    },
  };
}

function schemaForSeed(value: unknown, path: readonly string[]): Record<string, unknown> {
  if (isEnvReference(value)) return { $ref: "#/$defs/envReference" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      ...(value.length === 0 ? {} : { items: schemaForSeed(value[0], [...path, "0"]) }),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      additionalProperties: false,
      required: entries.map(([name]) => name),
      properties: Object.fromEntries(entries.map(([name, child]) => [
        name,
        schemaForSeed(child, [...path, name]),
      ])),
    };
  }
  if (typeof value === "string") {
    const name = path.at(-1);
    if (name === "$use" || name === "$schema") return { type: "string", const: value };
    return { type: "string", minLength: value.length === 0 ? 0 : 1 };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  throw new TypeError(`Cannot derive bootstrap schema for ${typeof value}`);
}

function agentInstructions(displayName: string, template: ProjectTemplate): string {
  const templateInstructions = template === "personal"
    ? [
        "- Treat memory, state, and conversation history as durable operator data; never reset or purge them without explicit authorization.",
        "- Scheduled and proactive work must use the configured channel and destination explicitly.",
      ]
    : template === "multi-runtime"
      ? [
          "- Treat each runtime attempt as isolated; never assume provider-native sessions are portable across runtimes.",
          "- Do not retry a failed turn after a committed side effect unless the operation is proven idempotent.",
        ]
      : ["- Keep changes small and report the evidence used to verify them."];
  return [
    "# Agent instructions",
    "",
    `You are ${displayName}, a focused and reliable assistant.`,
    "",
    "- Work only within the configured workspace and granted tools.",
    "- Ask before taking an action that could destroy, publish, or disclose user data.",
    "- Never print, persist, or summarize credential values.",
    "- Report runtime and tool failures honestly; never invent successful results.",
    ...templateInstructions,
    "",
  ].join("\n");
}

function projectReadme(displayName: string, template: ProjectTemplate): string {
  const templateNotes = template === "personal"
    ? [
        "This template selects Telegram, webhook, OpenAI-compatible API, and operator channels,",
        "owner-private local memory/state, a harmless Markdown cron example, a project-owned",
        "status MCP fixture, one enabled directory-backed webhook route, and a local OTLP exporter.",
        "Replace the example job, route, and tool with your own project behavior after reviewing",
        "their explicit channel, destination, listener, authentication, and tool policies.",
        "TUI, web, service management, and docs MCP remain separately installed products.",
      ]
    : template === "multi-runtime"
      ? [
          "This template routes primarily through Pi and falls back to the native Claude SDK.",
          "The second Pi fallback demonstrates that one model family can use a different runtime path.",
        ]
      : ["This template is the smallest runnable Pi plus loopback-webhook agent."];
  const environmentNames = TEMPLATE_ENVIRONMENT_NAMES[template].map((name) => `- \`${name}\``);
  const sourcePreviewInstall = template === "minimal"
    ? [
        "For this minimal template only, return to the source checkout and follow",
        "`docs/getting-started/install.md` for the explicit post-render source-preview",
        "local-tarball flow without registry packages or a workspace link.",
      ]
    : [
        "This template has no retained local-tarball install recipe during the source preview.",
        "Return to the source checkout and run `pnpm run verify:consumers` to validate",
        "the rendered contract without installing or starting this project.",
      ];

  return [
    `# ${displayName}`,
    "",
    ...templateNotes,
    "",
    "## Configure credentials",
    "",
    "Create `.secrets/pi/auth.json` locally as an owner-private (`0600`) file.",
    "For the default Pi route, add an `openai-codex` credential using the auth-store",
    "shape documented by `@mono-agent/runtime-pi`; the scaffolder never writes a credential file.",
    "",
    "Export these names with real values in the process that starts the agent:",
    "",
    ...environmentNames,
    "",
    "`.env.example` contains names only. Mono-agent resolves only explicit `$env`",
    "references and does not implicitly load that file.",
    "",
    "## Source-preview boundary",
    "",
    "These package versions are not published to npm during the source preview.",
    "Existing registry artifacts under the same names belong to the predecessor repository.",
    "Do not pass `--install` while these generated package pins remain unpublished.",
    "",
    ...sourcePreviewInstall,
    "",
  ].join("\n");
}

function gitignore(): string {
  return [
    ".mono-agent/artifacts/",
    ".env",
    ".secrets/",
    ".mono-agent/memory/",
    ".mono-agent/sessions/",
    ".mono-agent/state/",
    ".mono-agent/trace-sources/",
    "node_modules/",
    "",
  ].join("\n");
}

function personalCronJob(): string {
  return [
    "---",
    "id: morning-briefing",
    "expression: 30 7 * * *",
    "timezone: Europe/Rome",
    "runtime: pi",
    "model: openai-codex:gpt-5.6-sol",
    "effort: high",
    "notify: telegram",
    "overlap: skip",
    "maxRunMs: 600000",
    "---",
    "",
    "Prepare a concise morning briefing from information already available in this workspace.",
    "Do not change files, contact external services, or perform any other side effect.",
    "",
  ].join("\n");
}

function personalWebhookRoute(): string {
  return [
    "---",
    "name: invoke",
    "path: /webhook/invoke",
    "enabled: true",
    "---",
    "",
    "Handle this authenticated project webhook request.",
    "",
  ].join("\n");
}

function projectStatusMcpServer(): string {
  return [
    "let buffer = \"\";",
    "",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (chunk) => {",
    "  buffer += chunk;",
    "  while (buffer.includes(\"\\n\")) {",
    "    const index = buffer.indexOf(\"\\n\");",
    "    const line = buffer.slice(0, index);",
    "    buffer = buffer.slice(index + 1);",
    "    if (line.trim().length === 0) continue;",
    "    const message = JSON.parse(line);",
    "    if (message.id === undefined) continue;",
    "    let result;",
    "    if (message.method === \"initialize\") {",
    "      result = {",
    "        protocolVersion: message.params?.protocolVersion,",
    "        capabilities: { tools: {} },",
    "        serverInfo: { name: \"project-status\", version: \"1.0.0\" },",
    "      };",
    "    } else if (message.method === \"tools/list\") {",
    "      result = {",
    "        tools: [{",
    "          name: \"project_status\",",
    "          description: \"Return the static status of this scaffolded project fixture.\",",
    "          inputSchema: { type: \"object\", properties: {}, additionalProperties: false },",
    "        }],",
    "      };",
    "    } else if (message.method === \"tools/call\" && message.params?.name === \"project_status\") {",
    "      result = {",
    "        content: [{ type: \"text\", text: \"The scaffolded project MCP fixture is available.\" }],",
    "      };",
    "    } else {",
    "      process.stdout.write(JSON.stringify({",
    "        jsonrpc: \"2.0\",",
    "        id: message.id,",
    "        error: { code: -32601, message: \"Unknown MCP method or tool.\" },",
    "      }) + \"\\n\");",
    "      continue;",
    "    }",
    "    process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result }) + \"\\n\");",
    "  }",
    "});",
    "process.stdin.on(\"end\", () => process.exit(0));",
    "",
  ].join("\n");
}

function env(name: string): Readonly<{ $env: string }> {
  return Object.freeze({ $env: name });
}

function isEnvReference(value: unknown): value is Readonly<{ $env: string }> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof Reflect.get(value, "$env") === "string";
}

function assertSafeRenderedFiles(files: readonly RenderedProjectFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.path.length === 0
      || file.path.startsWith("/")
      || file.path.includes("\\")
      || file.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new TypeError(`Unsafe rendered project path: ${JSON.stringify(file.path)}`);
    }
    if (paths.has(file.path)) throw new TypeError(`Duplicate rendered project path: ${file.path}`);
    paths.add(file.path);
    if (file.path === ".env" || file.path.startsWith(".secrets/")) {
      throw new TypeError(`Scaffolder must not render secret-bearing file ${file.path}`);
    }
  }

  const environmentExample = files.find((file) => file.path === ".env.example")?.contents;
  if (environmentExample === undefined) throw new TypeError("Rendered project has no .env.example");
  for (const [index, line] of environmentExample.trimEnd().split("\n").entries()) {
    if (!/^[A-Z_][A-Z0-9_]*=$/u.test(line)) {
      throw new TypeError(`.env.example line ${String(index + 1)} must contain a name and no value`);
    }
  }
}

function validateDisplayName(value: string): void {
  if (value.trim().length === 0
    || value.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("displayName must be 1-128 printable characters");
  }
}

function validateAgentId(value: string, template: ProjectTemplate): void {
  if (template === "personal" && value.length > 128) {
    throw new TypeError("Personal template agent id must be at most 128 characters");
  }
}

function defaultDisplayName(agentId: string, template: ProjectTemplate): string {
  if (template === "personal" && agentId === "personal-agent") return "Personal Agent";
  return titleCase(agentId);
}

function titleCase(value: string): string {
  return value
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function agentIdFor(projectName: string): string {
  return normalizeNpmName(projectName, { stripLeadingAt: true });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
