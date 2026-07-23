import { describe, expect, it, vi } from "vitest";

import {
  OperatorClient,
  OperatorClientError,
  normalizeOperatorEndpoint,
  serializeOperatorFrame,
  type OperatorFrame,
} from "../index.js";
import { VALID_TURN_FRAMES, VALID_TURN_REQUEST } from "../testing.js";

function byteStream(chunks: readonly (string | Uint8Array)[], delayMs = 0, onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function ndjsonResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

async function collect(stream: AsyncIterable<OperatorFrame>): Promise<OperatorFrame[]> {
  const frames: OperatorFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

describe("OperatorClient", () => {
  it("accepts only trusted literal loopback HTTP endpoints", () => {
    expect(normalizeOperatorEndpoint("http://127.0.0.1:1234/operator/")).toBe("http://127.0.0.1:1234/operator");
    expect(normalizeOperatorEndpoint("http://127.42.7.9:1234/operator/")).toBe("http://127.42.7.9:1234/operator");
    expect(normalizeOperatorEndpoint("http://[::1]:1234/operator")).toBe("http://[::1]:1234/operator");
    for (const endpoint of [
      "https://127.0.0.1:1234",
      "http://localhost:1234",
      "http://126.255.255.255:1234",
      "http://128.0.0.1:1234",
      "http://[::ffff:127.0.0.1]:1234",
      "http://user:secret@127.0.0.1:1234",
      "http://127.0.0.1:1234?redirect=http://evil.example",
      "http://127.0.0.1:1234#fragment",
    ]) {
      expect(() => normalizeOperatorEndpoint(endpoint)).toThrow(OperatorClientError);
    }
  });

  it("decodes chunk-split valid frames and requires redirect rejection", async () => {
    const wire = VALID_TURN_FRAMES.map(serializeOperatorFrame).join("");
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
      return ndjsonResponse(byteStream([wire.slice(0, 17), wire.slice(17, 301), wire.slice(301)]));
    });
    const client = new OperatorClient({ endpoint: "http://127.0.0.1:4321/operator", token: "private-token", fetch });
    await expect(collect(client.streamTurn(VALID_TURN_REQUEST))).resolves.toEqual(VALID_TURN_FRAMES);
  });

  it("rejects malformed, oversized, and incomplete streams", async () => {
    const malformed = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      fetch: async () => ndjsonResponse(byteStream(["{not-json}\n"])),
    });
    await expect(collect(malformed.streamTurn(VALID_TURN_REQUEST))).rejects.toMatchObject({ code: "INVALID_STREAM" });

    const oversized = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      limits: { frameBytes: 64 },
      fetch: async () => ndjsonResponse(byteStream(["x".repeat(65)])),
    });
    await expect(collect(oversized.streamTurn(VALID_TURN_REQUEST))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const acceptedOnly = serializeOperatorFrame(VALID_TURN_FRAMES[0]!);
    const incomplete = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      fetch: async () => ndjsonResponse(byteStream([acceptedOnly])),
    });
    await expect(collect(incomplete.streamTurn(VALID_TURN_REQUEST))).rejects.toThrow("without a terminal frame");

    const partial = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      fetch: async () => ndjsonResponse(byteStream([acceptedOnly.slice(0, -1)])),
    });
    await expect(collect(partial.streamTurn(VALID_TURN_REQUEST))).rejects.toThrow("incomplete frame");
  });

  it("bounds JSON responses and request bodies before parsing or transport", async () => {
    const oversizedResponse = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      limits: { jsonResponseBytes: 32 },
      fetch: async () => new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "33" },
      }),
    });
    await expect(oversizedResponse.getInfo()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const fetch = vi.fn();
    const oversizedRequest = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      limits: { requestBytes: 64 },
      fetch,
    });
    await expect(collect(oversizedRequest.streamTurn({
      conversationId: "fixture-conversation",
      input: { text: "x".repeat(128) },
    }))).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(fetch).not.toHaveBeenCalled();

    const askFetch = vi.fn(async () => new Response('{"status":"accepted"}', {
      headers: { "content-type": "application/json" },
    }));
    const askClient = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      limits: { requestBytes: 64, askAnswerRequestBytes: 1_024 },
      fetch: askFetch,
    });
    await expect(askClient.answerAsk("fixture-conversation", {
      interactionId: "ask",
      answers: { constructor: ["x".repeat(128)] },
    })).resolves.toEqual({ status: "accepted" });
    expect(askFetch).toHaveBeenCalledOnce();
  });

  it("keeps a normal turn body alive after the header timeout window", async () => {
    const frames = [VALID_TURN_FRAMES[0]!, VALID_TURN_FRAMES.at(-1)!];
    const client = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      requestTimeoutMs: 10,
      fetch: async () => ndjsonResponse(byteStream(frames.map(serializeOperatorFrame), 25)),
    });
    await expect(collect(client.streamTurn(VALID_TURN_REQUEST))).resolves.toEqual(frames);
  });

  it("cancels the response reader when a stream consumer disconnects", async () => {
    let cancelled = false;
    const accepted = serializeOperatorFrame(VALID_TURN_FRAMES[0]!);
    const fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(accepted));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
    const client = new OperatorClient({ endpoint: "http://127.0.0.1:4321", fetch });
    const stream = client.streamTurn(VALID_TURN_REQUEST);
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "accepted" }, done: false });
    await stream.return();
    expect(cancelled).toBe(true);
  });

  it("rejects frames after a terminal and mismatched turn identifiers", async () => {
    const accepted = VALID_TURN_FRAMES[0]!;
    const terminal = VALID_TURN_FRAMES.at(-1)!;
    const trailing: OperatorFrame = { type: "activity", turnId: "fixture-turn", text: "too late" };
    const client = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      fetch: async () => ndjsonResponse(byteStream([[accepted, terminal, trailing].map(serializeOperatorFrame).join("")])),
    });
    await expect(collect(client.streamTurn(VALID_TURN_REQUEST))).rejects.toThrow("after its terminal frame");

    const mismatched: OperatorFrame = { type: "activity", turnId: "other-turn", text: "wrong" };
    const mismatchClient = new OperatorClient({
      endpoint: "http://127.0.0.1:4321",
      fetch: async () => ndjsonResponse(byteStream([[accepted, mismatched, terminal].map(serializeOperatorFrame).join("")])),
    });
    await expect(collect(mismatchClient.streamTurn(VALID_TURN_REQUEST))).rejects.toThrow("turnId does not match");
  });
});
