export const PACKAGE_CATEGORIES = [
  "runtime",
  "core",
  "context",
  "execution",
  "observability",
  "evaluation",
  "communication",
  "operator-surface",
  "app",
];

// `publishable: true` packages release in lockstep on the npm-release tag path.
// Within that set, `tier` splits them three ways:
//   - `tier: "plugin"` — optional plugin-tier extras (loaded via `channels.plugins[]`,
//     as request-scoped runtime extensions, or through an explicitly selected
//     plugin backend or companion MCP pairing, living under `extras/`);
//   - `tier: "alias"` — the unscoped `create-mono-agent` npm-init installer whose
//     `create-mono-agent`/`mono-agent` bins scaffold v1 or delegate to `@mono-agent/cli`;
//     carries no responsibility of its own and is exempt from the `@mono-agent/`
//     scope rule in the arch and release checks (the bare `mono-agent` npm name is
//     unavailable — npm blocks it as too similar to an unrelated `monoagent`);
//   - no `tier` — the core app-closure packages.
// All three counts are guarded by scripts/release/__tests__/package-count-drift.test.mjs.
export const packageCatalog = [
  {
    dir: "a2a-adapter",
    name: "@mono-agent/a2a-adapter",
    path: "extras/a2a-adapter",
    category: "communication",
    channelIds: ["a2a"],
    responsibility: "Exposes agent responders over A2A and consumes remote A2A agents through direct discovery.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "agent-app",
    name: "@mono-agent/agent-app",
    category: "app",
    responsibility: "Runs a config-first agent host: loads mono-agent.config.json, owns configured responder/harness/runtime/memory composition, and starts every configured channel and traceability.",
    allowedDependencyCategories: [
      "core",
      "context",
      "runtime",
      "execution",
      "observability",
      "communication",
      "operator-surface",
    ],
    publishable: true,
  },
  {
    dir: "agent-contracts",
    name: "@mono-agent/agent-contracts",
    category: "core",
    responsibility: "Defines shared structural request/response contracts plus adapter-neutral settings JSON, env, safe-bind, and bearer helpers.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "agent-harness",
    name: "@mono-agent/agent-harness",
    category: "execution",
    responsibility: "Composes prompt context, selected skills, runtime, memory, history, tool policy, and observability for one request.",
    allowedDependencyCategories: ["core", "context", "runtime", "observability"],
    publishable: true,
  },
  {
    dir: "agent-orchestrator",
    name: "@mono-agent/agent-orchestrator",
    path: "extras/agent-orchestrator",
    category: "execution",
    responsibility: "Exposes named collaborator responders to an orchestrator runtime through a bounded MCP tool.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "agent-runtime",
    name: "@mono-agent/agent-runtime",
    category: "runtime",
    responsibility: "Provides five runtime bridges (Claude SDK, Claude Code CLI, Codex app-server, OpenCode app-server, Pi SDK); direct OpenCode requires stable CLI >=1.15.0 on PATH.",
    allowedDependencyCategories: ["runtime"],
    publishable: true,
  },
  {
    dir: "channel-webhook",
    name: "@mono-agent/channel-webhook",
    category: "communication",
    channelIds: ["webhook"],
    responsibility: "Serves authenticated HTTP ingress as an explicitly selected typed channel module.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "cli",
    name: "@mono-agent/cli",
    category: "app",
    responsibility: "Provides thin validation, inspection, authoring, and foreground-run frontends over the core public API.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "core",
    name: "@mono-agent/core",
    category: "core",
    responsibility: "Loads strict agent configuration and runs selected typed modules without importing concrete implementations.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "config",
    name: "@mono-agent/config",
    category: "core",
    responsibility: "Loads adapter-neutral runtime, context, memory, tool, and artifact settings.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "cron-adapter",
    name: "@mono-agent/cron-adapter",
    category: "communication",
    channelIds: ["cron"],
    responsibility: "Invokes agent responders from cron schedules with configurable skip, queue, or replace overlap policies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "docs-mcp",
    name: "@mono-agent/docs-mcp",
    path: "extras/docs-mcp",
    category: "context",
    responsibility: "Provides offline hybrid search and guided reading over version-matched mono-agent documentation through MCP.",
    allowedDependencyCategories: [],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "memory",
    name: "@mono-agent/memory",
    category: "context",
    responsibility: "Provides local memory subpaths for the SQLite substrate, embedding search, and Bullet-Journal memory engine.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "memory-supermemory",
    name: "@mono-agent/memory-supermemory",
    path: "extras/memory-supermemory",
    category: "context",
    responsibility: "Provides a MemoryStore over an external Supermemory instance (local OSS binary or hosted cloud) via its REST API: server-side extraction, hybrid recall, awaited completed-turn admission, and legacy best-effort writes.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "module-sdk",
    name: "@mono-agent/module-sdk",
    category: "core",
    responsibility: "Defines the Apache-licensed typed module contracts, schemas, compliance helpers, and bounded host primitives.",
    allowedDependencyCategories: [],
    publishable: true,
    license: "Apache-2.0",
  },
  {
    dir: "operator",
    name: "@mono-agent/operator",
    category: "operator-surface",
    responsibility: "Defines the shared operator protocol, strict client, directory, domain state, action eligibility, and golden fixtures used by every renderer.",
    allowedDependencyCategories: [],
    publishable: true,
    license: "Apache-2.0",
  },
  {
    dir: "create-mono-agent",
    name: "create-mono-agent",
    category: "app",
    responsibility: "Transactionally scaffolds the exact minimal v1 dependency closure and delegates non-init commands to @mono-agent/cli.",
    allowedDependencyCategories: ["app"],
    publishable: true,
    tier: "alias",
  },
  {
    dir: "observability",
    name: "@mono-agent/observability",
    category: "observability",
    responsibility: "Records and reads local JSONL run artifacts, summaries, trace source manifests, and exposes the OTLP/Phoenix exporter through the ./otel subpath.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "openai-api-adapter",
    name: "@mono-agent/openai-api-adapter",
    category: "communication",
    channelIds: ["openai-api"],
    responsibility: "Exposes agent responders through OpenAI-compatible model discovery and Chat Completions endpoints.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-operator",
    name: "@mono-agent/channel-operator",
    category: "communication",
    channelIds: ["operator"],
    responsibility: "Serves one selected agent through the authenticated loopback operator protocol.",
    allowedDependencyCategories: ["core", "operator-surface"],
    publishable: true,
  },
  {
    dir: "operator-adapter",
    name: "@mono-agent/operator-adapter",
    category: "communication",
    channelIds: ["tui"],
    responsibility: "Retains the v0 TUI endpoint only until the legacy agent-app plane is removed in the next rebuild vertical.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-adapter",
    name: "@mono-agent/runtime-adapter",
    category: "runtime",
    responsibility: "Wraps @mono-agent/agent-runtime behind runtime contracts and owns sandbox policy/process wrapping.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "runtime-pi",
    name: "@mono-agent/runtime-pi",
    category: "runtime",
    responsibility: "Runs Pi-native provider turns as isolated native attempts behind the typed runtime contract.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "slack-adapter",
    name: "@mono-agent/slack-adapter",
    category: "communication",
    channelIds: ["slack"],
    responsibility: "Adapts Slack Socket Mode events to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "telegram-adapter",
    name: "@mono-agent/telegram-adapter",
    category: "communication",
    channelIds: ["telegram"],
    responsibility: "Adapts Telegram updates to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "tui",
    name: "@mono-agent/tui",
    category: "operator-surface",
    responsibility: "Runs the standalone pi-tui renderer over the shared operator client, directory, state, and action contracts.",
    allowedDependencyCategories: ["operator-surface"],
    publishable: true,
  },
  {
    dir: "web",
    name: "@mono-agent/web",
    category: "operator-surface",
    responsibility:
      "Runs the standalone authenticated browser product over the shared operator protocol with owner-private durable conversations.",
    allowedDependencyCategories: ["operator-surface"],
    publishable: true,
  },
  {
    dir: "whatsapp-adapter",
    name: "@mono-agent/whatsapp-adapter",
    path: "extras/whatsapp-adapter",
    category: "communication",
    channelIds: ["whatsapp"],
    responsibility: "Adapts WhatsApp messages to structural agent requests and buffered final-only replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "webhook-adapter",
    name: "@mono-agent/webhook-adapter",
    category: "communication",
    channelIds: ["webhook"],
    responsibility: "Invokes agent responders from HTTP webhook requests with sync and async modes.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    supersededBy: "@mono-agent/channel-webhook",
  },
];

export function shippedChannelIdsFromCatalog(catalog = packageCatalog) {
  return Object.freeze([
    ...new Set(catalog.flatMap((entry) => entry.channelIds ?? [])),
  ]);
}

export const SHIPPED_CHANNEL_IDS = shippedChannelIdsFromCatalog();

export function packageByName() {
  return new Map(packageCatalog.map((entry) => [entry.name, entry]));
}

export function packageRelativePath(entry) {
  return entry.path ?? `packages/${entry.dir}`;
}
