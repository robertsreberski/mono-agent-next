// SPDX-License-Identifier: MIT
import {
  conversationDeliveryEntryStateKey,
  conversationStateKey,
  deliveryStateKey,
} from "./execution-store.js";

import {
  parseConversationRecord,
  parseConversationDeliveryEntryRecord,
  parseDeliveryTranscriptEntry,
  deliveryEntryAuthorityDigest,
  chunkCanonicalTranscript,
  parseDeliveryRecord,
  assertDeliveryKeyAuthority,
  parseFingerprint,
  boundedIdentifier,
  boundedConversationId,
  boundedCode,
  boundedInteger,
  canonicalNow,
  addMilliseconds,
  isExpired,
} from "./execution-codec.js";

import {
  appendCanonicalTranscript,
  type CanonicalTranscriptEntry,
} from "./execution-transcript.js";

import type {
  DeliveryIntentInput,
  DeliveryIntentResult,
  DeliverySettlementInput,
  DeliverySettlementWithHistoryInput,
  DeliverySettlementWithHistoryResult,
} from "./execution-journal.js";

import type {
  ConversationRecord,
  ConversationDeliveryEntryRecord,
  DeliveryRecord,
} from "./execution-journal-records.js";

import {
  ExecutionJournalConcern,
  type ExecutionJournalDependencies,
} from "./execution-journal-concern.js";

export class ExecutionDeliveryJournal extends ExecutionJournalConcern {
  constructor(dependencies: ExecutionJournalDependencies) {
    super(dependencies);
  }

  async settleDeliveryWithHistory(
    input: DeliverySettlementWithHistoryInput,
  ): Promise<DeliverySettlementWithHistoryResult> {
    const idempotencyKey = boundedIdentifier(
      input.idempotencyKey,
      "idempotencyKey",
    );
    const deliveryFingerprint = parseFingerprint(
      input.fingerprint,
      "fingerprint",
    );
    const attempt = boundedInteger(input.attempt, "attempt", 1, 10_000);
    const token = boundedIdentifier(input.token, "delivery attempt token");
    const messageId = input.messageId === undefined
      ? undefined
      : boundedIdentifier(input.messageId, "messageId");
    const conversationId = boundedConversationId(
      input.conversationId,
      "conversationId",
    );
    const entryFingerprint = parseFingerprint(
      input.entryFingerprint,
      "entryFingerprint",
    );
    const entry = parseDeliveryTranscriptEntry(
      input.entry,
      conversationId,
      "1970-01-01T00:00:00.000Z",
    );
    const entryDigest = deliveryEntryAuthorityDigest(entry);
    const bindingKey = conversationDeliveryEntryStateKey(entry.entryId);
    const deliveryKey = deliveryStateKey(idempotencyKey);

    for (let retry = 0; retry < 5; retry += 1) {
      const delivery = await this.store.read(
        deliveryKey,
        parseDeliveryRecord,
        input.signal,
      );
      if (delivery === undefined) {
        throw new Error("delivery intent does not exist");
      }
      assertDeliveryKeyAuthority(delivery.value, idempotencyKey);
      if (
        delivery.value.fingerprint !== deliveryFingerprint
        || delivery.value.attempts !== attempt
        || delivery.value.attemptToken !== token
      ) {
        return Object.freeze({
          status: "conflict",
          conversationId,
          entryId: entry.entryId,
        });
      }
      if (
        delivery.value.status === "delivered"
        && delivery.value.messageId !== messageId
      ) {
        return Object.freeze({
          status: "conflict",
          conversationId,
          entryId: entry.entryId,
        });
      }
      if (
        delivery.value.status !== "intent"
        && delivery.value.status !== "delivered"
      ) {
        return Object.freeze({
          status: "conflict",
          conversationId,
          entryId: entry.entryId,
        });
      }
      if (delivery.value.status === "delivered") {
        if (delivery.value.historyEntryId === undefined) {
          throw new Error(
            "delivered receipt exists without its atomic destination history",
          );
        }
        if (
          delivery.value.historyEntryId !== entry.entryId
          || delivery.value.historyConversationId !== conversationId
          || delivery.value.historyEntryFingerprint !== entryFingerprint
          || delivery.value.historyEntryDigest !== entryDigest
        ) {
          return Object.freeze({
            status: "conflict",
            conversationId,
            entryId: entry.entryId,
          });
        }
      }
      const binding = await this.store.read(
        bindingKey,
        parseConversationDeliveryEntryRecord,
        input.signal,
      );
      if (binding !== undefined) {
        if (binding.value.entryId !== entry.entryId) {
          throw new Error(
            "conversation delivery binding key does not match its entry identity",
          );
        }
        if (
          binding.value.conversationId !== conversationId
          || binding.value.deliveryIdempotencyKey !== idempotencyKey
          || binding.value.deliveryFingerprint !== deliveryFingerprint
          || binding.value.fingerprint !== entryFingerprint
          || binding.value.entryDigest !== entryDigest
        ) {
          return Object.freeze({
            status: "conflict",
            conversationId,
            entryId: entry.entryId,
          });
        }
        const conversation = await this.store.read(
          conversationStateKey(conversationId),
          parseConversationRecord,
          input.signal,
        );
        if (conversation === undefined) {
          throw new Error(
            "conversation delivery binding points to missing destination history",
          );
        }
        const transcript = await this.loadConversationTranscript(
          conversation.value,
          input.signal,
        );
        const committedEntry = transcript.entries[binding.value.entryCount - 1];
        if (
          transcript.revision < binding.value.revision
          || transcript.entries.length < binding.value.entryCount
          || committedEntry === undefined
          || committedEntry.recordedAt !== binding.value.createdAt
          || deliveryEntryAuthorityDigest(committedEntry)
            !== binding.value.entryDigest
        ) {
          throw new Error(
            "conversation delivery binding does not match destination history",
          );
        }
        if (delivery.value.status !== "delivered") {
          throw new Error(
            "destination history exists without its atomic delivery receipt",
          );
        }
        return Object.freeze({
          status: "duplicate",
          conversationId,
          entryId: entry.entryId,
          revision: binding.value.revision,
          entryCount: binding.value.entryCount,
          ...(messageId === undefined ? {} : { messageId }),
        });
      }

      if (delivery.value.status === "delivered") {
        throw new Error(
          "delivered receipt exists without its atomic destination history",
        );
      }

      const conversation = await this.store.read(
        conversationStateKey(conversationId),
        parseConversationRecord,
        input.signal,
      );
      const loaded = conversation === undefined
        ? undefined
        : await this.loadConversationTranscriptState(
            conversation.value,
            input.signal,
          );
      if (
        loaded?.transcript.entries.some(
          (candidate) => candidate.entryId === entry.entryId,
        ) === true
      ) {
        return Object.freeze({
          status: "conflict",
          conversationId,
          entryId: entry.entryId,
        });
      }
      const now = canonicalNow(this.clock);
      const deliveryUpdatedAt = Date.parse(now) >= Date.parse(delivery.value.updatedAt)
        ? now
        : delivery.value.updatedAt;
      const recordedAt = conversation === undefined
        || Date.parse(now) >= Date.parse(conversation.value.updatedAt)
        ? now
        : conversation.value.updatedAt;
      const committedEntry = Object.freeze({
        ...entry,
        recordedAt,
      }) as CanonicalTranscriptEntry;
      const transcript = appendCanonicalTranscript(
        loaded?.transcript,
        conversationId,
        [committedEntry],
      );
      const chunked = chunkCanonicalTranscript(transcript);
      const createdAt = conversation === undefined
        ? recordedAt
        : conversation.value.createdAt
          ?? loaded?.transcript.entries[0]?.recordedAt
          ?? conversation.value.updatedAt;
      const conversationValue: ConversationRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.conversation",
        conversationId,
        revision: transcript.revision,
        transcriptChunks: chunked.manifest,
        entryCount: transcript.entries.length,
        createdAt,
        updatedAt: recordedAt,
        ...(conversation?.value.title === undefined
          ? {}
          : { title: conversation.value.title }),
        ...(conversation?.value.metadata === undefined
          ? {}
          : { metadata: conversation.value.metadata }),
      });
      const bindingValue: ConversationDeliveryEntryRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.conversation-delivery-entry",
        entryId: entry.entryId,
        conversationId,
        deliveryIdempotencyKey: idempotencyKey,
        deliveryFingerprint,
        fingerprint: entryFingerprint,
        entryDigest,
        revision: transcript.revision,
        entryCount: transcript.entries.length,
        createdAt: recordedAt,
      });
      const deliveryValue: DeliveryRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.delivery",
        idempotencyKey: delivery.value.idempotencyKey,
        fingerprint: delivery.value.fingerprint,
        channelInstanceId: delivery.value.channelInstanceId,
        ...(delivery.value.runId === undefined
          ? {}
          : { runId: delivery.value.runId }),
        status: "delivered",
        attempts: delivery.value.attempts,
        attemptToken: delivery.value.attemptToken,
        createdAt: delivery.value.createdAt,
        updatedAt: deliveryUpdatedAt,
        ...(messageId === undefined ? {} : { messageId }),
        historyEntryId: entry.entryId,
        historyConversationId: conversationId,
        historyEntryFingerprint: entryFingerprint,
        historyEntryDigest: entryDigest,
      });
      const previousChunks = new Map(
        (loaded?.chunks ?? []).map((chunk) => [chunk.key, chunk] as const),
      );
      const nextChunkKeys = new Set(
        chunked.chunks.map((chunk) => chunk.descriptor.key),
      );
      const result = await this.store.transaction({
        checks: chunked.chunks.flatMap((chunk) => {
          const previous = previousChunks.get(chunk.descriptor.key);
          return previous === undefined
            ? []
            : [{ key: previous.key, expectedVersion: previous.version }];
        }),
        puts: [
          {
            key: deliveryKey,
            expectedVersion: delivery.version,
            value: deliveryValue,
          },
          {
            key: conversationStateKey(conversationId),
            expectedVersion: conversation?.version ?? null,
            value: conversationValue,
          },
          {
            key: bindingKey,
            expectedVersion: null,
            value: bindingValue,
          },
        ],
        bytePuts: chunked.chunks.flatMap((chunk) =>
          previousChunks.has(chunk.descriptor.key)
            ? []
            : [{
                key: chunk.descriptor.key,
                expectedVersion: null,
                value: chunk.bytes,
              }]),
        deletes: (loaded?.chunks ?? []).flatMap((chunk) =>
          nextChunkKeys.has(chunk.key)
            ? []
            : [{ key: chunk.key, expectedVersion: chunk.version }]),
        signal: input.signal,
      });
      if (result.status === "applied") {
        return Object.freeze({
          status: "appended",
          conversationId,
          entryId: entry.entryId,
          revision: transcript.revision,
          entryCount: transcript.entries.length,
          ...(messageId === undefined ? {} : { messageId }),
        });
      }
    }
    throw new Error(
      "delivery settlement with destination history did not converge after contention",
    );
  }


  async prepareDelivery(input: DeliveryIntentInput): Promise<DeliveryIntentResult> {
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey");
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const channelInstanceId = boundedIdentifier(input.channelInstanceId, "channelInstanceId");
    const runId = input.runId === undefined ? undefined : boundedIdentifier(input.runId, "runId");
    const key = deliveryStateKey(idempotencyKey);

    for (let retry = 0; retry < 3; retry += 1) {
      const existing = await this.store.read(key, parseDeliveryRecord, input.signal);
      if (existing === undefined) {
        const now = canonicalNow(this.clock);
        const attemptToken = boundedIdentifier(
          this.createDeliveryToken(),
          "delivery attempt token",
        );
        const record: DeliveryRecord = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey,
          fingerprint,
          channelInstanceId,
          ...(runId === undefined ? {} : { runId }),
          status: "intent",
          attempts: 1,
          attemptToken,
          createdAt: now,
          updatedAt: now,
          leaseExpiresAt: addMilliseconds(now, this.staleAfterMs),
        });
        const created = await this.store.transaction({
          puts: [{ key, expectedVersion: null, value: record }],
          signal: input.signal,
        });
        if (created.status === "applied") {
          return { status: "send", attempt: 1, token: attemptToken };
        }
        continue;
      }
      assertDeliveryKeyAuthority(existing.value, idempotencyKey);
      if (
        existing.value.fingerprint !== fingerprint
        || existing.value.channelInstanceId !== channelInstanceId
        || existing.value.runId !== runId
      ) {
        return { status: "conflict" };
      }
      if (existing.value.status === "delivered") {
        return {
          status: "duplicate",
          ...(existing.value.messageId === undefined
            ? {}
            : { messageId: existing.value.messageId }),
        };
      }
      if (existing.value.status === "unknown") {
        return {
          status: "unknown",
          ...(existing.value.code === undefined ? {} : { code: existing.value.code }),
        };
      }
      if (existing.value.status === "intent") {
        if (!isExpired(existing.value.leaseExpiresAt, this.clock)) return { status: "join" };
        const now = canonicalNow(this.clock);
        const unknown: DeliveryRecord = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: existing.value.idempotencyKey,
          fingerprint: existing.value.fingerprint,
          channelInstanceId: existing.value.channelInstanceId,
          ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
          status: "unknown",
          attempts: existing.value.attempts,
          attemptToken: existing.value.attemptToken,
          createdAt: existing.value.createdAt,
          updatedAt: now,
          code: "stale-delivery-intent",
        });
        const settled = await this.store.transaction({
          puts: [{ key, expectedVersion: existing.version, value: unknown }],
          signal: input.signal,
        });
        if (settled.status === "applied") {
          return { status: "unknown", code: "stale-delivery-intent" };
        }
        continue;
      }
      const now = canonicalNow(this.clock);
      const attemptToken = boundedIdentifier(
        this.createDeliveryToken(),
        "delivery attempt token",
      );
      const retryRecord: DeliveryRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.delivery",
        idempotencyKey: existing.value.idempotencyKey,
        fingerprint: existing.value.fingerprint,
        channelInstanceId: existing.value.channelInstanceId,
        ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
        status: "intent",
        attempts: existing.value.attempts + 1,
        attemptToken,
        createdAt: existing.value.createdAt,
        updatedAt: now,
        leaseExpiresAt: addMilliseconds(now, this.staleAfterMs),
      });
      const retried = await this.store.transaction({
        puts: [{ key, expectedVersion: existing.version, value: retryRecord }],
        signal: input.signal,
      });
      if (retried.status === "applied") {
        return {
          status: "send",
          attempt: retryRecord.attempts,
          token: attemptToken,
        };
      }
    }
    throw new Error("delivery intent did not converge after contention");
  }

  async settleDelivery(input: DeliverySettlementInput): Promise<DeliveryIntentResult> {
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey");
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const attempt = boundedInteger(input.attempt, "attempt", 1, 10_000);
    const token = boundedIdentifier(input.token, "delivery attempt token");
    const key = deliveryStateKey(idempotencyKey);
    const existing = await this.store.read(key, parseDeliveryRecord, input.signal);
    if (existing === undefined) throw new Error("delivery intent does not exist");
    assertDeliveryKeyAuthority(existing.value, idempotencyKey);
    if (existing.value.fingerprint !== fingerprint) return { status: "conflict" };
    if (
      existing.value.attempts !== attempt
      || existing.value.attemptToken !== token
    ) {
      return { status: "conflict" };
    }
    if (existing.value.status === "delivered") {
      return {
        status: "duplicate",
        ...(existing.value.messageId === undefined ? {} : { messageId: existing.value.messageId }),
      };
    }
    if (existing.value.status === "unknown") {
      return {
        status: "unknown",
        ...(existing.value.code === undefined ? {} : { code: existing.value.code }),
      };
    }
    if (existing.value.status !== "intent") {
      if (input.status === "failed") return { status: "join" };
      throw new Error("only an active delivery intent can settle");
    }
    const messageId = input.messageId === undefined
      ? undefined
      : boundedIdentifier(input.messageId, "messageId");
    const code = input.code === undefined ? undefined : boundedCode(input.code, "code");
    if (input.status === "delivered" && code !== undefined) {
      throw new TypeError("delivered receipts cannot carry a failure code");
    }
    if (input.status !== "delivered" && code === undefined) {
      throw new TypeError("failed and unknown delivery receipts require a bounded code");
    }
    if (input.status !== "delivered" && messageId !== undefined) {
      throw new TypeError("non-delivered receipts cannot claim a message id");
    }
    const updated: DeliveryRecord = Object.freeze({
      schemaVersion: 1,
      kind: "mono-agent.delivery",
      idempotencyKey: existing.value.idempotencyKey,
      fingerprint: existing.value.fingerprint,
      channelInstanceId: existing.value.channelInstanceId,
      ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
      status: input.status,
      attempts: existing.value.attempts,
      attemptToken: existing.value.attemptToken,
      createdAt: existing.value.createdAt,
      updatedAt: canonicalNow(this.clock),
      ...(messageId === undefined ? {} : { messageId }),
      ...(code === undefined ? {} : { code }),
    });
    const result = await this.store.transaction({
      puts: [{ key, expectedVersion: existing.version, value: updated }],
      signal: input.signal,
    });
    if (result.status === "conflict") throw new Error("delivery settlement lost an atomic state race");
    if (updated.status === "delivered") {
      return {
        status: "duplicate",
        ...(updated.messageId === undefined ? {} : { messageId: updated.messageId }),
      };
    }
    if (updated.status === "unknown") {
      return {
        status: "unknown",
        ...(updated.code === undefined ? {} : { code: updated.code }),
      };
    }
    return { status: "join" };
  }

  /**
   * Reconcile a bounded page of durable artifact-publication intents.
   *
   * A descriptor is removed only after the selected state backend confirms
   * physical deletion. Backends that cannot prove reference-safe deletion
   * leave the descriptor cleanup-pending for a later retention/GC pass.
   */
}
