import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWebhookAdapterConfig,
  redactWebhookAdapterConfig,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-webhook-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadWebhookAdapterConfig", () => {
  it("loads adapter-owned webhook settings from JSON and env overrides", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        webhook: {
          enabled: true,
          host: "127.0.0.1",
          port: 4111,
          path: "/json",
          apiKey: "json-fixture-key",
          defaultMode: "async",
          retentionMs: 1000,
          maxStoredRequests: 10,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_PORT: "4222",
        MONO_AGENT_WEBHOOK_API_KEY: "env-fixture-key",
        MONO_AGENT_WEBHOOK_DEFAULT_MODE: "sync",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4222,
      path: "/json",
      allowNonLoopback: false,
      apiKey: "env-fixture-key",
      defaultMode: "sync",
      retentionMs: 1000,
      maxStoredRequests: 10,
      endpoints: [{ name: "default", path: "/json", mode: "sync", enabled: true }],
    });
  });

  it("treats JSON apiKey strings literally and only uses the documented env override", async () => {
    const pseudoReference = "env:MONO_AGENT_WEBHOOK_API_KEY";
    const json = {
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        apiKey: pseudoReference,
      },
    };

    const jsonOnly = await loadWebhookAdapterConfig({ env: {}, json });
    expect(jsonOnly.apiKey).toBe(pseudoReference);

    const withEnvOverride = await loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_API_KEY: "actual-env-key" },
      json,
    });
    expect(withEnvOverride.apiKey).toBe("actual-env-key");
  });

  it("defaults to a single /webhook/invoke endpoint when nothing is configured", async () => {
    const config = await loadWebhookAdapterConfig({ env: {} });
    expect(config.endpoints).toEqual([{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }]);
    expect(config.path).toBe("/webhook/invoke");
  });

  it("parses webhook.maxRunMs (and omits it when unset)", async () => {
    const unset = await loadWebhookAdapterConfig({ env: {} });
    expect(unset.maxRunMs).toBeUndefined();

    const config = await loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_MAX_RUN_MS: "600000" },
    });
    expect(config.maxRunMs).toBe(600000);
  });

  it("loads multiple endpoints from webhook.endpoints, mirroring the first as path/defaultMode", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        webhook: {
          enabled: true,
          port: 4310,
          defaultMode: "sync",
          endpoints: [
            { name: "invoke", path: "/webhook/invoke" },
            {
              path: "/webhook/research-result",
              mode: "async",
              prompt: "Match the incoming result to a request.",
              notify: true,
              notifyConversationId: "telegram:42",
              model: "claude:claude-opus-4-8",
              effort: "high",
              maxRunMs: 45_000,
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path });
    expect(config.endpoints).toEqual([
      { name: "invoke", path: "/webhook/invoke", mode: "sync", enabled: true },
      {
        name: "research-result",
        path: "/webhook/research-result",
        mode: "async",
        enabled: true,
        prompt: "Match the incoming result to a request.",
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
        maxRunMs: 45_000,
      },
    ]);
    expect(config.path).toBe("/webhook/invoke");
    expect(config.defaultMode).toBe("sync");
  });

  it("reads endpoints from MONO_AGENT_WEBHOOK_ENDPOINTS_JSON", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([
          {
            name: "hook",
            path: "/hook",
            mode: "async",
            notify: true,
            notifyConversationId: "slack:C1",
            maxRunMs: 0,
          },
        ]),
      },
    });
    expect(config.endpoints).toEqual([
      {
        name: "hook",
        path: "/hook",
        mode: "async",
        enabled: true,
        notify: true,
        notifyConversationId: "slack:C1",
        maxRunMs: 0,
      },
    ]);
  });

  it.each([-1, 1.5, 86_400_001, "1000"])(
    "rejects invalid per-endpoint maxRunMs value %j",
    async (maxRunMs) => {
      await expect(loadWebhookAdapterConfig({
        env: {
          MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([{ path: "/hook", maxRunMs }]),
        },
      })).rejects.toThrow(/webhook\.endpoints\[\]\.maxRunMs/u);
    },
  );

  it("loads native notification fields for the legacy single endpoint from env", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_PATH: "/hook",
        MONO_AGENT_WEBHOOK_PROMPT: "Summarize the payload.",
        MONO_AGENT_WEBHOOK_NOTIFY: "true",
        MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID: "telegram:42",
      },
    });
    expect(config.endpoints).toEqual([
      {
        name: "default",
        path: "/hook",
        mode: "sync",
        enabled: true,
        prompt: "Summarize the payload.",
        notify: true,
        notifyConversationId: "telegram:42",
      },
    ]);
  });

  it("synthesizes the legacy single endpoint with a prompt from webhook.prompt", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ webhook: { enabled: true, path: "/hook", prompt: "Do the thing." } })}\n`,
      "utf8",
    );
    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path });
    expect(config.endpoints).toEqual([
      { name: "default", path: "/hook", mode: "sync", enabled: true, prompt: "Do the thing." },
    ]);
  });

  it("merges webhook.endpoints with webhook/*.md files", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ webhook: { enabled: true, port: 4310, endpoints: [{ name: "invoke", path: "/webhook/invoke" }] } })}\n`,
      "utf8",
    );
    const webhookDir = join(dir, "webhook");
    await mkdir(webhookDir);
    await writeFile(
      join(webhookDir, "deep-research.md"),
      "---\npath: /webhook/deep-research\nmode: async\nnotify: true\nnotifyConversationId: telegram:42\n---\nMatch the request and file it.",
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path, cwd: dir });
    expect(config.endpoints.map((endpoint) => endpoint.name)).toEqual(["invoke", "deep-research"]);
    expect(config.endpoints[1]).toMatchObject({
      path: "/webhook/deep-research",
      mode: "async",
      prompt: "Match the request and file it.",
      notify: true,
      notifyConversationId: "telegram:42",
    });
  });

  it("rejects two endpoints with the same path", async () => {
    await expect(
      loadWebhookAdapterConfig({
        env: {
          MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([
            { name: "a", path: "/dup" },
            { name: "b", path: "/dup" },
          ]),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("accepts an enabled non-loopback bind only with explicit consent and an API key", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK: "true",
        MONO_AGENT_WEBHOOK_API_KEY: "fixture-key",
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      allowNonLoopback: true,
      apiKey: "fixture-key",
    });
  });

  it("fails closed when an enabled non-loopback bind has no API key", async () => {
    await expect(loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK: "true",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("fails closed when an enabled non-loopback bind has no explicit consent", async () => {
    await expect(loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_API_KEY: "fixture-key",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactWebhookAdapterConfig", () => {
  it("returns public webhook settings with the optional API key redacted", () => {
    const config = {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      apiKey: "fixture-redacted-value",
      defaultMode: "async" as const,
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "async" as const, enabled: true, maxRunMs: 0 }],
    };
    const redacted = redactWebhookAdapterConfig(config);
    expect(redacted).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      apiKey: { present: true, redacted: true },
      defaultMode: "async",
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "async", enabled: true, maxRunMs: 0 }],
    });
    expect(JSON.stringify(redacted)).not.toContain("fixture-redacted-value");
    // Endpoints are deep-cloned so callers cannot mutate the source array.
    expect(redacted.endpoints).not.toBe(config.endpoints);
  });

  it("reports an unset API key without inventing a secret", () => {
    expect(redactWebhookAdapterConfig({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      defaultMode: "sync",
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }],
    }).apiKey).toEqual({ present: false, redacted: true });
  });
});
