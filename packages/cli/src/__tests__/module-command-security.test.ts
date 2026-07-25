// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../index.js";

const roots: string[] = [];
const environmentName = "MONO_AGENT_FIXTURE_COMMAND_SECRET";

afterEach(async () => {
  delete process.env[environmentName];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("module command secret boundary", () => {
  it("never prints an environment-resolved secret from create, run, aggregate, or stop", async () => {
    const secret = "cli-module-command-secret-5f2c8e";
    process.env[environmentName] = secret;
    const fixture = await createCommandFixture();

    await fixture.writePhase("success");
    const successful = output();
    await expect(runCli(command(fixture.configPath), successful.io)).resolves.toBe(0);
    expect(successful.stdout.join("")).toContain("[REDACTED]");
    expect(successful.stdout.join("")).not.toContain(secret);

    for (const [phase, code] of [
      ["create", "module_command_create_failed"],
      ["run", "module_command_run_failed"],
      ["aggregate", "module_command_run_failed"],
      ["accessor-errors", "module_command_run_failed"],
      ["proxy-errors", "module_command_run_failed"],
      ["stop", "module_command_stop_failed"],
      ["both", "module_command_run_and_stop_failed"],
    ] as const) {
      await fixture.writePhase(phase);
      const failed = output();
      await expect(runCli(command(fixture.configPath), failed.io)).resolves.toBe(1);
      const stderr = failed.stderr.join("");
      expect(stderr).toContain(code);
      expect(stderr).toContain("main command fixture:secret");
      expect(stderr).toContain("[REDACTED]");
      expect(stderr).not.toContain(secret);
      expect(Buffer.byteLength(stderr, "utf8")).toBeLessThan(4_256);
    }
  });
});

function command(configPath: string): readonly string[] {
  return [
    "module", "command",
    "--config", configPath,
    "--module", "main",
    "--name", "fixture:secret",
  ];
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

async function createCommandFixture(): Promise<{
  readonly configPath: string;
  writePhase(phase: string): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-cli-command-"));
  roots.push(root);
  const packageName = `@fixture/runtime-command-${randomUUID().toLowerCase()}`;
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "You are a command security fixture.\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "command-security-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { [packageName]: "1.0.0" },
  }, null, 2)}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "command-security-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [packageName]: "1.0.0" } },
      [`node_modules/${packageName}`]: { version: "1.0.0" },
    },
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "1.0.0",
    type: "module",
    main: "./index.js",
    "mono-agent": {
      packageName,
      apiVersion: 1,
      kind: "runtime",
      responsibility: "Exercise module command secret projection.",
    },
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "index.js"), `
const failure = (code, phase, secret) => Object.assign(new Error(phase + " rejected " + secret), { code });
export const monoAgentModule = {
  manifest: {
    packageName: ${JSON.stringify(packageName)},
    packageVersion: "1.0.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Exercise module command secret projection.",
    capabilities: [],
  },
  schema: {
    jsonSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          "x-mono-agent-env-eligible": true,
          "x-mono-agent-secret": true,
        },
        phase: {
          type: "string",
          enum: ["success", "create", "run", "aggregate", "accessor-errors", "proxy-errors", "stop", "both"],
        },
      },
      required: ["apiKey", "phase"],
      additionalProperties: false,
    },
    parse(input) { return input; },
  },
  create({ config }) {
    if (config.phase === "create") throw failure("FIXTURE_CREATE", "create", config.apiKey);
    return {
      capabilities: {
        tools: true,
        mcp: true,
        attachments: true,
        approvals: true,
        structuredOutput: true,
        sandbox: true,
        sessions: true,
        maxTurns: true,
        maxOutputTokens: true,
      },
      runTurn() { throw new Error("unused"); },
      commands: [{
        name: "fixture:secret",
        kind: "authentication",
        description: "Exercise command error projection.",
        run() {
          if (config.phase === "run" || config.phase === "both") {
            throw failure("FIXTURE_RUN", "run", config.apiKey);
          }
          if (config.phase === "aggregate") {
            throw new AggregateError([
              failure("FIXTURE_AGGREGATE_INNER", "aggregate inner", config.apiKey),
            ], "aggregate rejected " + config.apiKey);
          }
          if (config.phase === "accessor-errors" || config.phase === "proxy-errors") {
            const entries = [];
            Object.defineProperty(entries, "0", {
              enumerable: true,
              get() { throw failure("FIXTURE_HOSTILE_READ", "hostile aggregate read", config.apiKey); },
            });
            const errors = config.phase === "proxy-errors"
              ? new Proxy(entries, {
                  getOwnPropertyDescriptor() {
                    throw failure("FIXTURE_PROXY_READ", "proxy aggregate read", config.apiKey);
                  },
                })
              : entries;
            const aggregate = new AggregateError([], "hostile aggregate rejected " + config.apiKey);
            Object.defineProperty(aggregate, "errors", { value: errors });
            throw aggregate;
          }
          return { status: "ready", credential: config.apiKey, [config.apiKey]: "secret-key" };
        },
      }],
      stop() {
        if (config.phase === "stop" || config.phase === "both") {
          throw failure("FIXTURE_STOP", "stop", config.apiKey);
        }
      },
    };
  },
};
`);
  const configPath = join(root, "mono-agent.config.json");
  return {
    configPath,
    async writePhase(phase: string) {
      await writeFile(configPath, `${JSON.stringify({
        configVersion: 1,
        agent: {
          id: "command-security",
          name: "Command Security",
          instructions: "./AGENTS.md",
          workspace: ".",
        },
        runtimes: {
          main: {
            $use: packageName,
            apiKey: { $env: environmentName },
            phase,
          },
        },
        routing: {
          primary: { runtime: "main", model: "fixture:model" },
          fallbacks: [],
        },
        policy: {
          tools: { default: "deny", allow: [] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
      }, null, 2)}\n`);
    },
  };
}
