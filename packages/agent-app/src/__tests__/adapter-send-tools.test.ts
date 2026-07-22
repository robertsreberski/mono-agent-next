import { link, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { createAgentHarness, createAgentResponder, createInMemoryHistoryStore } from "@mono-agent/agent-harness";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { SlackAdapter } from "@mono-agent/slack-adapter";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackRequestOptions,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import { TelegramApiError } from "@mono-agent/telegram-adapter";
import type {
  TelegramEditMessageTextParams,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelDriver } from "../channels.js";
import { startMonoAgentApp } from "../app.js";
import {
  createAdapterSendProxy,
  safeAdapterSendProxyErrorMessage,
} from "../adapter-send-proxy.js";
import {
  ADAPTER_SEND_TOOLS_MCP_SERVER_NAME,
  adapterSendToolsChildConfigFromEnv,
  adapterSendToolNames,
  adapterSendToolsMcpEnv,
  adapterSendToolsMcpServerSpec,
  createAdapterSendToolsRuntimeExtension,
  createAdapterSendToolsClients,
  createAdapterSendToolsServer,
  isAdapterSendToolAllowed,
  resolveAdapterSendToolsSettings,
} from "../adapter-send-tools.js";
import type { AdapterSendToolsSettings } from "../adapter-send-tools.js";
import { lookupProducingConversation, resolvePostedMessageIndexPath } from "../posted-message-index.js";
import { startInteractionBridge } from "../interaction-bridge.js";
import { createSlackPostedReplyHistory } from "../posted-reply-history.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-adapter-send-tools-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nTest agent.\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isAdapterSendToolAllowed global allow-all", () => {
  it("allows an adapter send tool under the global '*' wildcard", () => {
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["*"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendMessage", { allowedTools: ["*"] })).toBe(true);
  });

  it("lets an explicit deny win over the global '*' wildcard", () => {
    expect(
      isAdapterSendToolAllowed("SlackSendMessage", {
        allowedTools: ["*"],
        disallowedTools: ["SlackSendMessage"],
      }),
    ).toBe(false);
  });

  it("still denies when neither the global '*' nor a matching entry is present", () => {
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: [] })).toBe(false);
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["Read"] })).toBe(false);
  });
});

describe("isAdapterSendToolAllowed legacy snake_case aliases", () => {
  it("accepts BOTH the new PascalCase name and its legacy snake_case alias", () => {
    // New canonical name.
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["SlackSendMessage"] })).toBe(true);
    // Legacy alias in an existing config still enables the renamed tool.
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["slack_send_message"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendMessage", { allowedTools: ["telegram_send_message"] })).toBe(true);
  });

  it("maps BOTH legacy file-tool aliases onto the collapsed TelegramSendFile tool", () => {
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["TelegramSendFile"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["telegram_send_document"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["telegram_send_photo"] })).toBe(true);
  });

  it("honors a deny listing the legacy alias against a new-name allow (and vice versa)", () => {
    expect(
      isAdapterSendToolAllowed("SlackSendMessage", {
        allowedTools: ["SlackSendMessage"],
        disallowedTools: ["slack_send_message"],
      }),
    ).toBe(false);
    expect(
      isAdapterSendToolAllowed("TelegramSendFile", {
        allowedTools: ["telegram_send_photo"],
        disallowedTools: ["TelegramSendFile"],
      }),
    ).toBe(false);
  });
});

describe("resolveAdapterSendToolsSettings", () => {
  it("returns undefined when Slack and Telegram are disabled", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings({ env: {}, cwd: dir, configPath });

    expect(settings).toBeUndefined();
  });

  it("returns enabled Slack and Telegram send tool settings when the tool policy allows them", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1", "D2"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42", "-100"],
      },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["SlackSendMessage", "TelegramSendMessage"] },
    );

    expect(settings).toEqual({
      slack: {
        botToken: "xoxb-slack",
        allowedChannelIds: ["c1", "d2"],
        allowAllChannels: false,
      },
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42", "-100"],
        allowAllChats: false,
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: true, file: false },
      },
    });
    expect(adapterSendToolNames(settings!)).toEqual(["SlackSendMessage", "TelegramSendMessage"]);
  });

  it("does not expose send tools unless tool policy explicitly allows them", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });

    await expect(resolveAdapterSendToolsSettings({ env: {}, cwd: dir, configPath })).resolves.toBeUndefined();
    await expect(resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["SlackSendMessage"], disallowedTools: ["SlackSendMessage"] },
    )).resolves.toBeUndefined();
    await expect(resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      {
        allowedTools: ["mcp__mono-agent-adapter-send__*"],
        disallowedTools: ["mcp__mono-agent-adapter-send__*"],
      },
    )).resolves.toBeUndefined();
  });

  it("resolves the collapsed TelegramSendFile tool from a legacy telegram_send_photo config entry", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["telegram_send_photo"] },
    );

    expect(settings?.telegram).toMatchObject({ tools: { send: false, file: true } });
    expect(adapterSendToolNames(settings!)).toEqual(["TelegramSendFile"]);
  });

  it("skips an invalid enabled adapter without exposing a partial broken tool", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: { enabled: true, botToken: "xoxb-slack", appToken: "xapp-slack" },
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });
    const warnings: string[] = [];

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      {
        allowedTools: ["SlackSendMessage", "TelegramSendMessage"],
        logger: { warn: (message) => { warnings.push(message); } },
      },
    );

    expect(settings?.slack).toBeUndefined();
    expect(settings?.telegram).toMatchObject({ botToken: "telegram-token", allowedChatIds: ["42"] });
    expect(warnings).toEqual(["Slack send tool skipped because Slack adapter config is unavailable."]);
  });
});

describe("adapter send tools MCP spec/env", () => {
  it("passes only the config path through child-process env and points at the adapter-send entrypoint", () => {
    const allowedTools = ["SlackSendMessage"];
    const env = adapterSendToolsMcpEnv("/agent/mono-agent.config.json", allowedTools);
    const spec = adapterSendToolsMcpServerSpec("/agent/mono-agent.config.json", "/agent", allowedTools);

    expect(adapterSendToolsChildConfigFromEnv(env, "/agent")).toEqual({
      input: {
        env,
        cwd: "/agent",
        configPath: "/agent/mono-agent.config.json",
      },
      allowedTools,
    });
    expect(spec.type).toBe("stdio");
    expect(spec.command).toBe(process.execPath);
    expect(spec.cwd).toBe("/agent");
    expect((spec.args as string[])[0]).toBe("--use-bundled-ca");
    expect(String((spec.args as string[]).at(-1))).toMatch(/adapter-send-tools-main\.js$/u);
    expect(spec.env).toEqual({
      MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: "/agent/mono-agent.config.json",
      MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
      MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL: "",
      MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN: "",
    });
    expect(spec.env).not.toHaveProperty("HTTP_PROXY");
    expect(spec.env).not.toHaveProperty("HTTPS_PROXY");
    expect((spec as Record<PropertyKey, unknown>)[Symbol.for("@mono-agent/app-owned-local-binding")]).toBe(true);
    expect(JSON.stringify(spec.env)).not.toContain("xoxb-slack");
    expect(JSON.stringify(spec.env)).not.toContain("telegram-token");
    expect(JSON.stringify(spec.args)).not.toContain("xoxb-slack");
    expect(JSON.stringify(spec.args)).not.toContain("telegram-token");
    expect(JSON.stringify(spec)).not.toContain("local-binding");
  });

  it("forwards the producing conversation id and index path when indexing is configured, and parses them back", () => {
    const allowedTools = ["SlackSendMessage"];
    const indexing = { conversationId: "scheduled-scan#2026-06-22", indexPath: "/agent/artifacts/posted-message-index.jsonl" };
    const env = adapterSendToolsMcpEnv("/agent/mono-agent.config.json", allowedTools, indexing);

    expect(env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: indexing.conversationId,
      MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: indexing.indexPath,
    });
    expect(adapterSendToolsChildConfigFromEnv(env, "/agent").indexing).toEqual(indexing);
  });

  it("always forwards the producing run and exact conversation id for interaction history", async () => {
    const extension = createAdapterSendToolsRuntimeExtension("/agent/mono-agent.config.json", "/agent", ["AskUser"]);

    const result = await extension({
      runId: "run-env-wiring",
      request: { conversationId: "telegram:42#2026-07-02" },
    });

    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID).toBe("telegram:42#2026-07-02");
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID).toBe("run-env-wiring");
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH).toBeUndefined();
  });

  it("pins and removes adapter-only run output at settlement, idempotently", async () => {
    const outputRoot = join(dir, "outbound");
    const extension = createAdapterSendToolsRuntimeExtension(
      "/agent/mono-agent.config.json",
      "/agent",
      ["TelegramSendFile"],
      undefined,
      undefined,
      outputRoot,
    );
    const result = await extension({ runId: "run-output-cleanup", request: { conversationId: "telegram:42" } });
    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    const runOutputDir = spec.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR as string;
    const before = await lstat(runOutputDir);
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DEV).toBe(String(before.dev));
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_INO).toBe(String(before.ino));

    await result.cleanup();
    expect((await lstat(runOutputDir)).isDirectory()).toBe(true);
    await result.settleCleanup?.();
    await expect(lstat(runOutputDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(result.settleCleanup?.()).resolves.toBeUndefined();
  });

  it("never deletes a replacement directory during adapter output cleanup", async () => {
    const extension = createAdapterSendToolsRuntimeExtension(
      "/agent/mono-agent.config.json",
      "/agent",
      ["TelegramSendFile"],
      undefined,
      undefined,
      join(dir, "outbound"),
    );
    const result = await extension({ runId: "run-output-replaced", request: { conversationId: "telegram:42" } });
    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    const runOutputDir = spec.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR as string;
    await rename(runOutputDir, `${runOutputDir}-original`);
    await mkdir(runOutputDir);
    await writeFile(join(runOutputDir, "belongs-to-someone-else"), "keep", "utf8");

    await result.settleCleanup?.();

    expect((await lstat(join(runOutputDir, "belongs-to-someone-else"))).isFile()).toBe(true);
  });

  it("forwards interaction bridge env into stdio children for blocking ask tools", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });
    const interaction = {
      bridgeUrl: "http://127.0.0.1:43123",
      bridgeToken: "bridge-token",
      timeoutMs: 123_000,
    };
    const extension = createAdapterSendToolsRuntimeExtension(
      configPath,
      dir,
      ["AskUser"],
      undefined,
      interaction,
    );

    const result = await extension({
      runId: "run-bridge-env",
      request: {
        conversationId: "cron:morning-briefing#today",
        replyTo: { conversationId: "telegram:42" },
      },
    });

    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    expect(spec.env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: "cron:morning-briefing#today",
      MONO_AGENT_ADAPTER_TOOLS_INTERACTION_CONVERSATION_ID: "telegram:42",
      MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID: "run-bridge-env",
      MONO_AGENT_INTERACTION_BRIDGE_URL: interaction.bridgeUrl,
      MONO_AGENT_INTERACTION_BRIDGE_TOKEN: interaction.bridgeToken,
      MONO_AGENT_ASK_USER_TIMEOUT_MS: "123000",
    });
    const settings = await resolveAdapterSendToolsSettings(
      { env: spec.env, cwd: dir, configPath },
      { allowedTools: ["AskUser"] },
    );
    expect(settings?.askUser).toEqual({
      bridgeUrl: interaction.bridgeUrl,
      bridgeToken: interaction.bridgeToken,
      timeoutMs: interaction.timeoutMs,
      producerConversationId: "cron:morning-briefing#today",
      interactionConversationId: "telegram:42",
      runId: "run-bridge-env",
    });
  });

  it("forwards and revokes a run-scoped history capability only for send tools", async () => {
    const release = vi.fn();
    const issueDeliveryHistoryCapability = vi.fn(() => ({
      url: "http://127.0.0.1:43124",
      token: "history-token",
      release,
    }));
    const extension = createAdapterSendToolsRuntimeExtension(
      "/agent/mono-agent.config.json",
      "/agent",
      ["SlackSendMessage", "TelegramSendMessage"],
      undefined,
      undefined,
      undefined,
      { issueDeliveryHistoryCapability },
    );

    const result = await extension({ runId: "run-history-env", request: { conversationId: "cron:scan" } });
    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    expect(spec.env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL: "http://127.0.0.1:43124",
      MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN: "history-token",
    });
    expect(adapterSendToolsChildConfigFromEnv(spec.env, "/agent").deliveryHistory).toEqual({
      bridgeUrl: "http://127.0.0.1:43124",
      bridgeToken: "history-token",
    });
    expect(issueDeliveryHistoryCapability).toHaveBeenCalledWith({
      runId: "run-history-env",
      producerConversationId: "cron:scan",
      allowedChannels: ["slack", "telegram"],
    });
    await result.cleanup();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("adapter send tools sandbox proxy", () => {
  it("redacts authenticated proxy credentials from child diagnostics", () => {
    expect(safeAdapterSendProxyErrorMessage(
      new Error("connect failed via http://srt-user:srt-password@127.0.0.1:43123/path"),
    )).toBe("connect failed via http://[redacted]@127.0.0.1:43123/path");
    expect(safeAdapterSendProxyErrorMessage(
      "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA== request failed",
    )).toBe("Proxy-Authorization: [redacted] request failed");
    expect(safeAdapterSendProxyErrorMessage(
      new Error("invalid proxy opaque-srt-secret"),
      { HTTPS_PROXY: "opaque-srt-secret" },
    )).toBe("invalid proxy [redacted-proxy]");
  });

  it("does not create a dispatcher when no HTTP proxy is configured", () => {
    expect(createAdapterSendProxy({})).toBeUndefined();
  });

  it("preserves lowercase NO_PROXY precedence for non-loopback destinations", async () => {
    let proxyHits = 0;
    const proxy = createServer((_request, response) => {
      proxyHits += 1;
      response.end("unexpected proxy request");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy did not bind");

    const transport = createAdapterSendProxy({
      HTTP_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      no_proxy: "no-proxy.invalid",
      NO_PROXY: "",
    });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      await expect(transport.fetchImpl("http://no-proxy.invalid", {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
      expect(proxyHits).toBe(0);
    } finally {
      await transport.destroy();
      const proxyClosed = once(proxy, "close");
      proxy.close();
      await proxyClosed;
    }
  });

  it("prefers the lowercase proxy variables when both cases are populated", async () => {
    let lowerHits = 0;
    let upperHits = 0;
    const lowerProxy = createServer((_request, response) => {
      lowerHits += 1;
      response.end("lowercase proxy");
    });
    const upperProxy = createServer((_request, response) => {
      upperHits += 1;
      response.end("uppercase proxy");
    });
    lowerProxy.listen(0, "127.0.0.1");
    upperProxy.listen(0, "127.0.0.1");
    await Promise.all([once(lowerProxy, "listening"), once(upperProxy, "listening")]);
    const lowerAddress = lowerProxy.address();
    const upperAddress = upperProxy.address();
    if (lowerAddress === null || typeof lowerAddress === "string") throw new Error("lower proxy did not bind");
    if (upperAddress === null || typeof upperAddress === "string") throw new Error("upper proxy did not bind");

    const transport = createAdapterSendProxy({
      http_proxy: `http://127.0.0.1:${String(lowerAddress.port)}`,
      HTTP_PROXY: `http://127.0.0.1:${String(upperAddress.port)}`,
      no_proxy: "",
    });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      const response = await transport.fetchImpl("http://proxy-precedence.invalid");
      expect(await response.text()).toBe("lowercase proxy");
      expect(lowerHits).toBe(1);
      expect(upperHits).toBe(0);
    } finally {
      await transport.close();
      const lowerClosed = once(lowerProxy, "close");
      lowerProxy.close();
      await lowerClosed;
      const upperClosed = once(upperProxy, "close");
      upperProxy.close();
      await upperClosed;
    }
  });

  it("routes the real Telegram sender through an authenticated proxy on the Node 22.19 floor", async () => {
    const responseBody = JSON.stringify({
      ok: true,
      result: { message_id: 77, chat: { id: 42 }, text: "through proxy" },
    });
    let authenticatedProxyRequests = 0;
    const expectedAuth = `Basic ${Buffer.from("probe:secret").toString("base64")}`;
    const proxy = createServer((request, response) => {
      if (request.headers["proxy-authorization"] === expectedAuth) authenticatedProxyRequests += 1;
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(responseBody)),
        connection: "close",
      });
      response.end(responseBody);
    });
    proxy.on("connect", (request, socket) => {
      if (request.headers["proxy-authorization"] === expectedAuth) authenticatedProxyRequests += 1;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end([
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(responseBody)}`,
          "Connection: close",
          "",
          responseBody,
        ].join("\r\n"));
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("proxy did not bind a TCP port");

    const names = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    // Managed SRT publishes this loopback proxy as localhost. The child must
    // normalize that proxy endpoint without changing its credentials.
    process.env.HTTP_PROXY = `http://probe:secret@localhost:${address.port}`;
    process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
    process.env.NO_PROXY = "";
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;

    let transport: ReturnType<typeof createAdapterSendProxy>;
    try {
      const settings: AdapterSendToolsSettings = {
        telegram: {
          botToken: "123:telegram-token",
          allowedChatIds: ["42"],
          allowAllChats: false,
          apiRoot: "http://mono-agent-proxy-probe.invalid",
          tools: { send: true, file: false },
        },
      };

      // Negative control: grammY's default node-fetch transport does not use
      // the child-owned undici dispatcher, so the deliberately unresolvable
      // API host cannot reach the proxy.
      const directClients = await createAdapterSendToolsClients(settings);
      const directAbort = new AbortController();
      const abortTimer = setTimeout(() => directAbort.abort(), 250);
      try {
        await expect(
          directClients.telegram!.sendMessage!({ chat_id: 42, text: "direct" }, { signal: directAbort.signal }),
        ).rejects.toThrow();
      } finally {
        clearTimeout(abortTimer);
      }
      expect(authenticatedProxyRequests).toBe(0);

      transport = createAdapterSendProxy(process.env);
      if (transport === undefined) throw new Error("expected the child proxy transport");
      const clients = await createAdapterSendToolsClients(settings, { fetchImpl: transport.fetchImpl });
      const result = await clients.telegram!.sendMessage!({ chat_id: 42, text: "through proxy" });

      expect(result).toMatchObject({ message_id: 77, chat: { id: 42 }, text: "through proxy" });
      expect(authenticatedProxyRequests).toBe(1);
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      try {
        await transport?.close();
      } finally {
        const proxyClosed = once(proxy, "close");
        proxy.close();
        await proxyClosed;
      }
    }
  }, 10_000);

  it("routes Slack and Telegram clients through the supplied child fetch", async () => {
    const routedFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const host = new URL(String(input)).hostname;
      return host === "slack.com"
        ? new Response(JSON.stringify({ ok: true, channel: "C1", ts: "171.1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({
            ok: true,
            result: { message_id: 78, chat: { id: 42 }, text: "telegram" },
          }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const clients = await createAdapterSendToolsClients(bothAdaptersSettings(), {
      fetchImpl: routedFetch as unknown as typeof fetch,
    });

    await clients.slack?.chatPostMessage({ channel: "C1", text: "slack" });
    await clients.telegram!.sendMessage!({ chat_id: 42, text: "telegram" });

    expect(routedFetch).toHaveBeenCalledTimes(2);
    expect(routedFetch.mock.calls.map(([input]) => new URL(String(input)).hostname)).toEqual([
      "slack.com",
      "api.telegram.org",
    ]);
  });

  it("preserves streamed multipart and grammY's shim signal for a configured loopback endpoint", async () => {
    let receivedBody = "";
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: { message_id: 79, chat: { id: 42 } } }));
      });
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") throw new Error("target did not bind a TCP port");
    const targetUrl = `http://127.0.0.1:${String(targetAddress.port)}`;

    let proxyConnects = 0;
    const proxy = createServer((_request, response) => {
      proxyConnects += 1;
      response.writeHead(502);
      response.end();
    });
    proxy.on("connect", (_request, socket) => {
      proxyConnects += 1;
      socket.destroy();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy did not bind a TCP port");

    const transport = createAdapterSendProxy({
      HTTP_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      HTTPS_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      NO_PROXY: "127.0.0.1",
    }, { directLoopbackUrls: [targetUrl] });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      const clients = await createAdapterSendToolsClients({
        telegram: {
          botToken: "123:telegram-token",
          allowedChatIds: ["42"],
          allowAllChats: false,
          apiRoot: targetUrl,
          tools: { send: false, file: true },
        },
      }, { fetchImpl: transport.fetchImpl });

      const result = await clients.telegram?.sendDocument?.({
        chat_id: 42,
        document: new Uint8Array([65, 66, 67]),
        filename: "proof.txt",
        caption: "streamed",
      });

      expect(result?.message_id).toBe(79);
      expect(proxyConnects).toBe(0);
      expect(receivedBody).toContain("proof.txt");
      expect(receivedBody).toContain("streamed");
      expect(receivedBody).toContain("ABC");
    } finally {
      await transport?.close();
      const targetClosed = once(target, "close");
      target.close();
      await targetClosed;
      const proxyClosed = once(proxy, "close");
      proxy.close();
      await proxyClosed;
    }
  });

  it("routes a configured IPv6 loopback endpoint directly with SRT's bare NO_PROXY spelling", async () => {
    let proxyHits = 0;
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ipv6-direct");
    });
    target.listen(0, "::1");
    await once(target, "listening");
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") throw new Error("IPv6 target did not bind");
    const targetUrl = `http://[::1]:${String(targetAddress.port)}`;

    const proxy = createServer((_request, response) => {
      proxyHits += 1;
      response.writeHead(502);
      response.end();
    });
    proxy.on("connect", (_request, socket) => {
      proxyHits += 1;
      socket.destroy();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy did not bind");

    const transport = createAdapterSendProxy({
      HTTP_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      HTTPS_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      NO_PROXY: "localhost,127.0.0.1,::1",
    }, { directLoopbackUrls: [targetUrl] });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      const response = await transport.fetchImpl(targetUrl);
      expect(await response.text()).toBe("ipv6-direct");
      expect(proxyHits).toBe(0);
    } finally {
      await transport.close();
      const targetClosed = once(target, "close");
      target.close();
      await targetClosed;
      const proxyClosed = once(proxy, "close");
      proxy.close();
      await proxyClosed;
    }
  });

  it("routes an explicitly configured loopback endpoint through the scoped direct capability", async () => {
    let proxyHits = 0;
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("127-range-direct");
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") throw new Error("127/8 target did not bind");
    const targetUrl = `http://127.0.0.1:${String(targetAddress.port)}`;

    const proxy = createServer((_request, response) => {
      proxyHits += 1;
      response.writeHead(502);
      response.end();
    });
    proxy.on("connect", (_request, socket) => {
      proxyHits += 1;
      socket.destroy();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy did not bind");

    const transport = createAdapterSendProxy({
      HTTP_PROXY: `http://127.0.0.1:${String(proxyAddress.port)}`,
      NO_PROXY: "",
    }, { directLoopbackUrls: [targetUrl, "https://remote.example.com"] });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      const response = await transport.fetchImpl(targetUrl);
      expect(await response.text()).toBe("127-range-direct");
      expect(proxyHits).toBe(0);
    } finally {
      await transport.close();
      const targetClosed = once(target, "close");
      target.close();
      await targetClosed;
      const proxyClosed = once(proxy, "close");
      proxy.close();
      await proxyClosed;
    }
  });

  it("re-evaluates scoped direct routing when a configured loopback endpoint redirects to another origin", async () => {
    let configuredHits = 0;
    let redirectedHits = 0;
    let proxyHits = 0;
    let authenticatedProxyHits = 0;
    const expectedProxyAuth = `Basic ${Buffer.from("redirect:secret").toString("base64")}`;
    const redirected = createServer((_request, response) => {
      redirectedHits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("unconfigured-direct-target");
    });
    redirected.listen(0, "127.0.0.1");
    await once(redirected, "listening");
    const redirectedAddress = redirected.address();
    if (redirectedAddress === null || typeof redirectedAddress === "string") {
      throw new Error("redirect target did not bind");
    }

    let redirectLocation = "";
    const configured = createServer((_request, response) => {
      configuredHits += 1;
      response.writeHead(302, { location: redirectLocation });
      response.end();
    });
    configured.listen(0, "127.0.0.1");
    await once(configured, "listening");
    const configuredAddress = configured.address();
    if (configuredAddress === null || typeof configuredAddress === "string") {
      throw new Error("configured target did not bind");
    }
    const configuredUrl = `http://127.0.0.1:${String(configuredAddress.port)}/configured`;

    const proxy = createServer((request, response) => {
      proxyHits += 1;
      if (request.headers["proxy-authorization"] === expectedProxyAuth) authenticatedProxyHits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("redirect-routed-through-proxy");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy did not bind");

    const transport = createAdapterSendProxy({
      HTTP_PROXY: `http://redirect:secret@127.0.0.1:${String(proxyAddress.port)}`,
      // Match managed SRT's inherited bypass list. Both redirect targets are on
      // that list, but neither is the explicitly configured direct origin.
      NO_PROXY: "localhost,127.0.0.1,::1,10.0.0.0/8",
    }, { directLoopbackUrls: [configuredUrl] });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    try {
      for (const location of [
        `http://localhost:${String(redirectedAddress.port)}/unconfigured-host`,
        `http://127.0.0.1:${String(redirectedAddress.port)}/unconfigured-port`,
      ]) {
        redirectLocation = location;
        const response = await transport.fetchImpl(configuredUrl);
        expect(await response.text()).toBe("redirect-routed-through-proxy");
      }
      expect(configuredHits).toBe(2);
      expect(proxyHits).toBe(2);
      expect(authenticatedProxyHits).toBe(2);
      expect(redirectedHits).toBe(0);
    } finally {
      await transport.close();
      const configuredClosed = once(configured, "close");
      configured.close();
      await configuredClosed;
      const redirectedClosed = once(redirected, "close");
      redirected.close();
      await redirectedClosed;
      const proxyClosed = once(proxy, "close");
      proxy.close();
      await proxyClosed;
    }
  });

  it("mirrors a non-native abort signal and detaches its listener", async () => {
    const target = createServer(() => {});
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("target did not bind a TCP port");
    const targetUrl = `http://127.0.0.1:${String(address.port)}`;
    const transport = createAdapterSendProxy({
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1",
    }, { directLoopbackUrls: [targetUrl] });
    if (transport === undefined) throw new Error("expected the child proxy transport");
    const listeners = new Set<() => void>();
    let aborted = false;
    const shimSignal = {
      get aborted(): boolean {
        return aborted;
      },
      addEventListener(_type: "abort", listener: () => void): void {
        listeners.add(listener);
      },
      removeEventListener(_type: "abort", listener: () => void): void {
        listeners.delete(listener);
      },
    };

    try {
      const pending = transport.fetchImpl(targetUrl, {
        signal: shimSignal as unknown as AbortSignal,
      });
      await once(target, "request");
      aborted = true;
      for (const listener of listeners) listener();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(listeners.size).toBe(0);
    } finally {
      await transport.destroy();
      const closed = once(target, "close");
      target.close();
      await closed;
    }
  });

  it("makes dispatcher close and destroy repeat-safe", async () => {
    const closeTransport = createAdapterSendProxy({ HTTP_PROXY: "http://127.0.0.1:9" });
    if (closeTransport === undefined) throw new Error("expected a closeable child proxy transport");
    const firstClose = closeTransport.close();
    const secondClose = closeTransport.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;

    const destroyTransport = createAdapterSendProxy({ HTTP_PROXY: "http://127.0.0.1:9" });
    if (destroyTransport === undefined) throw new Error("expected a destroyable child proxy transport");
    const firstDestroy = destroyTransport.destroy();
    const secondDestroy = destroyTransport.destroy();
    expect(firstDestroy).toBe(secondDestroy);
    await firstDestroy;
  });
});

describe("adapter send MCP tools", () => {
  it("sends Slack and Telegram messages to allowed destinations", async () => {
    const slackCalls: SlackChatPostMessageParams[] = [];
    const telegramCalls: TelegramSendMessageParams[] = [];
    const settings = bothAdaptersSettings();
    const server = await createAdapterSendToolsServer(settings, {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          slackCalls.push(params);
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
      telegram: {
        async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
          telegramCalls.push(params);
          return { message_id: 77, chat: { id: params.chat_id }, text: params.text };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["SlackSendMessage", "TelegramSendMessage"]);

      const slackResult = await client.callTool({
        name: "SlackSendMessage",
        arguments: {
          channel: " C1 ",
          text: "**hello** [details](https://example.com/report)",
          thread_ts: "171.1",
          unfurl_links: false,
        },
      });
      expect(slackResult.structuredContent).toEqual({ ok: true, channel: "C1", ts: "171.123" });

      const telegramResult = await client.callTool({
        name: "TelegramSendMessage",
        arguments: {
          chat_id: -100,
          text: "hi",
          disable_web_page_preview: true,
          reply_options: ["Send", "Skip", "Revise"],
        },
      });
      expect(telegramResult.structuredContent).toEqual({
        ok: true,
        chat_id: -100,
        message_id: 77,
        reply_options: ["Send", "Skip", "Revise"],
      });
    });

    expect(slackCalls).toEqual([
      {
        channel: "C1",
        text: "*hello* <https://example.com/report|details>",
        thread_ts: "171.1",
        mrkdwn: true,
        unfurl_links: false,
      },
    ]);
    expect(telegramCalls).toEqual([{
      chat_id: -100,
      text: "hi",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Send", callback_data: "reply:v1:0" }],
          [{ text: "Skip", callback_data: "reply:v1:1" }],
          [{ text: "Revise", callback_data: "reply:v1:2" }],
        ],
      },
    }]);
  });

  it("records confirmed Slack and Telegram receipts in destination history with exact delivered text", async () => {
    const records: Array<{ conversationId: string; text: string; idempotencyKey: string }> = [];
    const historyBridge = await startInteractionBridge({
      host: "127.0.0.1",
      port: 0,
      recordDeliveryHistory: async (input) => {
        records.push(input);
        return { recorded: true };
      },
    });
    const capability = historyBridge.issueDeliveryHistoryCapability({
      runId: "run-destination-history",
      producerConversationId: "cron:destination-history",
      allowedChannels: ["slack", "telegram"],
    });
    try {
      const server = await createAdapterSendToolsServer(
        bothAdaptersSettings(),
        {
          slack: {
            async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
              return { ok: true, channel: params.channel, ts: "171.200" };
            },
          },
          telegram: {
            async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
              return { message_id: 88, chat: { id: params.chat_id }, text: params.text };
            },
          },
        },
        undefined,
        { deliveryHistory: { bridgeUrl: capability.url, bridgeToken: capability.token } },
      );

      await withMcpClient(server, async (client) => {
        const slackResult = await client.callTool({
          name: "SlackSendMessage",
          arguments: { channel: "C1", thread_ts: "170.100", text: "**delivered**" },
        });
        expect(slackResult.structuredContent).toMatchObject({
          ok: true,
          history: { accepted: true, code: "queued" },
        });
        const telegramResult = await client.callTool({
          name: "TelegramSendMessage",
          arguments: { chat_id: 42, text: "telegram exact" },
        });
        expect(telegramResult.structuredContent).toMatchObject({
          ok: true,
          history: { accepted: true, code: "queued" },
        });
      });

      await vi.waitFor(() => {
        expect(records).toEqual([
          {
            conversationId: "slack:C1:170.100",
            text: "*delivered*",
            idempotencyKey: "adapter-send:slack:C1:171.200",
          },
          {
            conversationId: "telegram:42",
            text: "telegram exact",
            idempotencyKey: "adapter-send:telegram:42:88",
          },
        ]);
      });
    } finally {
      capability.release();
      await historyBridge.stop();
    }
  });

  it("keeps a successful platform delivery authoritative when history queueing fails", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = await createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            return { ok: true, channel: params.channel, ts: "171.300" };
          },
        },
      },
      { conversationId: "cron:history-failure", indexPath },
      {
        deliveryHistory: { bridgeUrl: "http://127.0.0.1:9", bridgeToken: "unreachable" },
        fetchImpl: async () => { throw new Error("bridge unavailable"); },
      },
    );
    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "SlackSendMessage",
        arguments: { channel: "C1", text: "delivered despite history failure", mrkdwn: false },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        history: { accepted: false, code: "history_bridge_unreachable" },
      });
      expect(result.content).toEqual([{
        type: "text",
        text: "Sent Slack message to C1 at 171.300. Delivery succeeded, but destination history was not queued (history_bridge_unreachable).",
      }]);
    });
    expect(await lookupProducingConversation(indexPath, "C1", "171.300")).toBe("cron:history-failure");
  });

  it("forwards MCP cancellation to Slack, Telegram message, and Telegram file requests", async () => {
    const signals: Record<"slack" | "telegram" | "file", AbortSignal | undefined> = {
      slack: undefined,
      telegram: undefined,
      file: undefined,
    };
    const waitForAbort = async <T>(signal: AbortSignal | undefined): Promise<T> => {
      if (signal === undefined) throw new Error("missing request signal");
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
      throw new Error("unreachable");
    };
    const settings: AdapterSendToolsSettings = {
      ...bothAdaptersSettings(),
      telegram: {
        ...bothAdaptersSettings().telegram!,
        tools: { send: true, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      slack: {
        async chatPostMessage(_params: SlackChatPostMessageParams, options?: SlackRequestOptions) {
          signals.slack = options?.signal;
          return await waitForAbort<SlackChatPostMessageResult>(options?.signal);
        },
      },
      telegram: {
        async sendMessage(_params: TelegramSendMessageParams, options?: TelegramRequestOptions) {
          signals.telegram = options?.signal;
          return await waitForAbort<TelegramSentMessage>(options?.signal);
        },
        async sendDocument(params, options?: TelegramRequestOptions) {
          signals.file = options?.signal;
          return await waitForAbort<TelegramSentMessage>(options?.signal);
        },
      },
    });

    await withMcpClient(server, async (client) => {
      const cases = [
        { key: "slack" as const, name: "SlackSendMessage", args: { channel: "C1", text: "cancel" } },
        { key: "telegram" as const, name: "TelegramSendMessage", args: { chat_id: 42, text: "cancel" } },
        {
          key: "file" as const,
          name: "TelegramSendFile",
          args: { kind: "document", chat_id: 42, data: "QQ==", filename: "cancel.txt" },
        },
      ];
      for (const candidate of cases) {
        const controller = new AbortController();
        const pending = client.callTool(
          { name: candidate.name, arguments: candidate.args },
          undefined,
          { signal: controller.signal },
        );
        await vi.waitFor(() => {
          expect(signals[candidate.key]).toBeInstanceOf(AbortSignal);
        });
        controller.abort(new Error(`${candidate.name} cancelled`));
        await expect(pending).rejects.toThrow("cancelled");
        expect(signals[candidate.key]?.aborted).toBe(true);
      }
    });
  });

  it("sends SlackSendMessage text unchanged when mrkdwn is explicitly disabled", async () => {
    const slackCalls: SlackChatPostMessageParams[] = [];
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          slackCalls.push(params);
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      await client.callTool({
        name: "SlackSendMessage",
        arguments: {
          channel: "C1",
          text: "**literal** [details](https://example.com/report)",
          mrkdwn: false,
        },
      });
    });

    expect(slackCalls).toEqual([
      {
        channel: "C1",
        text: "**literal** [details](https://example.com/report)",
        mrkdwn: false,
      },
    ]);
  });

  it("preserves parenthesized Markdown link destinations in SlackSendMessage", async () => {
    const slackCalls: SlackChatPostMessageParams[] = [];
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          slackCalls.push(params);
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      await client.callTool({
        name: "SlackSendMessage",
        arguments: {
          channel: "C1",
          text: "[Wikipedia](https://en.wikipedia.org/wiki/Parenthesis_(rhetoric))",
        },
      });
    });

    expect(slackCalls).toEqual([
      {
        channel: "C1",
        text: "<https://en.wikipedia.org/wiki/Parenthesis_(rhetoric)|Wikipedia>",
        mrkdwn: true,
      },
    ]);
  });

  it("TelegramSendFile uploads base64 bytes with the given filename and caption", async () => {
    const docCalls: Array<{ chat_id: unknown; filename: string; bytes: number; caption?: string }> = [];
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: {
        sendMessage: vi.fn(),
        async sendDocument(params): Promise<TelegramSentMessage> {
          docCalls.push({
            chat_id: params.chat_id,
            filename: params.filename ?? "(none)",
            bytes: params.document instanceof Uint8Array ? params.document.byteLength : params.document.length,
            ...(params.caption === undefined ? {} : { caption: params.caption }),
          });
          return { message_id: 91, chat: { id: params.chat_id }, text: "" };
        },
      },
    });

    const data = Buffer.from("hello report").toString("base64");
    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["TelegramSendFile"]);
      const schema = tools.tools[0]?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty("chat_id");
      expect(schema.required).toContain("chat_id");

      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, data, filename: "report.txt", caption: "Daily report" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, chat_id: 42, message_id: 91, filename: "report.txt" });
    });

    expect(docCalls).toEqual([{ chat_id: 42, filename: "report.txt", bytes: "hello report".length, caption: "Daily report" }]);
  });

  it("TelegramSendFile rejects when neither data nor path is provided", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, file: true },
      },
    };
    const sendDocument = vi.fn();
    const server = await createAdapterSendToolsServer(settings, { telegram: { sendMessage: vi.fn(), sendDocument } });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, filename: "x.txt" },
      });
      expect(result.isError).toBe(true);
    });

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("TelegramSendFile reports its own allowlist error outside strict scope", async () => {
    const sendDocument = vi.fn();
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn(), sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: {
          kind: "document",
          chat_id: 999,
          data: Buffer.from("blocked").toString("base64"),
          filename: "blocked.txt",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "TelegramSendFile: chat_id is not allowed by Telegram adapter config." },
      ]);
    });

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("rejects Slack and Telegram destinations outside the adapter allowlists before calling clients", async () => {
    const slack = { chatPostMessage: vi.fn() };
    const telegram = { sendMessage: vi.fn() };
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), { slack, telegram });

    await withMcpClient(server, async (client) => {
      const slackResult = await client.callTool({
        name: "SlackSendMessage",
        arguments: { channel: "C999", text: "blocked" },
      });
      expect(slackResult.isError).toBe(true);
      expect(slackResult.content).toEqual([
        { type: "text", text: "SlackSendMessage: channel is not allowed by Slack adapter config." },
      ]);

      const telegramResult = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: 999, text: "blocked" },
      });
      expect(telegramResult.isError).toBe(true);
      expect(telegramResult.content).toEqual([
        { type: "text", text: "TelegramSendMessage: chat_id is not allowed by Telegram adapter config." },
      ]);
    });

    expect(slack.chatPostMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("adapter send tool posted-message indexing", () => {
  it("publishes a cross-conversation Slack index only after destination history is durable", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    let recordStarted = false;
    let finishRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => { finishRecord = resolve; });
    const historyBridge = await startInteractionBridge({
      host: "127.0.0.1",
      port: 0,
      recordDeliveryHistory: async () => {
        recordStarted = true;
        await recordGate;
        return { recorded: true };
      },
    });
    const capability = historyBridge.issueDeliveryHistoryCapability({
      runId: "run-index-after-history",
      producerConversationId: "scheduled-scan",
      allowedChannels: ["slack"],
    });
    try {
      const server = await createAdapterSendToolsServer(
        bothAdaptersSettings(),
        {
          slack: {
            async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
              return { ok: true, channel: params.channel, ts: "170.000099" };
            },
          },
        },
        { conversationId: "scheduled-scan", indexPath },
        { deliveryHistory: { bridgeUrl: capability.url, bridgeToken: capability.token } },
      );

      await withMcpClient(server, async (client) => {
        const pending = client.callTool({
          name: "SlackSendMessage",
          arguments: { channel: "C1", text: "history first" },
        });
        await vi.waitFor(() => expect(recordStarted).toBe(true));
        expect(await lookupProducingConversation(indexPath, "C1", "170.000099")).toBeUndefined();
        finishRecord();
        await expect(pending).resolves.toMatchObject({ structuredContent: { ok: true } });
      });
      expect(await lookupProducingConversation(indexPath, "C1", "170.000099")).toBe("scheduled-scan");
    } finally {
      capability.release();
      await historyBridge.stop();
    }
  });

  it("records a successful SlackSendMessage as (channel, ts) → producing conversation, de-bucketed", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = await createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            return { ok: true, channel: params.channel, ts: "170.000100" };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "hello" } });
      expect(result.structuredContent).toMatchObject({ ok: true, channel: "C1", ts: "170.000100" });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");
  });

  it("splits SlackSendMessage at Slack's 40,000-char limit and indexes every posted chunk", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const postCalls: SlackChatPostMessageParams[] = [];
    let nextTs = 170;
    const server = await createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            postCalls.push(params);
            return { ok: true, channel: params.channel, ts: `${nextTs++}.000100` };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );
    const text = `${"x".repeat(40_000)}tail`;

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "SlackSendMessage",
        arguments: {
          channel: "C1",
          text,
          thread_ts: "169.000100",
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
        },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        channel: "C1",
        ts: "170.000100",
        chunkCount: 2,
        chunks: [
          { channel: "C1", ts: "170.000100" },
          { channel: "C1", ts: "171.000100" },
        ],
      });
    });

    expect(postCalls.map((call) => call.text.length)).toEqual([40_000, 4]);
    expect(
      postCalls.every(
        (call) =>
          call.channel === "C1" &&
          call.thread_ts === "169.000100" &&
          call.mrkdwn === false &&
          call.unfurl_links === false &&
          call.unfurl_media === false,
      ),
    ).toBe(true);
    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");
    expect(await lookupProducingConversation(indexPath, "C1", "171.000100")).toBe("scheduled-scan");
  });

  it("end-to-end: a scan's SlackSendMessage post lets a later in-thread reply resume the scan conversation", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);

    // 1) Producer — the scheduled scan posts its summary via SlackSendMessage,
    //    running under the synthetic cron conversationId.
    const producer = await createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            return { ok: true, channel: params.channel, ts: "170.000100" };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );
    await withMcpClient(producer, async (client) => {
      await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "scheduled scan: suggested next step" } });
    });
    // Sanity: the producer wrote the linkage.
    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");

    // 2) Consumer — the Slack adapter, wired exactly like the channel driver, with a
    //    reply arriving in that thread.
    let captured: { conversationId?: string } | undefined;
    const adapter = new SlackAdapter({
      api: new MinimalSlackApi() as unknown as SlackWebApi,
      allowAllChannels: true,
      responder: {
        respond: async (request) => {
          captured = request;
          return { text: "Added to Todoist." };
        },
      },
      resolvePostIndex: (channelId, ts) => lookupProducingConversation(indexPath, channelId, ts),
    });

    await adapter.handleEventCallback(
      threadedDmReply({ channel: "C1", threadTs: "170.000100", ts: "171.000001", text: "follow-up reply in the scan thread" }),
    );

    // The reply resumes the scan conversation instead of a fresh, history-less thread.
    expect(captured?.conversationId).toBe("scheduled-scan");
  });

  it("replays confirmed Slack and Telegram sends on destination replies without copying Slack text to the producer", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const historyStore = createInMemoryHistoryStore({ maxMessages: 64 });
    await historyStore.append("scheduled-scan", [
      { role: "user", content: "Run the scan.", timestamp: "2026-07-17T08:00:00.000Z" },
      { role: "assistant", content: "Scan complete.", timestamp: "2026-07-17T08:00:01.000Z" },
    ]);
    const fake = createFakeRuntime(async () => ({ text: "reply handled" }));
    const postedReplyHistory = createSlackPostedReplyHistory({ maxMessages: 64, rollover: "none" });
    const harness = createAgentHarness({
      identityPath: join(dir, "IDENTITY.md"),
      runtime: fake.runtime,
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      cwd: dir,
      historyStore: postedReplyHistory.wrapHistoryStore(historyStore),
    });
    const responder = postedReplyHistory.wrapResponder(createAgentResponder({ harness }));
    const historyBridge = await startInteractionBridge({
      host: "127.0.0.1",
      port: 0,
      recordDeliveryHistory: async (input) => {
        if (responder.deliverVerbatim === undefined) return { recorded: false, code: "history_record_unavailable" };
        await responder.deliverVerbatim(input.conversationId, input.text, { idempotencyKey: input.idempotencyKey });
        return { recorded: true };
      },
    });
    const capability = historyBridge.issueDeliveryHistoryCapability({
      runId: "run-real-destination-replay",
      producerConversationId: "scheduled-scan",
      allowedChannels: ["slack", "telegram"],
    });
    try {
      const server = await createAdapterSendToolsServer(
        bothAdaptersSettings(),
        {
          slack: {
            async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
              return { ok: true, channel: params.channel, ts: "170.000100" };
            },
          },
          telegram: {
            async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
              return { message_id: 77, chat: { id: params.chat_id }, text: params.text };
            },
          },
        },
        { conversationId: "scheduled-scan", indexPath },
        { deliveryHistory: { bridgeUrl: capability.url, bridgeToken: capability.token } },
      );
      await withMcpClient(server, async (client) => {
        await client.callTool({
          name: "SlackSendMessage",
          arguments: { channel: "C1", text: "SLACK_DESTINATION_RECEIPT", mrkdwn: false },
        });
        await client.callTool({
          name: "TelegramSendMessage",
          arguments: { chat_id: 42, text: "TELEGRAM_DESTINATION_RECEIPT" },
        });
      });

      const slackAdapter = new SlackAdapter({
        api: new MinimalSlackApi() as unknown as SlackWebApi,
        allowAllChannels: true,
        responder,
        resolvePostIndex: (channelId, ts) => lookupProducingConversation(indexPath, channelId, ts),
      });
      await slackAdapter.handleEventCallback(
        threadedDmReply({ channel: "C1", threadTs: "170.000100", ts: "171.000001", text: "Slack follow-up" }),
      );
      await responder.respond(
        {
          conversationId: "telegram:42",
          replyTo: { conversationId: "telegram:42" },
          text: "Telegram follow-up",
          abortSignal: new AbortController().signal,
          metadata: { telegram: { chat: { id: 42 }, message: { id: 78 } } },
        },
        { append: async () => undefined },
      );

      expect(runtimeInputOccurrences(fake.calls[0], "SLACK_DESTINATION_RECEIPT")).toBe(1);
      expect(runtimeInputOccurrences(fake.calls[0], "TELEGRAM_DESTINATION_RECEIPT")).toBe(0);
      expect(runtimeInputOccurrences(fake.calls[1], "TELEGRAM_DESTINATION_RECEIPT")).toBe(1);
      expect(runtimeInputOccurrences(fake.calls[1], "SLACK_DESTINATION_RECEIPT")).toBe(0);
      expect((await historyStore.load("scheduled-scan")).some(
        (message) => message.content === "SLACK_DESTINATION_RECEIPT",
      )).toBe(false);
      expect((await historyStore.load("slack:C1:170.000100")).at(-1)?.content).toBe("SLACK_DESTINATION_RECEIPT");
      expect((await historyStore.load("telegram:42")).some(
        (message) => message.content === "TELEGRAM_DESTINATION_RECEIPT",
      )).toBe(true);
    } finally {
      capability.release();
      await historyBridge.stop();
      await (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it("writes no index entry when indexing is not configured", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "hello" } });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "171.123")).toBeUndefined();
  });
});

describe("adapter send tool app composition", () => {
  it("injects adapter send MCP server into app-served runtime requests", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      tools: { allowedTools: ["SlackSendMessage", "TelegramSendMessage"], disallowedTools: [] },
      webhook: { enabled: true },
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    let responder: AgentResponder | undefined;
    const driver: ChannelDriver = {
      id: "webhook",
      label: "Test",
      async loadConfig() {
        return { enabled: true };
      },
      isConfigError() {
        return false;
      },
      async start(input) {
        responder = input.responder;
        return { summary: {}, stop: async () => undefined };
      },
    };

    const app = await startMonoAgentApp({
      cwd: dir,
      configPath,
      env: {},
      drivers: [driver],
      runtime: fake.runtime,
    });
    await responder?.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    );

    const server = fake.calls[0]?.options.mcpServers?.[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as { env?: Record<string, string> } | undefined;
    expect(server).toMatchObject({ type: "stdio", command: process.execPath, cwd: dir });
    expect(server?.env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
      MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(["SlackSendMessage", "TelegramSendMessage"]),
    });
    expect(JSON.stringify(server?.env)).not.toContain("xoxb-slack");
    expect(JSON.stringify(server?.env)).not.toContain("telegram-token");
    expect((server as Record<PropertyKey, unknown>)[Symbol.for("@mono-agent/app-owned-local-binding")]).toBe(true);

    await app.stop();
  });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return configPath;
}

function baseConfig(): Record<string, unknown> {
  return {
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
    context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    traceability: { registryDir: "./trace-sources", sourceId: "adapter-send-test", sourceLabel: "Adapter Send Test" },
  };
}

function bothAdaptersSettings(): AdapterSendToolsSettings {
  return {
    slack: {
      botToken: "xoxb-slack",
      allowedChannelIds: ["c1"],
      allowAllChannels: false,
    },
    telegram: {
      botToken: "telegram-token",
      allowedChatIds: ["42", "-100"],
      allowAllChats: false,
      tools: { send: true, file: false },
    },
  };
}

async function withMcpClient<T>(
  server: Awaited<ReturnType<typeof createAdapterSendToolsServer>>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "adapter-send-tools-test", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Minimal SlackWebApi for driving the adapter's reply path in a test. */
class MinimalSlackApi {
  async authTest() {
    return { ok: true as const };
  }
  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }
  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    return { ok: true, channel: params.channel, ts: "172.000001" };
  }
  async chatUpdate(params: SlackChatUpdateParams) {
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

function threadedDmReply(options: { channel: string; threadTs: string; ts: string; text: string }): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev-reply",
    event_time: 172,
    event: {
      type: "message",
      channel: options.channel,
      user: "UUSER1",
      text: options.text,
      ts: options.ts,
      event_ts: options.ts,
      thread_ts: options.threadTs,
      channel_type: "im",
    },
  };
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  const fake = {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return run(prompt, options);
      },
      disposeAllSessions: vi.fn(async () => undefined),
    },
  };
  return fake;
}

function runtimeInputOccurrences(
  call: { readonly prompt: string; readonly options: RuntimeRunOptions } | undefined,
  needle: string,
): number {
  if (call === undefined) return 0;
  const input = [
    call.prompt,
    ...(call.options.messages ?? []).map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)),
  ].join("\n");
  return input.split(needle).length - 1;
}

describe("AskUser tool", () => {
  it("resolves askUser settings and the tool name when the policy allows AskUser and the bridge env is present", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings(
      {
        env: {
          MONO_AGENT_INTERACTION_BRIDGE_URL: "http://127.0.0.1:9999",
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "bridge-token",
          MONO_AGENT_ASK_USER_TIMEOUT_MS: "5000",
        },
        cwd: dir,
        configPath,
      },
      { allowedTools: ["AskUser"] },
    );

    expect(settings?.askUser).toEqual({
      bridgeUrl: "http://127.0.0.1:9999",
      bridgeToken: "bridge-token",
      timeoutMs: 5000,
    });
    expect(adapterSendToolNames(settings as AdapterSendToolsSettings)).toEqual(["AskUser"]);
  });

  it("omits askUser when the interaction bridge env is missing", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["AskUser"] },
    );

    expect(settings).toBeUndefined();
  });

  it("suppresses bridge-backed interaction tools for an MCP-incompatible route", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings(
      {
        env: {
          MONO_AGENT_INTERACTION_BRIDGE_URL: "http://127.0.0.1:9999",
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "bridge-token",
        },
        cwd: dir,
        configPath,
      },
      { allowedTools: ["*"], suppressInteractionTools: true },
    );

    expect(settings?.askUser).toBeUndefined();
    expect(settings).toBeUndefined();
  });

  it("is not registered without logical and physical conversation ids (parent-process shape)", async () => {
    const server = await createAdapterSendToolsServer(
      {
        telegram: {
          botToken: "telegram-token",
          allowedChatIds: ["42"],
          allowAllChats: false,
          tools: { send: true, file: false },
        },
        askUser: { bridgeUrl: "http://127.0.0.1:1", bridgeToken: "t", timeoutMs: 1_000 },
      },
      { telegram: { sendMessage: vi.fn() as never } },
    );
    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["TelegramSendMessage"]);
    });
  });

  it("blocks on the bridge until structured answers resolve the ask", async () => {
    const bridge = await startInteractionBridge({ host: "127.0.0.1", port: 0, askTimeoutMs: 5_000 });
    const bridgeFetch = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init));
    const presented: string[] = [];
    bridge.registerSink("telegram", {
      presentAsk: async (_conversationId, snapshot) => { presented.push(snapshot.interactionId); },
      updateAsk: async () => undefined,
      postStatus: async () => {},
    });
    try {
      const server = await createAdapterSendToolsServer(
        {
          askUser: {
            bridgeUrl: bridge.url,
            bridgeToken: bridge.token,
            timeoutMs: 5_000,
            producerConversationId: "cron:morning-briefing#2026-07-21",
            interactionConversationId: "telegram:42",
            runId: "run-ask-user",
          },
        },
        {},
        undefined,
        { fetchImpl: bridgeFetch as unknown as typeof fetch },
      );
      await withMcpClient(server, async (client) => {
        const pending = client.callTool({
          name: "AskUser",
          arguments: {
            message: "Draft reply",
            questions: [{
              header: "Delivery",
              question: "What should I do with this draft?",
              options: [
                { label: "Send", description: "Send the draft now." },
                { label: "Skip", description: "Leave it unsent." },
                { label: "Revise", description: "Keep editing it." },
              ],
            }],
          },
        });
        await vi.waitFor(() => {
          expect(presented).toHaveLength(1);
        });
        const snapshot = bridge.getPendingAsk("telegram:42")!;
        const question = snapshot.questions[0]!;
        await bridge.submitAskAnswers({
          conversationId: "telegram:42",
          interactionId: snapshot.interactionId,
          answers: [{ questionId: question.id, selectedOptionIds: [question.options[0]!.id] }],
        });
        const result = await pending;
        expect(result.structuredContent).toMatchObject({
          answered: true,
          answers: [{ header: "Delivery", selectedOptions: [{ label: "Send" }] }],
        });
        expect(JSON.stringify(result.content)).toContain("Delivery: Send");
      });
      expect(bridgeFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(bridgeFetch.mock.calls.every(([input]) => new URL(String(input)).origin === bridge.url)).toBe(true);
      expect(bridgeFetch.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
      const history = bridge.enrichAssistantHistory({
        runId: "run-ask-user",
        conversationId: "cron:morning-briefing#2026-07-21",
        assistantText: "Thanks.",
      });
      expect(history).toContain("Tool: AskUser");
      expect(history).toContain("What should I do with this draft?");
      expect(history).toContain("Outcome: answered");
      expect(history).toContain("Send");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects the removed free-text shape at the MCP schema boundary", async () => {
    const server = await createAdapterSendToolsServer({
      askUser: {
        bridgeUrl: "http://127.0.0.1:1",
        bridgeToken: "t",
        timeoutMs: 1_000,
        producerConversationId: "web:producer",
        interactionConversationId: "web:thread",
      },
    }, {});
    await withMcpClient(server, async (client) => {
      const result = await client.callTool({ name: "AskUser", arguments: { question: "Proceed?" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("questions");
    });
  });
});

describe("TelegramSendFile path upload", () => {
  it("uploads a workspace file by path, deriving the filename from the basename", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Transcript\n\nhello", "utf8");
    const sendDocument = vi.fn(async (params: { chat_id: unknown; filename: string }) => ({
      message_id: 90,
      chat: { id: params.chat_id },
    })) as never;
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath, caption: "your transcript" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, filename: "transcript.md" });
    });

    expect(sendDocument).toHaveBeenCalledTimes(1);
    const uploaded = (sendDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      document: Uint8Array;
      filename: string;
      caption?: string;
    };
    expect(uploaded.filename).toBe("transcript.md");
    expect(uploaded.caption).toBe("your transcript");
    expect(Buffer.from(uploaded.document).toString("utf8")).toBe("# Transcript\n\nhello");
  });

  it("host-binds strict TelegramSendFile without exposing or accepting a model-owned destination", async () => {
    const telegram = {
      sendMessage: vi.fn(async (params: TelegramSendMessageParams) => ({ message_id: 1, chat: { id: params.chat_id } })),
      sendDocument: vi.fn(async (params: { chat_id: string | number }) => ({ message_id: 2, chat: { id: params.chat_id } })),
    };
    const server = await createAdapterSendToolsServer({
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42", "99"],
        allowAllChats: false,
        tools: { send: true, file: true },
        sendTools: { scope: "producing-conversation" },
        producingConversationId: "telegram:42#2026-07-12",
      },
    }, { telegram });

    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      const fileTool = tools.tools.find((tool) => tool.name === "TelegramSendFile");
      const schema = fileTool?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).not.toHaveProperty("chat_id");
      expect(schema.required ?? []).not.toContain("chat_id");

      const redirectedMessage = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: 99, text: "cross-chat" },
      });
      expect(redirectedMessage.isError).toBe(true);
      expect(JSON.stringify(redirectedMessage.content)).toContain(
        "TelegramSendMessage: chat_id must match the producing Telegram conversation",
      );

      const hostBound = await client.callTool({
        name: "TelegramSendFile",
        arguments: {
          kind: "document",
          data: Buffer.from("first").toString("base64"),
          filename: "first.txt",
        },
      });
      expect(hostBound.content).toEqual([{
        type: "text",
        text: "Sent document 2 (first.txt) to the producing Telegram conversation.",
      }]);
      expect(hostBound.structuredContent).toEqual({ ok: true, message_id: 2, filename: "first.txt" });

      const attemptedRedirect = await client.callTool({
        name: "TelegramSendFile",
        arguments: {
          kind: "document",
          chat_id: 99,
          data: Buffer.from("second").toString("base64"),
          filename: "second.txt",
        },
      });
      expect(attemptedRedirect.structuredContent).toEqual({ ok: true, message_id: 2, filename: "second.txt" });
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.sendDocument).toHaveBeenCalledTimes(2);
    expect(telegram.sendDocument.mock.calls.map(([params]) => params.chat_id)).toEqual(["42", "42"]);
  });

  it.each([
    {
      label: "missing producing context",
      producingConversationId: undefined,
      allowedChatIds: ["42"],
      expected: "TelegramSendFile: producing Telegram conversation context is unavailable.",
    },
    {
      label: "non-Telegram producing context",
      producingConversationId: "slack:C123",
      allowedChatIds: ["42"],
      expected: "TelegramSendFile: producing Telegram conversation context is unavailable.",
    },
    {
      label: "producing chat outside the adapter allowlist",
      producingConversationId: "telegram:99#today",
      allowedChatIds: ["42"],
      expected: "TelegramSendFile: chat_id is not allowed by Telegram adapter config.",
    },
  ])("fails closed with a file-specific error for $label", async ({
    producingConversationId,
    allowedChatIds,
    expected,
  }) => {
    const sendDocument = vi.fn();
    const server = await createAdapterSendToolsServer({
      telegram: {
        botToken: "telegram-token",
        allowedChatIds,
        allowAllChats: false,
        tools: { send: false, file: true },
        sendTools: { scope: "producing-conversation" },
        ...(producingConversationId === undefined ? {} : { producingConversationId }),
      },
    }, {
      telegram: { sendMessage: vi.fn(), sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: {
          kind: "document",
          data: Buffer.from("blocked").toString("base64"),
          filename: "blocked.txt",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: expected }]);
    });

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("pins strict path uploads to the current run directory object and returns one generic path error", async () => {
    const runOutputDir = join(dir, "outbound", "run-1");
    await mkdir(runOutputDir, { recursive: true });
    const rootStats = await lstat(runOutputDir);
    const inside = join(runOutputDir, "transcript.md");
    const outside = join(dir, "other-chat.md");
    const missing = join(dir, "missing.md");
    const escape = join(runOutputDir, "escape.md");
    const hardlinkEscape = join(runOutputDir, "hardlink.md");
    await writeFile(inside, "inside", "utf8");
    await writeFile(outside, "outside", "utf8");
    await writeFile(escape, "initial candidate", "utf8");
    await link(outside, hardlinkEscape);
    const sendDocument = vi.fn(async (params: { chat_id: string | number }) => ({ message_id: 3, chat: { id: params.chat_id } }));
    const server = await createAdapterSendToolsServer({
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, file: true },
        sendTools: { scope: "producing-conversation", pathScope: "run-output" },
        producingConversationId: "telegram:42#today",
        runOutputDir,
        runOutputIdentity: { dev: rootStats.dev, ino: rootStats.ino },
        apiRoot: "http://127.0.0.1:8081",
      },
    }, {
      telegram: { sendMessage: vi.fn(), sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const allowed = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", path: inside },
      });
      expect(allowed.structuredContent).toMatchObject({ ok: true, filename: "transcript.md" });
      // Replace a previously regular in-scope candidate with a symlink before
      // upload; strict mode must not follow the replacement.
      await rm(escape);
      await symlink(outside, escape);
      const errors: string[] = [];
      for (const path of [outside, missing, escape, hardlinkEscape]) {
        const rejected = await client.callTool({
          name: "TelegramSendFile",
          arguments: { kind: "document", path },
        });
        expect(rejected.isError).toBe(true);
        errors.push(JSON.stringify(rejected.content));
      }
      expect(new Set(errors).size).toBe(1);
      expect(errors[0]).toContain("path must be a regular file inside the current run output directory");

      const originalRoot = `${runOutputDir}-original`;
      const attackerRoot = join(dir, "attacker-root");
      await mkdir(attackerRoot);
      await writeFile(join(attackerRoot, "stolen.md"), "stolen", "utf8");
      await rename(runOutputDir, originalRoot);
      await symlink(attackerRoot, runOutputDir);
      const swappedSymlink = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", path: join(runOutputDir, "stolen.md") },
      });
      expect(JSON.stringify(swappedSymlink.content)).toBe(errors[0]);

      await rm(runOutputDir);
      await mkdir(runOutputDir);
      await writeFile(join(runOutputDir, "replacement.md"), "replacement", "utf8");
      const swappedDirectory = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", path: join(runOutputDir, "replacement.md") },
      });
      expect(JSON.stringify(swappedDirectory.content)).toBe(errors[0]);
    });
    expect(sendDocument).toHaveBeenCalledTimes(1);
    const uploaded = (sendDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { document: unknown };
    expect(uploaded.document).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(uploaded.document as Uint8Array).toString("utf8")).toBe("inside");
  });
});

describe("self-hosted server send tools", () => {
  it("resolves apiRoot and maxUploadBytes from the telegram config", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        apiRoot: "http://127.0.0.1:8081",
        attachments: { maxUploadBytes: 1_048_576 },
      },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["TelegramSendFile"] },
    );

    expect(settings?.telegram).toMatchObject({
      apiRoot: "http://127.0.0.1:8081",
      maxUploadBytes: 1_048_576,
    });
  });

  it("defaults maxUploadBytes to the 20 MiB adapter cap when unset", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["TelegramSendFile"] },
    );

    expect(settings?.telegram?.maxUploadBytes).toBe(20 * 1024 * 1024);
    expect(settings?.telegram?.apiRoot).toBeUndefined();
  });

  it("sends a path upload as a file:// URI when an apiRoot is configured (zero buffering)", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Big transcript", "utf8");
    const sendDocument = vi.fn(async (params: { chat_id: unknown }) => ({
      message_id: 91,
      chat: { id: params.chat_id },
    })) as never;
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        apiRoot: "http://127.0.0.1:8081",
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath, caption: "your transcript" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
    });

    const uploaded = (sendDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { document: unknown };
    expect(uploaded.document).toBe(`file://${filePath}`);
  });

  it("falls back to a buffered upload when the server rejects the file:// URI", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Fallback transcript", "utf8");
    const sendDocument = vi.fn() as ReturnType<typeof vi.fn>;
    sendDocument.mockRejectedValueOnce(Object.assign(new Error("Bad Request: wrong file identifier"), { kind: "telegram" }));
    sendDocument.mockResolvedValueOnce({ message_id: 92, chat: { id: 42 } });
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        apiRoot: "http://127.0.0.1:8081",
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument: sendDocument as never },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
    });

    expect(sendDocument).toHaveBeenCalledTimes(2);
    const retried = sendDocument.mock.calls[1]?.[0] as { document: unknown; filename?: string };
    expect(Buffer.from(retried.document as Uint8Array).toString("utf8")).toBe("# Fallback transcript");
    expect(retried.filename).toBe("transcript.md");
  });

  it("honors the configured maxUploadBytes for buffered uploads", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        maxUploadBytes: 8,
        tools: { send: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument: vi.fn() as never },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, data: Buffer.from("way more than eight bytes").toString("base64"), filename: "x.md" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("upload cap");
    });
  });
});
