// SPDX-License-Identifier: MIT
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxProvider,
  type Models,
} from "@earendil-works/pi-ai";
import type {
  ModuleCommand,
  ModuleLogger,
  Runtime,
} from "@mono-agent/module-sdk";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import { createRuntimePi } from "../runtime.js";

const roots: string[] = [];
const logger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("pi:auth module command", () => {
  it("is available before start and reports redacted auth and model status", async () => {
    const fixture = await runtimeFixture({
      auth: {
        faux: {
          type: "api_key",
          key: "never-return-this-api-key",
        },
      },
    });
    const command = authCommand(fixture.runtime);
    const refresh = vi.spyOn(fixture.models, "refresh");
    const login = vi.spyOn(fixture.models, "login");

    expect(await fixture.runtime.health?.({ signal: signal() })).toMatchObject({
      status: "unknown",
      details: { state: "created" },
    });
    const status = await command.run(undefined, context());
    expect(status).toMatchObject({
      action: "status",
      status: "ready",
      providers: expect.arrayContaining([
        {
          provider: "faux",
          registered: true,
          credential: "api_key",
          modelCount: 1,
        },
      ]),
      unregisteredCredentials: 0,
      truncated: false,
    });
    expect(JSON.stringify(status)).not.toContain("never-return-this-api-key");
    expect(refresh).not.toHaveBeenCalled();

    await expect(command.run(
      { action: "models", provider: "faux" },
      context(),
    )).resolves.toMatchObject({
      action: "models",
      status: "ready",
      provider: "faux",
      refresh: "not-requested",
      total: 1,
      models: ["faux:faux-model"],
      truncated: false,
    });
    expect(refresh).not.toHaveBeenCalled();

    await expect(command.run(
      { action: "models", provider: "faux", refresh: true },
      context(),
    )).resolves.toMatchObject({
      action: "models",
      status: "ready",
      refresh: "requested",
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await expect(command.run(
      { action: "login", provider: "faux" },
      context(),
    )).resolves.toEqual({
      action: "login",
      status: "unsupported",
      provider: "faux",
      code: "interactive_login_unavailable",
      message: "Interactive Pi login is unavailable through module commands.",
    });
    expect(login).not.toHaveBeenCalled();
    expect(await fixture.runtime.health?.({ signal: signal() })).toMatchObject({
      status: "unknown",
      details: { state: "created" },
    });
  });

  it("rejects non-JSON, accessor-backed, proxy, and aborted inputs", async () => {
    const fixture = await runtimeFixture();
    const command = authCommand(fixture.runtime);
    let reads = 0;
    const accessor = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        reads += 1;
        return "status";
      },
    });

    await expect(command.run(accessor, context())).rejects.toThrow(/own data property/u);
    expect(reads).toBe(0);
    await expect(command.run(new Proxy({}, {}), context())).rejects.toThrow(/plain object/u);
    await expect(command.run({ action: "status", unknown: true }, context()))
      .rejects.toThrow(/unknown field/u);
    await expect(command.run({ action: "status", refresh: true }, context()))
      .rejects.toThrow(/only for the models action/u);

    const symbolic: Record<PropertyKey, unknown> = {};
    symbolic[Symbol("extra")] = true;
    await expect(command.run(symbolic, context())).rejects.toThrow(/unknown field/u);

    const controller = new AbortController();
    const reason = new Error("auth command cancelled");
    controller.abort(reason);
    await expect(command.run(undefined, context(controller.signal))).rejects.toBe(reason);
  });

  it("returns constant degraded output without exposing auth or discovery failures", async () => {
    const fixture = await runtimeFixture({
      rawAuth: '{"openai":{"type":"api_key","key":"secret-in-invalid-json"}',
    });
    const command = authCommand(fixture.runtime);
    const status = await command.run(undefined, context());
    expect(status).toMatchObject({
      action: "status",
      status: "degraded",
      code: "auth_status_unavailable",
      message: "Pi authentication status is partially unavailable.",
    });
    expect(JSON.stringify(status)).not.toContain("secret-in-invalid-json");

    vi.spyOn(fixture.models, "refresh")
      .mockRejectedValue(new Error("Bearer secret-provider-token"));
    const models = await command.run(
      { action: "models", refresh: true },
      context(),
    );
    expect(models).toMatchObject({
      action: "models",
      status: "degraded",
      code: "model_discovery_unavailable",
      message: "Pi model discovery is partially unavailable.",
    });
    expect(JSON.stringify(models)).not.toContain("secret-provider-token");
  });
});

async function runtimeFixture(options: {
  readonly auth?: Readonly<Record<string, unknown>>;
  readonly rawAuth?: string;
} = {}): Promise<{
  readonly runtime: Runtime;
  readonly models: Models;
}> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-auth-command-"));
  roots.push(root);
  const authPath = join(root, "auth.json");
  if (options.rawAuth !== undefined) {
    await writeFile(authPath, options.rawAuth, { mode: 0o600 });
    await chmod(authPath, 0o600);
  } else if (options.auth !== undefined) {
    await writeFile(authPath, `${JSON.stringify(options.auth)}\n`, { mode: 0o600 });
    await chmod(authPath, 0o600);
  }

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", input: ["text"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = createRuntimePi({
    config: parseRuntimePiConfig({ auth: { path: authPath } }),
    instanceId: "test-runtime",
    configDirectory: root,
    workspaceDirectory: root,
    models,
  });
  return { runtime, models };
}

function authCommand(runtime: Runtime): ModuleCommand {
  const command = runtime.commands?.find((candidate) => candidate.name === "pi:auth");
  if (command === undefined) throw new Error("pi:auth command is absent");
  return command;
}

function context(signalValue = signal()) {
  return { signal: signalValue, logger };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
