import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTuiAdapterConfig, redactTuiAdapterConfig } from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-tui-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadTuiAdapterConfig", () => {
  it("defaults to ENABLED on loopback with an ephemeral port (operator surface)", async () => {
    const config = await loadTuiAdapterConfig({ env: {} });

    expect(config).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/gui",
      allowNonLoopback: false,
    });
  });

  it("loads TUI settings from JSON with env overrides taking precedence", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        tui: {
          enabled: true,
          host: "127.0.0.1",
          port: 4111,
          basePath: "/operator/gui",
          allowNonLoopback: true,
          apiKey: "json-redacted-value",
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTuiAdapterConfig({
      env: { MONO_AGENT_TUI_PORT: "4222" },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4222,
      basePath: "/operator/gui",
      allowNonLoopback: true,
      apiKey: "json-redacted-value",
    });
  });

  it("can be disabled via JSON or env", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, `${JSON.stringify({ tui: { enabled: false } })}\n`, "utf8");

    expect((await loadTuiAdapterConfig({ env: {}, jsonPath: path })).enabled).toBe(false);
    expect((await loadTuiAdapterConfig({ env: { MONO_AGENT_TUI_ENABLED: "false" } })).enabled).toBe(false);
  });

  it("rejects a malformed base path", async () => {
    await expect(loadTuiAdapterConfig({ env: { MONO_AGENT_TUI_BASE_PATH: "no-slash" } }))
      .rejects.toMatchObject({ code: "invalid_config" });
  });

  it("collapses an all-slashes base path to root instead of an empty string", async () => {
    // "" would pass loading and then fail startTuiAdapter at startup.
    expect((await loadTuiAdapterConfig({ env: { MONO_AGENT_TUI_BASE_PATH: "////" } })).basePath).toBe("/");
    expect((await loadTuiAdapterConfig({ env: { MONO_AGENT_TUI_BASE_PATH: "/" } })).basePath).toBe("/");
    expect((await loadTuiAdapterConfig({ env: { MONO_AGENT_TUI_BASE_PATH: "/gui///" } })).basePath).toBe("/gui");
  });
});

describe("redactTuiAdapterConfig", () => {
  it("redacts the optional API key", () => {
    expect(redactTuiAdapterConfig({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/gui",
      allowNonLoopback: false,
      apiKey: "fixture-redacted-value",
    })).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/gui",
      allowNonLoopback: false,
      apiKey: { present: true, redacted: true },
    });
  });
});
