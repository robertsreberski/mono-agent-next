export type MemorySearchErrorCode =
  | "invalid_embedding_options"
  | "embedding_request_failed"
  | "embedding_response_invalid"
  | "embedding_circuit_open";

/** Turns text into dense vectors. Implementations: Ollama (default), LM Studio, OpenAI. */
export interface EmbeddingProvider {
  /** Stable identifier for diagnostics (e.g. "ollama:nomic-embed-text"). */
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export type EmbeddingProviderKind = "ollama" | "lmstudio" | "openai";

export interface EmbeddingProviderConfig {
  readonly provider: EmbeddingProviderKind;
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}
