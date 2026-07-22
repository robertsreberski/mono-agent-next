import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCronAdapterConfig,
  loadCronJobsFromDirectory,
  parseCronJobMarkdown,
  toCronJobs,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-cron-dir-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseCronJobMarkdown", () => {
  it("reads frontmatter metadata and uses the body as the prompt", () => {
    const job = parseCronJobMarkdown(
      "daily-digest.md",
      [
        "---",
        "id: digest",
        "expression: 0 8 * * *",
        "timezone: Europe/Warsaw",
        "enabled: true",
        "conversationId: digest-thread",
        "maxRunMs: 2700000",
        "notify: true",
        "notifyConversationId: telegram:42",
        "notifyFailureCooldownHours: 4",
        "---",
        "",
        "Summarize yesterday and post the digest.",
        "Keep it under five bullet points.",
      ].join("\n"),
    );

    expect(job).toEqual({
      id: "digest",
      enabled: true,
      expression: "0 8 * * *",
      timezone: "Europe/Warsaw",
      prompt: "Summarize yesterday and post the digest.\nKeep it under five bullet points.",
      conversationId: "digest-thread",
      maxRunMs: 2_700_000,
      notify: true,
      notifyConversationId: "telegram:42",
      notifyFailureCooldownHours: 4,
    });
  });

  it("reads per-job model and effort overrides from frontmatter", () => {
    const job = parseCronJobMarkdown(
      "research.md",
      [
        "---",
        "expression: 0 9 * * *",
        "model: claude:claude-opus-4-8",
        "effort: high",
        "---",
        "Run the deep research.",
      ].join("\n"),
    );

    expect(job.model).toBe("claude:claude-opus-4-8");
    expect(job.effort).toBe("high");
  });

  it("defaults id to the filename stem and timezone to UTC", () => {
    const job = parseCronJobMarkdown("weekly-review.md", "---\nexpression: 0 9 * * 1\n---\nWeekly review.");
    expect(job.id).toBe("weekly-review");
    expect(job.timezone).toBe("UTC");
    expect(job.enabled).toBe(true);
  });

  it("keeps quoted and unquoted (stepped) cron expressions intact", () => {
    const quoted = parseCronJobMarkdown("q.md", `---\nexpression: "0 9 * * *"\n---\nQuoted.`);
    expect(quoted.expression).toBe("0 9 * * *");

    const stepped = parseCronJobMarkdown("s.md", "---\nexpression: */5 * * * *\n---\nStepped.");
    expect(stepped.expression).toBe("*/5 * * * *");
  });

  it("ignores comment and blank frontmatter lines", () => {
    const job = parseCronJobMarkdown(
      "c.md",
      ["---", "# a scheduled note", "", "expression: 0 0 * * *", "", "---", "Body."].join("\n"),
    );
    expect(job.expression).toBe("0 0 * * *");
    expect(job.prompt).toBe("Body.");
  });

  it("rejects a file with no expression, naming the file", () => {
    let error: unknown;
    try {
      parseCronJobMarkdown("broken.md", "---\ntimezone: UTC\n---\nNo schedule here.");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_config", details: { file: "broken.md" } });
  });

  it("rejects a file with an empty prompt body", () => {
    expect(() => parseCronJobMarkdown("empty.md", "---\nexpression: 0 0 * * *\n---\n\n   \n")).toThrowError(
      /non-empty prompt/u,
    );
  });

  it("rejects a non-boolean enabled value", () => {
    expect(() => parseCronJobMarkdown("x.md", "---\nexpression: 0 0 * * *\nenabled: maybe\n---\nBody.")).toThrowError(
      /enabled/u,
    );
  });

  it("rejects a non-boolean notify value", () => {
    expect(() => parseCronJobMarkdown("x.md", "---\nexpression: 0 0 * * *\nnotify: maybe\n---\nBody.")).toThrowError(
      /notify/u,
    );
  });

  it("rejects a non-positive maxRunMs value", () => {
    expect(() => parseCronJobMarkdown("x.md", "---\nexpression: 0 0 * * *\nmaxRunMs: 0\n---\nBody.")).toThrowError(
      /maxRunMs/u,
    );
  });

  it("treats a __proto__ frontmatter key as inert data without polluting the prototype", () => {
    const job = parseCronJobMarkdown(
      "p.md",
      ["---", "__proto__: polluted", "expression: 0 0 * * *", "---", "Body."].join("\n"),
    );
    expect(job.expression).toBe("0 0 * * *");
    expect(({} as Record<string, unknown>).expression).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

describe("loadCronJobsFromDirectory", () => {
  it("loads markdown jobs in sorted filename order", async () => {
    await writeFile(join(dir, "b-second.md"), "---\nexpression: 0 9 * * *\n---\nSecond.", "utf8");
    await writeFile(join(dir, "a-first.md"), "---\nexpression: 0 8 * * *\n---\nFirst.", "utf8");

    const jobs = await loadCronJobsFromDirectory(dir);
    expect(jobs.map((job) => job.id)).toEqual(["a-first", "b-second"]);
  });

  it("ignores non-markdown files", async () => {
    await writeFile(join(dir, "job.md"), "---\nexpression: 0 8 * * *\n---\nReal.", "utf8");
    await writeFile(join(dir, "notes.txt"), "expression: 0 8 * * *", "utf8");
    await writeFile(join(dir, "README"), "not a job", "utf8");

    const jobs = await loadCronJobsFromDirectory(dir);
    expect(jobs.map((job) => job.id)).toEqual(["job"]);
  });

  it("returns no jobs for a missing directory", async () => {
    const jobs = await loadCronJobsFromDirectory(join(dir, "does-not-exist"));
    expect(jobs).toEqual([]);
  });

  it("rejects two files that resolve to the same id", async () => {
    await writeFile(join(dir, "one.md"), "---\nid: shared\nexpression: 0 8 * * *\n---\nOne.", "utf8");
    await writeFile(join(dir, "two.md"), "---\nid: shared\nexpression: 0 9 * * *\n---\nTwo.", "utf8");

    await expect(loadCronJobsFromDirectory(dir)).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("loadCronAdapterConfig with a cron folder", () => {
  it("merges cron.jobs config with cron-folder jobs", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "from-config", expression: "0 0 * * *", prompt: "config job" }] } })}\n`,
      "utf8",
    );
    const cronDir = join(dir, "cron");
    await mkdir(cronDir);
    await writeFile(join(cronDir, "from-folder.md"), "---\nexpression: 0 8 * * *\n---\nfolder job", "utf8");

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path, cwd: dir });
    expect(config.jobs.map((job) => job.id)).toEqual(["from-config", "from-folder"]);
  });

  it("rejects a folder job whose id collides with a config job", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "dupe", expression: "0 0 * * *", prompt: "config" }] } })}\n`,
      "utf8",
    );
    const cronDir = join(dir, "cron");
    await mkdir(cronDir);
    await writeFile(join(cronDir, "dupe.md"), "---\nexpression: 0 8 * * *\n---\nfolder", "utf8");

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path, cwd: dir })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("reads from a custom folder set via cron.dir", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, `${JSON.stringify({ cron: { dir: "myjobs" } })}\n`, "utf8");
    const cronDir = join(dir, "myjobs");
    await mkdir(cronDir);
    await writeFile(join(cronDir, "ping.md"), "---\nexpression: */5 * * * *\n---\nping", "utf8");

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path, cwd: dir });
    expect(config.jobs).toEqual([
      { id: "ping", enabled: true, expression: "*/5 * * * *", timezone: "UTC", prompt: "ping" },
    ]);
  });

  it("loads folder-only jobs and drops disabled ones from the runtime list", async () => {
    const cronDir = join(dir, "cron");
    await mkdir(cronDir);
    await writeFile(join(cronDir, "on.md"), "---\nexpression: 0 8 * * *\n---\non", "utf8");
    await writeFile(join(cronDir, "off.md"), "---\nexpression: 0 9 * * *\nenabled: false\n---\noff", "utf8");

    const config = await loadCronAdapterConfig({ env: {}, cwd: dir });
    expect(config.jobs.map((job) => job.id)).toEqual(["off", "on"]);
    expect(toCronJobs(config).map((job) => job.id)).toEqual(["on"]);
  });

  it("skips the folder scan when no base directory is provided", async () => {
    const config = await loadCronAdapterConfig({ env: {} });
    expect(config.jobs).toEqual([]);
  });

  it("rejects a non-string cron.dir instead of silently using the default", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, `${JSON.stringify({ cron: { dir: true } })}\n`, "utf8");

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path, cwd: dir })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });
});
