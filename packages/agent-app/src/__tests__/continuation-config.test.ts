import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTINUATION_SERVICE_PORT,
  loadContinuationSettings,
} from "../continuation-config.js";

describe("loadContinuationSettings", () => {
  it("uses a fixed restart-safe port when the host block is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-config-"));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, "{}\n");
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).resolves.toMatchObject({
      configured: false,
      enabled: true,
      host: "127.0.0.1",
      port: DEFAULT_CONTINUATION_SERVICE_PORT,
      namedRoutes: {},
      detachedServices: {},
    });
  });

  it("resolves named routes and detached service bearers only from named env vars", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-config-"));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, `${JSON.stringify({
      continuations: {
        host: "127.0.0.1",
        port: 4381,
        stateDir: ".mono-agent/continuations",
        namedRoutes: {
          "owner-attention": { mode: "notify_if_actionable", conversationId: "slack:D1:171.5" },
          capture: { mode: "capture", conversationId: "slack:D1:171.5" },
          steward: { mode: "silent" },
        },
        detachedServices: [{ name: "a8c-control", tokenEnv: "A8C_CONTROL_CONTINUATION_TOKEN" }],
        retention: {
          terminalMaxRecords: 10_000,
          terminalMaxAgeMs: 86_400_000,
          capturedTextMaxRecords: 250,
          capturedTextMaxAgeMs: 3_600_000,
        },
        limits: {
          maxActiveRecords: 2_000,
          maxActivePerOrigin: 200,
          maxConcurrent: 8,
          synthesisTimeoutMs: 300_000,
          deliveryTimeoutMs: 60_000,
          operatorPageSize: 50,
        },
      },
    })}\n`);
    const settings = await loadContinuationSettings({
      cwd,
      configPath,
      env: { A8C_CONTROL_CONTINUATION_TOKEN: "owner-only-service-secret" },
    });
    expect(settings).toMatchObject({
      configured: true,
      port: 4381,
      namedRoutes: {
        "owner-attention": { mode: "notify_if_actionable", conversationId: "slack:D1:171.5" },
        capture: { mode: "capture", conversationId: "slack:D1:171.5" },
        steward: { mode: "silent" },
      },
      detachedServices: { "a8c-control": "owner-only-service-secret" },
      retention: {
        terminalMaxRecords: 10_000,
        terminalMaxAgeMs: 86_400_000,
        capturedTextMaxRecords: 250,
        capturedTextMaxAgeMs: 3_600_000,
      },
      limits: {
        maxActiveRecords: 2_000,
        maxActivePerOrigin: 200,
        maxConcurrent: 8,
        synthesisTimeoutMs: 300_000,
        deliveryTimeoutMs: 60_000,
        operatorPageSize: 50,
      },
    });
  });

  it("fails closed when a detached service secret is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-config-"));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({
      continuations: {
        detachedServices: [{ name: "a8c-control", tokenEnv: "A8C_CONTROL_CONTINUATION_TOKEN" }],
      },
    }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(
      /requires A8C_CONTROL_CONTINUATION_TOKEN/u,
    );
  });

  it("rejects port zero because persisted callback URLs must survive restarts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-config-"));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ continuations: { port: 0 } }));

    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(
      /between 1 and 65535/u,
    );
  });

  it("rejects unknown continuation keys and destinations on silent routes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-config-"));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ continuations: { retryForever: true } }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(/unknown key/u);

    await writeFile(configPath, JSON.stringify({
      continuations: {
        namedRoutes: { steward: { mode: "silent", conversationId: "slack:D1" } },
      },
    }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(/forbidden/u);

    await writeFile(configPath, JSON.stringify({
      continuations: { retention: { terminalMaxRecords: -1 } },
    }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(/non-negative safe integer/u);

    await writeFile(configPath, JSON.stringify({
      continuations: { limits: { maxActiveRecords: 5, maxActivePerOrigin: 6 } },
    }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).rejects.toThrow(/cannot exceed maxActiveRecords/u);

    await writeFile(configPath, JSON.stringify({ continuations: { limits: { maxActiveRecords: 5 } } }));
    await expect(loadContinuationSettings({ cwd, configPath, env: {} })).resolves.toMatchObject({
      limits: { maxActiveRecords: 5, maxActivePerOrigin: 5 },
    });
  });
});
