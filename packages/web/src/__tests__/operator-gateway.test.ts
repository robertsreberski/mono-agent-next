import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OPERATOR_PROTOCOL,
  OPERATOR_REGISTRY_SCHEMA,
  type OperatorInfo,
} from "@mono-agent/operator";

import { createOperatorGateway } from "../operator-gateway.js";
import type { WebOperatorTurnInput } from "../service.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

afterEach(cleanup);

describe("web operator gateway", () => {
  it("discovers only replayable proactive conversations through the identity-bound shared client", async () => {
    const root = await temporaryDirectory();
    const registry = join(root, "registry");
    await mkdir(registry, { mode: 0o700 });
    const now = new Date().toISOString();
    await writeDescriptor(join(registry, "agent.json"), "http://127.0.0.1:43210", process.pid, now);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return new Response(JSON.stringify({
          ...operatorInfo(true, now),
          capabilities: { ...capabilities(true), proactive: true, replay: true },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/conversations")) {
        return new Response(JSON.stringify({ conversations: [
          { id: "proactive:one", title: "Update", updatedAt: now },
          { id: "web:ordinary", updatedAt: now },
        ] }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/conversations/proactive%3Aone/replay")) {
        return new Response(JSON.stringify({
          conversationId: "proactive:one",
          messages: [{ id: "m-1", role: "assistant", text: "Done", createdAt: now }],
        }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected operator request ${url}`);
    };
    const gateway = createOperatorGateway({ registryDirectories: [registry], environment: {}, fetch: fetchImpl });

    await expect(gateway.discoverProactiveConversations?.()).resolves.toEqual([{
      agentId: "personal",
      conversationId: "proactive:one",
      title: "Update",
      updatedAt: now,
      messages: [{ id: "m-1", role: "assistant", text: "Done", createdAt: now }],
    }]);
  });

  it("uses authoritative info and the shared override policy before forwarding overrides", async () => {
    const root = await temporaryDirectory();
    const registry = join(root, "registry");
    await mkdir(registry, { mode: 0o700 });
    const now = new Date().toISOString();
    await writeFile(join(registry, "agent.json"), JSON.stringify({
      schema: OPERATOR_REGISTRY_SCHEMA,
      agent: { id: "personal", label: "Personal Agent" },
      operator: { endpoint: "http://127.0.0.1:43210" },
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      capabilities: capabilities(true),
    }), { mode: 0o600 });
    await chmod(join(registry, "agent.json"), 0o600);

    let info = operatorInfo(false, now);
    const forwarded: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return new Response(JSON.stringify(info), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/turns")) {
        const request = JSON.parse(String(init?.body)) as { conversationId: string };
        forwarded.push(request);
        const finishedAt = new Date().toISOString();
        const frames = [
          { type: "accepted", turnId: "turn-1", conversationId: request.conversationId, startedAt: finishedAt },
          { type: "completed", turnId: "turn-1", finalMessage: { role: "assistant", text: "done" }, finishedAt, stopReason: "completed" },
        ];
        return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`Unexpected operator request ${url}`);
    };
    const gateway = createOperatorGateway({ registryDirectories: [registry], environment: {}, fetch: fetchImpl });

    await expect(gateway.runTurn(turn({ model: "approved:model" }))).rejects.toMatchObject({
      code: "runtime_overrides_unsupported",
    });
    expect(forwarded).toHaveLength(0);

    info = operatorInfo(true, now);
    await expect(gateway.runTurn(turn({ model: "forged:model" }))).rejects.toMatchObject({ code: "unknown_model" });
    await expect(gateway.runTurn(turn({ model: "approved:model", effort: "extreme" }))).rejects.toMatchObject({ code: "unsupported_effort" });
    expect(forwarded).toHaveLength(0);

    await expect(gateway.runTurn(turn({ model: "approved:model", effort: "high" }))).resolves.toBeUndefined();
    expect(forwarded).toMatchObject([{ model: "approved:model", effort: "high" }]);

    info = { ...operatorInfo(true, now), process: { pid: process.pid + 1, startedAt: now } };
    await expect(gateway.runTurn(turn({}))).rejects.toMatchObject({ code: "operator_identity_mismatch" });
    expect(forwarded).toHaveLength(1);
  });

  it("cancels through the identity-bound active client even if the registry swaps processes", async () => {
    const root = await temporaryDirectory();
    const registry = join(root, "registry");
    const descriptorPath = join(registry, "agent.json");
    await mkdir(registry, { mode: 0o700 });
    const startedAt = new Date().toISOString();
    await writeDescriptor(descriptorPath, "http://127.0.0.1:43210", process.pid, startedAt);

    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let turnReady!: () => void;
    const ready = new Promise<void>((resolve) => { turnReady = resolve; });
    const requestedUrls: string[] = [];
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "http://127.0.0.1:43210/v1/info") {
        return new Response(JSON.stringify(operatorInfo(true, startedAt)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://127.0.0.1:43210/v1/turns") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            const frames = [
              { type: "accepted", turnId: "turn-swap", conversationId: "web:swap", startedAt },
              { type: "delta", turnId: "turn-swap", target: "assistant", text: "started" },
            ];
            controller.enqueue(encoder.encode(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`));
          },
        }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
      }
      if (url === "http://127.0.0.1:43210/v1/conversations/web%3Aswap/cancel") {
        stream.enqueue(encoder.encode(`${JSON.stringify({
          type: "error",
          turnId: "turn-swap",
          error: { code: "cancelled", message: "cancelled", retryable: false },
          cancelled: true,
          finishedAt: new Date().toISOString(),
        })}\n`));
        stream.close();
        return new Response('{"status":"accepted"}', { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Request escaped the bound process: ${url}`);
    };
    const gateway = createOperatorGateway({ registryDirectories: [registry], environment: {}, fetch: fetchImpl });
    const running = gateway.runTurn({
      agentId: "personal",
      conversationId: "web:swap",
      text: "hello",
      signal: new AbortController().signal,
      async onText() { turnReady(); },
    });
    await ready;

    await writeDescriptor(descriptorPath, "http://127.0.0.1:43211", process.pid + 1, new Date(Date.now() + 1_000).toISOString());
    await gateway.cancel("personal", "web:swap");
    await expect(running).rejects.toMatchObject({ code: "operator_cancelled" });
    expect(requestedUrls).toContain("http://127.0.0.1:43210/v1/conversations/web%3Aswap/cancel");
    expect(requestedUrls.some((url) => url.includes(":43211"))).toBe(false);
  });

  it("gates live input and AskUser answers against the shared active state", async () => {
    const root = await temporaryDirectory();
    const registry = join(root, "registry");
    await mkdir(registry, { mode: 0o700 });
    const startedAt = new Date().toISOString();
    await writeDescriptor(join(registry, "agent.json"), "http://127.0.0.1:43210", process.pid, startedAt);
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let askReady!: () => void;
    const ready = new Promise<void>((resolve) => { askReady = resolve; });
    const bodies: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return new Response(JSON.stringify({
          ...operatorInfo(true, startedAt),
          capabilities: { ...capabilities(true), liveInput: true, askUser: true },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/turns")) {
        return new Response(new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode([
              { type: "accepted", turnId: "interactive-turn", conversationId: "web:interactive", startedAt },
              { type: "capabilities", turnId: "interactive-turn", capabilities: { ...capabilities(true), liveInput: true, askUser: true } },
              {
                type: "ask_user",
                turnId: "interactive-turn",
                ask: {
                  interactionId: "ask-1",
                  requestedAt: startedAt,
                  questions: [{ id: "continue", prompt: "Continue?", allowFreeText: false, multiple: false }],
                },
              },
            ].map((frame) => JSON.stringify(frame)).join("\n") + "\n"));
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.endsWith("/live-input")) {
        bodies.live = JSON.parse(String(init?.body)) as unknown;
        return new Response('{"status":"applied"}', { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/ask")) {
        bodies.ask = JSON.parse(String(init?.body)) as unknown;
        return new Response('{"status":"accepted"}', { headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected operator request ${url}`);
    };
    const gateway = createOperatorGateway({ registryDirectories: [registry], environment: {}, fetch: fetchImpl });
    const running = gateway.runTurn({
      agentId: "personal",
      conversationId: "web:interactive",
      text: "hello",
      signal: new AbortController().signal,
      async onText() {},
      async onState(state) {
        if (state.pendingAsk !== undefined) askReady();
      },
    });
    await ready;

    await expect(gateway.offerLiveInput?.("personal", "web:interactive", "more")).resolves.toEqual({ status: "applied" });
    await expect(gateway.answerAsk?.("personal", "web:interactive", {
      interactionId: "ask-1",
      answers: { continue: ["yes"] },
    })).resolves.toEqual({ status: "accepted" });
    expect(bodies.live).toMatchObject({ text: "more" });
    expect(bodies.ask).toEqual({ interactionId: "ask-1", answers: { continue: ["yes"] } });

    stream.enqueue(encoder.encode(`${JSON.stringify({
      type: "completed",
      turnId: "interactive-turn",
      finalMessage: { role: "assistant", text: "done" },
      finishedAt: new Date().toISOString(),
      stopReason: "completed",
    })}\n`));
    stream.close();
    await expect(running).resolves.toBeUndefined();
  });
});

function turn(overrides: { readonly model?: string; readonly effort?: string }): WebOperatorTurnInput {
  return {
    agentId: "personal",
    conversationId: `web:${Math.random()}`,
    text: "hello",
    signal: new AbortController().signal,
    async onText() {},
    ...overrides,
  };
}

function operatorInfo(runtimeOverrides: boolean, startedAt: string): OperatorInfo {
  return {
    protocol: OPERATOR_PROTOCOL,
    agent: { id: "personal", label: "Personal Agent" },
    process: { pid: process.pid, startedAt },
    capabilities: capabilities(runtimeOverrides),
    defaults: { model: "approved:model", effort: "high" },
    models: [{ id: "approved:model", efforts: ["low", "high"] }],
  };
}

function capabilities(runtimeOverrides: boolean) {
  return {
    attachments: false,
    liveInput: false,
    askUser: false,
    cancellation: true,
    quotes: false,
    runtimeOverrides,
    proactive: false,
    configView: true,
    replay: true,
    health: true,
  };
}

async function writeDescriptor(path: string, endpoint: string, pid: number, startedAt: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    schema: OPERATOR_REGISTRY_SCHEMA,
    agent: { id: "personal", label: "Personal Agent" },
    operator: { endpoint },
    pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    capabilities: capabilities(true),
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}
