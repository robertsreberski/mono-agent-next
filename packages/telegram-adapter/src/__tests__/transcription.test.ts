import { describe, expect, it } from "vitest";

import { createOpenAiTranscriber } from "../transcription.js";

describe("createOpenAiTranscriber", () => {
  it("posts multipart form data (file+model+language) and returns the transcript", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transcriber = createOpenAiTranscriber(
      {
        endpoint: "http://localhost:50060/v1/audio/transcriptions",
        model: "large-v3",
        language: "en",
      },
      fetchImpl,
    );
    const bytes = new TextEncoder().encode("fake-ogg-bytes");
    const transcript = await transcriber.transcribe(
      { bytes, mimeType: "audio/ogg", filename: "clip.ogg" },
      new AbortController().signal,
    );

    expect(transcript).toBe("hello world");
    expect(capturedUrl).toBe("http://localhost:50060/v1/audio/transcriptions");
    expect(capturedInit?.method).toBe("POST");
    const form = capturedInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("clip.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(form.get("model")).toBe("large-v3");
    expect(form.get("language")).toBe("en");
  });

  it("defaults the filename to voice.ogg and omits language when unset", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transcriber = createOpenAiTranscriber(
      { endpoint: "http://localhost:50060/v1/audio/transcriptions", model: "large-v3" },
      fetchImpl,
    );
    await transcriber.transcribe(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" },
      new AbortController().signal,
    );

    const form = capturedInit?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(form.get("model")).toBe("large-v3");
    expect(form.get("language")).toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("upstream error", { status: 500 })) as unknown as typeof fetch;
    const transcriber = createOpenAiTranscriber(
      { endpoint: "http://localhost:50060/v1/audio/transcriptions", model: "large-v3" },
      fetchImpl,
    );
    await expect(
      transcriber.transcribe(
        { bytes: new Uint8Array([1]), mimeType: "audio/ogg" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/500|failed/u);
  });

  it("throws when the response has no text", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const transcriber = createOpenAiTranscriber(
      { endpoint: "http://localhost:50060/v1/audio/transcriptions", model: "large-v3" },
      fetchImpl,
    );
    await expect(
      transcriber.transcribe(
        { bytes: new Uint8Array([1]), mimeType: "audio/ogg" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no text|text/u);
  });
});
