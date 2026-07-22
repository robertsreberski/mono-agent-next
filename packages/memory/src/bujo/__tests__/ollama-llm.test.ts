import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaLlm } from "../ollama-llm.js";

describe("createOllamaLlm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFetch(status: number, body: unknown): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response);
  }

  it("has id ollama:<model>", () => {
    const llm = createOllamaLlm({ model: "llama3.2" });
    expect(llm.id).toBe("ollama:llama3.2");
  });

  it("posts to <endpoint>/api/generate with native JSON mode", async () => {
    const fakeFetch = makeFetch(200, { response: "hello" });
    vi.stubGlobal("fetch", fakeFetch);

    const llm = createOllamaLlm({ model: "llama3.2", endpoint: "http://localhost:11434" });
    await llm.complete("test prompt");

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/generate");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "llama3.2",
      prompt: "test prompt",
      stream: false,
      format: "json",
    });
  });

  it("returns data.response on success", async () => {
    vi.stubGlobal("fetch", makeFetch(200, { response: "the answer" }));
    const llm = createOllamaLlm({ model: "llama3.2" });
    expect(await llm.complete("q")).toBe("the answer");
  });

  it("returns '' when response is missing from data", async () => {
    vi.stubGlobal("fetch", makeFetch(200, {}));
    const llm = createOllamaLlm({ model: "llama3.2" });
    expect(await llm.complete("q")).toBe("");
  });

  it("returns '' when response is not a string", async () => {
    vi.stubGlobal("fetch", makeFetch(200, { response: 42 }));
    const llm = createOllamaLlm({ model: "llama3.2" });
    expect(await llm.complete("q")).toBe("");
  });

  it("throws on non-ok status", async () => {
    vi.stubGlobal("fetch", makeFetch(500, {}));
    const llm = createOllamaLlm({ model: "llama3.2" });
    await expect(llm.complete("q")).rejects.toThrow("500");
  });

  it("trims trailing slash from endpoint", async () => {
    const fakeFetch = makeFetch(200, { response: "ok" });
    vi.stubGlobal("fetch", fakeFetch);

    const llm = createOllamaLlm({ model: "llama3.2", endpoint: "http://localhost:11434/" });
    await llm.complete("q");

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:11434/api/generate");
  });

  it("uses default endpoint http://localhost:11434 when not specified", async () => {
    const fakeFetch = makeFetch(200, { response: "ok" });
    vi.stubGlobal("fetch", fakeFetch);

    const llm = createOllamaLlm({ model: "llama3.2" });
    await llm.complete("q");

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:11434/api/generate");
  });

  it("aborts and throws an explicit timeout error when the call exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that never resolves until its abort signal fires (simulating a slow local model).
      const hangingFetch = vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }),
      );
      vi.stubGlobal("fetch", hangingFetch as unknown as typeof fetch);

      const llm = createOllamaLlm({ model: "llama3.2", timeoutMs: 1_000 });
      const pending = llm.complete("q");
      const assertion = expect(pending).rejects.toThrow("ollama /api/generate timed out after 1000ms");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a non-timeout fetch error unchanged (not relabeled as a timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch);
    const llm = createOllamaLlm({ model: "llama3.2", timeoutMs: 1_000 });
    await expect(llm.complete("q")).rejects.toThrow("ECONNREFUSED");
  });
});
