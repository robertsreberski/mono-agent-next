import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWhatsAppAdapterConfig,
  redactWhatsAppAdapterConfig,
  WhatsAppAdapterConfigError,
} from "../config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-whatsapp-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadWhatsAppAdapterConfig", () => {
  it("loads adapter-owned WhatsApp settings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        whatsapp: {
          enabled: true,
          allowedChatJids: ["123@s.whatsapp.net", "456@g.us"],
          groupMode: "mention",
          botJids: ["999@s.whatsapp.net"],
          mentionTextAliases: ["@mono"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWhatsAppAdapterConfig({ env: {}, jsonPath: path });
    expect(config).toEqual({
      enabled: true,
      allowedChatJids: ["123@s.whatsapp.net", "456@g.us"],
      allowAllChats: false,
      trigger: {
        groupMode: "mention",
        botJids: ["999@s.whatsapp.net"],
        mentionTextAliases: ["@mono"],
        stripMentionText: true,
      },
    });
  });

  it("lets env override JSON and supports group-any mode", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        whatsapp: {
          allowedChatJids: ["123@s.whatsapp.net"],
          groupMode: "mention",
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWhatsAppAdapterConfig({
      env: {
        MONO_AGENT_WHATSAPP_ENABLED: "true",
        MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS: "",
        MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS: "true",
        MONO_AGENT_WHATSAPP_GROUP_MODE: "any",
        MONO_AGENT_WHATSAPP_BOT_JIDS: "bot@s.whatsapp.net",
        MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES: "@agent,Assistant",
        MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT: "false",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      allowedChatJids: [],
      allowAllChats: true,
      trigger: {
        groupMode: "any",
        botJids: ["bot@s.whatsapp.net"],
        mentionTextAliases: ["@agent", "Assistant"],
        stripMentionText: false,
      },
    });
  });

  it("requires either an explicit allowlist or explicit allow-all choice when enabled", async () => {
    await expect(
      loadWhatsAppAdapterConfig({ env: { MONO_AGENT_WHATSAPP_ENABLED: "true" } }),
    ).rejects.toBeInstanceOf(WhatsAppAdapterConfigError);
  });

  it("is disabled by default and skips allowlist validation", async () => {
    const config = await loadWhatsAppAdapterConfig({ env: {} });
    expect(config).toEqual({
      enabled: false,
      allowedChatJids: [],
      allowAllChats: false,
      trigger: {
        groupMode: "mention",
        botJids: [],
        mentionTextAliases: [],
        stripMentionText: false,
      },
    });
  });

  it("defaults mention stripping on only for text aliases, not bot JIDs", async () => {
    const [withoutMentionIdentity, withBotJid, withTextAlias] = await Promise.all([
      loadWhatsAppAdapterConfig({ env: {} }),
      loadWhatsAppAdapterConfig({ env: { MONO_AGENT_WHATSAPP_BOT_JIDS: "bot@s.whatsapp.net" } }),
      loadWhatsAppAdapterConfig({ env: { MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES: "@agent" } }),
    ]);

    expect(withoutMentionIdentity.trigger.stripMentionText).toBe(false);
    expect(withBotJid.trigger.stripMentionText).toBe(false);
    expect(withTextAlias.trigger.stripMentionText).toBe(true);
  });

  it("rejects invalid group modes", async () => {
    await expect(
      loadWhatsAppAdapterConfig({
        env: {
          MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS: "true",
          MONO_AGENT_WHATSAPP_GROUP_MODE: "sometimes",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactWhatsAppAdapterConfig", () => {
  it("reports sensitive identifiers only by count", () => {
    const redacted = redactWhatsAppAdapterConfig({
      enabled: true,
      allowedChatJids: ["123@s.whatsapp.net"],
      allowAllChats: false,
      trigger: {
        groupMode: "mention",
        botJids: ["bot@s.whatsapp.net"],
        mentionTextAliases: ["@mono"],
        stripMentionText: true,
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("123@s.whatsapp.net");
    expect(JSON.stringify(redacted)).not.toContain("bot@s.whatsapp.net");
    expect(redacted).toEqual({
      enabled: true,
      allowedChatJids: { count: 1 },
      allowAllChats: false,
      trigger: {
        groupMode: "mention",
        botJids: { count: 1 },
        mentionTextAliases: { count: 1 },
        stripMentionText: true,
      },
    });
  });
});
