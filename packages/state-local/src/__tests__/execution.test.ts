import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalExecution } from "../execution.js";
import { acquireProcessLease } from "../secure-fs.js";
import { StateLocalStore } from "../store.js";

const OLD = "2026-07-20T12:00:00.000Z";
const NOW = "2026-07-23T12:00:00.000Z";
const LATER = "2026-07-24T12:00:00.000Z";
const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("state-local execution ownership", () => {
  it("owns the opaque protocol and proactive conversation representation", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    expect(store.toolContributions).toBe(store.execution.toolContributions);
    expect(store.toolContributions).toEqual([
      expect.objectContaining({ name: "RunHistory", effects: [] }),
    ]);
    expect(Object.getOwnPropertyDescriptor(store, "toolContributions"))
      .toMatchObject({ value: store.toolContributions });
    const protocol = await perform<{
      readonly protocol: string;
      readonly version: number;
      readonly operations: readonly string[];
    }>(store, "protocol.describe");
    expect(protocol).toMatchObject({
      protocol: "mono-agent.state-execution",
      version: 1,
    });
    expect(protocol.operations).toContain("delivery.settle-with-history");
    expect(protocol.operations).not.toContain("conversation.append-delivery");

    const opened = await perform<ConversationView>(store, "conversation.open", {
      title: "Daily report",
      initialText: "The report is ready.",
      metadata: { trigger: "cron" },
    });
    expect(opened.conversationId).toMatch(/^proactive:/u);
    expect(opened.createdAt).toBe(NOW);
    expect(opened.updatedAt).toBe(NOW);
    expect(opened.title).toBe("Daily report");
    expect(opened.metadata).toEqual({ trigger: "cron" });
    expect(opened.transcript).toMatchObject({
      schemaVersion: 1,
      kind: "mono-agent.canonical-transcript",
      conversationId: opened.conversationId,
      revision: 1,
    });
    expect(opened.transcript.entries).toEqual([expect.objectContaining({
      kind: "verbatim",
      role: "assistant",
      text: "The report is ready.",
    })]);

    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId: opened.conversationId,
    })).resolves.toEqual(opened);
    const listed = await perform<{
      readonly conversations: readonly {
        readonly conversationId: string;
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly title?: string;
      }[];
    }>(store, "conversation.list");
    expect(listed.conversations).toEqual([{
      conversationId: opened.conversationId,
      createdAt: NOW,
      updatedAt: NOW,
      title: "Daily report",
      metadata: { trigger: "cron" },
    }]);

    const appended = await perform<CanonicalTranscript>(
      store,
      "transcript.append",
      {
        current: opened.transcript,
        conversationId: opened.conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "entry-2",
          runId: "run-2",
          requestId: "request-2",
          conversationId: opened.conversationId,
          recordedAt: NOW,
          role: "user",
          text: "Thanks",
        }],
      },
    );
    expect(appended.revision).toBe(2);
    expect(appended.entries).toHaveLength(2);

    let getterInvoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "cursor", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "cursor";
      },
    });
    await expect(store.execution.perform({
      operation: "run.list",
      input: hostile,
      signal,
    })).rejects.toThrow(/own data property/u);
    expect(getterInvoked).toBe(false);
    await expect(store.execution.perform({
      operation: "not-supported",
      signal,
    })).rejects.toThrow(/unsupported/u);
    await store.close();
  });

  it("fails closed when a valid conversation record is copied under another conversation hash key", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    const first = await perform<ConversationView>(
      store,
      "conversation.open",
      {
        title: "Conversation A",
        initialText: "history A",
        metadata: { owner: "A" },
      },
    );
    const second = await perform<ConversationView>(
      store,
      "conversation.open",
      {
        title: "Conversation B",
        initialText: "history B",
        metadata: { owner: "B" },
      },
    );
    const records = await store.scan({
      prefix: "core/conversations/",
      limit: 10,
      signal,
    });
    expect(records.records).toHaveLength(2);
    const byConversationId = new Map(records.records.map((record) => {
      const decoded = JSON.parse(
        Buffer.from(record.value).toString("utf8"),
      ) as { readonly conversationId?: unknown };
      return [decoded.conversationId, record] as const;
    }));
    const firstRecord = byConversationId.get(first.conversationId);
    const secondRecord = byConversationId.get(second.conversationId);
    if (firstRecord === undefined || secondRecord === undefined) {
      throw new Error("Expected both conversation records.");
    }
    await store.write({
      key: firstRecord.key,
      value: secondRecord.value,
      expectedVersion: firstRecord.version,
      signal,
    });

    await expect(perform(store, "conversation.load", {
      conversationId: first.conversationId,
    })).rejects.toThrow(
      /conversation record key does not match its conversation identity/u,
    );
    await expect(perform(store, "conversation.list")).rejects.toThrow(
      /conversation record key does not match its conversation identity/u,
    );
    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId: second.conversationId,
    })).resolves.toMatchObject({
      conversationId: second.conversationId,
      title: "Conversation B",
      metadata: { owner: "B" },
      transcript: {
        entries: [expect.objectContaining({ text: "history B" })],
      },
    });
    await store.close();
  });

  it("atomically creates delivered destination history and binds exact replay across restart", async () => {
    const config = await createConfig();
    const store = await open(config, () => new Date(NOW));
    const conversationId = "slack:C123";
    const entry = assistantDeliveryEntry(
      conversationId,
      "delivery-entry-1",
      "Delivered externally",
    );
    const fingerprint = await perform<string>(store, "fingerprint.create", {
      channel: "slack",
      destination: conversationId,
      text: "Delivered externally",
    });
    const delivery = await prepareHistoryDelivery(store, "delivery-entry-1");
    const messageId = "m".repeat(512);

    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        entry,
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "appended",
      conversationId,
      entryId: "delivery-entry-1",
      revision: 1,
      entryCount: 1,
      messageId,
    });
    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId,
    })).resolves.toEqual({
      conversationId,
      createdAt: NOW,
      updatedAt: NOW,
      transcript: {
        schemaVersion: 1,
        kind: "mono-agent.canonical-transcript",
        conversationId,
        revision: 1,
        entries: [{ ...entry, recordedAt: NOW }],
      },
    });
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        entry,
        fingerprint,
        messageId,
      ),
    )).resolves.toMatchObject({
      status: "duplicate",
      revision: 1,
      entryCount: 1,
    });
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        assistantDeliveryEntry(
          conversationId,
          "delivery-entry-1-alias",
          "Delivered externally",
        ),
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId,
      entryId: "delivery-entry-1-alias",
    });
    const crossDelivery = await prepareHistoryDelivery(
      store,
      "delivery-entry-1-cross-pair",
    );
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        crossDelivery,
        conversationId,
        entry,
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId,
      entryId: "delivery-entry-1",
    });
    await expect(perform(store, "delivery.prepare", {
      idempotencyKey: crossDelivery.idempotencyKey,
      fingerprint: crossDelivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toMatchObject({ status: "join" });

    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        assistantDeliveryEntry(
          conversationId,
          "delivery-entry-1",
          "Conflicting content",
        ),
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId,
      entryId: "delivery-entry-1",
    });
    const conflictingFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { channel: "slack", destination: conversationId, text: "different" },
    );
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        entry,
        conflictingFingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId,
      entryId: "delivery-entry-1",
    });
    const otherConversationId = "slack:C999";
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        otherConversationId,
        assistantDeliveryEntry(
          otherConversationId,
          "delivery-entry-1",
          "Delivered externally",
        ),
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId: otherConversationId,
      entryId: "delivery-entry-1",
    });
    await expect(perform(store, "conversation.load", {
      conversationId: otherConversationId,
    })).resolves.toBeUndefined();
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        { ...entry, entryId: "user-delivery", role: "user" },
        fingerprint,
        messageId,
      ),
    )).rejects.toThrow(/assistant message or verbatim/u);
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        { ...entry, entryId: "caller-stamped", recordedAt: NOW },
        fingerprint,
        messageId,
      ),
    )).rejects.toThrow(/unknown field/u);
    await expect(perform(store, "delivery.prepare", {
      idempotencyKey: delivery.idempotencyKey,
      fingerprint: delivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toEqual({ status: "duplicate", messageId });
    await store.close();

    const reopened = await open(config, () => new Date(LATER));
    await expect(perform<ConversationDeliveryAppendResult>(
      reopened,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        entry,
        fingerprint,
        messageId,
      ),
    )).resolves.toEqual({
      status: "duplicate",
      conversationId,
      entryId: "delivery-entry-1",
      revision: 1,
      entryCount: 1,
      messageId,
    });
    expect((await perform<ConversationView>(reopened, "conversation.load", {
      conversationId,
    })).transcript.entries).toEqual([
      expect.objectContaining({ entryId: "delivery-entry-1", recordedAt: NOW }),
    ]);
    expect((await reopened.scan({
      prefix: "core/conversation-delivery-entries/",
      limit: 10,
      signal,
    })).records).toHaveLength(1);
    await reopened.close();
  });

  it("preserves derived creation chronology while upgrading a legacy conversation record", async () => {
    const config = await createConfig();
    let now = NOW;
    const store = await open(config, () => new Date(now));
    const conversationId = "legacy:missing-created-at";
    const runFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { request: "legacy-created-at" },
    );
    await perform(store, "run.admit", {
      requestId: "legacy-created-at-request",
      conversationId,
      fingerprint: runFingerprint,
      runId: "legacy-created-at-run",
    });
    const transcript = await perform<CanonicalTranscript>(
      store,
      "transcript.append",
      {
        conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "legacy-first-entry",
          runId: "legacy-created-at-run",
          requestId: "legacy-created-at-request",
          conversationId,
          recordedAt: OLD,
          role: "assistant",
          text: "original history",
        }],
      },
    );
    await perform(store, "run.settle", {
      runId: "legacy-created-at-run",
      requestId: "legacy-created-at-request",
      status: "completed",
      transcript,
      responseBytes: Buffer.from('{"status":"ok"}', "utf8"),
    });
    const beforeRecords = await store.scan({
      prefix: "core/conversations/",
      limit: 10,
      signal,
    });
    expect(beforeRecords.records).toHaveLength(1);
    const beforeRecord = JSON.parse(
      Buffer.from(beforeRecords.records[0]!.value).toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(beforeRecord, "createdAt")).toBe(false);
    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId,
    })).resolves.toMatchObject({
      createdAt: OLD,
      updatedAt: NOW,
    });

    now = LATER;
    const deliveryFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "legacy-created-at" },
    );
    const delivery = await prepareHistoryDelivery(store, "legacy-created-at");
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        delivery,
        conversationId,
        assistantDeliveryEntry(
          conversationId,
          "legacy-delivery-entry",
          "new delivery",
        ),
        deliveryFingerprint,
      ),
    )).resolves.toMatchObject({
      status: "appended",
      revision: 2,
      entryCount: 2,
    });
    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId,
    })).resolves.toMatchObject({
      createdAt: OLD,
      updatedAt: LATER,
      transcript: {
        entries: [
          expect.objectContaining({
            entryId: "legacy-first-entry",
            recordedAt: OLD,
          }),
          expect.objectContaining({
            entryId: "legacy-delivery-entry",
            recordedAt: LATER,
          }),
        ],
      },
    });
    const afterRecords = await store.scan({
      prefix: "core/conversations/",
      limit: 10,
      signal,
    });
    expect(afterRecords.records).toHaveLength(1);
    const afterRecord = JSON.parse(
      Buffer.from(afterRecords.records[0]!.value).toString("utf8"),
    ) as Record<string, unknown>;
    expect(afterRecord.createdAt).toBe(OLD);
    await store.close();
  });

  it("fails closed when a stored delivery binding disagrees with its hashed entry key", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    const conversationId = "external:corrupt-binding";
    const entry = assistantDeliveryEntry(
      conversationId,
      "binding-authority-entry",
      "bound",
    );
    const fingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "binding-authority" },
    );
    const delivery = await prepareHistoryDelivery(store, "binding-authority");
    await perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(delivery, conversationId, entry, fingerprint),
    );
    const bindings = await store.scan({
      prefix: "core/conversation-delivery-entries/",
      limit: 10,
      signal,
    });
    expect(bindings.records).toHaveLength(1);
    const binding = bindings.records[0]!;
    const tampered = JSON.parse(
      Buffer.from(binding.value).toString("utf8"),
    ) as Record<string, unknown>;
    tampered.entryId = "tampered-entry-id";
    await store.write({
      key: binding.key,
      value: Buffer.from(JSON.stringify(tampered), "utf8"),
      expectedVersion: binding.version,
      signal,
    });

    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(delivery, conversationId, entry, fingerprint),
    )).rejects.toThrow(/binding key does not match its entry identity/u);
    expect((await perform<ConversationView>(store, "conversation.load", {
      conversationId,
    })).transcript.entries).toHaveLength(1);
    await store.close();
  });

  it("fails closed across prepare, settle, and history settlement when a delivery receipt disagrees with its hashed key", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    const conversationId = "external:corrupt-delivery";
    const entry = assistantDeliveryEntry(
      conversationId,
      "corrupt-delivery-entry",
      "bound",
    );
    const fingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "corrupt-delivery" },
    );
    const delivery = await prepareHistoryDelivery(store, "corrupt-delivery");
    await perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(delivery, conversationId, entry, fingerprint),
    );
    const receipts = await store.scan({
      prefix: "core/deliveries/",
      limit: 10,
      signal,
    });
    expect(receipts.records).toHaveLength(1);
    const receipt = receipts.records[0]!;
    const tampered = JSON.parse(
      Buffer.from(receipt.value).toString("utf8"),
    ) as Record<string, unknown>;
    tampered.idempotencyKey = "tampered-delivery-idempotency-key";
    await store.write({
      key: receipt.key,
      value: Buffer.from(JSON.stringify(tampered), "utf8"),
      expectedVersion: receipt.version,
      signal,
    });

    await expect(perform(store, "delivery.prepare", {
      idempotencyKey: delivery.idempotencyKey,
      fingerprint: delivery.fingerprint,
      channelInstanceId: "history-channel",
    })).rejects.toThrow(
      /delivery record key does not match its idempotency identity/u,
    );
    await expect(perform(store, "delivery.settle", {
      idempotencyKey: delivery.idempotencyKey,
      fingerprint: delivery.fingerprint,
      attempt: delivery.attempt,
      token: delivery.token,
      status: "delivered",
    })).rejects.toThrow(
      /delivery record key does not match its idempotency identity/u,
    );
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(delivery, conversationId, entry, fingerprint),
    )).rejects.toThrow(/delivery record key does not match its idempotency identity/u);
    expect((await perform<ConversationView>(store, "conversation.load", {
      conversationId,
    })).transcript.entries).toHaveLength(1);
    await store.close();
  });

  it("rejects either half of a corrupted receipt-history atomic pair", async () => {
    const missingBindingStore = await open(
      await createConfig(),
      () => new Date(NOW),
    );
    const missingBindingConversationId = "external:missing-binding";
    const missingBindingEntry = assistantDeliveryEntry(
      missingBindingConversationId,
      "missing-binding-entry",
      "delivered",
    );
    const missingBindingFingerprint = await perform<string>(
      missingBindingStore,
      "fingerprint.create",
      { delivery: "missing-binding" },
    );
    const missingBindingDelivery = await prepareHistoryDelivery(
      missingBindingStore,
      "missing-binding",
    );
    const missingBindingInput = deliveryHistoryInput(
      missingBindingDelivery,
      missingBindingConversationId,
      missingBindingEntry,
      missingBindingFingerprint,
    );
    await perform(
      missingBindingStore,
      "delivery.settle-with-history",
      missingBindingInput,
    );
    const bindings = await missingBindingStore.scan({
      prefix: "core/conversation-delivery-entries/",
      limit: 10,
      signal,
    });
    expect(bindings.records).toHaveLength(1);
    await missingBindingStore.delete({
      key: bindings.records[0]!.key,
      expectedVersion: bindings.records[0]!.version,
      signal,
    });
    await expect(perform(
      missingBindingStore,
      "delivery.settle-with-history",
      missingBindingInput,
    )).rejects.toThrow(
      /delivered receipt exists without its atomic destination history/u,
    );
    await missingBindingStore.close();

    const missingReceiptStore = await open(
      await createConfig(),
      () => new Date(NOW),
    );
    const missingReceiptConversationId = "external:missing-receipt";
    const missingReceiptEntry = assistantDeliveryEntry(
      missingReceiptConversationId,
      "missing-receipt-entry",
      "delivered",
    );
    const missingReceiptFingerprint = await perform<string>(
      missingReceiptStore,
      "fingerprint.create",
      { delivery: "missing-receipt" },
    );
    const missingReceiptDelivery = await prepareHistoryDelivery(
      missingReceiptStore,
      "missing-receipt",
    );
    const missingReceiptInput = deliveryHistoryInput(
      missingReceiptDelivery,
      missingReceiptConversationId,
      missingReceiptEntry,
      missingReceiptFingerprint,
    );
    await perform(
      missingReceiptStore,
      "delivery.settle-with-history",
      missingReceiptInput,
    );
    const receipts = await missingReceiptStore.scan({
      prefix: "core/deliveries/",
      limit: 10,
      signal,
    });
    expect(receipts.records).toHaveLength(1);
    const receipt = receipts.records[0]!;
    const downgraded = JSON.parse(
      Buffer.from(receipt.value).toString("utf8"),
    ) as Record<string, unknown>;
    downgraded.status = "intent";
    downgraded.leaseExpiresAt = LATER;
    delete downgraded.messageId;
    delete downgraded.historyEntryId;
    delete downgraded.historyConversationId;
    delete downgraded.historyEntryFingerprint;
    delete downgraded.historyEntryDigest;
    await missingReceiptStore.write({
      key: receipt.key,
      value: Buffer.from(JSON.stringify(downgraded), "utf8"),
      expectedVersion: receipt.version,
      signal,
    });
    await expect(perform(
      missingReceiptStore,
      "delivery.settle-with-history",
      missingReceiptInput,
    )).rejects.toThrow(
      /destination history exists without its atomic delivery receipt/u,
    );
    await missingReceiptStore.close();
  });

  it("durably accepts 4,096-byte conversation IDs while retaining 512-byte identifier bounds", async () => {
    const config = await createConfig();
    const store = await open(config, () => new Date(NOW));
    const conversation513 = "a".repeat(513);
    const conversation4096 = "b".repeat(4_096);
    const conversation4097 = "c".repeat(4_097);
    const delivery513 = assistantDeliveryEntry(
      conversation513,
      "conversation-513-entry",
      "513-byte destination",
    );
    const delivery4096 = assistantDeliveryEntry(
      conversation4096,
      "conversation-4096-entry",
      "4096-byte destination",
    );
    const fingerprint513 = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "conversation-513" },
    );
    const fingerprint4096 = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "conversation-4096" },
    );
    const deliveryIntent513 = await prepareHistoryDelivery(
      store,
      "conversation-513",
    );
    const deliveryIntent4096 = await prepareHistoryDelivery(
      store,
      "conversation-4096",
    );
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        deliveryIntent513,
        conversation513,
        delivery513,
        fingerprint513,
      ),
    )).resolves.toMatchObject({
      status: "appended",
      conversationId: conversation513,
    });
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        deliveryIntent4096,
        conversation4096,
        delivery4096,
        fingerprint4096,
      ),
    )).resolves.toMatchObject({
      status: "appended",
      conversationId: conversation4096,
    });

    const runFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { request: "conversation-4096-run" },
    );
    await expect(perform<AdmissionResult>(store, "run.admit", {
      requestId: "conversation-boundary-request",
      conversationId: conversation4096,
      fingerprint: runFingerprint,
      runId: "conversation-boundary-run",
    })).resolves.toMatchObject({
      status: "accepted",
      summary: { runId: "conversation-boundary-run" },
    });

    const shortConversationId = "identifier-boundary";
    const entryId512 = "i".repeat(512);
    const entryFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "entry-id-512" },
    );
    const entryDelivery = await prepareHistoryDelivery(store, "entry-id-512");
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        entryDelivery,
        shortConversationId,
        {
          ...assistantDeliveryEntry(
            shortConversationId,
            entryId512,
            "512-byte entry identity",
          ),
          runId: "entry-boundary-run",
          requestId: "entry-boundary-request",
        },
        entryFingerprint,
      ),
    )).resolves.toMatchObject({
      status: "appended",
      entryId: entryId512,
    });
    const overflowEntryDelivery = await prepareHistoryDelivery(
      store,
      "entry-id-513",
    );
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        overflowEntryDelivery,
        shortConversationId,
        {
          ...assistantDeliveryEntry(
            shortConversationId,
            "j".repeat(513),
            "513-byte entry identity",
          ),
          runId: "entry-overflow-run",
          requestId: "entry-overflow-request",
        },
        entryFingerprint,
      ),
    )).rejects.toThrow(/bounded non-empty string/u);
    const overflowConversationDelivery = await prepareHistoryDelivery(
      store,
      "conversation-4097",
    );
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        overflowConversationDelivery,
        conversation4097,
        assistantDeliveryEntry(
          conversation4097,
          "conversation-4097-entry",
          "too long",
        ),
        fingerprint4096,
      ),
    )).rejects.toThrow(/bounded non-empty string/u);
    const messageBoundConversationId = "message-id-boundary";
    const messageBoundEntry = assistantDeliveryEntry(
      messageBoundConversationId,
      "message-id-boundary-entry",
      "message id",
    );
    const messageBoundFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "message-id-boundary" },
    );
    const messageBoundDelivery = await prepareHistoryDelivery(
      store,
      "message-id-boundary",
    );
    await expect(perform(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        messageBoundDelivery,
        messageBoundConversationId,
        messageBoundEntry,
        messageBoundFingerprint,
        "x".repeat(513),
      ),
    )).rejects.toThrow(/bounded non-empty string/u);
    await expect(perform(store, "conversation.load", {
      conversationId: messageBoundConversationId,
    })).resolves.toBeUndefined();
    await expect(perform(store, "delivery.prepare", {
      idempotencyKey: messageBoundDelivery.idempotencyKey,
      fingerprint: messageBoundDelivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toMatchObject({ status: "join" });
    await expect(perform<ConversationDeliveryAppendResult>(
      store,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        messageBoundDelivery,
        messageBoundConversationId,
        messageBoundEntry,
        messageBoundFingerprint,
        "x".repeat(512),
      ),
    )).resolves.toMatchObject({
      status: "appended",
      messageId: "x".repeat(512),
    });
    await expect(perform(store, "transcript.append", {
      conversationId: conversation4097,
      entries: [],
    })).rejects.toThrow(/bounded non-empty string/u);
    await expect(perform(store, "run.admit", {
      requestId: "conversation-overflow-request",
      conversationId: conversation4097,
      fingerprint: runFingerprint,
      runId: "conversation-overflow-run",
    })).rejects.toThrow(/bounded non-empty string/u);
    await store.close();

    const reopened = await open(config, () => new Date(LATER));
    await expect(perform<ConversationView>(reopened, "conversation.load", {
      conversationId: conversation513,
    })).resolves.toMatchObject({
      conversationId: conversation513,
      transcript: {
        entries: [expect.objectContaining({
          entryId: "conversation-513-entry",
          recordedAt: NOW,
        })],
      },
    });
    await expect(perform<ConversationView>(reopened, "conversation.load", {
      conversationId: conversation4096,
    })).resolves.toMatchObject({
      conversationId: conversation4096,
      transcript: {
        entries: [expect.objectContaining({
          entryId: "conversation-4096-entry",
          recordedAt: NOW,
        })],
      },
    });
    await expect(perform<ConversationDeliveryAppendResult>(
      reopened,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        deliveryIntent4096,
        conversation4096,
        delivery4096,
        fingerprint4096,
      ),
    )).resolves.toMatchObject({
      status: "duplicate",
      conversationId: conversation4096,
      revision: 1,
      entryCount: 1,
    });
    await expect(perform<RunRecord>(reopened, "run.read", {
      runId: "conversation-boundary-run",
    })).resolves.toMatchObject({
      summary: {
        status: "running",
        conversationId: conversation4096,
      },
    });
    await reopened.close();
  });

  it("durably keys provider sessions across the public route-model bounds", async () => {
    const config = await createConfig();
    const store = await open(config, () => new Date(NOW));
    const model513 = "m".repeat(513);
    const model4096 = "n".repeat(4_096);
    const runtime256 = "r".repeat(256);
    const sessionId512 = "s".repeat(512);
    const route4096SessionId = "route-model-4096-session";
    const route513 = {
      runtimeInstanceId: "runtime-model-513",
      model: model513,
    };
    const route4096 = {
      runtimeInstanceId: runtime256,
      model: model4096,
    };

    const persistSession = async (
      suffix: string,
      route: Readonly<{ runtimeInstanceId: string; model: string }>,
      sessionId: string,
    ): Promise<string> => {
      const conversationId = `session-model-${suffix}`;
      const requestId = `session-model-request-${suffix}`;
      const runId = `session-model-run-${suffix}`;
      const fingerprint = await perform<string>(
        store,
        "fingerprint.create",
        { request: suffix },
      );
      await perform(store, "run.admit", {
        requestId,
        conversationId,
        fingerprint,
        runId,
      });
      const transcript = await perform<CanonicalTranscript>(
        store,
        "transcript.append",
        {
          conversationId,
          entries: [{
            kind: "verbatim",
            entryId: `session-model-entry-${suffix}`,
            runId,
            requestId,
            conversationId,
            recordedAt: NOW,
            role: "assistant",
            text: "session boundary",
          }],
        },
      );
      await perform(store, "run.settle", {
        runId,
        requestId,
        status: "completed",
        transcript,
        responseBytes: Buffer.from('{"status":"ok"}', "utf8"),
        session: {
          value: {
            id: sessionId,
            conversationId,
            route,
            createdAt: NOW,
          },
          updatedAt: NOW,
        },
      });
      return conversationId;
    };

    const conversation513 = await persistSession(
      "513",
      route513,
      sessionId512,
    );
    const conversation4096 = await persistSession(
      "4096",
      route4096,
      route4096SessionId,
    );
    await expect(persistSession(
      "session-id-513",
      route513,
      "s".repeat(513),
    )).rejects.toThrow(/bounded non-empty string/u);
    await expect(perform(store, "session.load", {
      conversationId: conversation513,
      route: route513,
    })).resolves.toMatchObject({
      value: {
        id: sessionId512,
        route: route513,
      },
      updatedAt: NOW,
    });
    await expect(perform(store, "session.load", {
      conversationId: conversation4096,
      route: route4096,
    })).resolves.toMatchObject({
      value: {
        id: route4096SessionId,
        route: route4096,
      },
      updatedAt: NOW,
    });
    await expect(perform(store, "session.load", {
      conversationId: conversation4096,
      route: {
        runtimeInstanceId: runtime256,
        model: "x".repeat(4_097),
      },
    })).rejects.toThrow(/at most 4096 UTF-8 bytes/u);
    await expect(perform(store, "session.load", {
      conversationId: conversation4096,
      route: {
        runtimeInstanceId: "r".repeat(257),
        model: model4096,
      },
    })).rejects.toThrow(/between 1 and 256 characters/u);
    expect((await store.scan({
      prefix: "core/sessions/",
      limit: 10,
      signal,
    })).records).toHaveLength(2);
    await store.close();

    const reopened = await open(config, () => new Date(LATER));
    await expect(perform(reopened, "session.load", {
      conversationId: conversation513,
      route: route513,
    })).resolves.toMatchObject({
      value: { id: sessionId512, route: route513 },
      updatedAt: NOW,
    });
    await expect(perform(reopened, "session.load", {
      conversationId: conversation4096,
      route: route4096,
    })).resolves.toMatchObject({
      value: { id: route4096SessionId, route: route4096 },
      updatedAt: NOW,
    });
    await expect(perform(reopened, "session.evict", {
      conversationId: conversation4096,
      route: route4096,
      expected: {
        sessionId: route4096SessionId,
        updatedAt: NOW,
      },
    })).resolves.toBe(true);
    await expect(perform(reopened, "session.load", {
      conversationId: conversation4096,
      route: route4096,
    })).resolves.toBeUndefined();
    await reopened.close();
  });

  it("CAS-converges concurrent first deliveries without losing destination history", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    const first = new StateLocalExecution(store, { clock: () => new Date(NOW) });
    const second = new StateLocalExecution(store, { clock: () => new Date(NOW) });
    const conversationId = "telegram:concurrent-create";
    const fingerprintA = await perform<string>(store, "fingerprint.create", {
      delivery: "concurrent-a",
    });
    const fingerprintB = await perform<string>(store, "fingerprint.create", {
      delivery: "concurrent-b",
    });
    const entryA = assistantDeliveryEntry(
      conversationId,
      "concurrent-entry-a",
      "first",
    );
    const entryB = assistantDeliveryEntry(
      conversationId,
      "concurrent-entry-b",
      "second",
    );
    const deliveryA = await prepareHistoryDelivery(store, "concurrent-a");
    const deliveryB = await prepareHistoryDelivery(store, "concurrent-b");
    const distinct = await Promise.all([
      performExecution<ConversationDeliveryAppendResult>(
        first,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          deliveryA,
          conversationId,
          entryA,
          fingerprintA,
        ),
      ),
      performExecution<ConversationDeliveryAppendResult>(
        second,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          deliveryB,
          conversationId,
          entryB,
          fingerprintB,
        ),
      ),
    ]);
    expect(distinct.map((result) => result.status)).toEqual([
      "appended",
      "appended",
    ]);
    expect(distinct.map((result) =>
      result.status === "conflict" ? 0 : result.revision).sort()).toEqual([1, 2]);
    const loaded = await perform<ConversationView>(store, "conversation.load", {
      conversationId,
    });
    expect(loaded.transcript.revision).toBe(2);
    expect(loaded.transcript.entries.map((entry) => entry.entryId).sort()).toEqual([
      "concurrent-entry-a",
      "concurrent-entry-b",
    ]);

    const duplicateConversationId = "telegram:concurrent-duplicate";
    const duplicateEntry = assistantDeliveryEntry(
      duplicateConversationId,
      "concurrent-same-entry",
      "same",
    );
    const duplicateFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "concurrent-same" },
    );
    const duplicateDelivery = await prepareHistoryDelivery(
      store,
      "concurrent-same",
    );
    const duplicates = await Promise.all([
      performExecution<ConversationDeliveryAppendResult>(
        first,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          duplicateDelivery,
          duplicateConversationId,
          duplicateEntry,
          duplicateFingerprint,
        ),
      ),
      performExecution<ConversationDeliveryAppendResult>(
        second,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          duplicateDelivery,
          duplicateConversationId,
          duplicateEntry,
          duplicateFingerprint,
        ),
      ),
    ]);
    expect(duplicates.map((result) => result.status).sort()).toEqual([
      "appended",
      "duplicate",
    ]);
    expect((await perform<ConversationView>(store, "conversation.load", {
      conversationId: duplicateConversationId,
    })).transcript.entries).toHaveLength(1);

    const conflictConversationId = "telegram:concurrent-conflict";
    const conflictFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "concurrent-conflict" },
    );
    const conflictDelivery = await prepareHistoryDelivery(
      store,
      "concurrent-conflict",
    );
    const conflicts = await Promise.all([
      performExecution<ConversationDeliveryAppendResult>(
        first,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          conflictDelivery,
          conflictConversationId,
          assistantDeliveryEntry(
            conflictConversationId,
            "concurrent-conflict-entry",
            "left",
          ),
          conflictFingerprint,
        ),
      ),
      performExecution<ConversationDeliveryAppendResult>(
        second,
        "delivery.settle-with-history",
        deliveryHistoryInput(
          conflictDelivery,
          conflictConversationId,
          assistantDeliveryEntry(
            conflictConversationId,
            "concurrent-conflict-entry",
            "right",
          ),
          conflictFingerprint,
        ),
      ),
    ]);
    expect(conflicts.map((result) => result.status).sort()).toEqual([
      "appended",
      "conflict",
    ]);
    expect((await perform<ConversationView>(store, "conversation.load", {
      conversationId: conflictConversationId,
    })).transcript.entries).toHaveLength(1);
    await store.close();
  });

  it("recovers atomic delivery settlement and history at both snapshot crash boundaries", async () => {
    const committedConfig = await createConfig();
    const committedConversationId = "external:post-commit";
    const committedEntry = assistantDeliveryEntry(
      committedConversationId,
      "post-commit-entry",
      "committed",
    );
    const committedSetup = await open(
      committedConfig,
      () => new Date(NOW),
    );
    const committedFingerprint = await perform<string>(
      committedSetup,
      "fingerprint.create",
      { delivery: "post-commit" },
    );
    const committedDelivery = await prepareHistoryDelivery(
      committedSetup,
      "post-commit",
    );
    await committedSetup.close();

    let crashAfterCommit = true;
    const uncertain = await StateLocalStore.open(committedConfig, {
      instanceId: "execution-delivery-uncertain-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          afterRename: () => {
            if (!crashAfterCommit) return;
            crashAfterCommit = false;
            throw new Error("simulated crash after delivery append");
          },
        },
      },
    });
    await expect(perform(
      uncertain,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        committedDelivery,
        committedConversationId,
        committedEntry,
        committedFingerprint,
      ),
    )).rejects.toMatchObject({ code: "STATE_POISONED" });
    await uncertain.close();

    const recovered = await open(committedConfig, () => new Date(NOW));
    await expect(perform<ConversationDeliveryAppendResult>(
      recovered,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        committedDelivery,
        committedConversationId,
        committedEntry,
        committedFingerprint,
      ),
    )).resolves.toMatchObject({
      status: "duplicate",
      revision: 1,
      entryCount: 1,
    });
    await expect(perform(recovered, "delivery.prepare", {
      idempotencyKey: committedDelivery.idempotencyKey,
      fingerprint: committedDelivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toEqual({ status: "duplicate" });
    expect((await perform<ConversationView>(recovered, "conversation.load", {
      conversationId: committedConversationId,
    })).transcript.entries).toHaveLength(1);
    await recovered.close();

    const rejectedConfig = await createConfig();
    const rejectedConversationId = "external:pre-commit";
    const rejectedEntry = assistantDeliveryEntry(
      rejectedConversationId,
      "pre-commit-entry",
      "not committed",
    );
    const rejectedSetup = await open(rejectedConfig, () => new Date(NOW));
    const rejectedFingerprint = await perform<string>(
      rejectedSetup,
      "fingerprint.create",
      { delivery: "pre-commit" },
    );
    const rejectedDelivery = await prepareHistoryDelivery(
      rejectedSetup,
      "pre-commit",
    );
    await rejectedSetup.close();

    let crashBeforeCommit = true;
    const rejected = await StateLocalStore.open(rejectedConfig, {
      instanceId: "execution-delivery-rejected-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          beforeRename: () => {
            if (!crashBeforeCommit) return;
            crashBeforeCommit = false;
            throw new Error("simulated crash before delivery append");
          },
        },
      },
    });
    await expect(perform(
      rejected,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        rejectedDelivery,
        rejectedConversationId,
        rejectedEntry,
        rejectedFingerprint,
      ),
    )).rejects.toMatchObject({ code: "STATE_POISONED" });
    await rejected.close();

    const clean = await open(rejectedConfig, () => new Date(LATER));
    await expect(perform(clean, "conversation.load", {
      conversationId: rejectedConversationId,
    })).resolves.toBeUndefined();
    expect((await clean.scan({
      prefix: "core/conversation-delivery-entries/",
      limit: 10,
      signal,
    })).records).toHaveLength(0);
    await expect(perform(clean, "delivery.prepare", {
      idempotencyKey: rejectedDelivery.idempotencyKey,
      fingerprint: rejectedDelivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toEqual({
      status: "unknown",
      code: "stale-delivery-intent",
    });
    await expect(perform<ConversationDeliveryAppendResult>(
      clean,
      "delivery.settle-with-history",
      deliveryHistoryInput(
        rejectedDelivery,
        rejectedConversationId,
        rejectedEntry,
        rejectedFingerprint,
      ),
    )).resolves.toEqual({
      status: "conflict",
      conversationId: rejectedConversationId,
      entryId: "pre-commit-entry",
    });
    await expect(perform(clean, "delivery.prepare", {
      idempotencyKey: rejectedDelivery.idempotencyKey,
      fingerprint: rejectedDelivery.fingerprint,
      channelInstanceId: "history-channel",
    })).resolves.toEqual({
      status: "unknown",
      code: "stale-delivery-intent",
    });
    await expect(perform(clean, "conversation.load", {
      conversationId: rejectedConversationId,
    })).resolves.toBeUndefined();
    expect((await clean.scan({
      prefix: "core/conversation-delivery-entries/",
      limit: 10,
      signal,
    })).records).toHaveLength(0);
    await clean.close();
  });

  it("atomically persists a Core-limit proactive seed as restart-safe transcript chunks", async () => {
    const config = await createConfig();
    const initialText = "🙂".repeat((1024 * 1024) / 4);
    expect(Buffer.byteLength(initialText, "utf8")).toBe(1024 * 1024);
    const first = await open(config, () => new Date(NOW));
    const opened = await perform<ConversationView>(first, "conversation.open", {
      title: "Near-limit seed",
      initialText,
    });
    const initialChunks = await first.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    });
    expect(initialChunks.records.length).toBeGreaterThan(1);
    expect(initialChunks.records.every((record) =>
      record.value.byteLength <= 256 * 1024)).toBe(true);
    await first.close();

    const second = await open(config, () => new Date(NOW));
    const reloaded = await perform<ConversationView>(second, "conversation.load", {
      conversationId: opened.conversationId,
    });
    expect(reloaded.transcript.entries).toEqual([expect.objectContaining({
      kind: "verbatim",
      role: "assistant",
      text: initialText,
    })]);

    const fingerprint = await perform<string>(second, "fingerprint.create", {
      request: "continue-near-limit-seed",
    });
    await perform(second, "run.admit", {
      requestId: "continue-near-limit-seed",
      conversationId: opened.conversationId,
      fingerprint,
      runId: "near-limit-run",
    });
    const settledTranscript = await perform<CanonicalTranscript>(
      second,
      "transcript.append",
      {
        current: reloaded.transcript,
        conversationId: opened.conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "near-limit-assistant",
          runId: "near-limit-run",
          requestId: "continue-near-limit-seed",
          conversationId: opened.conversationId,
          recordedAt: NOW,
          role: "assistant",
          text: "continued",
        }],
      },
    );
    await perform(second, "run.settle", {
      runId: "near-limit-run",
      requestId: "continue-near-limit-seed",
      status: "completed",
      transcript: settledTranscript,
      responseBytes: Buffer.from('{"status":"ok"}', "utf8"),
    });
    expect((await second.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records).toHaveLength(0);
    await second.close();

    const third = await open(config, () => new Date(NOW));
    const settledReload = await perform<ConversationView>(third, "conversation.load", {
      conversationId: opened.conversationId,
    });
    expect(settledReload.transcript.entries).toEqual([
      expect.objectContaining({ text: initialText }),
      expect.objectContaining({ text: "continued" }),
    ]);
    await third.close();
  });

  it("recovers all chunks after an uncertain commit and none after a pre-commit crash", async () => {
    const initialText = "x".repeat(1024 * 1024);
    const committedConfig = await createConfig();
    let crashAfterCommit = true;
    const uncertain = await StateLocalStore.open(committedConfig, {
      instanceId: "execution-open-uncertain-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          afterRename: () => {
            if (!crashAfterCommit) return;
            crashAfterCommit = false;
            throw new Error("simulated crash after conversation commit");
          },
        },
      },
    });
    await expect(perform(uncertain, "conversation.open", { initialText }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await uncertain.close();

    const recovered = await open(committedConfig, () => new Date(NOW));
    const recoveredList = await perform<{
      readonly conversations: readonly { readonly conversationId: string }[];
    }>(recovered, "conversation.list");
    expect(recoveredList.conversations).toHaveLength(1);
    const recoveredConversation = await perform<ConversationView>(
      recovered,
      "conversation.load",
      { conversationId: recoveredList.conversations[0]!.conversationId },
    );
    expect(recoveredConversation.transcript.entries).toEqual([
      expect.objectContaining({ text: initialText }),
    ]);
    expect((await recovered.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records.length).toBeGreaterThan(1);
    await recovered.close();

    const rejectedConfig = await createConfig();
    let crashBeforeCommit = true;
    const rejected = await StateLocalStore.open(rejectedConfig, {
      instanceId: "execution-open-rejected-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          beforeRename: () => {
            if (!crashBeforeCommit) return;
            crashBeforeCommit = false;
            throw new Error("simulated crash before conversation commit");
          },
        },
      },
    });
    await expect(perform(rejected, "conversation.open", { initialText }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await rejected.close();

    const clean = await open(rejectedConfig, () => new Date(NOW));
    expect(await perform(clean, "conversation.list")).toEqual({
      conversations: [],
    });
    expect((await clean.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records).toHaveLength(0);
    await clean.close();
  });

  it("records complete runs and crash-resumes terminal retention without touching running work", async () => {
    const config = await createConfig();
    let now = OLD;
    let crashRelease = true;
    const store = await StateLocalStore.open(config, {
      instanceId: "execution-retention-test",
      signal,
      clock: () => new Date(now),
      hooks: {
        artifacts: {
          afterOrphanClaim: () => {
            if (!crashRelease) return;
            crashRelease = false;
            throw new Error("crash during published release");
          },
        },
      },
    });
    const conversationId = "conversation-1";
    const route = { runtimeInstanceId: "runtime-1", model: "model-1" };
    const fingerprint = await perform<string>(store, "fingerprint.create", {
      request: "terminal",
    });
    const admitted = await perform<AdmissionResult>(store, "run.admit", {
      requestId: "request-terminal",
      conversationId,
      fingerprint,
      runId: "run-terminal",
    });
    expect(admitted.status).toBe("accepted");

    await perform(store, "run.record-attempt", {
      runId: "run-terminal",
      attempt: {
        attempt: 1,
        route,
        status: "completed",
        startedAt: OLD,
        endedAt: OLD,
      },
    });
    const transcript = await perform<CanonicalTranscript>(
      store,
      "transcript.append",
      {
        conversationId,
        entries: [
          {
            kind: "verbatim",
            entryId: "terminal-user",
            runId: "run-terminal",
            requestId: "request-terminal",
            conversationId,
            recordedAt: OLD,
            role: "user",
            text: "hello",
          },
          {
            kind: "verbatim",
            entryId: "terminal-assistant",
            runId: "run-terminal",
            requestId: "request-terminal",
            conversationId,
            recordedAt: OLD,
            role: "assistant",
            text: "world",
          },
        ],
      },
    );
    const responseBytes = Buffer.from('{"status":"ok"}', "utf8");
    await perform(store, "run.settle", {
      runId: "run-terminal",
      requestId: "request-terminal",
      status: "completed",
      transcript,
      responseBytes,
      session: {
        value: {
          id: "session-1",
          conversationId,
          route,
          createdAt: OLD,
        },
        updatedAt: OLD,
      },
    });
    expect(await perform(store, "session.load", {
      conversationId,
      route,
    })).toMatchObject({ value: { id: "session-1" }, updatedAt: OLD });

    const cached = await perform<AdmissionResult>(store, "run.admit", {
      requestId: "request-terminal",
      conversationId,
      fingerprint,
    });
    if (cached.status !== "cached" || cached.responseRef === undefined) {
      throw new Error("Expected a cached terminal admission with a response ref.");
    }
    expect(await store.deleteArtifact({ ref: cached.responseRef, signal })).toBe(false);

    const deliveryFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "one" },
    );
    const delivery = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "delivery-1",
      fingerprint: deliveryFingerprint,
      channelInstanceId: "channel-1",
      runId: "run-terminal",
    });
    if (delivery.status !== "send") throw new Error("Expected a delivery send intent.");
    await perform(store, "delivery.settle", {
      idempotencyKey: "delivery-1",
      fingerprint: deliveryFingerprint,
      attempt: delivery.attempt,
      token: delivery.token,
      status: "delivered",
      messageId: "message-1",
    });

    const runningFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { request: "running" },
    );
    await perform(store, "run.admit", {
      requestId: "request-running",
      conversationId,
      fingerprint: runningFingerprint,
      runId: "run-running",
    });
    const staged = await perform<readonly {
      readonly slot: string;
      readonly ref: ArtifactRefLike;
    }[]>(store, "run.stage-artifacts", {
      runId: "run-running",
      requestId: "request-running",
      artifacts: [{
        slot: "live-output",
        data: Buffer.from("still referenced by a running intent", "utf8"),
        mediaType: "text/plain",
      }],
    });
    expect(staged).toHaveLength(1);

    now = NOW;
    const first = await store.maintain({ limit: 100, signal });
    expect(first).toMatchObject({
      terminalRunCandidates: 1,
      terminalRunsRemoved: 0,
      terminalDeliveryCandidates: 0,
      terminalDeliveriesRemoved: 0,
      staleSessionsRemoved: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    expect(await perform(store, "run.read", { runId: "run-terminal" })).toBeUndefined();
    const second = await store.maintain({ limit: 100, signal });
    expect(second.runEventsRemoved).toBe(3);
    const third = await store.maintain({ limit: 100, signal });
    expect(third).toMatchObject({
      terminalRunsRemoved: 1,
      terminalAdmissionsRemoved: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    await expect(store.maintain({ limit: 100, signal }))
      .rejects.toThrow("crash during published release");
    await store.close();

    const reopened = await open(config, () => new Date(NOW));
    const resumed = await reopened.maintain({ limit: 100, signal });
    expect(resumed).toMatchObject({
      publishedArtifactsReleased: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    await expect(reopened.readArtifact({
      ref: cached.responseRef,
      maxBytes: responseBytes.byteLength,
      signal,
    })).rejects.toMatchObject({ code: "STATE_ARTIFACT_NOT_FOUND" });
    expect(await perform(reopened, "run.read", { runId: "run-terminal" })).toBeUndefined();
    expect(await perform(reopened, "session.load", {
      conversationId,
      route,
    })).toBeUndefined();
    expect(await perform<RunRecord>(reopened, "run.read", {
      runId: "run-running",
    })).toMatchObject({ summary: { status: "running" } });
    expect(await perform<{
      readonly runs: readonly { readonly runId: string }[];
    }>(reopened, "run.list")).toMatchObject({
      runs: [{ runId: "run-running" }],
    });
    expect(await perform(reopened, "conversation.load", {
      conversationId,
    })).toMatchObject({
      transcript: { entries: expect.arrayContaining([
        expect.objectContaining({ text: "world" }),
      ]) },
    });
    expect(await perform(reopened, "artifact-publications.reconcile", {
      limit: 10,
    })).toMatchObject({
      skippedActive: 1,
      deletedArtifacts: 0,
    });
    expect(await reopened.deleteArtifact({ ref: staged[0]!.ref, signal })).toBe(false);
    expect((await reopened.listArtifacts({ limit: 10, signal })).artifacts)
      .toHaveLength(2);
    await reopened.close();
  });

  it("preserves delivered and unknown idempotency authority across retention and restart", async () => {
    const config = await createConfig();
    let now = OLD;
    const store = await open(config, () => new Date(now));
    const deliveredFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { destination: "delivered" },
    );
    const unknownFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { destination: "unknown" },
    );
    const delivered = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      channelInstanceId: "channel-1",
    });
    const unknown = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      channelInstanceId: "channel-1",
    });
    if (delivered.status !== "send" || unknown.status !== "send") {
      throw new Error("Expected fresh delivery intents.");
    }
    await perform(store, "delivery.settle", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      attempt: delivered.attempt,
      token: delivered.token,
      status: "delivered",
      messageId: "message-1",
    });
    await perform(store, "delivery.settle", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      attempt: unknown.attempt,
      token: unknown.token,
      status: "unknown",
      code: "transport-outcome-unknown",
    });

    now = NOW;
    await expect(store.maintain({ limit: 100, signal })).resolves.toMatchObject({
      terminalDeliveryCandidates: 0,
      terminalDeliveriesRemoved: 0,
    });
    await store.close();

    const reopened = await open(config, () => new Date(NOW));
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({ status: "duplicate", messageId: "message-1" });
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({
      status: "unknown",
      code: "transport-outcome-unknown",
    });
    const conflictingFingerprint = await perform<string>(
      reopened,
      "fingerprint.create",
      { destination: "different" },
    );
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: conflictingFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({ status: "conflict" });
    await reopened.close();
  });

  it("never grants private release authority to a legacy published artifact row", async () => {
    const config = await createConfig();
    const writer = await open(config, () => new Date(OLD));
    const conversationId = "legacy-conversation";
    const fingerprint = await perform<string>(writer, "fingerprint.create", {
      request: "legacy",
    });
    await perform(writer, "run.admit", {
      requestId: "legacy-request",
      conversationId,
      fingerprint,
      runId: "legacy-run",
    });
    const transcript = await perform<CanonicalTranscript>(
      writer,
      "transcript.append",
      {
        conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "legacy-entry",
          runId: "legacy-run",
          requestId: "legacy-request",
          conversationId,
          recordedAt: OLD,
          role: "assistant",
          text: "legacy",
        }],
      },
    );
    const responseBytes = Buffer.from("legacy response", "utf8");
    await perform(writer, "run.settle", {
      runId: "legacy-run",
      requestId: "legacy-request",
      status: "completed",
      transcript,
      responseBytes,
    });
    const cached = await perform<AdmissionResult>(writer, "run.admit", {
      requestId: "legacy-request",
      conversationId,
      fingerprint,
    });
    if (cached.status !== "cached" || cached.responseRef === undefined) {
      throw new Error("Expected a cached legacy response reference.");
    }
    await writer.close();

    const artifactDirectory = config.runs?.artifactsDirectory;
    if (artifactDirectory === undefined) throw new Error("Expected an artifact directory.");
    const lease = await acquireProcessLease(
      join(artifactDirectory, ".mono-agent-artifacts.lease.sqlite"),
    );
    try {
      const digest = cached.responseRef.sha256.slice("sha256:".length);
      const key = `artifact:${digest}`;
      const encoded = lease.readIndex(key, 2_048);
      if (encoded === undefined) throw new Error("Expected a v2 artifact index row.");
      const current = JSON.parse(encoded.toString("utf8")) as {
        readonly storageName?: unknown;
      };
      if (typeof current.storageName !== "string") {
        throw new Error("Expected a v2 artifact storage name.");
      }
      lease.writeIndex(
        key,
        Buffer.from(`${JSON.stringify({
          digest,
          sizeBytes: responseBytes.byteLength,
          storageName: current.storageName,
        })}\n`, "utf8"),
      );
    } finally {
      await lease.release();
    }

    const retained = await open(config, () => new Date(NOW));
    await retained.maintain({ limit: 100, signal });
    await retained.maintain({ limit: 100, signal });
    await retained.maintain({ limit: 100, signal });
    const releasePass = await retained.maintain({ limit: 100, signal });
    expect(releasePass).toMatchObject({
      publishedArtifactsReleased: 0,
      pendingRunRetentionCheckpoints: 1,
    });
    expect(Buffer.from(await retained.readArtifact({
      ref: cached.responseRef,
      maxBytes: responseBytes.byteLength,
      signal,
    }))).toEqual(responseBytes);
    await retained.close();
  });
});

interface ArtifactRefLike {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

interface CanonicalTranscript {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.canonical-transcript";
  readonly conversationId: string;
  readonly revision: number;
  readonly entries: readonly Record<string, unknown>[];
}

interface ConversationView {
  readonly conversationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transcript: CanonicalTranscript;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type ConversationDeliveryAppendResult =
  | {
      readonly status: "appended" | "duplicate";
      readonly conversationId: string;
      readonly entryId: string;
      readonly revision: number;
      readonly entryCount: number;
      readonly messageId?: string;
    }
  | {
      readonly status: "conflict";
      readonly conversationId: string;
      readonly entryId: string;
    };

type AdmissionResult =
  | { readonly status: "accepted"; readonly summary: { readonly runId: string } }
  | {
      readonly status: "cached";
      readonly responseRef?: ArtifactRefLike;
    }
  | { readonly status: "join" | "conflict" | "uncertain" };

type DeliveryResult =
  | {
      readonly status: "send";
      readonly attempt: number;
      readonly token: string;
    }
  | {
      readonly status: "join" | "duplicate" | "conflict" | "unknown";
    };

interface PreparedHistoryDelivery {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly attempt: number;
  readonly token: string;
}

interface RunRecord {
  readonly summary: {
    readonly status: string;
    readonly conversationId: string;
  };
}

async function perform<T = unknown>(
  store: StateLocalStore,
  operation: string,
  input?: unknown,
): Promise<T> {
  return await store.execution.perform({
    operation,
    ...(input === undefined ? {} : { input }),
    signal,
  }) as T;
}

async function performExecution<T = unknown>(
  execution: StateLocalExecution,
  operation: string,
  input?: unknown,
): Promise<T> {
  return await execution.perform({
    operation,
    ...(input === undefined ? {} : { input }),
    signal,
  }) as T;
}

async function prepareHistoryDelivery(
  store: StateLocalStore,
  suffix: string,
): Promise<PreparedHistoryDelivery> {
  const idempotencyKey = `history-delivery:${suffix}`;
  const fingerprint = await perform<string>(
    store,
    "fingerprint.create",
    { transportDelivery: suffix },
  );
  const intent = await perform<DeliveryResult>(store, "delivery.prepare", {
    idempotencyKey,
    fingerprint,
    channelInstanceId: "history-channel",
  });
  if (intent.status !== "send") {
    throw new Error("Expected a fresh history delivery intent.");
  }
  return Object.freeze({
    idempotencyKey,
    fingerprint,
    attempt: intent.attempt,
    token: intent.token,
  });
}

function deliveryHistoryInput(
  delivery: PreparedHistoryDelivery,
  conversationId: string,
  entry: Readonly<Record<string, unknown>>,
  entryFingerprint: string,
  messageId?: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...delivery,
    conversationId,
    entry,
    entryFingerprint,
    ...(messageId === undefined ? {} : { messageId }),
  });
}

function assistantDeliveryEntry(
  conversationId: string,
  entryId: string,
  text: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "verbatim",
    entryId,
    runId: `delivery:${entryId}`,
    requestId: `delivery:${entryId}`,
    conversationId,
    role: "assistant",
    text,
  });
}

async function createConfig(): Promise<ResolvedStateLocalConfig> {
  const parent = await mkdtemp(join(tmpdir(), "mono-agent-state-execution-"));
  roots.push(parent);
  const root = join(parent, "state");
  return {
    root,
    maxRecordBytes: 1024 * 1024,
    maxRecords: 10_000,
    maxTotalBytes: 64 * 1024 * 1024,
    runs: {
      artifactsDirectory: join(root, "artifacts"),
      retentionDays: 1,
    },
  };
}

function open(
  config: ResolvedStateLocalConfig,
  clock: () => Date,
): Promise<StateLocalStore> {
  return StateLocalStore.open(config, {
    instanceId: "execution-test",
    signal,
    clock,
  });
}
