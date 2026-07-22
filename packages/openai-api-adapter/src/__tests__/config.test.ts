import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadOpenAIApiAdapterConfig,
  redactOpenAIApiAdapterConfig,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-openai-api-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadOpenAIApiAdapterConfig", () => {
  it("loads OpenAI API settings from JSON and env overrides", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        openaiApi: {
          enabled: true,
          host: "127.0.0.1",
          port: 4111,
          basePath: "/openai/v1",
          allowNonLoopback: true,
          apiKey: "json-redacted-value",
          modelId: "json-model",
        },
      })}\n`,
      "utf8",
    );

    const config = await loadOpenAIApiAdapterConfig({
      env: {
        MONO_AGENT_OPENAI_API_PORT: "4222",
        MONO_AGENT_OPENAI_API_MODEL_ID: "env-model",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4222,
      basePath: "/openai/v1",
      allowNonLoopback: true,
      apiKey: "json-redacted-value",
      modelId: "env-model",
    });
  });

  it("fails closed when an enabled non-loopback endpoint has no API key", async () => {
    await expect(loadOpenAIApiAdapterConfig({
      env: {
        MONO_AGENT_OPENAI_API_ENABLED: "true",
        MONO_AGENT_OPENAI_API_HOST: "0.0.0.0",
        MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK: "true",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("fails validation before startup when non-loopback opt-in is missing", async () => {
    await expect(loadOpenAIApiAdapterConfig({
      env: {
        MONO_AGENT_OPENAI_API_ENABLED: "true",
        MONO_AGENT_OPENAI_API_HOST: "0.0.0.0",
        MONO_AGENT_OPENAI_API_KEY: "test-key",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("does not mistake a loopback-looking hostname for loopback", async () => {
    await expect(loadOpenAIApiAdapterConfig({
      env: {
        MONO_AGENT_OPENAI_API_ENABLED: "true",
        MONO_AGENT_OPENAI_API_HOST: "127.attacker.example",
        MONO_AGENT_OPENAI_API_KEY: "test-key",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactOpenAIApiAdapterConfig", () => {
  it("redacts the optional OpenAI API key", () => {
    expect(redactOpenAIApiAdapterConfig({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/v1",
      allowNonLoopback: false,
      apiKey: "fixture-redacted-value",
      modelId: "agent",
    })).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/v1",
      allowNonLoopback: false,
      apiKey: { present: true, redacted: true },
      modelId: "agent",
    });
  });
});
