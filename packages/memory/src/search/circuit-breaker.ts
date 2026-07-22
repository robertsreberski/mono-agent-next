import { MemorySearchError } from "./embeddings.js";
import type { EmbeddingProvider } from "./types.js";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface CircuitBreakerEmbeddingOptions {
  /** Consecutive inner failures before the breaker trips OPEN (default 3). */
  readonly failureThreshold?: number;
  /** How long the breaker stays OPEN before allowing a HALF-OPEN trial (default 30000ms). */
  readonly cooldownMs?: number;
  /** Injectable clock for deterministic tests (default Date.now). */
  readonly now?: () => number;
}

type BreakerState = "closed" | "open" | "half-open";

/**
 * Wraps an {@link EmbeddingProvider} with a circuit breaker so a slow/failing
 * backend stops blocking the critical path. After `failureThreshold` consecutive
 * failures the breaker trips OPEN and fails FAST (throwing `embedding_circuit_open`
 * without calling the inner provider) for `cooldownMs`. It then allows a single
 * HALF-OPEN trial: success CLOSES it, failure RE-OPENS it for a fresh cooldown.
 */
export class CircuitBreakerEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly inner: EmbeddingProvider;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  // Guards the single HALF-OPEN trial: once a trial is in flight, concurrent
  // callers must fail fast rather than pile onto an unhealthy backend.
  private trialInFlight = false;

  constructor(inner: EmbeddingProvider, options: CircuitBreakerEmbeddingOptions = {}) {
    this.inner = inner;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.id = inner.id;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) {
        throw new MemorySearchError("embedding_circuit_open", "Embedding circuit is open; failing fast.", {
          id: this.id,
          cooldownMs: this.cooldownMs,
        });
      }
      // Cooldown elapsed: allow exactly one trial.
      this.state = "half-open";
    }

    // In HALF-OPEN only the first caller may probe the backend; concurrent
    // callers fail fast so a single trial decides whether to re-close or
    // re-open. (Once state flips to half-open, the `state === "open"` guard
    // above no longer blocks them, so this second guard is required.)
    if (this.state === "half-open") {
      if (this.trialInFlight) {
        throw new MemorySearchError("embedding_circuit_open", "Embedding circuit is half-open; a trial is already in flight.", {
          id: this.id,
          cooldownMs: this.cooldownMs,
        });
      }
      this.trialInFlight = true;
    }

    try {
      const result = await this.inner.embed(texts);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
  }

  private onFailure(): void {
    if (this.state === "half-open") {
      // A failed trial re-opens the breaker for a fresh cooldown window.
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.trialInFlight = false;
  }
}

export function createCircuitBreakerEmbeddingProvider(
  inner: EmbeddingProvider,
  options: CircuitBreakerEmbeddingOptions = {},
): EmbeddingProvider {
  return new CircuitBreakerEmbeddingProvider(inner, options);
}
