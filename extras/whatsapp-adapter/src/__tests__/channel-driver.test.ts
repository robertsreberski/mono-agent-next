import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  ChannelLogger,
  ChannelStartInput,
} from "@mono-agent/agent-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import {
  createChannelDriver,
  createWhatsAppChannelDriver,
  type WhatsAppChannelDriverConfig,
} from "../channel-driver.js";
import {
  WhatsAppAdapterConfigError,
  type WhatsAppAdapterConfig,
} from "../config.js";
import { createChannelDriver as createChannelDriverFromIndex } from "../index.js";
import type {
  StartWhatsAppAdapterOptions,
  WhatsAppAdapterStartResult,
  WhatsAppSocketFactory,
} from "../start.js";

type StartAdapter = (
  options: StartWhatsAppAdapterOptions,
) => Promise<WhatsAppAdapterStartResult>;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-whatsapp-channel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createWhatsAppChannelDriver", () => {
  it("uses the default channel id and label and honors overrides", () => {
    const driver = createWhatsAppChannelDriver();
    const custom = createWhatsAppChannelDriver({
      id: "custom-whatsapp",
      label: "Custom WhatsApp",
    });

    expect(driver.id).toBe("whatsapp");
    expect(driver.label).toBe("WhatsApp");
    expect(custom.id).toBe("custom-whatsapp");
    expect(custom.label).toBe("Custom WhatsApp");
  });

  it("exports the createChannelDriver alias through the package barrel", () => {
    const driver = createChannelDriverFromIndex();

    expect(driver.id).toBe("whatsapp");
    expect(driver.label).toBe("WhatsApp");
  });

  it("loads disabled config without touching the start seams", async () => {
    const startAdapter = vi.fn<StartAdapter>(async () => fakeStartResult());
    const socketFactory = vi.fn() as unknown as WhatsAppSocketFactory;
    const driver = createWhatsAppChannelDriver({ startAdapter, socketFactory });

    const config = await driver.loadConfig(configInput());

    expect(config).toEqual(disabledConfig());
    expect(driver.disabledReason?.(config)).toBe("WhatsApp is disabled.");
    expect(startAdapter).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("loads adapter config from a present configPath when raw config is absent", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        whatsapp: {
          enabled: true,
          allowAllChats: true,
          groupMode: "any",
          botJids: ["bot@s.whatsapp.net"],
          mentionTextAliases: ["@mono"],
          stripMentionText: false,
        },
      })}\n`,
      "utf8",
    );
    const driver = createWhatsAppChannelDriver();

    const config = await driver.loadConfig(configInput({ configPath }));

    expect(config).toEqual({
      enabled: true,
      allowedChatJids: [],
      allowAllChats: true,
      trigger: {
        groupMode: "any",
        botJids: ["bot@s.whatsapp.net"],
        mentionTextAliases: ["@mono"],
        stripMentionText: false,
      },
    });
  });

  it("classifies enabled incomplete config as a WhatsApp config error", async () => {
    const driver = createWhatsAppChannelDriver();
    let caught: unknown;

    try {
      await driver.loadConfig(
        configInput({
          env: {
            MONO_AGENT_WHATSAPP_ENABLED: "true",
            MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS: "false",
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(driver.isConfigError(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: "missing_required_config",
      details: { env: "MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS" },
    });
  });

  it.each(invalidRawConfigCases)(
    "rejects wrong-typed raw plugin config field $name",
    async ({ config, field }) => {
      const driver = createWhatsAppChannelDriver({ config });

      const error = await driver.loadConfig(configInput()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WhatsAppAdapterConfigError);
      expect(driver.isConfigError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "invalid_config",
        details: { field },
      });
    },
  );

  it("wires start options, default authDir, socket seam, QR logging, and stop", async () => {
    const stop = vi.fn(async () => undefined);
    const startAdapter = vi.fn<StartAdapter>(async () => fakeStartResult(stop));
    const socketFactory = vi.fn() as unknown as WhatsAppSocketFactory;
    const driver = createWhatsAppChannelDriver({ startAdapter, socketFactory });
    const config = enabledConfig();
    const responder = fakeResponder();
    const logger = fakeLogger();

    const running = await driver.start(startInput({ config, responder, logger }));

    expect(running.summary).toEqual({});
    expect(startAdapter).toHaveBeenCalledTimes(1);
    const options = firstStartAdapterOptions(startAdapter);
    expect(options.authDir).toBe(resolve(dir, ".mono-agent", "whatsapp-auth"));
    expect(options.config).toBe(config);
    expect(options.responder).toBe(responder);
    expect(options.logger).toBe(logger);
    expect(options.createSocket).toBe(socketFactory);

    await options.onQr?.("qr-payload");
    expect(logger.info).toHaveBeenCalledWith(
      "WhatsApp login QR code received; scan it with the WhatsApp app.",
      { qr: "qr-payload" },
    );

    await running.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("honors authDir overrides", async () => {
    const startAdapter = vi.fn<StartAdapter>(async () => fakeStartResult());
    const driver = createWhatsAppChannelDriver({
      authDir: "/custom/whatsapp-auth",
      startAdapter,
    });

    await driver.start(startInput({ config: enabledConfig() }));

    expect(firstStartAdapterOptions(startAdapter).authDir).toBe("/custom/whatsapp-auth");
  });

  it("loads plugin-style raw config and still lets env override it", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        whatsapp: {
          enabled: false,
          allowedChatJids: ["file@s.whatsapp.net"],
          groupMode: "mention",
        },
      })}\n`,
      "utf8",
    );

    const driver = createChannelDriver({
      config: {
        enabled: false,
        allowedChatJids: ["plugin@s.whatsapp.net"],
        allowAllChats: false,
        groupMode: "mention",
      },
    });

    const config = await driver.loadConfig(
      configInput({
        configPath,
        env: {
          MONO_AGENT_WHATSAPP_ENABLED: "true",
          MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS: "env@s.whatsapp.net",
          MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS: "true",
          MONO_AGENT_WHATSAPP_GROUP_MODE: "any",
        },
      }),
    );

    expect(config).toEqual({
      enabled: true,
      allowedChatJids: ["env@s.whatsapp.net"],
      allowAllChats: true,
      trigger: {
        groupMode: "any",
        botJids: [],
        mentionTextAliases: [],
        stripMentionText: false,
      },
    });
    expect(driver.disabledReason?.(config)).toBeUndefined();
  });

  it("reports config view fields with file and env provenance", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        whatsapp: {
          enabled: true,
          allowedChatJids: ["file@s.whatsapp.net"],
          allowAllChats: false,
          groupMode: "mention",
          botJids: ["bot@s.whatsapp.net"],
        },
      })}\n`,
      "utf8",
    );
    const driver = createWhatsAppChannelDriver();

    const section = await driver.configView!({
      env: { MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS: "true" },
      cwd: dir,
      configPath,
    });

    expect(section).toMatchObject({ id: "whatsapp", label: "WhatsApp", status: "active" });
    const fields = new Map(section.fields.map((field) => [field.id, field]));
    expect(fields.get("whatsapp.enabled")).toMatchObject({ value: "true", source: "json" });
    expect(fields.get("whatsapp.allowedChatJids")).toMatchObject({ value: "file@s.whatsapp.net", source: "json" });
    expect(fields.get("whatsapp.allowAllChats")).toMatchObject({ value: "true", source: "env" });
    expect(fields.get("whatsapp.stripMentionText")).toMatchObject({ value: "\u2014", source: "default" });
  });

  it("reports config view fields from plugin-style raw config", async () => {
    const driver = createChannelDriver({
      id: "custom-whatsapp",
      label: "Custom WhatsApp",
      config: {
        enabled: false,
        allowedChatJids: ["plugin@s.whatsapp.net"],
        allowAllChats: false,
        groupMode: "mention",
      },
    });

    const section = await driver.configView!(configInput());

    expect(section).toMatchObject({ id: "custom-whatsapp", label: "Custom WhatsApp", status: "disabled" });
    const fields = new Map(section.fields.map((field) => [field.id, field]));
    expect(fields.get("whatsapp.enabled")).toMatchObject({ value: "false", source: "json" });
    expect(fields.get("whatsapp.allowedChatJids")).toMatchObject({ value: "plugin@s.whatsapp.net", source: "json" });
  });
});

const invalidRawConfigCases: readonly {
  readonly name: string;
  readonly config: WhatsAppChannelDriverConfig;
  readonly field: string;
}[] = [
  {
    name: "enabled",
    config: { enabled: "true" },
    field: "whatsapp.enabled",
  },
  {
    name: "allowAllChats",
    config: { allowAllChats: "true" },
    field: "whatsapp.allowAllChats",
  },
  {
    name: "allowedChatJids",
    config: { allowedChatJids: "jid@s.whatsapp.net" },
    field: "whatsapp.allowedChatJids",
  },
  {
    name: "botJids",
    config: { botJids: "bot@s.whatsapp.net" },
    field: "whatsapp.botJids",
  },
  {
    name: "mentionTextAliases",
    config: { mentionTextAliases: "@mono" },
    field: "whatsapp.mentionTextAliases",
  },
];

function configInput(overrides: {
  readonly env?: Record<string, string | undefined>;
  readonly configPath?: string;
} = {}) {
  return {
    env: overrides.env ?? {},
    cwd: dir,
    configPath: overrides.configPath ?? join(dir, "missing-config.json"),
  };
}

function startInput(
  overrides: {
    readonly config: WhatsAppAdapterConfig;
    readonly responder?: AgentResponder;
    readonly logger?: ChannelLogger;
  },
): ChannelStartInput<WhatsAppAdapterConfig> {
  return {
    config: overrides.config,
    coreConfig: {},
    responder: overrides.responder ?? fakeResponder(),
    cwd: dir,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    onFailure: vi.fn(),
  };
}

function enabledConfig(): WhatsAppAdapterConfig {
  return {
    enabled: true,
    allowedChatJids: ["123@s.whatsapp.net"],
    allowAllChats: false,
    trigger: {
      groupMode: "mention",
      botJids: [],
      mentionTextAliases: [],
      stripMentionText: false,
    },
  };
}

function disabledConfig(): WhatsAppAdapterConfig {
  return {
    enabled: false,
    allowedChatJids: [],
    allowAllChats: false,
    trigger: {
      groupMode: "mention",
      botJids: [],
      mentionTextAliases: [],
      stripMentionText: false,
    },
  };
}

function fakeResponder(): AgentResponder {
  return { respond: vi.fn(async () => ({ text: "ok" })) };
}

function fakeLogger(): ChannelLogger {
  return {
    info: vi.fn(),
  };
}

function firstStartAdapterOptions(
  startAdapter: ReturnType<typeof vi.fn<StartAdapter>>,
): StartWhatsAppAdapterOptions {
  const call = startAdapter.mock.calls[0];
  if (call === undefined) {
    throw new Error("Expected startAdapter to be called.");
  }
  return call[0];
}

function fakeStartResult(stop = vi.fn(async () => undefined)): WhatsAppAdapterStartResult {
  return {
    adapter: {} as WhatsAppAdapterStartResult["adapter"],
    runner: {} as WhatsAppAdapterStartResult["runner"],
    socket: {} as WhatsAppAdapterStartResult["socket"],
    stop,
  };
}
