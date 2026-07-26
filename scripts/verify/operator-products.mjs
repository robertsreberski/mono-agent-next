#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { monoAgentModule } from "@mono-agent/channel-operator";
import { parseAskUserAnswer } from "@mono-agent/module-sdk";
import {
  OPERATOR_REGISTRY_SCHEMA,
  OperatorClient,
  OperatorClientError,
  initialOperatorState,
  reduceOperatorFrame,
} from "@mono-agent/operator";
import {
  MULTI_QUESTION_ASK_USER_ANSWER,
  MULTI_QUESTION_ASK_USER_TURN_FRAMES,
} from "@mono-agent/operator/testing";
import { startMonoAgentTui } from "@mono-agent/tui";
import { startWebServer } from "@mono-agent/web";

const OPERATOR_TOKEN = "operator-products-smoke-token-0123456789";
const OPERATOR_TOKEN_ENV = "MONO_AGENT_OPERATOR_PRODUCTS_SMOKE_TOKEN";
const WEB_TOKEN = "web-products-smoke-token-0123456789";
const AGENT_ID = "operator-products-smoke";
const AGENT_LABEL = "Operator Products Smoke";
const EXPECTED_REPLY = "mono-agent-next operator products e2e ok";
const INTERACTIVE_INPUT = "prove interactive operator parity";
const WAIT_TIMEOUT_MS = 5_000;

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-agent-operator-products-"));
  const registryDirectory = join(temporaryRoot, "registry");
  const webDataDirectory = join(temporaryRoot, "web-data");
  const lifecycle = new AbortController();
  const disconnect = deferred();
  const cancelStarted = deferred();
  const cancelObserved = deferred();
  const dispatched = [];
  const interactiveAnswers = new Map();
  const interactiveWaiters = new Map();
  let operatorChannel;
  let webServer;
  let tui;

  try {
    await mkdir(registryDirectory, { mode: 0o700 });
    await chmod(registryDirectory, 0o700);

    const config = monoAgentModule.schema.parse({
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: OPERATOR_TOKEN },
    });
    const operatorIdentity = {
      agent: { id: AGENT_ID, label: AGENT_LABEL },
      process: { pid: process.pid },
      defaults: { runtime: "smoke", model: "smoke:model" },
      configPath: join(temporaryRoot, "mono-agent.config.json"),
      projectRoot: temporaryRoot,
    };
    operatorChannel = await monoAgentModule.create({
      instanceId: AGENT_ID,
      config,
      provenance: {
        "/auth/token": { source: "environment", environmentName: OPERATOR_TOKEN_ENV },
      },
      configDirectory: temporaryRoot,
      workspaceDirectory: temporaryRoot,
      dataDirectory: temporaryRoot,
      logger: noopLogger(),
      host: {
        grantedCapabilities: new Set(["operator.identity.v1"]),
        getCapability(name) {
          return name === "operator.identity.v1" ? operatorIdentity : undefined;
        },
        async dispatch(request, reply) {
          dispatched.push(request);
          if (request.conversationId === "disconnect-smoke") {
            await waitForAbort(request.signal);
            disconnect.resolve();
            return { status: "cancelled" };
          }
          if (request.conversationId === "cancel-smoke") {
            cancelStarted.resolve();
            await waitForAbort(request.signal);
            cancelObserved.resolve();
            return { status: "cancelled" };
          }
          if (request.text === INTERACTIVE_INPUT) {
            const ask = MULTI_QUESTION_ASK_USER_TURN_FRAMES.find(
              (frame) => frame.type === "ask_user",
            )?.ask;
            assert.ok(ask, "shared AskUser fixture is missing its ask frame");
            const waiter = deferred();
            interactiveWaiters.set(request.conversationId, waiter);
            await reply.emit({ type: "ask-user", ask });
            await within(waiter.promise, `AskUser answer for ${request.conversationId}`);
            return { status: "completed", text: "Answers recorded." };
          }
          await reply.emit({ type: "text-delta", delta: "mono-agent-next " });
          await reply.emit({ type: "activity", text: "Proving the operator product path" });
          await reply.emit({ type: "text-delta", delta: "operator products e2e ok" });
          return { status: "completed", text: EXPECTED_REPLY };
        },
        async answerAsk(conversationId, answer) {
          const ask = MULTI_QUESTION_ASK_USER_TURN_FRAMES.find(
            (frame) => frame.type === "ask_user",
          )?.ask;
          assert.ok(ask, "shared AskUser fixture is missing its ask frame");
          const parsed = parseAskUserAnswer(answer, ask);
          const projected = {
            interactionId: parsed.interactionId,
            answers: Object.fromEntries(Object.entries(parsed.answers)),
          };
          assert.deepEqual(
            projected,
            MULTI_QUESTION_ASK_USER_ANSWER,
          );
          interactiveAnswers.set(conversationId, projected);
          interactiveWaiters.get(conversationId)?.resolve();
          return { status: "accepted" };
        },
      },
      signal: lifecycle.signal,
    });
    await operatorChannel.start?.({ signal: lifecycle.signal });
    assert.match(operatorChannel.endpoint ?? "", /^http:\/\/127\.0\.0\.1:\d+$/u);

    const operator = new OperatorClient({
      endpoint: operatorChannel.endpoint,
      token: OPERATOR_TOKEN,
      requestTimeoutMs: WAIT_TIMEOUT_MS,
    });
    const info = await operator.getInfo();
    assert.equal(info.agent.id, AGENT_ID);
    assert.equal(info.agent.label, AGENT_LABEL);
    assert.equal(info.capabilities.cancellation, true);

    await assert.rejects(
      new OperatorClient({
        endpoint: operatorChannel.endpoint,
        requestTimeoutMs: WAIT_TIMEOUT_MS,
      }).getInfo(),
      (error) => error instanceof OperatorClientError
        && error.code === "HTTP_ERROR"
        && error.status === 401,
      "the operator endpoint must reject an unauthenticated client",
    );

    const frames = [];
    let state = initialOperatorState("stream-smoke");
    for await (const frame of operator.streamTurn({
      conversationId: "stream-smoke",
      input: { text: "prove the shared operator path" },
      metadata: { source: "operator-products-smoke" },
    })) {
      frames.push(frame);
      state = reduceOperatorFrame(state, frame);
    }
    assert.deepEqual(frames.map((frame) => frame.type), [
      "accepted",
      "delta",
      "activity",
      "delta",
      "completed",
    ]);
    assert.equal(state.status, "completed");
    assert.equal(state.assistantText, EXPECTED_REPLY);
    assert.deepEqual(state.activities, [{
      type: "activity",
      text: "Proving the operator product path",
    }]);
    assert.equal(state.finalMessage?.text, EXPECTED_REPLY);

    for await (const frame of operator.streamTurn({
      conversationId: "disconnect-smoke",
      input: { text: "disconnect after admission" },
    })) {
      assert.equal(frame.type, "accepted");
      break;
    }
    await within(disconnect.promise, "operator dispatch abort after client disconnect");

    const cancelledFramesPromise = collectFrames(operator.streamTurn({
      conversationId: "cancel-smoke",
      input: { text: "cancel this turn" },
    }));
    await within(cancelStarted.promise, "cancel turn admission");
    assert.deepEqual(
      await operator.cancelConversation("cancel-smoke", { reason: "smoke cancellation" }),
      { status: "accepted" },
    );
    await within(cancelObserved.promise, "operator dispatch abort after explicit cancellation");
    const cancelledFrames = await within(cancelledFramesPromise, "cancelled terminal stream frame");
    assert.deepEqual(cancelledFrames.map((frame) => frame.type), ["accepted", "error"]);
    assert.equal(cancelledFrames.at(-1)?.type, "error");
    assert.equal(cancelledFrames.at(-1)?.cancelled, true);

    const descriptorPath = join(registryDirectory, `${AGENT_ID}.json`);
    const now = new Date().toISOString();
    await writeFile(descriptorPath, `${JSON.stringify({
      schema: OPERATOR_REGISTRY_SCHEMA,
      agent: { id: AGENT_ID, label: AGENT_LABEL },
      operator: {
        endpoint: operatorChannel.endpoint,
        tokenEnvironment: OPERATOR_TOKEN_ENV,
      },
      pid: process.pid,
      startedAt: info.process.startedAt,
      heartbeatAt: now,
      capabilities: info.capabilities,
    })}\n`, { flag: "wx", mode: 0o600 });
    await chmod(descriptorPath, 0o600);

    const environment = { [OPERATOR_TOKEN_ENV]: OPERATOR_TOKEN };
    const webConfig = {
      configVersion: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: WEB_TOKEN },
      dataDirectory: webDataDirectory,
      agentRegistries: [registryDirectory],
      externalOrigins: [],
      sourcePath: join(temporaryRoot, "web.config.json"),
    };
    webServer = await startWebServer({ config: webConfig, environment });

    const unauthenticatedBootstrap = await fetch(new URL("api/v1/bootstrap", webServer.url));
    assert.equal(unauthenticatedBootstrap.status, 401);
    const bootstrap = await webJson(webServer, "api/v1/bootstrap");
    assert.equal(bootstrap.version, 1);
    assert.deepEqual(bootstrap.agents.map((agent) => agent.id), [AGENT_ID]);
    assert.equal(bootstrap.agents[0]?.online, true);

    const threadResponse = await webFetch(webServer, "api/v1/threads", {
      method: "POST",
      json: { agentId: AGENT_ID, title: "Durable smoke thread" },
    });
    assert.equal(threadResponse.status, 201);
    const thread = await threadResponse.json();
    assert.equal(thread.agentId, AGENT_ID);

    const turnResponse = await webFetch(
      webServer,
      `api/v1/threads/${encodeURIComponent(thread.id)}/turns`,
      { method: "POST", json: { text: "prove the durable web product" } },
    );
    assert.equal(turnResponse.status, 200);
    assert.match(turnResponse.headers.get("content-type") ?? "", /^application\/x-ndjson\b/u);
    const webFrames = parseNdjson(await turnResponse.text());
    assert.equal(webFrames.at(-1)?.type, "done");
    assert.equal(webFrames.at(-1)?.detail.thread.status, "complete");
    assert.equal(lastAssistant(webFrames.at(-1)?.detail).text, EXPECTED_REPLY);

    const detailBeforeRestart = await webJson(
      webServer,
      `api/v1/threads/${encodeURIComponent(thread.id)}`,
    );
    assert.equal(detailBeforeRestart.thread.status, "complete");
    assert.equal(lastAssistant(detailBeforeRestart).text, EXPECTED_REPLY);

    await webServer.stop();
    webServer = undefined;
    webServer = await startWebServer({ config: webConfig, environment });
    const detailAfterRestart = await webJson(
      webServer,
      `api/v1/threads/${encodeURIComponent(thread.id)}`,
    );
    assert.deepEqual(detailAfterRestart, detailBeforeRestart);

    const parityThreadResponse = await webFetch(webServer, "api/v1/threads", {
      method: "POST",
      json: { agentId: AGENT_ID, title: "Shared AskUser parity" },
    });
    assert.equal(parityThreadResponse.status, 201);
    const parityThread = await parityThreadResponse.json();
    const parityTurnResponse = await webFetch(
      webServer,
      `api/v1/threads/${encodeURIComponent(parityThread.id)}/turns`,
      { method: "POST", json: { text: INTERACTIVE_INPUT } },
    );
    assert.equal(parityTurnResponse.status, 200);
    const webPending = await eventuallyValue(async () => {
      const detail = await webJson(
        webServer,
        `api/v1/threads/${encodeURIComponent(parityThread.id)}`,
      );
      return detail.thread.pendingAsk === undefined ? undefined : detail;
    }, "web shared AskUser fixture");
    const sharedAsk = MULTI_QUESTION_ASK_USER_TURN_FRAMES.find(
      (frame) => frame.type === "ask_user",
    )?.ask;
    assert.ok(sharedAsk);
    assert.deepEqual(webPending.thread.pendingAsk, sharedAsk);
    const webAnswerResponse = await webFetch(
      webServer,
      `api/v1/threads/${encodeURIComponent(parityThread.id)}/ask`,
      { method: "POST", json: MULTI_QUESTION_ASK_USER_ANSWER },
    );
    assert.equal(webAnswerResponse.status, 200);
    assert.deepEqual(await webAnswerResponse.json(), { status: "accepted" });
    const parityWebFrames = parseNdjson(await parityTurnResponse.text());
    assert.equal(parityWebFrames.at(-1)?.type, "done");
    assert.equal(parityWebFrames.at(-1)?.detail.thread.status, "complete");
    assert.deepEqual(
      interactiveAnswers.get(`web:${parityThread.id}`),
      MULTI_QUESTION_ASK_USER_ANSWER,
    );

    const terminal = new SmokeTerminal();
    let tuiInfoRequests = 0;
    const tuiFetch = async (input, init) => {
      if (String(input).endsWith("/v1/info")) {
        tuiInfoRequests += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${OPERATOR_TOKEN}`);
      }
      return fetch(input, init);
    };
    tui = await startMonoAgentTui({
      endpoint: operatorChannel.endpoint,
      token: OPERATOR_TOKEN,
      fetch: tuiFetch,
      terminal,
      conversationId: "tui-parity-smoke",
      requestTimeoutMs: WAIT_TIMEOUT_MS,
    });
    assert.equal(terminal.started, true);
    assert.equal(tuiInfoRequests, 1);
    for (const command of [
      "/runtime smoke-secondary",
      "/model smoke:model-override",
      "/effort high",
      INTERACTIVE_INPUT,
    ]) {
      terminal.submit(command);
      await tick();
    }
    await eventuallyValue(
      () => terminal.output().includes("constructor") && terminal.output().includes("checks")
        ? true
        : undefined,
      "TUI shared AskUser fixture",
    );
    const tuiDispatch = dispatched.find(
      (request) => request.conversationId === "tui-parity-smoke",
    );
    assert.ok(tuiDispatch, "TUI did not submit an interactive turn");
    assert.deepEqual(
      {
        text: tuiDispatch.text,
        runtime: tuiDispatch.runtime,
        model: tuiDispatch.model,
        effort: tuiDispatch.effort,
      },
      {
        text: INTERACTIVE_INPUT,
        runtime: "smoke-secondary",
        model: "smoke:model-override",
        effort: "high",
      },
    );
    terminal.submit(`/answer ${JSON.stringify(MULTI_QUESTION_ASK_USER_ANSWER.answers)}`);
    await eventuallyValue(
      () => interactiveAnswers.get("tui-parity-smoke"),
      "TUI structured AskUser answer",
    );
    await eventuallyValue(
      () => terminal.output().includes("Answers recorded.") ? true : undefined,
      "TUI completed turn",
    );
    assert.deepEqual(
      interactiveAnswers.get("tui-parity-smoke"),
      MULTI_QUESTION_ASK_USER_ANSWER,
    );
    await tui.stop();
    await within(tui.waitUntilExit(), "TUI exit");
    tui = undefined;
    assert.equal((await operator.getInfo()).agent.id, AGENT_ID);
    assert.equal((await operatorChannel.health?.({ signal: lifecycle.signal }))?.status, "healthy");

    assert.ok(dispatched.some((request) => request.conversationId === "stream-smoke"));
    assert.ok(dispatched.some((request) => request.conversationId === `web:${thread.id}`));
    console.log(
      `Verified authenticated operator streaming/reduction/cancellation, durable web restart, and shared interactive Web/TUI AskUser + override parity on Node.js ${process.versions.node}.`,
    );
  } finally {
    await tui?.stop().catch(() => undefined);
    await webServer?.stop().catch(() => undefined);
    lifecycle.abort(new Error("operator products smoke cleanup"));
    await operatorChannel?.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolveAbort) => signal.addEventListener("abort", resolveAbort, { once: true }));
}

async function collectFrames(stream) {
  const frames = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(WAIT_TIMEOUT_MS)}ms`)), WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventuallyValue(read, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await tick();
  }
  throw new Error(`${label} exceeded ${String(WAIT_TIMEOUT_MS)}ms`);
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function webFetch(server, path, options = {}) {
  const headers = new Headers({ authorization: `Bearer ${WEB_TOKEN}` });
  let body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  return fetch(new URL(path, server.url), {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function webJson(server, path) {
  const response = await webFetch(server, path);
  const body = await response.text();
  assert.equal(response.status, 200, `${path} returned ${String(response.status)}: ${body}`);
  return JSON.parse(body);
}

function parseNdjson(body) {
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function lastAssistant(detail) {
  const message = detail?.messages?.filter((entry) => entry.role === "assistant").at(-1);
  assert.ok(message, "web thread has no assistant message");
  return message;
}

class SmokeTerminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  started = false;
  writes = [];

  start(onInput, onResize) {
    this.onInput = onInput;
    this.onResize = onResize;
    this.started = true;
  }

  stop() {
    this.onInput = undefined;
    this.onResize = undefined;
    this.started = false;
  }

  submit(value) {
    assert.ok(this.onInput, "terminal is not accepting input");
    for (const character of value) this.onInput(character);
    this.onInput("\r");
  }

  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  output() { return this.writes.join(""); }
}

await main();
