import { checkedFetch } from "@mono-agent/module-sdk";

import type { MemoryLocalEmbeddingsConfig } from "./config.js";
import { MemoryLocalError } from "./errors.js";

const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_EMBEDDING_BATCH = 64;

export interface MemoryEmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export class OllamaMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly #config: MemoryLocalEmbeddingsConfig;

  constructor(config: MemoryLocalEmbeddingsConfig) {
    this.#config = config;
    this.id = `ollama:${config.model}`;
    this.dimensions = config.dimensions;
  }

  async embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0 || texts.length > MAX_EMBEDDING_BATCH) {
      throw providerFailure();
    }
    if (texts.some((text) => typeof text !== "string" || text.length === 0)) {
      throw providerFailure();
    }
    try {
      const response = await checkedFetch(
        `${this.#config.endpoint}/api/embed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.#config.model, input: texts }),
          signal,
        },
        {
          maxResponseBytes: MAX_EMBEDDING_RESPONSE_BYTES,
          timeoutMs: this.#config.timeoutMs,
          maxRedirects: 0,
        },
      );
      if (response.status < 200 || response.status >= 300) throw providerFailure();
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) throw providerFailure();
      const parsed = response.json();
      if (!isPlainObject(parsed) || !Array.isArray(parsed.embeddings)) throw providerFailure();
      if (parsed.embeddings.length !== texts.length) throw providerFailure();
      return Object.freeze(parsed.embeddings.map((entry) => {
        if (
          !Array.isArray(entry) ||
          entry.length !== this.dimensions ||
          entry.some((value) => typeof value !== "number" || !Number.isFinite(value))
        ) {
          throw providerFailure();
        }
        return Object.freeze([...entry] as number[]);
      }));
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      }
      if (error instanceof MemoryLocalError) throw error;
      throw providerFailure();
    }
  }
}

export function toVectorBlob(vector: readonly number[]): Buffer {
  const output = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    output.writeFloatLE(vector[index]!, index * 4);
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function providerFailure(): MemoryLocalError {
  return new MemoryLocalError(
    "embedding_unavailable",
    "Memory embedding provider is unavailable or returned an invalid bounded response.",
  );
}
