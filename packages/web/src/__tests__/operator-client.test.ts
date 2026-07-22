import { describe, expect, it } from "vitest";

import { OperatorClient } from "../operator-client.js";

function turnInput() {
  return {
    conversationId: "c",
    text: "prompt",
    attachments: [],
    metadata: {},
    signal: new AbortController().signal,
    onFrame() {},
  } as const;
}

describe("OperatorClient", () => {
  it("parses capabilities/model metadata and rejects untrusted endpoints", async () => {
    expect(() => new OperatorClient({ baseUrl: "http://192.168.1.5:1234/gui" })).toThrowError(/non-loopback/u);
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        label: "Agent",
        model: "p/m",
        effort: "high",
        models: ["p/m"],
        modelOptions: {
          "p/m": {
            effortLevels: ["low", "high"],
            reasoning: true,
            contextWindow: 128_000,
          },
        },
        capabilities: { attachments: true, askUser: true },
      })) as typeof fetch,
    });
    await expect(client.info()).resolves.toEqual({
      schema: 1,
      label: "Agent",
      model: "p/m",
      effort: "high",
      models: ["p/m"],
      modelOptions: {
        "p/m": {
          effortLevels: ["low", "high"],
          reasoning: true,
          contextWindow: 128_000,
        },
      },
      supportsAttachments: true,
      supportsHistoryAppend: false,
      supportsAskUser: true,
      supportsLiveInput: false,
    });
  });

  it("posts live input to the encoded conversation and validates its settlement", async () => {
    let request: { url: string; body: unknown } | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async (input, init) => {
        request = { url: String(input), body: JSON.parse(String(init?.body)) };
        return Response.json({ status: "applied", runId: "run-7" });
      }) as typeof fetch,
    });

    await expect(client.liveInput({
      conversationId: "web:thread/one",
      id: "input-1",
      text: "Use the new constraint",
      receivedAt: "2026-07-21T09:00:00.000Z",
    })).resolves.toEqual({ status: "applied", runId: "run-7" });
    expect(request).toEqual({
      url: "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/live-input",
      body: {
        id: "input-1",
        text: "Use the new constraint",
        receivedAt: "2026-07-21T09:00:00.000Z",
      },
    });
  });

  it("reads and submits structured AskUser state on the encoded conversation route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const snapshot = {
      interactionId: "ask-test",
      questions: [],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    } as const;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return init?.method === "POST"
          ? Response.json({ accepted: true, snapshot: { ...snapshot, status: "answered" } })
          : Response.json({ ask: snapshot });
      }) as typeof fetch,
    });

    await expect(client.pendingAsk("web:thread/one")).resolves.toEqual(snapshot);
    await expect(client.submitAsk("web:thread/one", "ask-test", [{
      questionId: "q0",
      selectedOptionIds: ["q0o0"],
    }])).resolves.toMatchObject({ accepted: true, snapshot: { status: "answered" } });

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/ask",
      "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/ask",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });

  it("drops non-positive and non-integral context-window metadata", async () => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        modelOptions: {
          zero: { contextWindow: 0 },
          negative: { contextWindow: -1 },
          fractional: { contextWindow: 4_096.5 },
          text: { contextWindow: "8192" },
          valid: { contextWindow: 8_192 },
        },
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      modelOptions: {
        zero: {},
        negative: {},
        fractional: {},
        text: {},
        valid: { contextWindow: 8_192 },
      },
    });
  });

  it("sends the web client marker/attachments and replays every NDJSON frame", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "key",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response([
          JSON.stringify({ kind: "status", text: "thinking" }),
          JSON.stringify({ kind: "append", delta: "hello" }),
          JSON.stringify({ kind: "finish", finalText: "hello", metadata: { runtime: { model: "actual" } } }),
          "",
        ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
      }) as typeof fetch,
    });
    const frames: unknown[] = [];
    const result = await client.turn({
      conversationId: "web:thread",
      text: "prompt",
      attachments: [{ kind: "document", mimeType: "text/plain", data: "aGk=", name: "a.txt", sizeBytes: 2 }],
      metadata: { web: { model: "p/m" }, tui: { model: "p/m" } },
      signal: new AbortController().signal,
      onFrame(frame) { frames.push(frame); },
    });

    expect(requestBody).toMatchObject({ client: "web", conversationId: "web:thread", text: "prompt" });
    expect(requestBody?.attachments).toEqual([{ kind: "document", mimeType: "text/plain", data: "aGk=", name: "a.txt", sizeBytes: 2 }]);
    expect(frames).toEqual([{ kind: "status", text: "thinking" }, { kind: "append", delta: "hello" }]);
    expect(result).toEqual({ finalText: "hello", metadata: { runtime: { model: "actual" } } });
  });

  it("posts authenticated verbatim history with its stable idempotency key", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "secret",
      fetchImpl: (async (input, init) => {
        request = { url: String(input), init };
        return Response.json({ recorded: true });
      }) as typeof fetch,
    });

    await client.recordVerbatim("web:notification-1", "Morning brief", "cron:daily:success");

    expect(request?.url).toBe("http://127.0.0.1:1234/gui/v1/conversations/web%3Anotification-1/verbatim");
    expect(request?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:daily:success" }),
    });
  });

  it("distinguishes cancellation and incomplete streams", async () => {
    const cancelled = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(`${JSON.stringify({ kind: "error", message: "stop", cancelled: true })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(cancelled.turn(turnInput()))
      .rejects.toMatchObject({ code: "cancelled", cancelled: true });

    const incomplete = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("", { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch,
    });
    await expect(incomplete.turn(turnInput()))
      .rejects.toMatchObject({ code: "incomplete_operator_stream" });
  });

  it("rejects schema skew, oversized metadata, and non-NDJSON turn responses", async () => {
    const unsupported = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => Response.json({ schema: 2 })) as typeof fetch,
    });
    await expect(unsupported.info()).rejects.toMatchObject({ code: "unsupported_operator_schema" });

    const oversized = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch,
    });
    await expect(oversized.info()).rejects.toMatchObject({ code: "operator_info_too_large" });

    const wrongContentType = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => Response.json({ kind: "finish", finalText: "wrong" })) as typeof fetch,
    });
    await expect(wrongContentType.turn(turnInput())).rejects.toMatchObject({ code: "invalid_operator_content_type" });
  });

  it("bounds unterminated and terminal NDJSON frames while accepting a final frame without a newline", async () => {
    const unterminated = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("x".repeat(8 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(unterminated.turn(turnInput())).rejects.toMatchObject({ code: "operator_frame_too_large" });

    const oversizedFinish = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(`${JSON.stringify({ kind: "finish", finalText: "x".repeat(8 * 1024 * 1024) })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(oversizedFinish.turn(turnInput())).rejects.toMatchObject({ code: "operator_frame_too_large" });

    const terminalWithoutNewline = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(JSON.stringify({ kind: "finish", finalText: "done" }), {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(terminalWithoutNewline.turn(turnInput())).resolves.toEqual({ finalText: "done" });
  });

  it("never follows redirects and reads only a bounded HTTP error prefix", async () => {
    let redirectMode: RequestInit["redirect"];
    const redirected = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } });
      }) as typeof fetch,
    });
    await expect(redirected.info()).rejects.toMatchObject({ code: "agent_http_error" });
    expect(redirectMode).toBe("error");

    const hugeError = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("sensitive".repeat(100_000), { status: 500 })) as typeof fetch,
    });
    const failure: unknown = await hugeError.info().then((): unknown => undefined, (error: unknown) => error);
    expect((failure as Error).message.length).toBeLessThan(400);
    expect(failure).toMatchObject({ code: "agent_http_error" });
  });

  it("bounds a hanging cancellation request", async () => {
    let cancelSignal: AbortSignal | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async (_input, init) => {
        cancelSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolvePromise, reject) => {
          cancelSignal?.addEventListener("abort", () => reject(cancelSignal?.reason), { once: true });
        });
      }) as typeof fetch,
    });
    const startedAt = Date.now();
    await expect(client.cancel("conversation")).rejects.toBeDefined();
    expect(cancelSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 5_000);
});
