#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// Boots the real web product against a real operator channel on a fixed port,
// so Playwright can drive the shipped bundle in a real browser.
//
// Nothing here is a mock of the product. The operator channel, its HTTP
// transport, the registry descriptor, the web server, and the built webapp
// bundle are the shipped ones. The only substitution is the agent behind the
// channel: `dispatch` is scripted, so the turn is deterministic and no provider
// is contacted. That is the same substitution
// `scripts/verify/operator-products.mjs` already makes.
//
// The script stays alive until it is signalled; Playwright's `webServer` owns
// its lifetime.

import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { monoAgentModule } from "@mono-agent/channel-operator";
import { OPERATOR_REGISTRY_SCHEMA, OperatorClient } from "@mono-agent/operator";
import { startWebServer } from "@mono-agent/web";

export const BROWSER_FIXTURE_PORT = 4398;
export const BROWSER_FIXTURE_WEB_TOKEN = "mono-agent-browser-render-token-0123456789";
export const BROWSER_FIXTURE_AGENT_ID = "browser-render-smoke";
export const BROWSER_FIXTURE_AGENT_LABEL = "Browser Render Smoke";

/**
 * The turn the browser must render. Every frame here is one the console has
 * gotten wrong at least once: tool calls and tool results rendered as nothing
 * (#116), activity text never surfacing (#118), and the reply arriving as
 * deltas rather than a single message.
 */
export const BROWSER_FIXTURE_TOOL_NAME = "read_repository_file";
export const BROWSER_FIXTURE_TOOL_RESULT_TEXT = "tool result rendered in a real browser";
export const BROWSER_FIXTURE_ACTIVITY_TEXT = "Reading the repository file";
export const BROWSER_FIXTURE_REPLY = "browser render smoke ok";

const OPERATOR_TOKEN = "mono-agent-browser-render-operator-0123456789";
const OPERATOR_TOKEN_ENV = "MONO_AGENT_BROWSER_RENDER_OPERATOR_TOKEN";

async function dispatchScriptedTurn(reply) {
  await reply.emit({ type: "activity", text: BROWSER_FIXTURE_ACTIVITY_TEXT });
  await reply.emit({
    type: "tool-call",
    call: {
      id: "call-1",
      name: BROWSER_FIXTURE_TOOL_NAME,
      input: { path: "README.md" },
    },
  });
  await reply.emit({
    type: "tool-result",
    result: {
      callId: "call-1",
      content: [{ type: "text", text: BROWSER_FIXTURE_TOOL_RESULT_TEXT }],
    },
  });
  await reply.emit({ type: "text-delta", delta: "browser render " });
  await reply.emit({ type: "text-delta", delta: "smoke ok" });
  return { status: "completed", text: BROWSER_FIXTURE_REPLY };
}

export async function startBrowserFixture({
  port = BROWSER_FIXTURE_PORT,
  auth = { token: BROWSER_FIXTURE_WEB_TOKEN },
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-browser-render-"));
  const registryDirectory = join(root, "registry");
  const lifecycle = new AbortController();
  await mkdir(registryDirectory, { mode: 0o700 });
  await chmod(registryDirectory, 0o700);

  const operatorChannel = await monoAgentModule.create({
    instanceId: BROWSER_FIXTURE_AGENT_ID,
    config: monoAgentModule.schema.parse({
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: OPERATOR_TOKEN },
    }),
    provenance: {
      "/auth/token": { source: "environment", environmentName: OPERATOR_TOKEN_ENV },
    },
    configDirectory: root,
    workspaceDirectory: root,
    dataDirectory: root,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    host: {
      grantedCapabilities: new Set(["operator.identity.v1"]),
      getCapability(name) {
        return name === "operator.identity.v1"
          ? {
            agent: { id: BROWSER_FIXTURE_AGENT_ID, label: BROWSER_FIXTURE_AGENT_LABEL },
            process: { pid: process.pid },
            defaults: { runtime: "smoke", model: "smoke:model" },
            configPath: join(root, "mono-agent.config.json"),
            projectRoot: root,
          }
          : undefined;
      },
      dispatch(_request, reply) {
        return dispatchScriptedTurn(reply);
      },
    },
    signal: lifecycle.signal,
  });
  await operatorChannel.start?.({ signal: lifecycle.signal });

  const info = await new OperatorClient({
    endpoint: operatorChannel.endpoint,
    token: OPERATOR_TOKEN,
    requestTimeoutMs: 5_000,
  }).getInfo();

  const descriptorPath = join(registryDirectory, `${BROWSER_FIXTURE_AGENT_ID}.json`);
  // Written through a temp file and renamed, never truncated in place. The web
  // gateway reads this file on every turn, and an in-place rewrite leaves a
  // window where it reads a half-written descriptor and reports the agent
  // offline. That produced a 1-in-6 failure in this lane before it was fixed --
  // a fixture defect that would have read as a product flake.
  const writeDescriptor = async () => {
    const temporaryPath = `${descriptorPath}.${String(process.pid)}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      schema: OPERATOR_REGISTRY_SCHEMA,
      agent: { id: BROWSER_FIXTURE_AGENT_ID, label: BROWSER_FIXTURE_AGENT_LABEL },
      operator: { endpoint: operatorChannel.endpoint, tokenEnvironment: OPERATOR_TOKEN_ENV },
      pid: process.pid,
      startedAt: info.process.startedAt,
      heartbeatAt: new Date().toISOString(),
      capabilities: info.capabilities,
    })}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, descriptorPath);
  };
  await writeDescriptor();
  // A descriptor written once goes stale and the gateway starts answering
  // `agent_offline`, which is correct behaviour and would make this lane look
  // like a product defect. A real agent heartbeats; so does the fixture.
  const heartbeat = setInterval(() => {
    void writeDescriptor().catch(() => undefined);
  }, 5_000);
  heartbeat.unref();

  const webServer = await startWebServer({
    config: {
      configVersion: 1,
      listen: { host: "127.0.0.1", port },
      auth,
      allowInsecureHttp: false,
      dataDirectory: join(root, "web-data"),
      agentRegistries: [registryDirectory],
      allowedHosts: [],
      externalOrigins: [],
      sourcePath: join(root, "web.config.json"),
    },
    environment: { [OPERATOR_TOKEN_ENV]: OPERATOR_TOKEN },
  });

  return {
    url: webServer.url,
    async stop() {
      clearInterval(heartbeat);
      await webServer.stop().catch(() => undefined);
      lifecycle.abort();
      await operatorChannel.stop?.().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startBrowserFixture();
  process.stdout.write(`browser fixture listening on ${fixture.url}\n`);
  const shutdown = () => {
    void fixture.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
