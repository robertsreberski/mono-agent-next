import { createServer, request as httpRequest, type Server } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPERATOR_PROTOCOL, OPERATOR_REGISTRY_SCHEMA } from "@mono-agent/operator";

import type { WebConfig } from "../config.js";
import type { WebAgent } from "../contracts.js";
import { startWebServer, type WebServerHandle } from "../server.js";
import type { WebOperatorGateway } from "../service.js";
import { DurableWebStore } from "../store.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

const WEB_TOKEN = "web-browser-token-0123456789";
const OPERATOR_TOKEN = "operator-token-0123456789";
const webServers = new Set<WebServerHandle>();
const operatorServers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...webServers].map(async (server) => server.stop()));
  await Promise.all([...operatorServers].map(closeNodeServer));
  webServers.clear();
  operatorServers.clear();
  await cleanup();
});

describe("standalone web product", () => {
  it("authenticates browser APIs and rejects cross-origin or browser-simple mutations", async () => {
    const root = await temporaryDirectory();
    const gateway = immediateGateway();
    const server = await startWebServer({ config: config(join(root, "state")), operatorGateway: gateway });
    webServers.add(server);

    const unauthorized = await fetch(`${server.url}api/v1/bootstrap`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("mono-agent web");

    const forgedAuthority = `attacker.invalid:${server.port}`;
    expect(await getWithAuthority(server, "/", forgedAuthority, false)).toBe(421);
    expect(await getWithAuthority(server, "/api/v1/bootstrap", forgedAuthority, true)).toBe(421);

    const crossOrigin = await fetch(`${server.url}api/v1/threads`, {
      method: "POST",
      headers: authHeaders({ origin: "http://attacker.invalid", "content-type": "application/json" }),
      body: JSON.stringify({ agentId: "personal" }),
    });
    expect(crossOrigin.status).toBe(403);

    expect(await mutationWithAuthority(server, forgedAuthority)).toBe(421);

    const loopbackAuthority = `localhost:${server.port}`;
    expect(await mutationWithAuthority(server, loopbackAuthority)).toBe(201);

    const simple = await fetch(`${server.url}api/v1/threads`, {
      method: "POST",
      headers: authHeaders({ "content-type": "text/plain" }),
      body: JSON.stringify({ agentId: "personal" }),
    });
    expect(simple.status).toBe(415);
  });

  it("discovers through operator, streams one real turn, and reloads durable state", async () => {
    const root = await temporaryDirectory();
    const registry = join(root, "registry");
    await mkdir(registry, { mode: 0o700 });
    const operator = await startOperatorFixture();
    const now = new Date().toISOString();
    await writeFile(join(registry, "personal.json"), JSON.stringify({
      schema: OPERATOR_REGISTRY_SCHEMA,
      agent: { id: "personal", label: "Personal Agent" },
      operator: { endpoint: operator.url, tokenEnvironment: "OPERATOR_TEST_TOKEN" },
      pid: process.pid,
      startedAt: operator.startedAt,
      heartbeatAt: now,
      capabilities: capabilities(),
    }), { mode: 0o600 });
    await chmod(join(registry, "personal.json"), 0o600);
    const productConfig = config(join(root, "state"), { agentRegistries: [registry] });
    const environment = { OPERATOR_TEST_TOKEN: OPERATOR_TOKEN };
    const first = await startWebServer({ config: productConfig, environment });
    webServers.add(first);

    const bootstrap = await json(first, "/api/v1/bootstrap");
    expect(bootstrap).toMatchObject({ agents: [{ id: "personal", label: "Personal Agent", online: true }], threads: [] });
    const thread = await json(first, "/api/v1/threads", {
      method: "POST", body: JSON.stringify({ agentId: "personal", title: "Durable operator turn" }),
    }) as { id: string };
    const turnResponse = await fetch(`${first.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "hello operator" }),
    });
    expect(turnResponse.status).toBe(200);
    expect(turnResponse.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await turnResponse.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ type: "done", detail: { thread: { status: "complete" } } });
    expect(events.some((event) => JSON.stringify(event).includes("hello from agent"))).toBe(true);

    await first.stop();
    webServers.delete(first);
    const second = await startWebServer({ config: productConfig, environment });
    webServers.add(second);
    await expect(json(second, `/api/v1/threads/${thread.id}`)).resolves.toMatchObject({
      thread: { status: "complete", title: "Durable operator turn" },
      messages: [
        { role: "user", text: "hello operator", status: "complete" },
        { role: "assistant", text: "hello from agent", status: "complete" },
      ],
    });
  });

  it("cancels the exact active process turn and persists cancellation", async () => {
    const root = await temporaryDirectory();
    const cancelled = vi.fn();
    const gateway: WebOperatorGateway = {
      async listAgents() { return [agent()]; },
      async runTurn(input) {
        await input.onText("working");
        if (input.signal.aborted) throw input.signal.reason;
        await new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      },
      async cancel(_agentId, conversationId) { cancelled(conversationId); },
    };
    const server = await startWebServer({ config: config(join(root, "state")), operatorGateway: gateway });
    webServers.add(server);
    const thread = await json(server, "/api/v1/threads", {
      method: "POST", body: JSON.stringify({ agentId: "personal" }),
    }) as { id: string };
    const streaming = await fetch(`${server.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text: "wait" }),
    });
    const detail = await json(server, `/api/v1/threads/${thread.id}/cancel`, { method: "POST", body: "{}" });
    expect(detail).toMatchObject({ thread: { status: "cancelled" } });
    expect(cancelled).toHaveBeenCalledWith(`web:${thread.id}`);
    await streaming.text();
  });

  it("keeps the service-owned turn running after the browser stream disconnects", async () => {
    const root = await temporaryDirectory();
    let finish!: () => void;
    let started!: () => void;
    const finishGate = new Promise<void>((resolve) => { finish = resolve; });
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const gateway: WebOperatorGateway = {
      async listAgents() { return [agent()]; },
      async runTurn(input) {
        await input.onText("partial");
        started();
        await finishGate;
        expect(input.signal.aborted).toBe(false);
        await input.onText("settled after reload");
      },
      async cancel() {},
    };
    const server = await startWebServer({ config: config(join(root, "state")), operatorGateway: gateway });
    webServers.add(server);
    const thread = await json(server, "/api/v1/threads", {
      method: "POST", body: JSON.stringify({ agentId: "personal" }),
    }) as { id: string };
    const streaming = await fetch(`${server.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text: "continue" }),
    });
    await startedGate;
    const reader = streaming.body!.getReader();
    await reader.read();
    await reader.cancel("simulated reload");
    finish();

    let detail: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await json(server, `/api/v1/threads/${thread.id}`);
      if ((detail as { thread: { status: string } }).thread.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail).toMatchObject({
      thread: { status: "complete" },
      messages: [{ role: "user" }, { role: "assistant", text: "settled after reload", status: "complete" }],
    });
  });

  it("fails closed before binding a non-loopback listener without a strong token", async () => {
    const root = await temporaryDirectory();
    await expect(startWebServer({
      config: config(join(root, "state"), { host: "0.0.0.0", token: "sixteen-char-key!", allowInsecureHttp: true }),
      operatorGateway: immediateGateway(),
    })).rejects.toMatchObject({ code: "unsafe_non_loopback_bind" });
  });

  it("requires an explicit plaintext trusted-network opt-in for every non-loopback bind", async () => {
    const root = await temporaryDirectory();
    await expect(startWebServer({
      config: config(join(root, "state"), { host: "0.0.0.0" }),
      operatorGateway: immediateGateway(),
    })).rejects.toMatchObject({ code: "insecure_http_opt_in_required" });
  });

  it("accepts a direct Tailscale address origin on an authenticated wildcard listener", async () => {
    const root = await temporaryDirectory();
    const server = await startWebServer({
      config: config(join(root, "state"), { host: "0.0.0.0", allowInsecureHttp: true }),
      operatorGateway: immediateGateway(),
    });
    webServers.add(server);
    const tailscaleAuthority = `100.100.100.100:${server.port}`;
    expect(await mutationWithAuthority(server, tailscaleAuthority)).toBe(201);
  });

  it("destroys sockets on deadline and returns after an upstream ignores shutdown", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let gatewayStarted!: () => void;
    const started = new Promise<void>((resolve) => { gatewayStarted = resolve; });
    const never = new Promise<void>(() => undefined);
    const gateway: WebOperatorGateway = {
      async listAgents() { return [agent()]; },
      async runTurn() { gatewayStarted(); await never; },
      async cancel() { await never; },
    };
    const server = await startWebServer({
      config: config(dataDirectory),
      operatorGateway: gateway,
      shutdownTimeoutMs: 25,
    });
    webServers.add(server);
    const thread = await json(server, "/api/v1/threads", {
      method: "POST", body: JSON.stringify({ agentId: "personal" }),
    }) as { id: string };
    const streaming = await fetch(`${server.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ text: "hang" }),
    });
    await started;

    const stopStarted = Date.now();
    await server.stop();
    expect(Date.now() - stopStarted).toBeLessThan(500);
    webServers.delete(server);
    await streaming.body?.cancel().catch(() => undefined);

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({ thread: { status: "interrupted" } });
    await reopened.close();
  });
});

function config(
  dataDirectory: string,
  overrides: { readonly host?: string; readonly token?: string; readonly allowInsecureHttp?: boolean; readonly agentRegistries?: readonly string[] } = {},
): WebConfig {
  return {
    configVersion: 1,
    listen: { host: overrides.host ?? "127.0.0.1", port: 0 },
    auth: { token: overrides.token ?? WEB_TOKEN },
    allowInsecureHttp: overrides.allowInsecureHttp ?? false,
    dataDirectory,
    agentRegistries: overrides.agentRegistries ?? [join(dataDirectory, "missing-registry")],
    sourcePath: join(dataDirectory, "web.config.json"),
  };
}

function agent(): WebAgent {
  return { id: "personal", label: "Personal Agent", endpoint: "http://127.0.0.1:1", online: true, capabilities: capabilities() };
}

function immediateGateway(): WebOperatorGateway {
  return {
    async listAgents() { return [agent()]; },
    async runTurn(input) { await input.onText("fixture response"); },
    async cancel() {},
  };
}

function capabilities(): Record<string, boolean> {
  return {
    attachments: false, liveInput: false, askUser: false, cancellation: true, quotes: false,
    runtimeOverrides: true, proactive: false, configView: true, replay: true, health: true,
  };
}

async function startOperatorFixture(): Promise<{ readonly url: string; readonly startedAt: string }> {
  const startedAt = new Date().toISOString();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${OPERATOR_TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":"unauthorized"}'); return;
    }
    if (request.method === "POST" && request.url === "/v1/turns") {
      const body = JSON.parse(await bodyText(request)) as { conversationId: string };
      const now = new Date().toISOString();
      const frames = [
        { type: "accepted", turnId: "turn-1", conversationId: body.conversationId, startedAt: now },
        { type: "capabilities", turnId: "turn-1", capabilities: capabilities() },
        { type: "delta", turnId: "turn-1", target: "assistant", mode: "append", text: "hello from " },
        { type: "delta", turnId: "turn-1", target: "assistant", mode: "append", text: "agent" },
        { type: "completed", turnId: "turn-1", finalMessage: { role: "assistant", text: "hello from agent" }, finishedAt: now, stopReason: "completed" },
      ];
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/cancel")) {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"accepted"}'); return;
    }
    if (request.method === "GET" && request.url === "/v1/info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocol: OPERATOR_PROTOCOL, agent: { id: "personal", label: "Personal Agent" }, process: { pid: process.pid, startedAt }, capabilities: capabilities() }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"not_found"}');
  });
  operatorServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind");
  return { url: `http://127.0.0.1:${address.port}`, startedAt };
}

async function bodyText(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${WEB_TOKEN}`, ...extra };
}

function mutationWithAuthority(server: WebServerHandle, authority: string): Promise<number> {
  const body = JSON.stringify({ agentId: "personal" });
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/api/v1/threads",
      method: "POST",
      headers: {
        authorization: `Bearer ${WEB_TOKEN}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        host: authority,
        origin: `http://${authority}`,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function getWithAuthority(
  server: WebServerHandle,
  path: string,
  authority: string,
  authenticated: boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path,
      method: "GET",
      headers: {
        host: authority,
        ...(authenticated ? { authorization: `Bearer ${WEB_TOKEN}` } : {}),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

async function json(server: WebServerHandle, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${server.url}${path.replace(/^\//u, "")}`, {
    ...init,
    headers: authHeaders(init.body === undefined ? {} : { "content-type": "application/json" }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function closeNodeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
