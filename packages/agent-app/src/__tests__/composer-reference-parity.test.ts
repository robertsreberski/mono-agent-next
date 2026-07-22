import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

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

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

function section(page: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing section ${marker}`);
  }
  const rest = page.slice(start + marker.length);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
}

function between(page: string, startMarker: string, endMarker: string): string {
  const start = page.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`missing start marker ${startMarker}`);
  }
  const end = page.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`missing end marker ${endMarker}`);
  }
  return page.slice(start, end);
}

function firstJsonBlock(page: string): unknown {
  const match = page.match(/```json\n([\s\S]*?)\n```/u);
  if (match?.[1] === undefined) {
    throw new Error("missing JSON code block");
  }
  return JSON.parse(match[1]);
}

function markdownTableRows(page: string): readonly (readonly string[])[] {
  return page
    .split("\n")
    .filter((line) => line.startsWith("| ") && line.endsWith(" |"))
    .map((line) => line.slice(2, -2).split(/(?<!\\) \| /u));
}

function registryConfigIds(registry: string): readonly string[] {
  return markdownTableRows(registry)
    .filter((cells) => cells.length === 4 && /`[^`]+`/u.test(cells[0] ?? ""))
    .filter((cells) => /\bconfig\b/u.test((cells[2] ?? "").replaceAll("`", "")))
    .flatMap((cells) =>
      [...(cells[0] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ""),
    )
    .filter(Boolean)
    .sort();
}

function composerRegistryIds(coverage: string): readonly string[] {
  return markdownTableRows(coverage)
    .filter((cells) => cells.length === 4)
    .flatMap((cells) => [...(cells[3] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ""))
    .filter(Boolean)
    .sort();
}

function auditComposerConfigCoverage(registry: string, coverage: string): {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
} {
  const registryIds = registryConfigIds(registry);
  const representedIds = composerRegistryIds(coverage);
  const registrySet = new Set(registryIds);
  const representedSet = new Set(representedIds);
  const counts = new Map<string, number>();
  for (const id of representedIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return {
    missing: registryIds.filter((id) => !representedSet.has(id)),
    unexpected: representedIds.filter((id) => !registrySet.has(id)),
    duplicates: [...counts]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(),
  };
}

function rowWithRegistryId(page: string, id: string): string {
  const row = markdownTableRows(page).find((cells) =>
    cells.some((cell) => [...cell.matchAll(/`([^`]+)`/gu)].some((match) => match[1] === id))
  );
  if (row === undefined) {
    throw new Error(`missing table row for registry id ${id}`);
  }
  return row.join(" | ");
}

function expectInteractionAutoStartContract(page: string, label: string): void {
  for (const anchor of [
    "AskUser",
    "interaction",
    "progress.enabled",
    "mcpRequestContextServers",
  ]) {
    expect(page, `${label} is missing interaction auto-start anchor ${anchor}`).toContain(anchor);
  }
}

function expectNativeNotifyDestinationContract(page: string, label: string): void {
  for (const anchor of ["exactly one", "0 or 2+", "explicit `notifyConversationId`"]) {
    expect(page, `${label} is missing native-notify semantic ${anchor}`).toContain(anchor);
  }
  expect(page, `${label} must skip ambiguous destinations with a warning`).toMatch(
    /skip(?:s|ped)[^.]*warning/u,
  );
  expect(page, `${label} must forbid inference for model-exhaustion notices`).toMatch(
    /never (?:infer|use inference)/u,
  );
}

function expectOptionalEnvMappingLegend(page: string, label: string): void {
  expect(page, `${label} must allow JSON-only config fields`).toContain("config fields may be JSON-only");
  expect(page, `${label} must require an explicit environment mapping`).toContain(
    "only fields with a documented `MONO_AGENT_*` mapping accept one",
  );
  expect(page, `${label} must define the no-mapping marker`).toContain(
    "`--` means none, as for `channels.plugins`",
  );
  expect(page, `${label} must not promise environment overrides for every field`).not.toMatch(
    /every field[^.\n]*(?:env|environment)/iu,
  );
  expect(page).not.toContain("env var override always exists");
}

describe("mono-agent-composer reference parity", () => {
  const registry = readRepoFile("docs/reference/feature-registry.md");
  const matrix = readRepoFile("docs/reference/feature-matrix.md");
  const canonicalBlueprint = readRepoFile("docs/config/blueprint.md");
  const envReference = readRepoFile("docs/config/env-vars.md");
  const deliveryReference = readRepoFile("docs/channels/delivery-and-send-tools.md");
  const interactivePlaybook = readRepoFile(
    "docs/playbooks/interactive-transcription-large-media.md",
  );
  const generatedConfigReference = readRepoFile("docs/config/reference.md");
  const coverage = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md",
  );
  const blueprint = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
  );
  const packageMap = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/package-map.md",
  );
  const composerPlaybooks = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/playbooks.md",
  );

  it("represents every config-bearing registry row exactly once", () => {
    expect(auditComposerConfigCoverage(registry, coverage)).toEqual({
      missing: [],
      unexpected: [],
      duplicates: [],
    });
  });

  it("distinguishes JSON config coverage from optional environment mappings in both authoritative references", () => {
    const legends = [
      [between(coverage, "# Feature Coverage", "## Runtime"), "feature-coverage legend"],
      [between(blueprint, "# Config Blueprint", "## Folder Layout"), "config-blueprint introduction"],
    ] as const;
    const pluginConfigRow = markdownTableRows(generatedConfigReference).find(
      (cells) => cells[0] === "`channels.plugins`",
    );

    for (const [legend, label] of legends) {
      expectOptionalEnvMappingLegend(legend, label);
    }
    expect(pluginConfigRow?.[2]).toBe("`--`");
  });

  it("keeps copyable webhook blueprints free of pseudo-interpolated credentials", () => {
    const surfaces = [
      [between(canonicalBlueprint, '"webhook": {', '"openaiApi": {'), "canonical blueprint"],
      [between(blueprint, '"webhook": {', '"openaiApi": {'), "composer blueprint"],
    ] as const;

    for (const [webhookBlock, label] of surfaces) {
      expect(webhookBlock, `${label} must omit a copyable literal API key`).not.toContain('"apiKey"');
      expect(webhookBlock, `${label} must not imply env: interpolation`).not.toContain(
        "env:MONO_AGENT_WEBHOOK_API_KEY",
      );
      expect(webhookBlock, `${label} must point to the real owner-only env path`).toContain(
        "MONO_AGENT_WEBHOOK_API_KEY=<strong-random-secret>",
      );
      expect(webhookBlock).toContain("owner-only .env");
      expect(webhookBlock).toContain("JSON strings are literal");
    }
  });

  it("fails the reviewer synthetic config-row mutation when the composer is unchanged", () => {
    const syntheticRow = readRepoFile(
      "packages/agent-app/src/__tests__/fixtures/composer-reference-synthetic-config-row.md",
    ).trim();
    const audit = auditComposerConfigCoverage(`${registry}\n${syntheticRow}\n`, coverage);

    expect(audit.missing).toContain("runtime.synthetic-freshness-probe");
  });

  it("keeps configured cron jobs distinct from programmatic overlap controls", () => {
    const row = markdownTableRows(coverage).find((cells) =>
      cells[3]?.includes("`cron.scheduled-prompts`"),
    );

    expect(row).toHaveLength(4);
    expect(row?.[0]).toBe(
      "Cron jobs (five-field expressions, timezones, stable job-id-seeded `H`; agent-app pins overlap to skip)",
    );
    expect(row?.[1]).toBe("config + code");
    expect(row?.[2]).toContain("per-job `model` / `effort`");
    expect(row?.[2]).toContain("programmatic-only `startCronAdapter` options");
    expect(row?.[3]).toBe("`cron.scheduled-prompts`");
  });

  it("keeps per-job cron scheduling distinct from shared harness bounds", () => {
    const cronChannel = readRepoFile("docs/channels/cron.md");
    const overlap = section(cronChannel, "Configured overlap: ticks are skipped, never queued");
    const watchdog = section(cronChannel, "Run watchdog: a wedged run is aborted, not left to starve");

    expect(overlap).toContain("Scheduler overlap state is tracked per job");
    expect(overlap).toContain("shared agent-app harness admission and execution limits");
    expect(overlap).toContain("serialize work across different jobs or reject a run");
    expect(watchdog).toContain("scheduler slot it reclaims are **per job**");
    expect(watchdog).toContain("shared agent-app harness admission and execution limits");
    expect(watchdog).toContain("delay sibling provider work or reject it");
    expect(cronChannel).not.toContain("never block one another");
    expect(cronChannel).not.toContain("does not affect its siblings");
  });

  it("documents every interaction-bridge auto-start path", () => {
    const surfaces = [
      [rowWithRegistryId(registry, "interaction.bridge"), "feature registry"],
      [rowWithRegistryId(coverage, "interaction.bridge"), "composer feature coverage"],
      [between(canonicalBlueprint, "// Human-in-the-loop bridge", '"sandbox": {'), "canonical blueprint"],
      [between(blueprint, "// Human-in-the-loop bridge", '"sandbox": {'), "composer blueprint"],
      [section(envReference, "Interaction (AskUser + tool progress)"), "environment reference"],
      [
        between(deliveryReference, "### `AskUser`", "## Native proactive notification"),
        "delivery reference",
      ],
      [
        between(interactivePlaybook, "This playbook shows", "## Who this is for"),
        "interactive playbook introduction",
      ],
    ] as const;

    for (const [page, label] of surfaces) {
      expectInteractionAutoStartContract(page, label);
    }
  });

  it("keeps retired Session Recorder surfaces out of active references", () => {
    for (const [page, label] of [
      [registry, "feature registry"],
      [matrix, "feature matrix"],
      [coverage, "composer feature coverage"],
      [packageMap, "composer package map"],
      [blueprint, "composer config blueprint"],
    ] as const) {
      expect(page, `${label} still advertises session-web`).not.toContain("@mono-agent/session-web");
      expect(page, `${label} still advertises live config`).not.toContain('"live"');
      expect(page, `${label} still advertises the live feature id`).not.toContain("live.event-relay");
    }
  });

  it("keeps the always-on web console distinct from the Session Recorder", () => {
    const cliWeb = rowWithRegistryId(registry, "app.cli-web");
    expect(cliWeb).toContain("mono-agent web");
    expect(cliWeb).toContain("--loopback");
    expect(cliWeb).toContain("--all --yes");
    expect(cliWeb).not.toContain("--include-memory");
    expect(packageMap).toContain("@mono-agent/web");
    expect(packageMap).not.toContain("@mono-agent/session-web");
  });

  it("keeps the annotated config blueprint complete for audited config keys", () => {
    const anchors = [
      '"routeSafety": "uniform"',
      "none|minimal|low|medium|high|xhigh|max|ultra",
      '"maxConcurrentRuns"',
      '"maxPendingRuns"',
      '"backend": "bujo"',
      '"supermemory"',
      '"interaction"',
      '"endpoints"',
      '"model"',
      '"effort"',
      '"notify"',
      '"notifyConversationId"',
      '"notifyFailureCooldownHours"',
    ];

    for (const anchor of anchors) {
      expect(blueprint, `config blueprint is missing ${anchor}`).toContain(anchor);
    }
  });

  it("maps the optional memory backend and browser surface to their owning packages", () => {
    expect(packageMap).toContain("@mono-agent/memory-supermemory");
    expect(packageMap).toContain('memory.backend: "supermemory"');
    expect(packageMap).toContain("@mono-agent/web");
    expect(packageMap).not.toContain("@mono-agent/session-web");
    expect(packageMap).not.toContain("mono-agent sessions");
  });

  it("mirrors native-notify configuration and destination-resolution semantics", () => {
    const composerSection = section(composerPlaybooks, "6. Cron digest with native notify");
    const canonicalPlaybook = readRepoFile("docs/playbooks/cron-digest-proactive-notify.md");
    const semanticSurfaces = [
      [rowWithRegistryId(registry, "channel.native-notify"), "feature registry"],
      [rowWithRegistryId(coverage, "channel.native-notify"), "composer feature coverage"],
      [composerSection, "composer playbook"],
      [canonicalPlaybook, "canonical notify playbook"],
      [
        between(deliveryReference, "### Destination resolution", "### Staying silent"),
        "delivery reference",
      ],
    ] as const;

    expect(firstJsonBlock(composerSection)).toEqual(firstJsonBlock(canonicalPlaybook));
    expect(composerSection).toContain("`channel.native-notify`");
    expect(composerSection).not.toContain("SlackSendMessage");
    for (const [page, label] of semanticSurfaces) {
      expectNativeNotifyDestinationContract(page, label);
    }
  });
});
