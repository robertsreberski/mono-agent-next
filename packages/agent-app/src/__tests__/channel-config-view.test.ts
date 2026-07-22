import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CRON_CONFIG_FIELDS } from "@mono-agent/cron-adapter";
import { OPENAI_API_CONFIG_FIELDS } from "@mono-agent/openai-api-adapter";
import { SLACK_CONFIG_FIELDS } from "@mono-agent/slack-adapter";
import { TELEGRAM_CONFIG_FIELDS } from "@mono-agent/telegram-adapter";
import { WEBHOOK_CONFIG_FIELDS } from "@mono-agent/webhook-adapter";
import type { JsonEnvFieldSpec } from "@mono-agent/agent-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectChannelConfigViews } from "../channel-config-view.js";
import { createTelegramChannelDriver, defaultChannelDrivers } from "../channels.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "channel-config-view-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2));
  return configPath;
}

describe("channel config view", () => {
  it("tags json-sourced fields, env overrides, and defaults with their source", async () => {
    const configPath = await writeConfig({
      telegram: { enabled: true, botToken: "123:abc", allowAllChats: true },
    });
    const driver = createTelegramChannelDriver();

    const section = await driver.configView!({
      env: { MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "false" },
      cwd: dir,
      configPath,
    });

    expect(section.id).toBe("telegram");
    expect(section.status).toBe("active");
    const byId = new Map(section.fields.map((field) => [field.id, field]));
    expect(byId.get("telegram.enabled")).toMatchObject({ value: "true", source: "json" });
    // A real env var wins over the JSON value — same precedence as the loader.
    expect(byId.get("telegram.allowAllChats")).toMatchObject({ value: "false", source: "env" });
    expect(byId.get("telegram.pollWatchdogMs")).toMatchObject({ value: "—", source: "default" });
  });

  it("never prints a secret value — only set/unset — and carries the env key", async () => {
    const configPath = await writeConfig({
      telegram: { enabled: true, botToken: "123:secret-token", allowAllChats: true },
    });
    const driver = createTelegramChannelDriver();

    const section = await driver.configView!({ env: {}, cwd: dir, configPath });

    const botToken = section.fields.find((field) => field.id === "telegram.botToken");
    expect(botToken).toMatchObject({
      value: "set",
      source: "json",
      redacted: true,
      envKey: "MONO_AGENT_TELEGRAM_BOT_TOKEN",
    });
    expect(JSON.stringify(section)).not.toContain("secret-token");
  });

  it("redacts the webhook API key in the channel config view", async () => {
    const configPath = await writeConfig({
      webhook: { enabled: true, apiKey: "fixture-webhook-secret" },
    });
    const section = await defaultChannelDrivers()
      .find((driver) => driver.id === "webhook")!
      .configView!({ env: {}, cwd: dir, configPath });

    expect(section.fields.find((field) => field.id === "webhook.apiKey")).toMatchObject({
      value: "set",
      source: "json",
      redacted: true,
      envKey: "MONO_AGENT_WEBHOOK_API_KEY",
    });
    expect(JSON.stringify(section)).not.toContain("fixture-webhook-secret");
  });

  it("reports a disabled channel section as disabled", async () => {
    const configPath = await writeConfig({ telegram: { enabled: false } });
    const driver = createTelegramChannelDriver();

    const section = await driver.configView!({ env: {}, cwd: dir, configPath });

    expect(section.status).toBe("disabled");
  });

  it("composes a section for every default driver, even on an empty config", async () => {
    const configPath = await writeConfig({});

    const sections = await collectChannelConfigViews(defaultChannelDrivers(), {
      env: {},
      cwd: dir,
      configPath,
    });

    expect(sections.map((section) => section.id).sort()).toEqual(
      ["cron", "openai-api", "slack", "telegram", "tui", "webhook"].sort(),
    );
  });
});

describe("adapter field registries", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  function repoRoot(): string {
    let current = here;
    for (let depth = 0; depth < 12; depth += 1) {
      if (existsSync(join(current, "pnpm-workspace.yaml"))) {
        return current;
      }
      current = dirname(current);
    }
    throw new Error("could not locate pnpm-workspace.yaml above the test file");
  }

  async function registryEntries(): Promise<readonly [pkgPath: string, fields: readonly JsonEnvFieldSpec[]][]> {
    const [whatsapp, a2a] = await Promise.all([
      import("@mono-agent/whatsapp-adapter"),
      import("@mono-agent/a2a-adapter"),
    ]);
    return [
      ["packages/telegram-adapter", TELEGRAM_CONFIG_FIELDS],
      ["packages/slack-adapter", SLACK_CONFIG_FIELDS],
      ["extras/whatsapp-adapter", whatsapp.WHATSAPP_CONFIG_FIELDS],
      ["extras/a2a-adapter", a2a.A2A_CONFIG_FIELDS],
      ["packages/webhook-adapter", WEBHOOK_CONFIG_FIELDS],
      ["packages/openai-api-adapter", OPENAI_API_CONFIG_FIELDS],
      ["packages/cron-adapter", CRON_CONFIG_FIELDS],
    ];
  }

  it("only names env keys the owning adapter's loader actually reads", async () => {
    const root = repoRoot();
    for (const [pkgPath, fields] of await registryEntries()) {
      const source = readFileSync(join(root, pkgPath, "src/config.ts"), "utf8");
      const literals = new Set([...source.matchAll(/MONO_AGENT_[A-Z0-9_]+/gu)].map((match) => match[0]));
      for (const field of fields) {
        expect(literals, `${pkgPath} loader does not read ${field.env}`).toContain(field.env);
      }
    }
  });

  it("uses unique field ids and env keys per registry", async () => {
    for (const [pkgPath, fields] of await registryEntries()) {
      const ids = fields.map((field) => field.id);
      const envs = fields.map((field) => field.env);
      expect(new Set(ids).size, `${pkgPath} duplicate ids`).toBe(ids.length);
      expect(new Set(envs).size, `${pkgPath} duplicate env keys`).toBe(envs.length);
    }
  });

  it("marks every beginner-critical credential field as secret", async () => {
    const secretIds = (await registryEntries()).flatMap(([, fields]) => fields.filter((field) => field.secret === true).map((field) => field.id));
    expect(secretIds.sort()).toEqual(
      [
        "a2a.consumer.bearerToken",
        "a2a.provider.bearerToken",
        "openaiApi.apiKey",
        "slack.appToken",
        "slack.botToken",
        "telegram.botToken",
        "webhook.apiKey",
      ].sort(),
    );
  });
});
