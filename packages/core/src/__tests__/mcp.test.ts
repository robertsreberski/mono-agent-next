import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { AgentConfigError, createAgentHost } from "../index.js";
import {
  BoundedStdioMcpTransport,
  bestEffortClose,
  connectProjectMcpTools,
  createCheckedMcpFetch,
  loadProjectMcpConfig,
  parseProjectMcpConfig,
  resolveMcpToolNames,
} from "../mcp.js";
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
  const first = await host.submit({ requestId: "mcp-first", conversationId: "mcp", text: "probe" });
  expect(observedTools[0]).toEqual(["environment_probe"]);
  expect(first.text).toContain("included");
  expect(first.text).not.toContain("should-not-leak");

  const narrowed = await host.submit({
    requestId: "mcp-narrow",
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

it("rejects an oversized unterminated stdio frame before parsing and terminates the child", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  const serverPath = join(project.root, "oversized-stdio.mjs");
  const pidPath = join(project.root, "oversized-stdio.pid");
  const closeMarkerPath = join(project.root, "oversized-stdio.closed");
  await writeFile(serverPath, OVERSIZED_STDIO_SERVER_SOURCE);
  const transport = new BoundedStdioMcpTransport({
    command: process.execPath,
    args: [serverPath, pidPath, closeMarkerPath],
    cwd: project.root,
    env: {},
  }, 1024 * 1024, 25);
  const transportError = new Promise<Error>((resolveError) => {
    transport.onerror = resolveError;
  });
  const transportClosed = new Promise<void>((resolveClose) => {
    transport.onclose = resolveClose;
  });

  await transport.start();
  await expect(transportError).resolves.toMatchObject({
    message: "MCP stdio frame exceeds 1048576 bytes before newline",
  });
  await transportClosed;
  expect(await readFile(closeMarkerPath, "utf8")).toBe("SIGTERM");
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

it("drains and bounds hostile stdio stderr without surfacing configured secrets", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  const serverPath = join(project.root, "hostile-stderr.mjs");
  const pidPath = join(project.root, "hostile-stderr.pid");
  const closeMarkerPath = join(project.root, "hostile-stderr.closed");
  const secret = "mcp-stderr-secret-value";
  await writeFile(serverPath, HOSTILE_STDERR_SERVER_SOURCE);
  const transport = new BoundedStdioMcpTransport({
    command: process.execPath,
    args: [serverPath, pidPath, closeMarkerPath],
    cwd: project.root,
    env: { API_TOKEN: secret },
    redactionValues: [secret],
  }, 1_024, 25);
  const transportError = new Promise<Error>((resolveError) => {
    transport.onerror = resolveError;
  });
  const transportClosed = new Promise<void>((resolveClose) => {
    transport.onclose = resolveClose;
  });

  await transport.start();
  const error = await transportError;
  expect(error.message).toContain("[REDACTED]");
  expect(error.message).toContain("truncated after 65536 bytes");
  expect(error.message).not.toContain(secret);
  expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(4_096);
  await transportClosed;
  expect(await readFile(closeMarkerPath, "utf8")).toBe("SIGTERM");
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

it("parses descriptor-read MCP data without opening the source and bounds server count", () => {
  expect(parseProjectMcpConfig({
    mcpServers: {
      local: { type: "stdio", command: process.execPath },
    },
  }, {}, "descriptor snapshot")).toEqual({
    mcpServers: {
      local: { type: "stdio", command: process.execPath },
    },
  });

  const tooMany = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`server-${index}`, { type: "stdio", command: process.execPath }]),
  );
  try {
    parseProjectMcpConfig({ mcpServers: tooMany }, {}, "descriptor snapshot");
    throw new Error("expected server cap validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConfigError);
    expect((error as AgentConfigError).issues).toContainEqual(expect.objectContaining({
      path: "mcpServers",
      code: "limit",
      message: expect.stringMatching(/at most 32 servers/u),
    }));
  }
});

it("resolves names only after the full MCP catalog is known", () => {
  const sources = [
    { server: "alpha", tool: "shared" },
    { server: "alpha", tool: "unique" },
    { server: "beta", tool: "shared" },
    { server: "beta", tool: "core__reserved" },
    { server: "beta", tool: "not.portable" },
  ] as const;
  const forward = resolveMcpToolNames(sources);
  const reverse = resolveMcpToolNames([...sources].reverse());
  const forwardNames = new Map(forward.tools.map((tool) => [`${tool.server}:${tool.tool}`, tool.name]));
  const reverseNames = new Map(reverse.tools.map((tool) => [`${tool.server}:${tool.tool}`, tool.name]));

  expect(forward.ambiguousAliases).toEqual(["shared"]);
  expect(forwardNames).toEqual(reverseNames);
  expect(forward.tools.find((tool) => tool.tool === "unique")).toMatchObject({
    name: "unique",
    rawAlias: "unique",
  });
  for (const tool of forward.tools.filter((entry) => entry.tool !== "unique")) {
    expect(tool.name).toMatch(/^mcp__[A-Za-z0-9_-]{43}$/u);
    expect(tool.rawAlias).toBeUndefined();
  }
  expect(forwardNames.get("alpha:shared")).not.toBe(forwardNames.get("beta:shared"));
});

it("rejects duplicate source identities and malicious final-name collisions", () => {
  expect(() => resolveMcpToolNames([
    { server: "alpha", tool: "duplicate" },
    { server: "alpha", tool: "duplicate" },
  ])).toThrow(/advertised duplicate tool/u);

  const canonical = resolveMcpToolNames([{ server: "alpha", tool: "not.portable" }]).tools[0]!.name;
  expect(() => resolveMcpToolNames([
    { server: "alpha", tool: "not.portable" },
    { server: "beta", tool: canonical },
  ])).toThrow(/final tool name collision/u);
});

it("paginates deterministically, canonicalizes collisions, and preserves MCP isError", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  await writeFile(join(project.root, "alpha.mjs"), catalogServerSource([
    [
      { name: "zeta" },
      { name: "shared" },
    ],
    [{ name: "alpha" }],
  ], { content: [{ type: "text", text: "expected failure" }], isError: true }));
  await writeFile(join(project.root, "beta.mjs"), catalogServerSource([
    [
      { name: "shared" },
      { name: "runtime__reserved" },
    ],
  ], { content: [{ type: "text", text: "ok" }] }));
  const config = parseProjectMcpConfig({
    mcpServers: {
      beta: { type: "stdio", command: process.execPath, args: ["./beta.mjs"] },
      alpha: { type: "stdio", command: process.execPath, args: ["./alpha.mjs"] },
    },
  }, {});

  const connected = await connectProjectMcpTools(config, {
    projectRoot: project.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    expect(connected.tools.map((tool) => `${tool.source.kind === "mcp" ? tool.source.server : "core"}:${tool.source.kind === "mcp" ? tool.source.tool : tool.name}`)).toEqual([
      "alpha:alpha",
      "alpha:shared",
      "alpha:zeta",
      "beta:runtime__reserved",
      "beta:shared",
    ]);
    expect(connected.ambiguousAliases).toEqual(["shared"]);
    expect(connected.tools.find((tool) => tool.source.kind === "mcp" && tool.source.tool === "alpha")).toMatchObject({
      name: "alpha",
      rawAlias: "alpha",
    });
    const sharedNames = connected.tools
      .filter((tool) => tool.source.kind === "mcp" && tool.source.tool === "shared")
      .map((tool) => tool.name);
    expect(sharedNames).toHaveLength(2);
    expect(sharedNames[0]).not.toBe(sharedNames[1]);
    expect(sharedNames.every((name) => /^mcp__[A-Za-z0-9_-]{43}$/u.test(name))).toBe(true);
    expect(connected.tools.find((tool) =>
      tool.source.kind === "mcp" && tool.source.tool === "runtime__reserved")?.name).toMatch(
      /^mcp__[A-Za-z0-9_-]{43}$/u,
    );

    const result = await connected.tools.find((tool) =>
      tool.source.kind === "mcp" && tool.source.server === "alpha" && tool.source.tool === "alpha")!.execute({});
    expect(result).toMatchObject({
      content: [{ type: "text", text: "expected failure" }],
      isError: true,
    });
  } finally {
    await connected.close();
  }
});

it("rejects repeated tools/list cursors", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  await writeFile(join(project.root, "loop.mjs"), repeatingCursorServerSource());
  const config = parseProjectMcpConfig({
    mcpServers: {
      loop: { type: "stdio", command: process.execPath, args: ["./loop.mjs"] },
    },
  }, {});
  await expect(connectProjectMcpTools(config, {
    projectRoot: project.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
  })).rejects.toThrow(/repeated tools\/list cursor/u);
});

it("bounds MCP catalog cardinality and individual schemas", async () => {
  const manyProject = await createFixtureProject([]);
  projects.push(manyProject);
  await writeFile(join(manyProject.root, "many.mjs"), catalogServerSource([
    Array.from({ length: 129 }, (_, index) => ({ name: `tool_${index}` })),
  ], { content: [{ type: "text", text: "ok" }] }));
  await expect(connectProjectMcpTools(parseProjectMcpConfig({
    mcpServers: {
      many: { type: "stdio", command: process.execPath, args: ["./many.mjs"] },
    },
  }, {}), {
    projectRoot: manyProject.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
  })).rejects.toThrow(/tool limit exceeded: 129 > 128/u);

  const schemaProject = await createFixtureProject([]);
  projects.push(schemaProject);
  await writeFile(join(schemaProject.root, "schema.mjs"), catalogServerSource([
    [{
      name: "oversized_schema",
      inputSchema: { type: "object", description: "x".repeat(70_000), properties: {} },
    }],
  ], { content: [{ type: "text", text: "ok" }] }));
  await expect(connectProjectMcpTools(parseProjectMcpConfig({
    mcpServers: {
      schema: { type: "stdio", command: process.execPath, args: ["./schema.mjs"] },
    },
  }, {}), {
    projectRoot: schemaProject.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
  })).rejects.toThrow(/input schema exceeds 65536 bytes/u);
});

it("applies a hard deadline to MCP tool calls", async () => {
  const project = await createFixtureProject([]);
  projects.push(project);
  await writeFile(join(project.root, "hang.mjs"), hangingCallServerSource());
  const connected = await connectProjectMcpTools(parseProjectMcpConfig({
    mcpServers: {
      hang: { type: "stdio", command: process.execPath, args: ["./hang.mjs"] },
    },
  }, {}), {
    projectRoot: project.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    callTimeoutMs: 25,
    callTotalTimeoutMs: 25,
  });
  try {
    await expect(connected.tools[0]!.execute({})).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    await connected.close();
  }
});

it("checks every MCP HTTP redirect before following it", async () => {
  const calls: string[] = [];
  const sameOriginFetch = createCheckedMcpFetch(
    new URL("https://mcp.example.test/start"),
    vi.fn(async (url) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        return new Response(null, { status: 307, headers: { location: "/next" } });
      }
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    }),
  );
  await expect((await sameOriginFetch("https://mcp.example.test/start", { method: "POST" })).text()).resolves.toBe("ok");
  expect(calls).toEqual([
    "https://mcp.example.test/start",
    "https://mcp.example.test/next",
  ]);

  const crossOriginBase = vi.fn(async () =>
    new Response(null, { status: 307, headers: { location: "https://other.example.test/mcp" } }));
  const crossOriginFetch = createCheckedMcpFetch(new URL("https://mcp.example.test/start"), crossOriginBase);
  await expect(crossOriginFetch("https://mcp.example.test/start", { method: "POST" })).rejects.toThrow(
    /changed origin/u,
  );
  expect(crossOriginBase).toHaveBeenCalledOnce();

  const changingMethodFetch = createCheckedMcpFetch(
    new URL("https://mcp.example.test/start"),
    vi.fn(async () => new Response(null, { status: 302, headers: { location: "/next" } })),
  );
  await expect(changingMethodFetch("https://mcp.example.test/start", { method: "POST" })).rejects.toThrow(
    /method-changing redirect/u,
  );
});

it("bounds MCP HTTP response bodies even without Content-Length", async () => {
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(700_000));
      controller.enqueue(new Uint8Array(400_000));
      controller.close();
    },
  });
  const checkedFetch = createCheckedMcpFetch(
    new URL("https://mcp.example.test/start"),
    vi.fn(async () => new Response(oversized, {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
  );
  const response = await checkedFetch("https://mcp.example.test/start");
  await expect(response.arrayBuffer()).rejects.toThrow(/exceeds 1048576 bytes/u);

  const oversizedSse = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data:${"x".repeat(1_050_000)}\n\n`));
      controller.close();
    },
  });
  const checkedSseFetch = createCheckedMcpFetch(
    new URL("https://mcp.example.test/start"),
    vi.fn(async () => new Response(oversizedSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })),
  );
  const sseResponse = await checkedSseFetch("https://mcp.example.test/start");
  await expect(sseResponse.text()).rejects.toThrow(/SSE frame exceeds 1048576 bytes/u);
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

const OVERSIZED_STDIO_SERVER_SOURCE = String.raw`
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {
  writeFileSync(process.argv[3], "SIGTERM");
  process.exit(0);
});
process.stdout.write(Buffer.alloc(1_100_000, 0x78));
setInterval(() => undefined, 1_000);
`;

const HOSTILE_STDERR_SERVER_SOURCE = String.raw`
import { writeFileSync, writeSync } from "node:fs";

writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {
  writeFileSync(process.argv[3], "SIGTERM");
  process.exit(0);
});
writeSync(2, Buffer.from((process.env.API_TOKEN ?? "missing") + "\n"));
const stderrChunk = Buffer.alloc(64 * 1024, 0x78);
for (let index = 0; index < 64; index += 1) writeSync(2, stderrChunk);
writeSync(1, Buffer.alloc(2_048, 0x79));
setInterval(() => undefined, 1_000);
`;

function catalogServerSource(
  pages: readonly (readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Readonly<Record<string, unknown>>;
  }[])[],
  callResult: Readonly<Record<string, unknown>>,
): string {
  const normalizedPages = pages.map((page) => page.map(({ name, description, inputSchema }) => ({
    name,
    description: description ?? `${name} tool`,
    inputSchema: inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
  })));
  return String.raw`
const pages = ${JSON.stringify(normalizedPages)};
const callResult = ${JSON.stringify(callResult)};
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
        serverInfo: { name: "catalog-fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      const page = message.params?.cursor === undefined ? 0 : Number(message.params.cursor);
      result = {
        tools: pages[page] ?? [],
        ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
      };
    } else if (message.method === "tools/call") {
      result = callResult;
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } }) + "\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;
}

function repeatingCursorServerSource(): string {
  return String.raw`
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
    const result = message.method === "initialize"
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "cursor-fixture", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? { tools: [], nextCursor: "repeat" }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;
}

function hangingCallServerSource(): string {
  return String.raw`
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
    if (message.id === undefined || message.method === "tools/call") continue;
    const result = message.method === "initialize"
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "hang-fixture", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? {
            tools: [{
              name: "hang",
              description: "Never finishes",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            }],
          }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
