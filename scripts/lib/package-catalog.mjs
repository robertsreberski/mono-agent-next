// SPDX-License-Identifier: MIT
export const PACKAGE_CATEGORIES = [
  "runtime",
  "core",
  "context",
  "execution",
  "observability",
  "communication",
  "operator-surface",
  "app",
];

/**
 * The mono-agent publishable roster. This is deliberately the complete
 * product architecture rather than a compatibility catalog: deleted v0 names
 * must not be added back as aliases or transitional packages.
 */
export const packageCatalog = [
  {
    dir: "module-sdk",
    name: "@mono-agent/module-sdk",
    category: "core",
    responsibility: "Defines typed module, selected-instance tool, schema, compliance, and bounded host contracts.",
    allowedDependencyCategories: [],
    publishable: true,
  },
  {
    dir: "core",
    name: "@mono-agent/core",
    category: "core",
    responsibility: "Loads strict agent configuration, runs selected typed modules, and governs one callable-tool catalog.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "cli",
    name: "@mono-agent/cli",
    category: "app",
    responsibility: "Provides thin validation, inspection, module-command, authoring, and foreground-run frontends over the core public API.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-pi",
    name: "@mono-agent/runtime-pi",
    category: "runtime",
    responsibility: "Runs Pi-native provider turns as isolated typed runtime attempts with native session linkage.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-claude",
    name: "@mono-agent/runtime-claude",
    category: "runtime",
    responsibility: "Runs Claude SDK or Claude CLI native attempts behind the typed runtime contract.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-codex",
    name: "@mono-agent/runtime-codex",
    category: "runtime",
    responsibility: "Runs Codex app-server attempts with bounded process, session, approval, and cancellation handling.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-opencode",
    name: "@mono-agent/runtime-opencode",
    category: "runtime",
    responsibility: "Runs an authenticated loopback OpenCode server with fail-closed tool containment and bounded native sessions.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-telegram",
    name: "@mono-agent/channel-telegram",
    category: "communication",
    channelIds: ["telegram"],
    responsibility: "Maps Telegram Bot API updates and deliveries onto normalized channel turns.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-slack",
    name: "@mono-agent/channel-slack",
    category: "communication",
    channelIds: ["slack"],
    responsibility: "Maps Slack Socket Mode interactions and Web API deliveries onto normalized channel turns.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-webhook",
    name: "@mono-agent/channel-webhook",
    category: "communication",
    channelIds: ["webhook"],
    responsibility: "Serves bounded authenticated webhook ingress and explicit proactive webhook delivery.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-openai-api",
    name: "@mono-agent/channel-openai-api",
    category: "communication",
    channelIds: ["openai-api"],
    responsibility: "Serves one selected agent through a bounded authenticated OpenAI-compatible API.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-operator",
    name: "@mono-agent/channel-operator",
    category: "communication",
    channelIds: ["operator"],
    responsibility: "Serves one selected agent through the authenticated shared operator protocol.",
    allowedDependencyCategories: ["core", "operator-surface"],
    publishable: true,
  },
  {
    dir: "trigger-cron",
    name: "@mono-agent/trigger-cron",
    category: "execution",
    responsibility: "Discovers scheduled Markdown jobs and emits deterministic idempotent trigger events.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "memory-local",
    name: "@mono-agent/memory-local",
    category: "context",
    responsibility: "Provides owner-private SQLite memory recall, capture, forgetting, and permanent first-run identity.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "state-local",
    name: "@mono-agent/state-local",
    category: "execution",
    responsibility: "Provides owner-private CAS state, durable transcript/run records, RunHistory, idempotency, and presence publication.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "exporter-otlp",
    name: "@mono-agent/exporter-otlp",
    category: "observability",
    responsibility: "Exports bounded normalized telemetry batches to an OTLP HTTP endpoint.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "sandbox-srt",
    name: "@mono-agent/sandbox-srt",
    category: "execution",
    responsibility: "Executes selected commands through a fingerprinted fail-closed Sandbox Runtime Tool boundary.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "operator",
    name: "@mono-agent/operator",
    category: "operator-surface",
    responsibility: "Defines the operator protocol, strict client, directory, domain state, actions, and fixtures.",
    allowedDependencyCategories: [],
    publishable: true,
  },
  {
    dir: "tui",
    name: "@mono-agent/tui",
    category: "operator-surface",
    responsibility: "Runs the standalone pi-tui renderer over the shared operator client and domain contracts.",
    allowedDependencyCategories: ["operator-surface"],
    publishable: true,
  },
  {
    dir: "web",
    name: "@mono-agent/web",
    category: "operator-surface",
    responsibility: "Runs the standalone authenticated browser product with owner-private durable conversations.",
    allowedDependencyCategories: ["operator-surface"],
    publishable: true,
  },
  {
    dir: "create-mono-agent",
    name: "create-mono-agent",
    category: "app",
    responsibility: "Transactionally scaffolds minimal, Personal, and multi-runtime projects and delegates to the CLI.",
    allowedDependencyCategories: ["app"],
    publishable: true,
    tier: "alias",
  },
  {
    dir: "docs-mcp",
    name: "@mono-agent/docs-mcp",
    path: "extras/docs-mcp",
    category: "context",
    responsibility: "Provides offline search and guided reading over version-matched documentation through MCP.",
    allowedDependencyCategories: [],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "service-macos",
    name: "@mono-agent/service-macos",
    category: "app",
    responsibility: "Inspects, plans, and explicitly reconciles fingerprinted macOS launchd service state.",
    allowedDependencyCategories: ["core", "operator-surface"],
    publishable: true,
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
