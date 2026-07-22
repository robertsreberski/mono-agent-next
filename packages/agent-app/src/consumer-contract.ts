import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readMonoAgentConfigJson } from "@mono-agent/config";
import type { MonoAgentConfigJson } from "@mono-agent/config";
import type { RunSummaryStatus } from "@mono-agent/observability";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import { loadAppCoreConfig } from "./app-config.js";
import { validateMonoAgentFolder } from "./doctor.js";

export const consumerContractNames = ["local-agent-alpha", "local-agent-beta"] as const;

export type ConsumerContractName = (typeof consumerContractNames)[number];

export interface ConsumerContractIssue {
  readonly check: string;
  readonly message: string;
}

export interface ConsumerContractSectionStatus {
  readonly id: string;
  readonly status: ValidationStatus;
}

export interface ConsumerContractFixtureOptions {
  readonly name: ConsumerContractName;
  readonly fixtureDir: string;
  readonly env?: Record<string, string | undefined>;
  /** Optional sandbox engine override for deterministic contract validation. */
  readonly sandboxEngine?: SandboxEngine;
}

export interface ConsumerContractFixtureResult {
  readonly name: ConsumerContractName;
  readonly ok: boolean;
  readonly reportOk?: boolean;
  readonly networkCallCount: number;
  readonly sections: readonly ConsumerContractSectionStatus[];
  readonly issues: readonly ConsumerContractIssue[];
}

const forbiddenFixtureSecretPattern = /(sk-|xoxb-|bot[0-9]+:|apiKey|token)/u;
// Guards the retired/deprecated memory MCP surfaces (an mcp.json must not declare a
// standalone memory server — MemoryRecall is auto-provisioned in-app, never via MCP config).
const forbiddenMcpMemoryPattern = /@mono-agent\/memory-mcp|\bmemory-mcp\b|\bmemory_note\b|\bmemory_recall\b/u;

export const consumerContractRunSummaryStatuses = {
  running: true,
  succeeded: true,
  failed: true,
  cancelled: true,
  interrupted: true,
} satisfies Record<RunSummaryStatus, true>;

type ValidationReport = Awaited<ReturnType<typeof validateMonoAgentFolder>>;
type ValidationStatus = ValidationReport["sections"][number]["status"];
type ConsumerSourceJson = MonoAgentConfigJson & {
  readonly telegram?: { readonly enabled?: boolean };
  readonly slack?: { readonly enabled?: boolean };
  readonly webhook?: { readonly enabled?: boolean };
  readonly openaiApi?: { readonly enabled?: boolean };
};

interface ConsumerFixture {
  readonly name: ConsumerContractName;
  readonly sourceJson: ConsumerSourceJson;
  readonly config: Awaited<ReturnType<typeof loadAppCoreConfig>>;
  readonly report: ValidationReport;
}

const expectedContracts = {
  "local-agent-alpha": {
    memoryMode: "bujo",
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "TelegramSendMessage",
    ],
    channels: {
      telegram: "active",
      slack: "disabled",
      webhook: "active",
      "openai-api": "active",
      cron: "active",
      // The default-on operator surface is active with no `tui` section in the fixture.
      tui: "active",
    },
    enabledFlags: {
      telegram: true,
      slack: false,
      webhook: true,
      "openai-api": true,
    },
  },
  "local-agent-beta": {
    memoryMode: "journal",
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "SlackSendMessage",
      "MemoryRecall",
    ],
    channels: {
      telegram: "disabled",
      slack: "active",
      webhook: "disabled",
      "openai-api": "active",
      cron: "active",
      // The default-on operator surface is active with no `tui` section in the fixture.
      tui: "active",
    },
    enabledFlags: {
      telegram: false,
      slack: true,
      webhook: false,
      "openai-api": true,
    },
  },
} as const;

export async function validateConsumerContractFixture(
  options: ConsumerContractFixtureOptions,
): Promise<ConsumerContractFixtureResult> {
  const issues: ConsumerContractIssue[] = [];
  let reportOk: boolean | undefined;
  let sections: readonly ConsumerContractSectionStatus[] = [];
  let networkCallCount = 0;

  const secretHits = await scanConsumerFixtureSecrets(options.fixtureDir);
  if (secretHits.length > 0) {
    issues.push(issue("fixture-secrets", `Fixture contains forbidden secret markers: ${secretHits.join(", ")}`));
  }

  const dir = await mkdtemp(join(tmpdir(), `agent-app-consumer-${options.name}-`));
  const restoreFetch = installNetworkGuard(() => {
    networkCallCount += 1;
  });
  try {
    await cp(options.fixtureDir, dir, { recursive: true });
    const configPath = join(dir, "mono-agent.config.json");
    const sourceJson = (await readMonoAgentConfigJson(configPath)).json as ConsumerSourceJson;
    const config = await loadAppCoreConfig({ env: options.env ?? {}, cwd: dir, configPath });
    await seedPrivateConsumerMemoryGeneration(dir, config);
    const report = await validateMonoAgentFolder({
      env: options.env ?? {},
      cwd: dir,
      configPath,
      liveness: false,
      ...(options.sandboxEngine === undefined ? {} : { sandboxEngine: options.sandboxEngine }),
    });
    reportOk = report.ok;
    sections = sectionStatuses(report);
    issues.push(...consumerContractIssues({ name: options.name, sourceJson, config, report }));
  } catch (error) {
    issues.push(issue("consumer-contract", reasonOf(error)));
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }

  if (networkCallCount > 0) {
    issues.push(issue("offline", `Validation attempted ${networkCallCount} network call(s) under liveness:false.`));
  }

  return {
    name: options.name,
    ok: issues.length === 0,
    ...(reportOk === undefined ? {} : { reportOk }),
    networkCallCount,
    sections,
    issues,
  };
}

/**
 * Golden fixtures intentionally remain source-only: committing native SQLite
 * binaries would make them platform-specific and opaque to review. Seed the
 * copied fixture with a real empty generation so doctor validates the same
 * managed layout as a rebuilt consumer. Keep the import dynamic: merely
 * importing agent-app must never load better-sqlite3/sqlite-vec.
 */
async function seedPrivateConsumerMemoryGeneration(
  privateFixtureRoot: string,
  config: Awaited<ReturnType<typeof loadAppCoreConfig>>,
): Promise<void> {
  const memory = config.memory;
  if (memory === undefined || (memory.backend ?? "bujo") === "supermemory") return;

  const privateRoot = resolve(privateFixtureRoot);
  const memoryRoot = resolve(memory.path);
  const relativeMemoryRoot = relative(privateRoot, memoryRoot);
  if (relativeMemoryRoot.length === 0
    || relativeMemoryRoot === ".."
    || relativeMemoryRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeMemoryRoot)) {
    throw new Error("Consumer fixture memory.path must be a strict lexical descendant of its private fixture copy.");
  }

  const { safeRebuildMemoryIndex } = await import("@mono-agent/memory/bujo");
  const embeddings = memory.embeddings;
  if (embeddings === undefined) {
    await safeRebuildMemoryIndex({ root: memoryRoot, tier: memory.mode });
    return;
  }

  const dimension = embeddings.dim ?? 768;
  await safeRebuildMemoryIndex({
    root: memoryRoot,
    tier: memory.mode,
    embeddings: {
      id: `${embeddings.provider}:${embeddings.model}`,
      embed: async (texts) => texts.map(() => {
        const vector = new Array<number>(dimension).fill(0);
        vector[0] = 1;
        return vector;
      }),
    },
    dim: dimension,
  });
}

function consumerContractIssues(fixture: ConsumerFixture): readonly ConsumerContractIssue[] {
  const issues: ConsumerContractIssue[] = [];
  const expected = expectedContracts[fixture.name];

  if (!fixture.report.ok) {
    issues.push(issue("validation", "validateMonoAgentFolder returned ok=false."));
  }

  issues.push(...channelContractIssues(fixture.report, expected.channels));
  issues.push(...sourceEnabledFlagIssues(fixture.sourceJson, expected.enabledFlags));
  issues.push(...arrayEqualsIssues("tools.allowedTools", fixture.config.tools.allowedTools, expected.allowedTools));
  issues.push(...arrayEqualsIssues("tools.disallowedTools", fixture.config.tools.disallowedTools, []));

  if (fixture.config.tools.allowedTools.length === 0) {
    issues.push(issue("tools.allowedTools", "Allowed tools must not be empty."));
  }
  if (fixture.config.memory?.mode !== expected.memoryMode) {
    issues.push(issue("memory.mode", `Expected ${expected.memoryMode}, got ${String(fixture.config.memory?.mode)}.`));
  }
  if (fixture.config.memory?.recallTool?.enabled !== true) {
    issues.push(issue("memory.recallTool.enabled", "Expected memory recall tool to be enabled."));
  }
  if (!["ok", "waiting"].includes(sectionStatus(fixture.report, "memory") ?? "")) {
    issues.push(issue("memory.section", "Memory doctor section must be ok or waiting."));
  }
  if (typeof fixture.sourceJson.artifacts?.dir !== "string" || fixture.sourceJson.artifacts.dir.trim().length === 0) {
    issues.push(issue("artifacts.dir", "Source fixture must explicitly include artifacts.dir."));
  }
  if (fixture.config.observability?.exporters[0]?.type !== "phoenix") {
    issues.push(issue("observability.exporters", "Expected first observability exporter type to be phoenix."));
  }
  issues.push(...retiredMcpMemorySurfaceIssues(fixture));

  return issues;
}

function channelContractIssues(
  report: ValidationReport,
  expected: typeof expectedContracts[ConsumerContractName]["channels"],
): readonly ConsumerContractIssue[] {
  const issues: ConsumerContractIssue[] = [];
  const statuses = channelStatuses(report);
  const actualKeys = [...statuses.keys()].sort();
  const expectedKeys = Object.keys(expected).sort();
  if (!arraysEqual(actualKeys, expectedKeys)) {
    issues.push(issue("channels", `Expected channel ids ${expectedKeys.join(", ")}, got ${actualKeys.join(", ")}.`));
  }

  for (const [id, expectedState] of Object.entries(expected)) {
    const status = statuses.get(id);
    if (status === undefined) {
      issues.push(issue(`channel:${id}`, "Missing channel section."));
      continue;
    }
    if (status === "error") {
      issues.push(issue(`channel:${id}`, "Channel section must not be error."));
    }
    if (expectedState === "active") {
      if (status !== "ok" && status !== "waiting") {
        issues.push(issue(`channel:${id}`, `Expected active channel to be ok or waiting, got ${status}.`));
      }
    } else if (status !== "disabled") {
      issues.push(issue(`channel:${id}`, `Expected disabled channel, got ${status}.`));
    }
  }

  return issues;
}

function sourceEnabledFlagIssues(
  sourceJson: ConsumerSourceJson,
  expected: typeof expectedContracts[ConsumerContractName]["enabledFlags"],
): readonly ConsumerContractIssue[] {
  const issues: ConsumerContractIssue[] = [];
  for (const [id, enabled] of Object.entries(expected)) {
    const actual = sourceEnabledFlag(sourceJson, id);
    if (actual !== enabled) {
      issues.push(issue(`${id}.enabled`, `Expected ${String(enabled)}, got ${String(actual)}.`));
    }
  }
  return issues;
}

function sourceEnabledFlag(sourceJson: ConsumerSourceJson, id: string): boolean {
  switch (id) {
    case "telegram":
      return sourceJson.telegram?.enabled === true;
    case "slack":
      return sourceJson.slack?.enabled === true;
    case "webhook":
      return sourceJson.webhook?.enabled === true;
    case "openai-api":
      return sourceJson.openaiApi?.enabled === true;
    default:
      throw new Error(`unknown channel enabled flag: ${id}`);
  }
}

function retiredMcpMemorySurfaceIssues(fixture: ConsumerFixture): readonly ConsumerContractIssue[] {
  const issues: ConsumerContractIssue[] = [];
  if (fixture.config.tools.allowedTools.includes("memory_note")) {
    issues.push(issue("tools.allowedTools", "Allowed tools must not expose retired memory_note."));
  }
  if (fixture.config.tools.mcpConfigPath === undefined) {
    issues.push(issue("tools.mcpConfigPath", "Expected fixture to resolve tools.mcpConfigPath."));
    return issues;
  }
  const mcpText = readFileSync(fixture.config.tools.mcpConfigPath, "utf8");
  if (forbiddenMcpMemoryPattern.test(mcpText)) {
    issues.push(issue("tools.mcpConfigPath", "MCP config exposes a retired memory MCP surface."));
  }
  return issues;
}

function channelStatuses(report: ValidationReport): Map<string, ValidationStatus> {
  const result = new Map<string, ValidationStatus>();
  for (const section of report.sections) {
    if (section.id.startsWith("channel:")) {
      result.set(section.id.slice("channel:".length), section.status);
    }
  }
  return result;
}

function sectionStatus(report: ValidationReport, id: string): ValidationStatus | undefined {
  return report.sections.find((section) => section.id === id)?.status;
}

function sectionStatuses(report: ValidationReport): readonly ConsumerContractSectionStatus[] {
  return report.sections.map(({ id, status }) => ({ id, status }));
}

function arrayEqualsIssues(
  check: string,
  actual: readonly string[],
  expected: readonly string[],
): readonly ConsumerContractIssue[] {
  if (arraysEqual(actual, expected)) {
    return [];
  }
  return [issue(check, `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`)];
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function scanConsumerFixtureSecrets(root: string): Promise<readonly string[]> {
  const files = await readFixtureFiles(root);
  return files.flatMap(({ path, content }) =>
    forbiddenFixtureSecretPattern.test(content) ? [relative(root, path)] : [],
  );
}

async function readFixtureFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return await readFixtureFiles(path);
      }
      if (!entry.isFile()) {
        return [];
      }
      return [{ path, content: await readFile(path, "utf8") }];
    }),
  );
  return files.flat();
}

function installNetworkGuard(onCall: () => void): () => void {
  const globalWithFetch = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const originalFetch = globalWithFetch.fetch;
  globalWithFetch.fetch = (() => {
    onCall();
    throw new Error("consumer contract fixtures must validate without network access");
  }) as typeof fetch;
  return () => {
    if (originalFetch === undefined) {
      delete globalWithFetch.fetch;
    } else {
      globalWithFetch.fetch = originalFetch;
    }
  };
}

function issue(check: string, message: string): ConsumerContractIssue {
  return { check, message };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
