import { createHash } from "node:crypto";
import { waitForValueWithAbort } from "./host-lifecycle.js";
import type { DurableFingerprint } from "./state-execution-client.js";

export class ConversationTails {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(
    conversationId: string,
    signal: AbortSignal,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.#tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = previous.catch(() => undefined);
    const current = ready.then(() => gate);
    this.#tails.set(conversationId, current);
    try {
      await waitForValueWithAbort(ready, signal);
      return await operation();
    } finally {
      release();
      void current.finally(() => {
        if (this.#tails.get(conversationId) === current) this.#tails.delete(conversationId);
      });
    }
  }
}

export function durableFingerprint(value: unknown): DurableFingerprint {
  const encoded = JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : entry);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
