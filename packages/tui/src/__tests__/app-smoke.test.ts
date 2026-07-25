// SPDX-License-Identifier: MIT
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OperatorClient,
  OPERATOR_REGISTRY_SCHEMA,
  serializeOperatorFrame,
  type OperatorFrame,
} from "@mono-agent/operator";
import {
  FIXTURE_CAPABILITIES,
  MULTI_QUESTION_ASK_USER_ANSWER,
  MULTI_QUESTION_ASK_USER_TURN_FRAMES,
  VALID_OPERATOR_INFO,
  VALID_TURN_FRAMES,
} from "@mono-agent/operator/testing";

import { startMonoAgentTui } from "../runtime/start.js";
import { MonoAgentTuiApp } from "../ui/app.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function delayedFixtureStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      VALID_TURN_FRAMES.forEach((frame, index) => {
        setTimeout(() => {
          controller.enqueue(encoder.encode(serializeOperatorFrame(frame)));
          if (index === VALID_TURN_FRAMES.length - 1) controller.close();
        }, index * 20);
      });
    },
  });
}

function openFixtureStream(
  frames: readonly OperatorFrame[],
  signal?: AbortSignal | null,
): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(serializeOperatorFrame(frame)));
      }
      const abort = () => controller.error(signal?.reason ?? new Error("fixture stream aborted"));
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

function submit(terminal: TestTerminal, value: string): void {
  for (const character of value) terminal.feed(character);
  terminal.feed("\r");
}

describe("standalone TUI", () => {
  it("uses shared attachment, quote, replay, config, and health contracts when advertised", async () => {
    const terminal = new TestTerminal();
    const root = await mkdtemp(join(tmpdir(), "mono-agent-tui-assets-"));
    const attachmentPath = join(root, "note.txt");
    const oversizedPath = join(root, "too-large.bin");
    await writeFile(attachmentPath, Buffer.alloc(128 * 1_024, 0x61));
    await writeFile(oversizedPath, Buffer.alloc((512 * 1_024) + 1, 0x62));
    let turnBody: Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    const frames: readonly OperatorFrame[] = [
      { type: "accepted", turnId: "asset-turn", conversationId: "asset-conversation", startedAt: now },
      {
        type: "completed",
        turnId: "asset-turn",
        finalMessage: { id: "assistant-2", role: "assistant", text: "received" },
        finishedAt: now,
        stopReason: "completed",
      },
    ];
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/config")) {
        return json({ revision: "config-r1", generatedAt: now, value: { safe: true }, redacted: true });
      }
      if (url.endsWith("/v1/health")) {
        return json({ status: "healthy", checkedAt: now, details: [{ id: "core", status: "healthy" }] });
      }
      if (url.endsWith("/v1/conversations/asset-conversation/replay")) {
        return json({
          conversationId: "asset-conversation",
          messages: [{ id: "assistant-1", role: "assistant", text: "previous", createdAt: now }],
        });
      }
      if (url.endsWith("/v1/turns")) {
        turnBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(frames.map(serializeOperatorFrame).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "asset-conversation",
    });
    const submit = async (value: string, expected: string) => {
      for (const character of value) terminal.feed(character);
      terminal.feed("\r");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain(expected));
    };

    try {
      await submit("/config", "config-r1");
      await submit("/health", "core: healthy");
      await submit("/replay", "assistant-1");
      await submit(`/attach ${oversizedPath}`, "no larger than 512 KiB");
      await submit(`/attach ${attachmentPath}`, "queued attachment note.txt");
      await submit("/quote assistant-1=previous", "queued quote assistant-1");
      await submit("use the context", "received");
      expect(turnBody).toMatchObject({
        conversationId: "asset-conversation",
        input: {
          text: "use the context",
          attachments: [{ name: "note.txt", mediaType: "text/plain", sizeBytes: 128 * 1_024 }],
          quote: {
            conversationId: "asset-conversation",
            messageId: "assistant-1",
            text: "previous",
          },
        },
      });
      expect(requested).toEqual(expect.arrayContaining([
        "http://127.0.0.1:4321/operator/v1/config",
        "http://127.0.0.1:4321/operator/v1/health",
        "http://127.0.0.1:4321/operator/v1/conversations/asset-conversation/replay",
      ]));
    } finally {
      await handle.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a real shared-client turn, renders stream activity, and exits without stopping the agent", async () => {
    const terminal = new TestTerminal();
    const requests: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({
        url,
        method,
        authorization,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        return new Response(delayedFixtureStream(), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`unexpected operator request ${method} ${url}`);
    };

    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      token: "owner-secret",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
      runtime: "pi",
      model: "fixture:model",
      effort: "high",
    });

    for (const character of "hello") terminal.feed(character);
    terminal.feed("\r");
    await eventually(() => {
      const output = stripAnsi(terminal.output());
      expect(output).toContain("Calling a fixture tool");
      expect(output).toContain("tool fixture_tool started");
      expect(output).toContain("tool fixture-tool-call completed");
      expect(output).toContain("context compacted");
      expect(output).toContain("Hello fixture");
      expect(output).toContain("completed");
    });

    const turn = requests.find((request) => request.url.endsWith("/v1/turns"));
    expect(turn).toMatchObject({
      method: "POST",
      authorization: "Bearer owner-secret",
      body: {
        conversationId: "fixture-conversation",
        input: { text: "hello" },
        runtime: "pi",
        model: "fixture:model",
        effort: "high",
        metadata: { source: "tui" },
      },
    });

    for (const character of "/exit") terminal.feed(character);
    terminal.feed("\r");
    await handle.waitUntilExit();
    expect(requests.every((request) => !request.url.includes("/stop"))).toBe(true);
  });

  it("rejects non-loopback direct endpoints without exposing the programmatic token", async () => {
    const terminal = new TestTerminal();
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch must not run");
    };
    await expect(startMonoAgentTui({
      endpoint: "https://example.com/operator",
      token: "must-stay-secret",
      fetch: fetchImpl,
      terminal,
    })).rejects.toThrow("must use HTTP on loopback");
    expect(terminal.output()).not.toContain("must-stay-secret");
  });

  it("renders operator-controlled OSC, CSI, C1, and bidi payloads as inert text", async () => {
    const terminal = new TestTerminal();
    const frames: readonly OperatorFrame[] = [
      {
        type: "accepted",
        turnId: "escape-turn",
        conversationId: "escape-conversation",
        startedAt: "2026-01-02T03:04:06.000Z",
      },
      {
        type: "capabilities",
        turnId: "escape-turn",
        capabilities: FIXTURE_CAPABILITIES,
      },
      { type: "activity", turnId: "escape-turn", text: "activity\u009b2J" },
      {
        type: "delta",
        turnId: "escape-turn",
        target: "assistant",
        text: "answer\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[2J",
      },
      {
        type: "ask_user",
        turnId: "escape-turn",
        ask: {
          interactionId: "escape-ask",
          requestedAt: "2026-01-02T03:04:06.500Z",
          questions: [{
            id: "choice",
            prompt: "choose\u202e now",
            choices: [{ value: "one", label: "One\u001b[31m" }],
            allowFreeText: true,
            multiple: false,
          }],
        },
      },
      {
        type: "error",
        turnId: "escape-turn",
        error: { code: "unsafe", message: "failed\u001b[2J", retryable: false },
        cancelled: false,
        finishedAt: "2026-01-02T03:04:07.000Z",
      },
    ];
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return json({
          ...VALID_OPERATOR_INFO,
          agent: {
            ...VALID_OPERATOR_INFO.agent,
            label: "Fixture\u001b]52;c;bGFiZWw=\u0007 Agent",
          },
        });
      }
      if (url.endsWith("/v1/turns")) {
        return new Response(new ReadableStream({
          start(controller) {
            frames.forEach((frame, index) => {
              setTimeout(() => {
                controller.enqueue(encoder.encode(serializeOperatorFrame(frame)));
                if (index === frames.length - 1) controller.close();
              }, index * 20);
            });
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "escape-conversation",
    });
    for (const character of "render safely") terminal.feed(character);
    terminal.feed("\r");
    await eventually(() => {
      const text = stripAnsi(terminal.output());
      expect(text).toContain("\\u001b]52");
      expect(text).toContain("\\u009b");
      expect(text).toContain("\\u202e");
      expect(text).toContain("failed\\u001b[2J");
    });
    const output = terminal.output();
    expect(output).not.toContain("\u001b]52;");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u202e");
    await handle.stop();
  });

  it("uses the shared cancellation action and waits for its terminal frame", async () => {
    const terminal = new TestTerminal();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelBody: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        return new Response(new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(serializeOperatorFrame({
              type: "accepted",
              turnId: "cancel-turn",
              conversationId: "cancel-conversation",
              startedAt: "2026-01-02T03:04:06.000Z",
            })));
            controller.enqueue(encoder.encode(serializeOperatorFrame({
              type: "capabilities",
              turnId: "cancel-turn",
              capabilities: FIXTURE_CAPABILITIES,
            })));
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.endsWith("/v1/conversations/cancel-conversation/cancel")) {
        cancelBody = JSON.parse(String(init?.body));
        streamController?.enqueue(encoder.encode(serializeOperatorFrame({
          type: "error",
          turnId: "cancel-turn",
          error: { code: "cancelled", message: "Turn cancelled", retryable: false },
          cancelled: true,
          finishedAt: "2026-01-02T03:04:07.000Z",
        })));
        streamController?.close();
        return json({ status: "accepted" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "cancel-conversation",
    });
    for (const character of "cancel me") terminal.feed(character);
    terminal.feed("\r");
    await eventually(() => expect(stripAnsi(terminal.output())).toContain("capabilities updated"));
    terminal.feed("\u001b");
    await eventually(() => expect(stripAnsi(terminal.output())).toContain("cancelled"));
    expect(cancelBody).toEqual({ reason: "operator cancelled from TUI" });
    await handle.stop();
  });

  it("accepts model and effort overrides when optional allowlists are absent", async () => {
    const terminal = new TestTerminal();
    const { models: _models, ...infoWithoutModels } = VALID_OPERATOR_INFO;
    let turnBody: Record<string, unknown> | undefined;
    const frames: readonly OperatorFrame[] = [
      {
        type: "accepted",
        turnId: "override-turn",
        conversationId: "override-conversation",
        startedAt: "2026-01-02T03:04:06.000Z",
      },
      {
        type: "completed",
        turnId: "override-turn",
        finalMessage: { role: "assistant", text: "override accepted" },
        finishedAt: "2026-01-02T03:04:07.000Z",
        stopReason: "completed",
      },
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(infoWithoutModels);
      if (url.endsWith("/v1/turns")) {
        turnBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(frames.map(serializeOperatorFrame).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "override-conversation",
    });
    for (const value of ["/runtime alternate-pi", "/model custom:model", "/effort custom-effort", "use overrides"]) {
      for (const character of value) terminal.feed(character);
      terminal.feed("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await eventually(() => expect(turnBody).toBeDefined());
    expect(turnBody).toMatchObject({
      runtime: "alternate-pi",
      model: "custom:model",
      effort: "custom-effort",
      input: { text: "use overrides" },
    });
    await handle.stop();
  });

  it("renders and submits every question from the shared multi-question AskUser fixture", async () => {
    const terminal = new TestTerminal();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let answerBody: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        return new Response(new ReadableStream({
          start(controller) {
            streamController = controller;
            for (const frame of MULTI_QUESTION_ASK_USER_TURN_FRAMES.slice(0, -1)) {
              controller.enqueue(encoder.encode(serializeOperatorFrame(frame)));
            }
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.endsWith("/v1/conversations/fixture-conversation/ask")) {
        answerBody = JSON.parse(String(init?.body));
        streamController?.enqueue(encoder.encode(serializeOperatorFrame(
          MULTI_QUESTION_ASK_USER_TURN_FRAMES.at(-1)!,
        )));
        streamController?.close();
        return json({ status: "accepted" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
    });
    const submit = async (value: string, expected: string) => {
      for (const character of value) terminal.feed(character);
      terminal.feed("\r");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain(expected));
    };

    await submit("ask me", "Answer every question in one command");
    expect(stripAnsi(terminal.output())).toContain("constructor");
    expect(stripAnsi(terminal.output())).toContain("checks");
    await submit("/answer constructor=speed", 'missing "checks"');
    expect(answerBody).toBeUndefined();
    await submit("/answer constructor=fast; checks=tests", 'not a choice for "constructor"');
    expect(answerBody).toBeUndefined();
    await submit(`/answer ${JSON.stringify(MULTI_QUESTION_ASK_USER_ANSWER.answers)}`, "answer accepted");
    expect(answerBody).toEqual(MULTI_QUESTION_ASK_USER_ANSWER);
    await eventually(() => expect(stripAnsi(terminal.output())).toContain("Answers recorded."));
    await handle.stop();
  });

  it("surfaces a rejecting answerAsk as a warning notice and keeps the renderer alive", async () => {
    const terminal = new TestTerminal();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        return openFixtureStream(MULTI_QUESTION_ASK_USER_TURN_FRAMES.slice(0, -1), init?.signal);
      }
      if (url.endsWith("/v1/conversations/fixture-conversation/ask")) {
        return new Response("ask unavailable", { status: 500 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
    });

    try {
      submit(terminal, "ask me");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain("Answer every question"));
      submit(terminal, `/answer ${JSON.stringify(MULTI_QUESTION_ASK_USER_ANSWER.answers)}`);
      await eventually(() => {
        expect(stripAnsi(terminal.output())).toContain("operator request failed with HTTP 500");
        expect(terminal.output()).toContain("\u001b[38;5;214moperator request failed with HTTP 500");
      });
      submit(terminal, "/help");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain("/attach <path>"));
      await expect(handle.stop()).resolves.toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("surfaces a rejecting offerLiveInput as a warning notice and keeps the renderer alive", async () => {
    const terminal = new TestTerminal();
    const activeFrames = VALID_TURN_FRAMES.slice(0, 2);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) return openFixtureStream(activeFrames, init?.signal);
      if (url.endsWith("/v1/conversations/fixture-conversation/live-input")) {
        return new Response("live input unavailable", { status: 500 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
    });

    try {
      submit(terminal, "start a turn");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain("capabilities updated"));
      submit(terminal, "steer this turn");
      await eventually(() => {
        expect(stripAnsi(terminal.output())).toContain("operator request failed with HTTP 500");
        expect(terminal.output()).toContain("\u001b[38;5;214moperator request failed with HTTP 500");
      });
      submit(terminal, "/help");
      await eventually(() => expect(stripAnsi(terminal.output())).toContain("/attach <path>"));
      await expect(handle.stop()).resolves.toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("/send refuses a second turn while the first turn has not been accepted", async () => {
    const terminal = new TestTerminal();
    let turnRequests = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        turnRequests += 1;
        return openFixtureStream([], init?.signal);
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
    });

    try {
      submit(terminal, "first turn");
      await eventually(() => expect(turnRequests).toBe(1));
      submit(terminal, "/send follow-up");
      await eventually(() => {
        expect(stripAnsi(terminal.output())).toContain("A turn is starting or already active");
      });
      expect(turnRequests).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  it("preserves line breaks in structured config notices", async () => {
    const terminal = new TestTerminal();
    const now = new Date().toISOString();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/config")) {
        return json({ revision: "config-r1", generatedAt: now, value: { safe: true }, redacted: true });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "fixture-conversation",
    });

    try {
      submit(terminal, "/config");
      await eventually(() => {
        const output = stripAnsi(terminal.output());
        expect(output).toMatch(/\n\s*"safe": true/u);
        expect(output).not.toContain("\\u000a");
        expect(output).not.toContain("\\n");
      });
    } finally {
      await handle.stop();
    }
  });

  it("evicts the oldest transcript children at the fixed renderer bound", async () => {
    const terminal = new TestTerminal();
    const client = new OperatorClient({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: async (input) => {
        if (String(input).endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
        throw new Error(`unexpected request ${String(input)}`);
      },
    });
    const app = new MonoAgentTuiApp({
      terminal,
      client,
      conversationId: "fixture-conversation",
    });
    await app.start();

    try {
      for (let index = 0; index < 260; index += 1) {
        submit(terminal, `/unknown-${String(index)}`);
      }
      const transcript = (app as unknown as {
        transcript: { readonly children: readonly unknown[] };
      }).transcript;
      expect(transcript.children).toHaveLength(256);
    } finally {
      app.stop();
    }
  });

  it("enforces model and effort allowlists when the endpoint advertises them", async () => {
    const terminal = new TestTerminal();
    let turnBody: Record<string, unknown> | undefined;
    const frames: readonly OperatorFrame[] = [
      {
        type: "accepted",
        turnId: "allowlist-turn",
        conversationId: "allowlist-conversation",
        startedAt: "2026-01-02T03:04:06.000Z",
      },
      {
        type: "completed",
        turnId: "allowlist-turn",
        finalMessage: { role: "assistant", text: "defaults used" },
        finishedAt: "2026-01-02T03:04:07.000Z",
        stopReason: "completed",
      },
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return json(VALID_OPERATOR_INFO);
      if (url.endsWith("/v1/turns")) {
        turnBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(frames.map(serializeOperatorFrame).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const handle = await startMonoAgentTui({
      endpoint: "http://127.0.0.1:4321/operator",
      fetch: fetchImpl,
      terminal,
      conversationId: "allowlist-conversation",
    });
    for (const value of ["/model missing:model", "/effort extreme", "use defaults"]) {
      for (const character of value) terminal.feed(character);
      terminal.feed("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await eventually(() => expect(turnBody).toBeDefined());
    expect(turnBody).not.toHaveProperty("model");
    expect(turnBody).not.toHaveProperty("effort");
    expect(stripAnsi(terminal.output())).toContain("not advertised");
    await handle.stop();
  });

  it("rejects a discovered endpoint whose startup identity differs from its registry descriptor", async () => {
    const registry = await mkdtemp(join(tmpdir(), "mono-agent-tui-identity-"));
    await chmod(registry, 0o700);
    try {
      await writeFile(join(registry, "fixture.json"), JSON.stringify({
        schema: OPERATOR_REGISTRY_SCHEMA,
        agent: { id: "fixture-agent", label: "Fixture Agent" },
        operator: { endpoint: "http://127.0.0.1:4321/operator" },
        pid: 42,
        startedAt: "2026-01-02T03:04:05.000Z",
        heartbeatAt: new Date().toISOString(),
      }), { mode: 0o600 });
      const fetchImpl: typeof fetch = async () => json({
        ...VALID_OPERATOR_INFO,
        process: { ...VALID_OPERATOR_INFO.process, pid: 99 },
      });
      await expect(startMonoAgentTui({
        registryDirectories: [registry],
        operatorId: "fixture-agent",
        fetch: fetchImpl,
        terminal: new TestTerminal(),
      })).rejects.toMatchObject({
        code: "OPERATOR_IDENTITY_MISMATCH",
        field: "process.pid",
        expected: 42,
        actual: 99,
      });
    } finally {
      await rm(registry, { recursive: true, force: true });
    }
  });

  it("rebinds discovered identity immediately before each turn and refuses a swapped process", async () => {
    const registry = await mkdtemp(join(tmpdir(), "mono-agent-tui-rebind-"));
    await chmod(registry, 0o700);
    try {
      await writeFile(join(registry, "fixture.json"), JSON.stringify({
        schema: OPERATOR_REGISTRY_SCHEMA,
        agent: { id: "fixture-agent", label: "Fixture Agent" },
        operator: { endpoint: "http://127.0.0.1:4321/operator" },
        pid: 42,
        startedAt: "2026-01-02T03:04:05.000Z",
        heartbeatAt: new Date().toISOString(),
      }), { mode: 0o600 });
      let infoRequests = 0;
      let turnRequests = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) {
          infoRequests += 1;
          return json(infoRequests === 1 ? VALID_OPERATOR_INFO : {
            ...VALID_OPERATOR_INFO,
            process: { ...VALID_OPERATOR_INFO.process, startedAt: "2026-01-02T03:04:08.000Z" },
          });
        }
        if (url.endsWith("/v1/turns")) {
          turnRequests += 1;
          throw new Error("turn must not start after identity mismatch");
        }
        throw new Error(`unexpected request ${url}`);
      };
      const terminal = new TestTerminal();
      const handle = await startMonoAgentTui({
        registryDirectories: [registry],
        operatorId: "fixture-agent",
        fetch: fetchImpl,
        terminal,
      });
      for (const character of "do not run") terminal.feed(character);
      terminal.feed("\r");
      await eventually(() => {
        expect(stripAnsi(terminal.output())).toContain("identity verification failed");
      });
      expect(infoRequests).toBe(2);
      expect(turnRequests).toBe(0);
      await handle.stop();
    } finally {
      await rm(registry, { recursive: true, force: true });
    }
  });

  it("discovers through the shared owner-private directory and resolves only its named token", async () => {
    const registry = await mkdtemp(join(tmpdir(), "mono-agent-tui-registry-"));
    await chmod(registry, 0o700);
    try {
      await writeFile(join(registry, "fixture.json"), JSON.stringify({
        schema: OPERATOR_REGISTRY_SCHEMA,
        agent: { id: "fixture-agent", label: "Fixture Agent" },
        operator: {
          endpoint: "http://127.0.0.1:4321/operator",
          tokenEnvironment: "FIXTURE_OPERATOR_TOKEN",
        },
        pid: 42,
        startedAt: "2026-01-02T03:04:05.000Z",
        heartbeatAt: new Date().toISOString(),
      }), { mode: 0o600 });

      let authorization: string | null = null;
      const fetchImpl: typeof fetch = async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return json(VALID_OPERATOR_INFO);
      };
      const handle = await startMonoAgentTui({
        registryDirectories: [registry],
        operatorId: "fixture-agent",
        env: {
          FIXTURE_OPERATOR_TOKEN: "discovered-secret",
          UNRELATED_SECRET: "must-not-be-used",
        },
        fetch: fetchImpl,
        terminal: new TestTerminal(),
      });
      await handle.stop();
      expect(authorization).toBe("Bearer discovered-secret");
    } finally {
      await rm(registry, { recursive: true, force: true });
    }
  });
});
