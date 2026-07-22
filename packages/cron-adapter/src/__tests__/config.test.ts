import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCronAdapterConfig,
  redactCronAdapterConfig,
  toCronJobs,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-cron-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadCronAdapterConfig", () => {
  it("loads a single cron job from JSON and env overrides", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          enabled: true,
          expression: "0 * * * *",
          timezone: "Europe/Amsterdam",
          prompt: "json prompt",
          conversationId: "json-conversation",
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_PROMPT: "env prompt",
        MONO_AGENT_CRON_TIMEZONE: "Asia/Tokyo",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      jobs: [{
        id: "default",
        enabled: true,
        expression: "0 * * * *",
        timezone: "Asia/Tokyo",
        prompt: "env prompt",
        conversationId: "json-conversation",
      }],
    });
  });

  it("loads multiple cron jobs from the cron.jobs array in the JSON config file", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [
            {
              id: "daily",
              enabled: true,
              expression: "0 9 * * *",
              timezone: "UTC",
              prompt: "Morning summary.",
              maxRunMs: 2_700_000,
              notify: true,
              notifyConversationId: "telegram:42",
              notifyFailureCooldownHours: 2,
            },
            { id: "weekly", enabled: false, expression: "0 9 * * 1", prompt: "Weekly recap.", conversationId: "cron-weekly" },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });

    expect(config.jobs).toEqual([
      {
        id: "daily",
        enabled: true,
        expression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Morning summary.",
        maxRunMs: 2_700_000,
        notify: true,
        notifyConversationId: "telegram:42",
        notifyFailureCooldownHours: 2,
      },
      { id: "weekly", enabled: false, expression: "0 9 * * 1", timezone: "UTC", prompt: "Weekly recap.", conversationId: "cron-weekly" },
    ]);
  });

  it("lets the MONO_AGENT_CRON_JOBS_JSON env beat the cron.jobs JSON section", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "from-json", expression: "0 9 * * *", prompt: "json" }] } })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([
          { id: "from-env", expression: "*/5 * * * *", prompt: "env" },
        ]),
      },
      jsonPath: path,
    });

    expect(config.jobs.map((job) => job.id)).toEqual(["from-env"]);
  });

  it("rejects a cron.jobs section that is not an array of valid jobs", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken" }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects a cron.jobs maxRunMs that is not a positive integer", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken", expression: "0 9 * * *", prompt: "run", maxRunMs: -1 }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects a cron.jobs notifyFailureCooldownHours that is not a positive integer", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken", expression: "0 9 * * *", prompt: "run", notifyFailureCooldownHours: 0 }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("loads multiple cron jobs from JSON env", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([
          { id: "one", enabled: true, expression: "*/5 * * * *", prompt: "one", notify: true, notifyConversationId: "slack:C1" },
          { id: "two", enabled: false, expression: "0 0 * * *", prompt: "two" },
        ]),
      },
    });

    expect(config.jobs).toEqual([
      { id: "one", enabled: true, expression: "*/5 * * * *", timezone: "UTC", prompt: "one", notify: true, notifyConversationId: "slack:C1" },
      { id: "two", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "two" },
    ]);
  });

  it("loads native notify settings from single-job env fields", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_NOTIFY: "true",
        MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID: "telegram:42",
        MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS: "3",
      },
    });

    expect(config.jobs).toEqual([
      {
        id: "default",
        enabled: true,
        expression: "0 8 * * *",
        timezone: "UTC",
        prompt: "brief",
        notify: true,
        notifyConversationId: "telegram:42",
        notifyFailureCooldownHours: 3,
      },
    ]);
  });

  it("rejects an invalid notify failure cooldown from single-job env fields", async () => {
    await expect(loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS: "0",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("loads per-job model and effort overrides from the cron.jobs JSON array", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [
            {
              id: "research",
              enabled: true,
              expression: "0 9 * * *",
              prompt: "Deep research.",
              model: "claude:claude-opus-4-8",
              effort: "high",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });

    expect(config.jobs).toEqual([
      {
        id: "research",
        enabled: true,
        expression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Deep research.",
        model: "claude:claude-opus-4-8",
        effort: "high",
      },
    ]);
  });

  it("loads model and effort from single-job env fields", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_MODEL: "claude:claude-opus-4-8",
        MONO_AGENT_CRON_EFFORT: "max",
      },
    });

    expect(config.jobs).toEqual([
      {
        id: "default",
        enabled: true,
        expression: "0 8 * * *",
        timezone: "UTC",
        prompt: "brief",
        model: "claude:claude-opus-4-8",
        effort: "max",
      },
    ]);
  });
});

describe("redactCronAdapterConfig", () => {
  it("returns cron jobs without changing prompts", () => {
    expect(redactCronAdapterConfig({
      jobs: [{ id: "default", enabled: true, expression: "* * * * *", timezone: "UTC", prompt: "run" }],
    })).toEqual({
      jobs: [{ id: "default", enabled: true, expression: "* * * * *", timezone: "UTC", prompt: "run" }],
    });
  });
});

describe("toCronJobs", () => {
  it("drops disabled jobs and maps to the runtime CronJob shape", () => {
    const jobs = toCronJobs({
      jobs: [
        {
          id: "on",
          enabled: true,
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "run",
          conversationId: "c1",
          maxRunMs: 45_000,
          notify: true,
          notifyConversationId: "telegram:42",
          model: "claude:claude-opus-4-8",
          effort: "high",
        },
        { id: "off", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "skip" },
      ],
    });

    expect(jobs).toEqual([
      {
        id: "on",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "run",
        conversationId: "c1",
        maxRunMs: 45_000,
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
      },
    ]);
    expect(jobs.some((job) => job.id === "off")).toBe(false);
  });
});
