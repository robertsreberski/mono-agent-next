import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCronAdapterConfig } from "@mono-agent/cron-adapter";
import { loadOpenAIApiAdapterConfig } from "@mono-agent/openai-api-adapter";
import { loadSlackAdapterConfig } from "@mono-agent/slack-adapter";
import { loadTelegramAdapterConfig } from "@mono-agent/telegram-adapter";
import { loadTuiAdapterConfig } from "@mono-agent/operator-adapter";
import { loadWebhookAdapterConfig } from "@mono-agent/webhook-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isChannelConfigured } from "../channel-gate.js";
import { defaultChannelDrivers } from "../channels.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "channel-gate-"));
  configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, "{}");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isChannelConfigured", () => {
  const spec = { jsonKey: "telegram", envPrefix: "MONO_AGENT_TELEGRAM_" };

  it("is false on an empty folder with no env", async () => {
    expect(await isChannelConfigured({ env: {}, cwd: dir, configPath }, spec)).toBe(false);
  });

  it("is true when the JSON section exists — even with enabled:false", async () => {
    await writeFile(configPath, JSON.stringify({ telegram: { enabled: false } }));
    expect(await isChannelConfigured({ env: {}, cwd: dir, configPath }, spec)).toBe(true);
  });

  it("is true when any prefixed env var is set", async () => {
    const env = { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:abc" };
    expect(await isChannelConfigured({ env, cwd: dir, configPath }, spec)).toBe(true);
  });

  it("ignores unrelated env vars", async () => {
    const env = { MONO_AGENT_MODEL: "claude:claude-sonnet-4-6" };
    expect(await isChannelConfigured({ env, cwd: dir, configPath }, spec)).toBe(false);
  });

  it("is true when the channel's folder exists (cron/, webhook/)", async () => {
    const cronSpec = { jsonKey: "cron", envPrefix: "MONO_AGENT_CRON_", dir: "cron" };
    expect(await isChannelConfigured({ env: {}, cwd: dir, configPath }, cronSpec)).toBe(false);
    await mkdir(join(dir, "cron"));
    expect(await isChannelConfigured({ env: {}, cwd: dir, configPath }, cronSpec)).toBe(true);
  });
});

describe("unconfigured drivers answer with the adapter loader's own empty-input output", () => {
  // Drift guard: if an adapter changes its empty-input defaults, the driver's
  // synthetic UNCONFIGURED_* constant must change with it — this test fails
  // until they match again.
  it("deep-equals each real loader's result on empty input", async () => {
    const input = { env: {}, cwd: dir, configPath };
    const drivers = new Map(defaultChannelDrivers().map((driver) => [driver.id, driver]));
    const empty = { env: {}, json: {}, cwd: dir };

    expect(await drivers.get("telegram")!.loadConfig(input)).toEqual(await loadTelegramAdapterConfig(empty));
    expect(await drivers.get("slack")!.loadConfig(input)).toEqual(await loadSlackAdapterConfig(empty));
    expect(await drivers.get("webhook")!.loadConfig(input)).toEqual(await loadWebhookAdapterConfig(empty));
    expect(await drivers.get("openai-api")!.loadConfig(input)).toEqual(await loadOpenAIApiAdapterConfig(empty));
    expect(await drivers.get("cron")!.loadConfig(input)).toEqual(await loadCronAdapterConfig(empty));
  });

  it("tui is the deliberate exception: ungated, and its empty-input default is ENABLED", async () => {
    // The TUI stream endpoint is an operator surface (loopback-only, ephemeral
    // port), so with no `tui` section it still starts — `mono-agent tui` must
    // reach any running agent without a config edit.
    const tui = defaultChannelDrivers().find((driver) => driver.id === "tui")!;

    const config = await tui.loadConfig({ env: {}, cwd: dir, configPath });
    expect(config).toEqual(await loadTuiAdapterConfig({ env: {} }));
    expect((config as { enabled: boolean }).enabled).toBe(true);
    expect(tui.disabledReason?.(config)).toBeUndefined();

    // The opt-out still works through the same loader.
    await writeFile(configPath, JSON.stringify({ tui: { enabled: false } }));
    const disabled = await tui.loadConfig({ env: {}, cwd: dir, configPath });
    expect(tui.disabledReason?.(disabled)).toBeDefined();
  });

  it("still runs the real loader for a present-but-disabled section (malformed sections keep erroring)", async () => {
    // allowedChatIds must be an array; with the section present the REAL loader
    // must parse (and reject) it — the gate must not swallow this into a synthetic.
    await writeFile(configPath, JSON.stringify({ telegram: { enabled: false, pollWatchdogMs: "not-a-number" } }));
    const telegram = defaultChannelDrivers().find((driver) => driver.id === "telegram")!;
    // enabled:false short-circuits before pollWatchdogMs parsing in the real
    // loader, so this loads fine — but through the real code path: the loaded
    // config echoes the section (not the synthetic constant shape assertion
    // below would catch a swallowed parse).
    const config = (await telegram.loadConfig({ env: {}, cwd: dir, configPath })) as { enabled: boolean };
    expect(config.enabled).toBe(false);

    // A malformed env value errors exactly as before (env values are parsed
    // strictly, unlike wrong-typed JSON values which the layerer drops), and
    // isConfigError recognizes the adapter's typed error — the throwing load
    // populated the lazily-cached module, so the instanceof check works.
    const badEnv = { MONO_AGENT_TELEGRAM_ENABLED: "yes-please" };
    await expect(telegram.loadConfig({ env: badEnv, cwd: dir, configPath })).rejects.toThrow(/MONO_AGENT_TELEGRAM_ENABLED/u);
    const error = await telegram.loadConfig({ env: badEnv, cwd: dir, configPath }).catch((e: unknown) => e);
    expect(telegram.isConfigError(error)).toBe(true);
  });
});
