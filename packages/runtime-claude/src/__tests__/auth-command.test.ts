// SPDX-License-Identifier: MIT
import type { ModuleCommand, ModuleLogger, Runtime } from "@mono-agent/module-sdk";
import { describe, expect, it } from "vitest";

import { monoAgentModule } from "../index.js";

const logger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const signal = new AbortController().signal;

async function create(config: unknown): Promise<Runtime> {
  return monoAgentModule.create({
    instanceId: "claude",
    config: monoAgentModule.schema.parse(config),
    provenance: {},
    configDirectory: "/config",
    workspaceDirectory: "/workspace",
    dataDirectory: "/data",
    logger,
    host: { grantedCapabilities: new Set(), getCapability() { return undefined; } },
    signal,
  });
}

function authCommand(runtime: Runtime): ModuleCommand {
  const command = runtime.commands?.find(({ name }) => name === "claude:auth");
  if (command === undefined) throw new Error("claude:auth command is missing");
  return command;
}

describe("claude:auth", () => {
  it("is available before start and reports config versus ambient auth without secrets", async () => {
    const secret = `claude-secret-${"x".repeat(100_000)}`;
    const configured = await create({
      auth: { method: "oauth-token", token: secret },
    });
    const configuredResult = await authCommand(configured).run(undefined, { logger, signal });
    const serialized = JSON.stringify(configuredResult);

    expect(await configured.health?.({ signal })).toMatchObject({
      status: "unknown",
      details: { state: "created" },
    });
    expect(serialized.length).toBeLessThan(1_024);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("claude-secret");
    expect(configuredResult).toMatchObject({
      provider: "claude",
      action: "status",
      status: "ok",
      authentication: {
        state: "configured-unverified",
        source: "module-config",
        method: "oauth-token",
        verified: false,
      },
    });

    const ambient = await create({});
    expect(await authCommand(ambient).run({}, { logger, signal })).toMatchObject({
      authentication: {
        state: "ambient-unverified",
        source: "native-credential-store",
        method: "native",
        verified: false,
      },
    });
  });

  it("reports model discovery and interactive login as honestly unsupported", async () => {
    const command = authCommand(await create({}));

    expect(await command.run({ action: "models" }, { logger, signal })).toMatchObject({
      provider: "claude",
      action: "models",
      status: "unsupported",
      code: "model_discovery_unavailable",
    });
    expect(await command.run({ action: "login" }, { logger, signal })).toMatchObject({
      provider: "claude",
      action: "login",
      status: "unsupported",
      code: "interactive_login_unavailable",
    });
  });

  it("rejects accessor, oversized, and aborted input with bounded fixed errors", async () => {
    const command = authCommand(await create({}));
    let getterCalled = false;
    const accessor = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "status";
      },
    });

    expect(() => command.run(accessor, { logger, signal })).toThrow(
      "runtime-claude auth input must contain only action: status, models, or login",
    );
    expect(getterCalled).toBe(false);
    expect(() => command.run({ action: "secret".repeat(100_000) }, { logger, signal }))
      .toThrow("runtime-claude auth input must contain only action: status, models, or login");

    const controller = new AbortController();
    controller.abort("secret abort reason");
    expect(() => command.run(undefined, { logger, signal: controller.signal }))
      .toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});
