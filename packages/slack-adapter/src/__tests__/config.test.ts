import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSlackAdapterConfig,
  SlackAdapterConfigError,
} from "../config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-slack-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSlackAdapterConfig", () => {
  it("loads adapter-owned Slack settings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111", "C222"],
          botUserIds: ["Ubot"],
          mentionTextAliases: ["@mono"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config).toEqual({
      enabled: true,
      botToken: "json-bot-token",
      appToken: "json-app-token",
      allowedChannelIds: ["D111", "C222"],
      allowAllChannels: false,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stripMentionText: true,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("loads Socket Mode resilience tuning from JSON and lets env override it", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowAllChannels: true,
          heartbeatIntervalMs: 15000,
          heartbeatTimeoutMs: 120000,
          reconnectInitialBackoffMs: 250,
          reconnectMaxBackoffMs: 20000,
          reconnectStabilityMs: 45000,
          reconnectStartupGraceMs: 8000,
          drainDeadlineMs: 4000,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });
    expect(config.heartbeatIntervalMs).toBe(15000);
    expect(config.heartbeatTimeoutMs).toBe(120000);
    expect(config.reconnectInitialBackoffMs).toBe(250);
    expect(config.reconnectMaxBackoffMs).toBe(20000);
    expect(config.reconnectStabilityMs).toBe(45000);
    expect(config.reconnectStartupGraceMs).toBe(8000);
    expect(config.drainDeadlineMs).toBe(4000);

    // env wins over JSON.
    const overridden = await loadSlackAdapterConfig({
      env: { MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS: "60000" },
      jsonPath: path,
    });
    expect(overridden.reconnectMaxBackoffMs).toBe(60000);
  });

  it("defaults Socket Mode tuning to undefined when unset (runner defaults apply)", async () => {
    const config = await loadSlackAdapterConfig({
      env: {
        MONO_AGENT_SLACK_ENABLED: "true",
        MONO_AGENT_SLACK_BOT_TOKEN: "b",
        MONO_AGENT_SLACK_APP_TOKEN: "a",
        MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true",
      },
    });
    expect(config.reconnectMaxBackoffMs).toBeUndefined();
    expect(config.heartbeatTimeoutMs).toBeUndefined();
  });

  it("rejects a non-integer Socket Mode tuning value", async () => {
    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_ENABLED: "true",
          MONO_AGENT_SLACK_BOT_TOKEN: "b",
          MONO_AGENT_SLACK_APP_TOKEN: "a",
          MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true",
          MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS: "soon",
        },
      }),
    ).rejects.toThrow(SlackAdapterConfigError);
  });

  it("lets env override JSON and supports explicit allow-all", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["C111"],
          stripMentionText: true,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({
      env: {
        MONO_AGENT_SLACK_ENABLED: "true",
        MONO_AGENT_SLACK_BOT_TOKEN: "env-bot-token",
        MONO_AGENT_SLACK_APP_TOKEN: "env-app-token",
        MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS: "",
        MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true",
        MONO_AGENT_SLACK_BOT_USER_IDS: "U1, U2",
        MONO_AGENT_SLACK_MENTION_TEXT_ALIASES: "@agent, Assistant",
        MONO_AGENT_SLACK_STRIP_MENTION_TEXT: "false",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      botToken: "env-bot-token",
      appToken: "env-app-token",
      allowedChannelIds: [],
      allowAllChannels: true,
      botUserIds: ["U1", "U2"],
      mentionTextAliases: ["@agent", "Assistant"],
      stripMentionText: false,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("requires tokens and an explicit allowlist or allow-all choice when enabled", async () => {
    await expect(
      loadSlackAdapterConfig({ env: { MONO_AGENT_SLACK_ENABLED: "true", MONO_AGENT_SLACK_BOT_TOKEN: "bot-token" } }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);

    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_ENABLED: "true",
          MONO_AGENT_SLACK_BOT_TOKEN: "bot-token",
          MONO_AGENT_SLACK_APP_TOKEN: "app-token",
        },
      }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);
  });

  it("is disabled by default and skips credential validation", async () => {
    const config = await loadSlackAdapterConfig({ env: {} });
    expect(config).toEqual({
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds: [],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("defaults mention stripping on for either native bot IDs or text aliases", async () => {
    const [withoutMentionIdentity, withBotUserId, withTextAlias] = await Promise.all([
      loadSlackAdapterConfig({ env: {} }),
      loadSlackAdapterConfig({ env: { MONO_AGENT_SLACK_BOT_USER_IDS: "U0BOT" } }),
      loadSlackAdapterConfig({ env: { MONO_AGENT_SLACK_MENTION_TEXT_ALIASES: "@agent" } }),
    ]);

    expect(withoutMentionIdentity.stripMentionText).toBe(false);
    expect(withBotUserId.stripMentionText).toBe(true);
    expect(withTextAlias.stripMentionText).toBe(true);
  });

  it("ignores malformed shortcuts config while disabled", async () => {
    const config = await loadSlackAdapterConfig({
      env: {},
      json: {
        slack: {
          enabled: false,
          shortcuts: { callbackId: "sync_now", prompt: "Run the sync." },
        },
      },
    });

    expect(config).toEqual({
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds: [],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("ignores malformed homeTab config while disabled", async () => {
    const config = await loadSlackAdapterConfig({
      env: {},
      json: {
        slack: {
          enabled: false,
          homeTab: "not-an-object",
        },
      },
    });

    expect(config).toEqual({
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds: [],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("loads slack.shortcuts bindings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D111" }],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config.shortcuts).toEqual([
      { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D111" },
    ]);
  });

  it("rejects a malformed slack.shortcuts entry", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "", prompt: "missing id" }],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("loads slack.homeTab config from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: {
            enabled: true,
            headerText: "Controls",
            buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D111" }],
          },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config.homeTab).toEqual({
      enabled: true,
      headerText: "Controls",
      buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D111" }],
    });
  });

  it("rejects a malformed slack.homeTab button", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, buttons: [{ actionId: "sync_now", prompt: "no label" }] },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("carries threadReply through on a Home button and a shortcut", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D111", ackText: "…", threadReply: true }],
          homeTab: {
            enabled: true,
            buttons: [{ actionId: "draft", label: "📝 Draft", prompt: "Draft it.", channelId: "D111", ackText: "…", threadReply: true }],
          },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config.shortcuts[0]?.threadReply).toBe(true);
    expect(config.homeTab.buttons[0]?.threadReply).toBe(true);
  });

  it("rejects a non-boolean slack.homeTab button threadReply", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, buttons: [{ actionId: "draft", label: "📝", prompt: "Draft it.", ackText: "…", threadReply: "yes" }] },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects a non-boolean slack.shortcuts threadReply", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "sync_now", prompt: "Run.", ackText: "…", threadReply: 1 }],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects threadReply without ackText (nothing to thread under) on a button and a shortcut", async () => {
    const buttonPath = join(dir, "button.config.json");
    await writeFile(
      buttonPath,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, buttons: [{ actionId: "draft", label: "📝", prompt: "Draft it.", threadReply: true }] },
        },
      })}\n`,
      "utf8",
    );
    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: buttonPath })).rejects.toMatchObject({
      code: "invalid_config",
    });

    const shortcutPath = join(dir, "shortcut.config.json");
    await writeFile(
      shortcutPath,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "sync_now", prompt: "Run.", threadReply: true }],
        },
      })}\n`,
      "utf8",
    );
    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: shortcutPath })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects duplicate slack.shortcuts callbackId", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          shortcuts: [
            { callbackId: "dup", prompt: "one", channelId: "D111" },
            { callbackId: "dup", prompt: "two", channelId: "D111" },
          ],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects duplicate slack.homeTab actionId", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          homeTab: {
            enabled: true,
            buttons: [
              { actionId: "dup", label: "A", prompt: "one", channelId: "D111" },
              { actionId: "dup", label: "B", prompt: "two", channelId: "D111" },
            ],
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects an enabled homeTab with no buttons and no headerText", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: { enabled: true, botToken: "b", appToken: "a", allowedChannelIds: ["D111"], homeTab: { enabled: true } },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("accepts an enabled header-only homeTab (no buttons)", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, headerText: "Welcome" },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });
    expect(config.homeTab).toEqual({ enabled: true, headerText: "Welcome", buttons: [] });
  });

  it("rejects invalid booleans", async () => {
    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_BOT_TOKEN: "bot-token",
          MONO_AGENT_SLACK_APP_TOKEN: "app-token",
          MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "sometimes",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});
