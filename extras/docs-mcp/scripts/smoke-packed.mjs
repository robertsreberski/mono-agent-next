import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smokeRoot = await mkdtemp(join(tmpdir(), "mono-agent-docs-packed-smoke-"));
let client;

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", smokeRoot], {
    cwd: packageRoot,
    env: { ...process.env, CI: "1" },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  const tarballs = (await readdir(smokeRoot)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `Expected one packed tarball, found ${tarballs.length}.`);

  await writeFile(join(smokeRoot, "package.json"), `${JSON.stringify({
    name: "mono-agent-docs-packed-smoke",
    private: true,
    type: "module",
    dependencies: {
      "@mono-agent/docs-mcp": `file:./${tarballs[0]}`,
    },
  }, null, 2)}\n`, "utf8");
  await execFileAsync("pnpm", ["install", "--ignore-scripts"], {
    cwd: smokeRoot,
    env: { ...process.env, CI: "1" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });

  const executable = join(
    smokeRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mono-agent-docs-mcp.cmd" : "mono-agent-docs-mcp",
  );
  const registrationPath = join(smokeRoot, ".mcp.json");
  await writeFile(registrationPath, `${JSON.stringify({
    mcpServers: {
      "mono-agent-docs": {
        type: "stdio",
        command: executable,
        args: [],
      },
    },
  }, null, 2)}\n`, "utf8");
  const registration = JSON.parse(await readFile(registrationPath, "utf8"));
  const registeredServer = registration?.mcpServers?.["mono-agent-docs"];
  assert.deepEqual(
    Object.keys(registration),
    ["mcpServers"],
    "Companion registration must remain outside mono-agent.config.json.",
  );
  assert.deepEqual(
    registeredServer,
    { type: "stdio", command: executable, args: [] },
    "Companion registration did not preserve the exact stdio command.",
  );
  const transport = new StdioClientTransport({
    command: registeredServer.command,
    args: registeredServer.args,
    cwd: smokeRoot,
    stderr: "pipe",
  });
  client = new Client({ name: "mono-agent-docs-packed-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const response = await client.callTool({
    name: "mono_agent_docs",
    arguments: {
      action: "search",
      query: "Which config field loads channel plugin packages?",
      scope: "docs",
      limit: 3,
    },
  });
  assert.notEqual(response.isError, true, "Packed MCP search returned a tool error.");
  const structured = response.structuredContent;
  assert.equal(structured?.schema, "mono-agent.docs.v2");
  assert.equal(structured?.action, "search");
  assert.equal(structured?.retrievalMode, "hybrid");
  assert.ok(Array.isArray(structured?.results) && structured.results.length === 3, "Expected three packed-corpus results.");
  const first = structured.results[0];
  assert.ok(typeof first === "object" && first !== null && "readTarget" in first && typeof first.readTarget === "string");
  assert.ok("markdown" in first && typeof first.markdown === "string" && first.markdown.length > 1_200 && first.markdown.length <= 3_000);
  assert.ok(Array.isArray(structured.navigation?.nextActions) && structured.navigation.nextActions.length > 0);

  const read = await client.callTool({
    name: "mono_agent_docs",
    arguments: { action: "read", target: first.readTarget },
  });
  assert.notEqual(read.isError, true, "Packed MCP read returned a tool error.");
  assert.equal(read.structuredContent?.schema, "mono-agent.docs.v2");
  assert.equal(read.structuredContent?.action, "read");
  assert.ok(
    typeof read.structuredContent?.markdown === "string"
      && read.structuredContent.markdown.length > first.markdown.length
      && read.structuredContent.markdown.length <= 10_000,
    "Packed MCP read did not expand the search excerpt.",
  );

  const resource = await client.readResource({ uri: first.readTarget });
  assert.ok(
    resource.contents.some((content) => "text" in content
      && content.text.includes("Source:")
      && content.text.length > first.markdown.length),
    "Packed chunk resource was not expanded and readable.",
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: "@mono-agent/docs-mcp",
    transport: "packed-stdio",
    registration: "mcpServers.mono-agent-docs",
    docsVersion: structured.docsVersion,
    corpusDigest: structured.corpusDigest,
    topResult: first.readTarget,
  })}\n`);
} finally {
  if (client !== undefined) await client.close().catch(() => undefined);
  await rm(smokeRoot, { recursive: true, force: true });
}
