// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { waitForValueWithAbort } from "./host-lifecycle.js";
import type { DurableFingerprint } from "./state-execution-client.js";
import type { AgentSubmitInput } from "./types.js";

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
export function submissionFingerprint(input: AgentSubmitInput): DurableFingerprint {
  return durableFingerprint({
    schemaVersion: 1,
    kind: "mono-agent.submission-fingerprint",
    conversationId: input.conversationId,
    text: input.text,
    attachments: (input.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: `sha256:${createHash("sha256").update(attachment.data).digest("hex")}`,
    })),
    runtime: input.runtime ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    maxTurns: input.maxTurns ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    responseSchema: input.responseSchema ?? null,
    metadata: input.metadata ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    toolPolicy: input.toolPolicy ?? null,
  });
}
