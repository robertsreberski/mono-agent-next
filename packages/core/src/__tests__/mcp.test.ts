import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { AgentConfigError, createAgentHost } from "../index.js";
import { bestEffortClose, loadProjectMcpConfig } from "../mcp.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

it("loads an ordinary stdio MCP, applies monotonic tool policy, and does not leak ambient env", async () => {
  const observedTools: string[][] = [];
  const project = await createFixtureProject([{
    kind: "runtime",
    controller: {
      create() {
        return {
          capabilities: {
            tools: true,
            mcp: true,
            attachments: false,
            approvals: true,
            structuredOutput: false,
            sandbox: false,
            sessions: false,
          },
          async runTurn(request: unknown, context: unknown) {
            const tools = isRecord(request) && Array.isArray(request.tools) ? request.tools : [];
            const names = tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []);
            observedTools.push(names);
            if (names.length === 0) return completed("no-tools");
            if (!isRecord(context) || typeof context.executeTool !== "function") throw new Error("missing executeTool");
            const result = await context.executeTool(
              { id: "probe", name: names[0], input: {} },
              new AbortController().signal,
            );
            return completed(JSON.stringify(result));
          },
        };
      },
    },
  }]);
  projects.push(project);
  const runtime = project.modules[0]!.name;
  const serverPath = join(project.root, "mcp-server.mjs");
  await writeFile(serverPath, MCP_SERVER_SOURCE);
  await project.writeMcp({
    mcpServers: {
      probe: {
        type: "stdio",
        command: process.execPath,
        args: ["./mcp-server.mjs"],
        env: { EXPLICIT_SECRET: { $env: "EXPLICIT_SECRET" } },
      },
    },
  });
  const config = minimalConfig(runtime, {
    context: { mcp: { configPath: "./.mcp.json" } },
    policy: {
      tools: { default: "deny", allow: ["environment_probe"] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    },
  });
  await project.writeConfig(config);
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    EXPLICIT_SECRET: "included",
    SECRET_UNRELATED: "should-not-leak",
  };
  const host = await createAgentHost(project.configPath, { environment });
  const first = await host.submit({ conversationId: "mcp", text: "probe" });
  expect(observedTools[0]).toEqual(["environment_probe"]);
  expect(first.text).toContain("included");
  expect(first.text).not.toContain("should-not-leak");

  const narrowed = await host.submit({
    conversationId: "mcp",
    text: "narrow",
    toolPolicy: { allow: ["not-globally-allowed"] },
  });
  expect(observedTools[1]).toEqual([]);
  expect(narrowed.text).toBe("no-tools");
  await host.stop();
});

it("fails MCP env validation before starting any module", async () => {
  let created = 0;
  const project = await createFixtureProject([{
    kind: "runtime",
    controller: {
      create() {
        created += 1;
        return {};
      },
    },
  }]);
  projects.push(project);
  const runtime = project.modules[0]!.name;
  await project.writeMcp({
    mcpServers: {
      probe: { type: "stdio", command: process.execPath, env: { TOKEN: { $env: "ABSENT" } } },
    },
  });
  await project.writeConfig(minimalConfig(runtime, { context: { mcp: { configPath: "./.mcp.json" } } }));
  try {
    await createAgentHost(project.configPath, { environment: { PATH: process.env.PATH } });
    throw new Error("expected missing MCP environment to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConfigError);
    expect((error as AgentConfigError).issues.some((issue) => issue.message.includes("ABSENT"))).toBe(true);
  }
  expect(created).toBe(0);
});

it("allows HTTPS or literal-loopback HTTP MCP URLs and rejects other plain HTTP hosts", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  const path = await project.writeMcp({
    mcpServers: {
      localIpv4: { type: "http", url: "http://127.42.0.1:3210/mcp" },
      localIpv6: { type: "http", url: "http://[::1]:3210/mcp" },
      remoteTls: { type: "http", url: "https://mcp.example.test/service" },
    },
  });

  await expect(loadProjectMcpConfig(path, {})).resolves.toMatchObject({
    mcpServers: {
      localIpv4: { url: "http://127.42.0.1:3210/mcp" },
      localIpv6: { url: "http://[::1]:3210/mcp" },
      remoteTls: { url: "https://mcp.example.test/service" },
    },
  });

  for (const url of [
    "http://localhost:3210/mcp",
    "http://192.0.2.10:3210/mcp",
    "http://mcp.example.test/service",
  ]) {
    await project.writeMcp({ mcpServers: { unsafe: { type: "http", url } } });
    await expect(loadProjectMcpConfig(path, {})).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "mcpServers.unsafe.url", code: "insecure_http" }),
      ]),
    });
  }
});

it("requires explicit env references for secret-bearing MCP env and header values", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  const path = await project.writeMcp({
    mcpServers: {
      worker: {
        type: "stdio",
        command: process.execPath,
        env: {
          NODE_ENV: "production",
          API_TOKEN: "inline-stdio-secret",
        },
      },
      remote: {
        type: "http",
        url: "https://mcp.example.test/service",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer inline-header-secret",
        },
      },
    },
  });

  let error: AgentConfigError | undefined;
  try {
    await loadProjectMcpConfig(path, {});
  } catch (candidate) {
    if (candidate instanceof AgentConfigError) error = candidate;
  }
  expect(error).toBeInstanceOf(AgentConfigError);
  expect(error?.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "mcpServers.worker.env.API_TOKEN", code: "inline_secret" }),
    expect.objectContaining({ path: "mcpServers.remote.headers.Authorization", code: "inline_secret" }),
  ]));
  expect(JSON.stringify(error?.issues)).not.toContain("inline-stdio-secret");
  expect(JSON.stringify(error?.issues)).not.toContain("inline-header-secret");

  await project.writeMcp({
    mcpServers: {
      worker: {
        type: "stdio",
        command: process.execPath,
        env: {
          NODE_ENV: "production",
          API_TOKEN: { $env: "MCP_API_TOKEN" },
        },
      },
      remote: {
        type: "http",
        url: "https://mcp.example.test/service",
        headers: {
          Accept: "application/json",
          Authorization: { $env: "MCP_AUTHORIZATION" },
          "X-Tenant": "tenant-a",
        },
      },
    },
  });
  await expect(loadProjectMcpConfig(path, {
    MCP_API_TOKEN: "stdio-secret",
    MCP_AUTHORIZATION: "Bearer header-secret",
  })).resolves.toMatchObject({
    mcpServers: {
      worker: { env: { NODE_ENV: "production", API_TOKEN: { $env: "MCP_API_TOKEN" } } },
      remote: {
        headers: {
          Accept: "application/json",
          Authorization: { $env: "MCP_AUTHORIZATION" },
          "X-Tenant": "tenant-a",
        },
      },
    },
  });
});

it("bounds both client and transport close attempts during partial MCP cleanup", async () => {
  vi.useFakeTimers();
  try {
    const client = { close: vi.fn(async () => new Promise<void>(() => undefined)) };
    const transport = { close: vi.fn(async () => new Promise<void>(() => undefined)) };
    const completion = bestEffortClose(client, transport, 50);

    await vi.advanceTimersByTimeAsync(50);
    expect(client.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    await expect(completion).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

const MCP_SERVER_SOURCE = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "env-probe", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [{
          name: "environment_probe",
          description: "Report bounded env inheritance",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      };
    } else if (message.method === "tools/call") {
      result = {
        content: [{
          type: "text",
          text: JSON.stringify({
            explicit: process.env.EXPLICIT_SECRET ?? null,
            unrelated: process.env.SECRET_UNRELATED ?? null,
          }),
        }],
      };
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } }) + "\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
