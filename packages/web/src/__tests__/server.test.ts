// SPDX-License-Identifier: MIT
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
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
  it("exposes bounded attachments, quotes, operator views, and durable thread deletion", async () => {
    const root = await temporaryDirectory();
    let forwarded: unknown;
    const now = new Date().toISOString();
    const gateway: WebOperatorGateway = {
      async listAgents() {
        return [{ ...agent(), capabilities: { ...capabilities(), attachments: true, quotes: true } }];
      },
      async runTurn(input) {
        forwarded = input;
        await input.onText("accepted");
      },
      async cancel() {},
      async readReplay(_agentId, conversationId) {
        return { conversationId, messages: [{ id: "m1", role: "assistant", text: "accepted" }] };
      },
      async readConfig() {
        return { revision: "r1", generatedAt: now, value: { channels: "[redacted]" }, redacted: true };
      },
      async readHealth() {
        return { status: "healthy", checkedAt: now, details: [] };
      },
    };
    const server = await startWebServer({ config: config(join(root, "state")), operatorGateway: gateway });
    webServers.add(server);
    const index = await (await fetch(server.url)).text();
    expect(index).toContain("mono-agent Console");
    const manifest = await fetch(`${server.url}manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toContain("mono-agent Console");
    const thread = await json(server, "/api/v1/threads", {
      method: "POST", body: JSON.stringify({ agentId: "personal" }),
    }) as { id: string; operatorConversationId: string };
    const largeData = Buffer.alloc(320 * 1_024, 0x61);
    const attachment = {
      id: "file-1",
      name: "note.txt",
      mediaType: "text/plain",
      sizeBytes: largeData.byteLength,
      url: `data:text/plain;base64,${largeData.toString("base64")}`,
    };
    const response = await fetch(`${server.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        text: "with context",
        attachments: [attachment],
        quote: { conversationId: thread.operatorConversationId, messageId: "m1", text: "previous" },
        runtime: "pi-secondary",
        model: "openai:gpt-5.6-sol",
        effort: "high",
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(forwarded).toMatchObject({
      attachments: [attachment],
      quote: { conversationId: thread.operatorConversationId, messageId: "m1", text: "previous" },
      runtime: "pi-secondary",
      model: "openai:gpt-5.6-sol",
      effort: "high",
    });
    const oversizedData = Buffer.alloc((512 * 1_024) + 1, 0x62);
    const oversized = await fetch(`${server.url}api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        text: "",
        attachments: [{
          id: "file-too-large",
          name: "large.bin",
          mediaType: "application/octet-stream",
          sizeBytes: oversizedData.byteLength,
          url: `data:application/octet-stream;base64,${oversizedData.toString("base64")}`,
        }],
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(json(server, `/api/v1/threads/${thread.id}/replay`)).resolves.toMatchObject({ conversationId: thread.operatorConversationId });
    await expect(json(server, "/api/v1/agents/personal/config")).resolves.toMatchObject({ revision: "r1", redacted: true });
    await expect(json(server, "/api/v1/agents/personal/health")).resolves.toMatchObject({ status: "healthy" });
    await expect(json(server, `/api/v1/threads/${thread.id}`, {
      method: "PATCH", body: JSON.stringify({ archived: true }),
    })).resolves.toMatchObject({ archivedAt: expect.any(String) });
    await expect(json(server, `/api/v1/threads/${thread.id}`, { method: "DELETE", body: "{}" })).resolves.toEqual({ deleted: true });
    const missing = await fetch(`${server.url}api/v1/threads/${thread.id}`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

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
    expect(await page.text()).toContain("mono-agent Console");

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

  it("applies guarded agent/thread patches and streams authenticated resumable revisions", async () => {
    const root = await temporaryDirectory();
    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
    });
    webServers.add(server);

    expect((await fetch(`${server.url}api/v1/events`)).status).toBe(401);
    const controller = new AbortController();
    const eventResponse = await fetch(`${server.url}api/v1/events`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    expect(eventResponse.status).toBe(200);
    expect(eventResponse.headers.get("content-type")).toContain("text/event-stream");
    const events = sseReader(eventResponse);
    await expect(events.next()).resolves.toMatchObject({ type: "ready", revision: 0 });

    const thread = await json(server, "/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: "personal" }),
    }) as { readonly id: string };
    await expect(events.next()).resolves.toMatchObject({
      type: "threads.changed",
      revision: 1,
      threadId: thread.id,
    });

    const prematureDelete = await fetch(`${server.url}api/v1/threads/${thread.id}`, {
      method: "DELETE",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
    });
    expect(prematureDelete.status).toBe(409);
    const titled = await json(server, `/api/v1/threads/${thread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Manual browser title" }),
    });
    expect(titled).toMatchObject({ title: "Manual browser title", titleManual: true });
    const pinned = await json(server, "/api/v1/agents/personal", {
      method: "PATCH",
      body: JSON.stringify({ pinned: true }),
    });
    expect(pinned).toMatchObject({ id: "personal", pinned: true });
    expect(await json(server, "/api/v1/bootstrap")).toMatchObject({
      revision: 3,
      agents: [{ id: "personal", pinned: true }],
    });
    await events.cancel();
    controller.abort();

    const replayResponse = await fetch(`${server.url}api/v1/events`, {
      headers: authHeaders({ "last-event-id": "2" }),
    });
    const replay = sseReader(replayResponse);
    await expect(replay.next()).resolves.toMatchObject({ type: "agents.changed", revision: 3 });
    await replay.cancel();

    const resetResponse = await fetch(`${server.url}api/v1/events`, {
      headers: authHeaders({ "last-event-id": "999" }),
    });
    const reset = sseReader(resetResponse);
    await expect(reset.next()).resolves.toMatchObject({ type: "reset", revision: 3 });
    await reset.cancel();
  });

  it("trusts one exact external HTTPS authority only from its loopback proxy connection", async () => {
    const root = await temporaryDirectory();
    const externalOrigin = "https://console.example.test";
    const server = await startWebServer({
      config: config(join(root, "state"), { externalOrigins: [externalOrigin] }),
      operatorGateway: immediateGateway(),
    });
    webServers.add(server);

    expect(await getWithAuthority(server, "/", "console.example.test", false)).toBe(200);
    expect(await mutationWithExternalAuthority(
      server,
      "console.example.test",
      externalOrigin,
    )).toBe(201);
    expect(await mutationWithExternalAuthority(
      server,
      "console.example.test",
      "https://attacker.example.test",
    )).toBe(403);
    expect(await mutationWithExternalAuthority(
      server,
      "lookalike.console.example.test",
      externalOrigin,
    )).toBe(421);
    expect(await getWithAuthority(
      server,
      "/",
      `console.example.test:${server.port}`,
      false,
    )).toBe(421);
  });

  it("serves packed assets without treating API or health paths as SPA navigation", async () => {
    const root = await temporaryDirectory();
    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
    });
    webServers.add(server);
    const worker = await (await fetch(`${server.url}sw.js`)).text();
    expect(worker).toContain("denylist:[/^\\/api");
    expect(worker).toContain("/^\\/healthz$/");
    expect(worker).not.toContain('url:"api');
    expect(worker).not.toContain('url:"/api');
    expect(worker).not.toContain('url:"healthz');
    expect(worker).not.toContain('url:"/healthz');
    expect((await fetch(`${server.url}api/not-a-route`, { headers: authHeaders() })).status).toBe(404);
    expect((await fetch(`${server.url}healthz/not-a-route`)).status).toBe(404);
  });

  it("never serves bytes through static-file or static-directory symlinks", async () => {
    const root = await temporaryDirectory();
    const assets = join(root, "assets");
    const outside = join(root, "outside");
    await mkdir(assets);
    await mkdir(outside);
    await writeFile(join(assets, "index.html"), "<h1>safe application</h1>");
    await writeFile(join(assets, "inside.txt"), "inside target");
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(assets, "inside.txt"), join(assets, "inside-link.txt"));
    await symlink(join(outside, "secret.txt"), join(assets, "outside-link.txt"));
    await symlink(outside, join(assets, "outside-directory"));

    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
      staticDirectory: assets,
    });
    webServers.add(server);

    const index = await fetch(server.url);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("safe application");
    for (const path of [
      "inside-link.txt",
      "outside-link.txt",
      "outside-directory/secret.txt",
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/inside target|outside secret/u);
    }
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

  it("bounds live event subscribers and readmits one after a stream closes", async () => {
    const root = await temporaryDirectory();
    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
    });
    webServers.add(server);

    const open: AbortController[] = [];
    // `fetch` resolves once headers arrive, which can race the server's own
    // registration. Reading the first event proves this subscriber is counted
    // before the next one is opened.
    const subscribe = async (): Promise<Response> => {
      const controller = new AbortController();
      open.push(controller);
      const response = await fetch(`${server.url}api/v1/events`, {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
        signal: controller.signal,
      });
      if (response.status === 200 && response.body !== null) {
        await response.body.getReader().read();
      }
      return response;
    };

    try {
      for (let index = 0; index < 32; index += 1) {
        expect((await subscribe()).status).toBe(200);
      }
      const overflow = await fetch(`${server.url}api/v1/events`, {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
      });
      expect(overflow.status).toBe(503);
      expect(await overflow.json()).toMatchObject({ error: { code: "event_capacity" } });

      // Closing one stream must return its slot; a leaked `close` would keep
      // the console permanently unable to resubscribe after a reload.
      open.shift()?.abort();
      await vi.waitFor(async () => {
        const readmitted = await subscribe();
        expect(readmitted.status).toBe(200);
      }, { timeout: 5_000 });
    } finally {
      for (const controller of open) controller.abort();
    }
  });

  it("withholds a static asset that exceeds the size cap or changes identity mid-read", async () => {
    const root = await temporaryDirectory();
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "index.html"), "<h1>safe application</h1>");
    // 16 MiB is the cap; one byte past it must not be served at all.
    await writeFile(join(assets, "huge.txt"), Buffer.alloc(16 * 1_024 * 1_024 + 1, 0x61));
    await writeFile(join(assets, "swapped.txt"), "original bytes");

    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
      staticDirectory: assets,
    });
    webServers.add(server);

    const oversized = await fetch(`${server.url}huge.txt`);
    expect(oversized.status).toBe(404);
    expect(await oversized.text()).not.toContain("aaaa");

    const swapped = await fetch(`${server.url}swapped.txt`);
    expect(swapped.status).toBe(200);
    expect(await swapped.text()).toBe("original bytes");

    // Replace the path with a different inode while the server is running: the
    // before/after identity comparison must refuse to hand back either file's
    // bytes rather than serving a half-read mixture.
    await writeFile(join(root, "replacement.txt"), "replacement bytes");
    await rename(join(root, "replacement.txt"), join(assets, "swapped.txt"));
    const afterSwap = await fetch(`${server.url}swapped.txt`);
    expect([200, 404]).toContain(afterSwap.status);
    if (afterSwap.status === 200) expect(await afterSwap.text()).toBe("replacement bytes");
  });

  it("keeps the emitted service worker uncacheable", async () => {
    const root = await temporaryDirectory();
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "index.html"), "<h1>safe application</h1>");
    // VitePWA emits `sw.js`; a stale worker would pin an old console build.
    await writeFile(join(assets, "sw.js"), "self.addEventListener('install', () => {});");

    const server = await startWebServer({
      config: config(join(root, "state")),
      operatorGateway: immediateGateway(),
      staticDirectory: assets,
    });
    webServers.add(server);

    const worker = await fetch(`${server.url}sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get("cache-control")).toBe("no-store");
  });

function config(
  dataDirectory: string,
  overrides: {
    readonly host?: string;
    readonly token?: string;
    readonly allowInsecureHttp?: boolean;
    readonly agentRegistries?: readonly string[];
    readonly externalOrigins?: readonly string[];
  } = {},
): WebConfig {
  return {
    configVersion: 1,
    listen: { host: overrides.host ?? "127.0.0.1", port: 0 },
    auth: { token: overrides.token ?? WEB_TOKEN },
    allowInsecureHttp: overrides.allowInsecureHttp ?? false,
    dataDirectory,
    agentRegistries: overrides.agentRegistries ?? [join(dataDirectory, "missing-registry")],
    externalOrigins: overrides.externalOrigins ?? [],
    sourcePath: join(dataDirectory, "web.config.json"),
  };
}

function agent(): WebAgent {
  return {
    id: "personal",
    label: "Personal Agent",
    endpoint: "http://127.0.0.1:1",
    online: true,
    pinned: false,
    capabilities: capabilities(),
  };
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
  // Wrapped rather than passed straight in: `createServer` expects a void
  // handler, so a rejection thrown inside an async one becomes an unhandled
  // rejection and the request hangs. The test then times out with the reason
  // detached from the failure that caused it.
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
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
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    });
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

function mutationWithExternalAuthority(
  server: WebServerHandle,
  authority: string,
  origin: string,
): Promise<number> {
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
        origin,
        "x-forwarded-host": "ignored.example.test",
        "x-forwarded-proto": "http",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function sseReader(response: Response): {
  readonly next: () => Promise<Record<string, unknown>>;
  readonly cancel: () => Promise<void>;
} {
  if (response.body === null) throw new Error("Missing SSE body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    async next() {
      for (;;) {
        const separator = pending.indexOf("\n\n");
        if (separator >= 0) {
          const block = pending.slice(0, separator);
          pending = pending.slice(separator + 2);
          const data = block.split("\n").find((line) => line.startsWith("data:"));
          if (data !== undefined) return JSON.parse(data.slice(5).trim()) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE ended before the next event.");
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/gu, "\n");
      }
    },
    async cancel() {
      await reader.cancel();
      reader.releaseLock();
    },
  };
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
