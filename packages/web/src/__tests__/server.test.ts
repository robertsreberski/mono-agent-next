import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isAllowedWebHostname, startWebServer, type WebServerHandle } from "../server.js";
import { prepareWebStatePaths } from "../state-paths.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];
const servers: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function start(options: Partial<Parameters<typeof startWebServer>[0]> = {}): Promise<{ handle: WebServerHandle; baseUrl: string; root: string }> {
  const root = await temporaryRoot();
  cleanup.push(root);
  // Managed runtimes live below ~/.mono-agent. Keep a hidden parent in the
  // fixture so SPA fallback tests exercise Express's dotfile handling.
  const staticDir = join(root, ".mono-agent", "static");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>web</title>");
  const handle = await startWebServer({
    port: 0,
    stateDir: join(root, "state"),
    staticDir,
    discoveryIntervalMs: 0,
    purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: operatorFetch(),
    ...options,
  });
  servers.push(handle);
  return { handle, baseUrl: `http://127.0.0.1:${handle.port}`, root };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("web HTTP server", () => {
  it("defaults to a LAN bind with no application auth or CORS grant", async () => {
    const { handle, baseUrl } = await start();
    expect(handle.host).toBe("0.0.0.0");
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: 1 });
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>web</title>");
    const clientRoute = await fetch(`${baseUrl}/conversations/example`);
    expect(clientRoute.status).toBe(200);
    expect(await clientRoute.text()).toContain("<title>web</title>");
    const bootstrap = await fetch(`${baseUrl}/api/v1/bootstrap`);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
    const body = await bootstrap.json() as { agents: unknown[] };
    expect(body.agents[0]).toMatchObject({ sourceId: "agent-one", status: "online", supportsAttachments: true });
  });

  it("publishes an owner-private loopback ingress and removes only its live record on stop", async () => {
    const recorded: unknown[] = [];
    const { handle, baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsHistoryAppend: true,
        onVerbatim: async (conversationId, body) => void recorded.push({ conversationId, body }),
      }),
    });
    const ingressPath = join(handle.stateDir, "notify-ingress.json");
    expect((await lstat(ingressPath)).mode & 0o777).toBe(0o600);
    const ingress = JSON.parse(await readFile(ingressPath, "utf8")) as { url: string; token: string };
    expect(new URL(ingress.url).hostname).toBe("127.0.0.1");

    const unauthorized = await fetch(ingress.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey: "cron:daily:one:success",
        text: "Morning brief",
      }),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(ingress.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingress.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey: "cron:daily:one:success",
        text: "Morning brief",
      }),
    });
    expect(accepted.status).toBe(201);
    const delivered = await json(accepted) as { threadId: string; duplicate: boolean };
    expect(delivered.duplicate).toBe(false);
    expect(recorded).toEqual([{
      conversationId: `web:${delivered.threadId}`,
      body: { text: "Morning brief", idempotencyKey: "cron:daily:one:success" },
    }]);
    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap`)) as { threads: unknown[] };
    expect(bootstrap.threads).toEqual([
      expect.objectContaining({
        id: delivered.threadId,
        title: "Cron notification",
        trigger: { kind: "cron" },
      }),
    ]);

    await handle.stop();
    await expect(lstat(ingressPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects DNS-rebinding hosts and cross-origin mutations while accepting the exact configured hostname", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    expect(isAllowedWebHostname("mickey.home.arpa", "mickey.home.arpa", "mickey")).toBe(true);
    expect(isAllowedWebHostname("attacker.home.arpa", "mickey.home.arpa", "mickey")).toBe(false);
    expect(isAllowedWebHostname("attacker.local", "0.0.0.0", "mickey")).toBe(false);
    expect(isAllowedWebHostname("attacker.ts.net", "0.0.0.0", "mickey")).toBe(false);
    expect(isAllowedWebHostname("mickey-home.tailnet.ts.net", "0.0.0.0", "mickey", ["mickey-home.tailnet.ts.net"]))
      .toBe(true);

    const target = new URL(baseUrl);
    const rebindingStatus = await new Promise<number>((resolvePromise, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/healthz",
        headers: { Host: "attacker" },
      }, (response) => {
        response.resume();
        resolvePromise(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
    expect(rebindingStatus).toBe(421);
    const crossOrigin = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(sameOrigin.status).toBe(201);
  });

  it("maps oversized JSON to 413 instead of a generic server error", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const response = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "x".repeat(300_000) }),
    });
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ error: { code: "request_too_large" } });
  });

  it("validates exact host configuration before acquiring the persistent service lease", async () => {
    const root = await temporaryRoot();
    cleanup.push(root);
    const staticDir = join(root, "static");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "ok");
    const options = {
      host: "127.0.0.1",
      port: 0,
      stateDir: join(root, "state"),
      staticDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [],
    } as const;

    await expect(startWebServer({ ...options, allowedHosts: ["bad:host"] }))
      .rejects.toMatchObject({ code: "invalid_allowed_host" });
    const handle = await startWebServer(options);
    servers.push(handle);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("streams raw uploads, rejects encoded/wrong-size bodies, and serves non-images as safe downloads", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const unsupported = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "raw.bin", contentType: "application/octet-stream", sizeBytes: 1 }),
    });
    expect(unsupported.status).toBe(415);

    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "page('x').html", contentType: "text/html", sizeBytes: 5 }),
    });
    const attachment = (await json(created)).attachment as { id: string };
    const wrongMime = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "text/html" }, body: "hello",
    });
    expect(wrongMime.status).toBe(415);
    const encoded = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" }, body: "hello",
    });
    expect(encoded.status).toBe(415);
    const uploaded = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "hello",
    });
    expect(uploaded.status).toBe(200);

    const content = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-disposition")).toContain("attachment;");
    expect(content.headers.get("content-disposition")).toContain("%27");
    expect(await content.text()).toBe("hello");
  });

  it("keeps failed upload bytes staged/retryable and removes only staged attachments", async () => {
    const { baseUrl, handle } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", contentType: "text/plain", sizeBytes: 5 }),
    });
    const attachment = (await json(created)).attachment as { id: string };
    const mismatch = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "four",
    });
    expect(mismatch.status).toBe(400);
    expect((await readdir(join(handle.stateDir, "uploads"))).filter((name) => name.includes("partial"))).toEqual([]);
    const retried = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "hello",
    });
    expect(retried.status).toBe(200);
    const committedDelete = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}`, { method: "DELETE" });
    expect(committedDelete.status).toBe(204); // uploaded but still staged until a turn commits it
    expect(await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`)).toMatchObject({ status: 404 });
  });

  it("cleans validated crash-residue partial uploads before accepting traffic", async () => {
    const root = await temporaryRoot();
    cleanup.push(root);
    const stateDir = join(root, "state");
    const paths = await prepareWebStatePaths({ stateDir });
    const partial = join(paths.uploads, "11111111-1111-4111-8111-111111111111.bin.partial-22222222-2222-4222-8222-222222222222");
    await writeFile(partial, "orphan", { mode: 0o600 });
    const staticDir = join(root, "static");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "ok");
    const handle = await startWebServer({
      host: "127.0.0.1", port: 0, stateDir, staticDir,
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [],
    });
    servers.push(handle);
    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports create/read/archive/turn API flow with a source-bound conversation", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string; sourceId: string };
    expect(thread.sourceId).toBe("agent-one");
    const turn = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", model: "provider/default", effort: "high" }),
    });
    expect(turn.status).toBe(202);
    let detail: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
      if ((detail.thread as { runState?: { status?: string } }).runState?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(detail).toMatchObject({ thread: { sourceId: "agent-one", runState: { status: "complete" } } });
    const archived = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
    });
    expect((await json(archived)).thread).toMatchObject({ id: thread.id });
    const deleted = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`)).toMatchObject({ status: 404 });
  });

  it("accepts a live follow-up for the active web turn and exposes its applied status", async () => {
    const encoder = new TextEncoder();
    let finishTurn = () => undefined;
    const liveInputs: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const { baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "append", delta: "Working" })}\n`));
            finishTurn = () => {
              controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
              controller.close();
            };
          },
        }),
        onLiveInput: async (conversationId, body) => {
          liveInputs.push({ conversationId, body });
          return { status: "applied", runId: "run-live" };
        },
      }),
    });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const started = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Start the work" }),
    });
    expect(started.status).toBe(202);

    const response = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Use the smaller scope" }),
    });
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      disposition: "pending",
      message: { role: "user", liveInputStatus: "pending" },
    });

    let detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const messages = detail.messages as Array<{ liveInputStatus?: string }>;
      if (messages.some((message) => message.liveInputStatus === "applied")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
    }
    expect(detail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ liveInputStatus: "applied" }),
    ]));
    expect(liveInputs).toEqual([{
      conversationId: `web:${thread.id}`,
      body: expect.objectContaining({ text: "Use the smaller scope" }),
    }]);
    finishTurn();
  });

  it("proxies pending and submitted AskUser state for a web conversation", async () => {
    const submissions: Record<string, unknown>[] = [];
    const snapshot = {
      interactionId: "ask-test",
      questions: [{
        id: "q0",
        header: "Delivery",
        question: "Send the draft?",
        options: [
          { id: "q0o0", label: "Send", description: "Send it now." },
          { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        ],
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    };
    const { baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsAskUser: true,
        pendingAsk: snapshot,
        onAskSubmit: (body) => submissions.push(body),
      }),
    });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };

    const pending = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/ask`);
    expect(await json(pending)).toEqual({ ask: snapshot });
    const submitted = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ask-test",
        answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
      }),
    });
    expect(await json(submitted)).toMatchObject({ accepted: true, snapshot: { status: "answered" } });
    expect(submissions).toEqual([{
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    }]);
  });

  it("validates the public quote payload before starting a turn", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const response = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Follow up",
        quote: { text: "", messageId: "message" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("validates and persists agent pins with pinned-first bootstrap ordering", async () => {
    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      source: { ...first.source, sourceId: "agent-two", label: "Agent Two" },
    });
    const { baseUrl } = await start({
      host: "127.0.0.1",
      discoverImpl: async () => [first, second],
    });
    const headers = { "content-type": "application/json" };

    const invalid = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: "yes" }),
    });
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ error: { code: "invalid_request" } });
    const missing = await fetch(`${baseUrl}/api/v1/agents/missing`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: { code: "agent_not_found" } });

    const pinned = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
    });
    expect(pinned.status).toBe(200);
    expect(await json(pinned)).toMatchObject({ agent: { sourceId: "agent-two", pinned: true } });
    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap`)) as { agents: Array<{ sourceId: string; pinned: boolean }> };
    expect(bootstrap.agents.map(({ sourceId, pinned: isPinned }) => ({ sourceId, pinned: isPinned }))).toEqual([
      { sourceId: "agent-two", pinned: true },
      { sourceId: "agent-one", pinned: false },
    ]);

    const unpinned = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: false }),
    });
    expect(unpinned.status).toBe(200);
    expect(await json(unpinned)).toMatchObject({ agent: { sourceId: "agent-two", pinned: false } });
  });

  it("caps SSE clients and permits reconnect/bootstrap semantics", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const streams = await Promise.all(Array.from({ length: 64 }, async () => fetch(`${baseUrl}/api/v1/events`)));
    expect(streams.every((response) => response.status === 200)).toBe(true);
    const firstChunk = await streams[0]?.body?.getReader().read();
    expect(new TextDecoder().decode(firstChunk?.value)).toContain("event: ready");
    const overflow = await fetch(`${baseUrl}/api/v1/events`);
    expect(overflow.status).toBe(503);
    await Promise.all(streams.map(async (response) => response.body?.cancel().catch(() => undefined)));
    let reconnected: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = await fetch(`${baseUrl}/api/v1/events`);
      if (candidate.status === 200) {
        reconnected = candidate;
        break;
      }
      expect(candidate.status).toBe(503);
      await candidate.body?.cancel();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(reconnected?.status).toBe(200);
    await reconnected?.body?.cancel();
  }, 15_000);
});
