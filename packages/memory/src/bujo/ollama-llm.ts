import type { LlmComplete, LlmCompleteOptions } from "./llm.js";

// Capture uses one extraction and at most one reconcile call; local Ollama chat models can still
// take tens of seconds per call, so the per-call timeout is generous and overridable. A timeout is
// surfaced as a model failure; queued capture logs it while the synchronous raw audit remains.
const DEFAULT_TIMEOUT_MS = 120_000;

export function createOllamaLlm(opts: { model: string; endpoint?: string; timeoutMs?: number }): LlmComplete {
  const endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/u, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: `ollama:${opts.model}`,
    async complete(prompt: string, options?: LlmCompleteOptions): Promise<string> {
      const ctrl = new AbortController();
      const abort = (): void => ctrl.abort(options?.abortSignal?.reason);
      if (options?.abortSignal?.aborted === true) abort();
      else options?.abortSignal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        if (ctrl.signal.aborted) return;
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      try {
        const res = await fetch(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: opts.model, prompt, stream: false, format: "json" }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`ollama /api/generate ${res.status}`);
        const data = (await res.json()) as { response?: unknown };
        return typeof data.response === "string" ? data.response : "";
      } catch (err) {
        // Translate our own abort into an explicit, diagnosable timeout (a generic AbortError that
        // callers swallow would make a slow-model capture look like "nothing to remember").
        if (timedOut) throw new Error(`ollama /api/generate timed out after ${timeoutMs}ms`);
        throw err;
      } finally {
        clearTimeout(timer);
        options?.abortSignal?.removeEventListener("abort", abort);
      }
    },
  };
}
