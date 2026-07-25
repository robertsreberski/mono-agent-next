// SPDX-License-Identifier: MIT

import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TriggerHost } from "@mono-agent/module-sdk/internal";

import {
  MAX_CRON_JOBS,
  MAX_CRON_JOB_BYTES,
  TriggerCronConfigError,
  loadCronJobsFromDirectory,
  monoAgentModule,
  nextCronOccurrence,
  parseCronJobMarkdown,
  parseTriggerCronConfig,
  triggerCronConfigSchema,
} from "../index.js";

describe("trigger-cron job loader", () => {
  it("wraps disabled YAML aliases as typed configuration failures", async () => {
    const content = jobMarkdown([
      'expression: &schedule "* * * * *"',
      "runtime: *schedule",
    ]);

    expect(() => parseCronJobMarkdown("alias.md", content)).toThrow(TriggerCronConfigError);
    expect(() => parseCronJobMarkdown("alias.md", content)).toThrow(/invalid YAML.*Alias resolution is disabled/u);

    await withTempDirectory(async (root) => {
      await writeFile(join(root, "alias.md"), content);
      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toMatch(/alias\.md.*invalid YAML.*Alias resolution is disabled/u);
    });
  });

  it("reports every rejected job in one pass", async () => {
    // Validating until the first rejection meant a directory with four
    // incompatible files took four start attempts to fully diagnose.
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "good.md"), jobMarkdown(['expression: "* * * * *"']));
      await writeFile(join(root, "bad-one.md"), "no frontmatter at all\n");
      await writeFile(join(root, "bad-two.md"), jobMarkdown(["expression: not-a-cron-expression"]));
      await writeFile(join(root, "bad-three.md"), "also missing frontmatter\n");

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toMatch(/3 cron jobs were rejected/u);
      expect(error.message).toContain("bad-one.md");
      expect(error.message).toContain("bad-two.md");
      expect(error.message).toContain("bad-three.md");
      expect(error.message).not.toContain("good.md");
    });
  });

  it("still reports a lone rejection without aggregate framing", async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "good.md"), jobMarkdown(['expression: "* * * * *"']));
      await writeFile(join(root, "only-bad.md"), "no frontmatter at all\n");

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toContain("only-bad.md");
      expect(error.message).not.toMatch(/cron jobs were rejected/u);
    });
  });

  it("rejects a symlinked jobs directory", async () => {
    await withTempDirectory(async (root) => {
      const realDirectory = join(root, "real");
      const linkedDirectory = join(root, "linked");
      await mkdir(realDirectory);
      await symlink(realDirectory, linkedDirectory, "dir");

      const error = await configFailure(loadCronJobsFromDirectory(linkedDirectory));
      expect(error.message).toMatch(/must be a real directory, not a symlink/u);
    });
  });

  it("rejects a symlinked Markdown job through the no-follow file boundary", async () => {
    await withTempDirectory(async (root) => {
      const target = join(root, "target.txt");
      const linkedJob = join(root, "linked.md");
      await writeFile(target, jobMarkdown(['expression: "* * * * *"']));
      await symlink(target, linkedJob, "file");

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toMatch(/Unable to load cron job .*linked\.md/u);
    });
  });

  it("rejects an oversized Markdown job before reading it", async () => {
    await withTempDirectory(async (root) => {
      const oversized = join(root, "oversized.md");
      await writeFile(oversized, "");
      await truncate(oversized, MAX_CRON_JOB_BYTES + 1);

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toContain(`no larger than ${String(MAX_CRON_JOB_BYTES)} bytes`);
    });
  });

  it("rejects duplicate explicit job ids", async () => {
    await withTempDirectory(async (root) => {
      const content = jobMarkdown([
        "id: shared",
        'expression: "* * * * *"',
      ]);
      await writeFile(join(root, "first.md"), content);
      await writeFile(join(root, "second.md"), content);

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toMatch(/Duplicate cron job id "shared" in first\.md and second\.md/u);
    });
  });

  it("ignores non-Markdown entries and lowercases an uppercase extension-derived id", async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "Morning-Brief.MD"), jobMarkdown(['expression: "* * * * *"']));
      await writeFile(join(root, "notes.txt"), "not a cron job");
      await mkdir(join(root, "archive"));

      const jobs = await loadCronJobsFromDirectory(root);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: "morning-brief",
        source: join(root, "Morning-Brief.MD"),
      });
    });
  });

  it("rejects more than the bounded job count", async () => {
    await withTempDirectory(async (root) => {
      await writeFilesInBatches(
        Array.from(
          { length: MAX_CRON_JOBS + 1 },
          (_unused, index) => join(root, `${String(index).padStart(4, "0")}.md`),
        ),
      );

      const error = await configFailure(loadCronJobsFromDirectory(root));
      expect(error.message).toContain(`exceeds the ${String(MAX_CRON_JOBS)} job limit`);
    });
  }, 20_000);
});

describe("trigger-cron config and module wiring", () => {
  it("keeps parser length limits aligned with the published schema", () => {
    const properties = triggerCronConfigSchema.jsonSchema.properties;
    expect(properties.jobsDirectory.maxLength).toBe(1_024);
    expect(properties.timezone.maxLength).toBe(128);

    const maximumDirectory = "a".repeat(properties.jobsDirectory.maxLength);
    expect(parseTriggerCronConfig({ jobsDirectory: maximumDirectory }).jobsDirectory).toBe(maximumDirectory);
    expect(() => parseTriggerCronConfig({
      jobsDirectory: `${maximumDirectory}a`,
    })).toThrow(TriggerCronConfigError);
    const astralBoundary = "😀".repeat(properties.jobsDirectory.maxLength);
    expect(parseTriggerCronConfig({ jobsDirectory: astralBoundary }).jobsDirectory).toBe(astralBoundary);
    expect(() => parseTriggerCronConfig({
      jobsDirectory: `${astralBoundary}😀`,
    })).toThrow(TriggerCronConfigError);
    expect(parseTriggerCronConfig({
      jobsDirectory: "cron",
      timezone: "Europe/Rome",
    }).timezone).toBe("Europe/Rome");
    expect(() => parseTriggerCronConfig({
      jobsDirectory: "cron",
      timezone: "a".repeat(properties.timezone.maxLength + 1),
    })).toThrow(TriggerCronConfigError);
  });

  it("creates a working trigger from a config-relative jobs directory", async () => {
    await withTempDirectory(async (root) => {
      const jobsDirectory = join(root, "jobs");
      await mkdir(jobsDirectory);
      await writeFile(join(jobsDirectory, "wired-job.md"), jobMarkdown([
        'expression: "* * * * *"',
      ], "Run through the module definition."));

      const host: TriggerHost = {
        grantedCapabilities: new Set(),
        getCapability<T>(): T | undefined {
          return undefined;
        },
        async emit() {
          throw new Error("Module wiring test must not emit.");
        },
      };
      const lifecycle = new AbortController();
      const trigger = await monoAgentModule.create({
        instanceId: "cron-wiring",
        config: monoAgentModule.schema.parse({
          jobsDirectory: "jobs",
          timezone: "Europe/Rome",
        }),
        provenance: {},
        configDirectory: root,
        workspaceDirectory: root,
        dataDirectory: root,
        logger: nullLogger,
        host,
        signal: lifecycle.signal,
      });

      expect(trigger.jobs[0]).toMatchObject({
        id: "wired-job",
        timezone: "Europe/Rome",
        source: join(jobsDirectory, "wired-job.md"),
        prompt: "Run through the module definition.",
      });
    });
  });

  it("computes a weekday Europe/Rome schedule across the daylight-saving boundary", () => {
    const romeJob = parseCronJobMarkdown("rome.md", jobMarkdown([
      "expression: 45 6 * * 1-5",
      "timezone: Europe/Rome",
    ]));

    expect(nextCronOccurrence(
      romeJob,
      new Date("2026-03-26T06:46:00.000Z"),
    ).toISOString()).toBe("2026-03-27T05:45:00.000Z");
    expect(nextCronOccurrence(
      romeJob,
      new Date("2026-03-27T05:46:00.000Z"),
    ).toISOString()).toBe("2026-03-30T04:45:00.000Z");
  });
});

const nullLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function jobMarkdown(frontmatter: readonly string[], prompt = "Run the job."): string {
  return `---
${frontmatter.join("\n")}
---

${prompt}
`;
}

async function configFailure(operation: Promise<unknown>): Promise<TriggerCronConfigError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(TriggerCronConfigError);
    return error as TriggerCronConfigError;
  }
  throw new Error("Expected a TriggerCronConfigError.");
}

async function withTempDirectory<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-trigger-cron-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFilesInBatches(paths: readonly string[]): Promise<void> {
  const batchSize = 64;
  for (let index = 0; index < paths.length; index += batchSize) {
    await Promise.all(paths.slice(index, index + batchSize).map(async (path) => {
      await writeFile(path, "");
    }));
  }
}
