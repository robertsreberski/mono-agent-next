import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WebAgentSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function agent(sourceId = "agent-one", supportsAttachments = true): WebAgentSummary {
  return {
    sourceId,
    label: sourceId,
    status: "online",
    health: "running",
    supportsAttachments,
    models: ["provider/default"],
    defaultModel: "provider/default",
    efforts: ["low", "high"],
    modelOptions: { "provider/default": { effortLevels: ["low", "high"] } },
    updatedAt: "2026-07-17T09:00:00.000Z",
  };
}

describe("WebStore", () => {
  it("persists agent pins independently of discovery and sorts pinned agents first", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent("alpha"), agent("zulu")]);

    expect(store.listAgents().map(({ sourceId, pinned }) => ({ sourceId, pinned }))).toEqual([
      { sourceId: "alpha", pinned: false },
      { sourceId: "zulu", pinned: false },
    ]);
    expect(store.setAgentPinned("zulu", true)).toMatchObject({ sourceId: "zulu", pinned: true });
    store.replaceAgents([agent("alpha")]);
    expect(store.listAgents()[0]).toMatchObject({
      sourceId: "zulu",
      pinned: true,
      status: "offline",
    });
    store.replaceAgents([agent("zulu"), agent("alpha")]);
    expect(store.listAgents().map(({ sourceId, pinned }) => ({ sourceId, pinned }))).toEqual([
      { sourceId: "zulu", pinned: true },
      { sourceId: "alpha", pinned: false },
    ]);
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.listAgents()[0]).toMatchObject({ sourceId: "zulu", pinned: true });
    expect(reopened.setAgentPinned("zulu", false)).toMatchObject({ sourceId: "zulu", pinned: false });
    expect(() => reopened.setAgentPinned("missing", true)).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    reopened.close();
  });

  it("persists permanently agent-bound threads, structured messages, and archive state", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const created = store.createThread("agent-one");

    const turn = store.beginTurn({
      threadId: created.id,
      text: "First prompt for the title",
      attachmentIds: [],
      model: "provider/default",
      effort: "high",
    });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "Answer" },
      { kind: "event", event: { type: "assistant_thought", text: "Think" } },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "event", event: { type: "tool_call_completed", id: "tool-1", name: "Search", content: "done" } },
    ]);
    const detail = store.completeTurn(turn.turnId, "Final answer");

    expect(detail.thread.sourceId).toBe("agent-one");
    expect(detail.thread.title).toBe("First prompt for the title");
    expect(detail.thread.runState).toMatchObject({ status: "complete", model: "provider/default", effort: "high" });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.parts).toEqual([
      { type: "text", text: "Final answer" },
      { type: "reasoning", text: "Think" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "Search", args: { q: "x" }, result: "done", status: "complete" },
    ]);

    const archived = store.patchThread(created.id, { archived: true });
    expect(archived.archivedAt).toMatch(/^\d{4}-/u);
    expect(() => store.beginTurn({ threadId: created.id, text: "no", attachmentIds: [] })).toThrowError(/Unarchive/u);
    expect(store.patchThread(created.id, { archived: false }).sourceId).toBe("agent-one");
    store.close();
  });

  it("projects synthetic steering events as one completed Steered tool row", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });

    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "tool_call_started",
          id: "live-input:follow-up-1",
          name: "↪️ Steered: “Use the API instead”",
          metadata: { liveInput: true, synthetic: true },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_completed",
          id: "live-input:follow-up-1",
          name: "↪️ Steered: “Use the API instead”",
          content: "Applied to current run",
          metadata: { liveInput: true, synthetic: true },
        },
      },
    ]);
    const detail = store.completeTurn(turn.turnId, "done");
    const tool = detail.messages.at(-1)?.parts.find((part) => part.type === "tool-call");

    expect(tool).toEqual({
      type: "tool-call",
      toolCallId: "live-input:follow-up-1",
      toolName: "↪️ Steered: “Use the API instead”",
      result: "Applied to current run",
      status: "complete",
    });
    store.close();
  });

  it("deletes only archived threads, removes attachment files, and sweeps crash orphans", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.selectThread(thread.id);
    await expect(store.deleteArchivedThread(thread.id)).rejects.toMatchObject({ code: "thread_not_archived" });

    const attachment = store.createUpload({
      name: "notes.txt",
      contentType: "text/plain",
      kind: "document",
      declaredSize: 5,
    });
    const attachmentPath = store.attachmentPath(attachment);
    await writeFile(attachmentPath, "hello", { mode: 0o600 });
    store.markUploadComplete(attachment.id, 5);
    const turn = store.beginTurn({ threadId: thread.id, text: "", attachmentIds: [attachment.id] });
    store.completeTurn(turn.turnId, "done");
    store.patchThread(thread.id, { archived: true });

    await expect(store.deleteArchivedThread(thread.id)).resolves.toEqual({ orphanedFiles: 0 });
    expect(store.getThread(thread.id)).toBeUndefined();
    expect(store.getStoredAttachment(attachment.id)).toBeUndefined();
    expect(store.currentThreadId()).toBeUndefined();
    await expect(lstat(attachmentPath)).rejects.toMatchObject({ code: "ENOENT" });

    const orphan = join(store.paths.uploads, "11111111-1111-4111-8111-111111111111.bin");
    await writeFile(orphan, "orphan", { mode: 0o600 });
    await expect(store.purgeUnreferencedAttachmentFiles()).resolves.toBe(1);
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
  });

  it("enforces one active turn per thread while allowing parallel threads", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const one = store.createThread("agent-one");
    const two = store.createThread("agent-one");
    const first = store.beginTurn({ threadId: one.id, text: "one", attachmentIds: [] });
    expect(() => store.beginTurn({ threadId: one.id, text: "again", attachmentIds: [] })).toThrowError(/active turn/u);
    expect(store.beginTurn({ threadId: two.id, text: "parallel", attachmentIds: [] }).turnId).toBeTruthy();
    store.interruptTurn(first.turnId);
    store.close();
  });

  it("persists live follow-ups on the active turn and marks provider acknowledgement", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({
      threadId: thread.id,
      text: "Initial request",
      attachmentIds: [],
      model: "provider/default",
      effort: "high",
    });

    const reserved = store.reserveLiveInput(thread.id, "Use the second approach");
    expect(reserved).toMatchObject({
      offered: true,
      input: { status: "offered", text: "Use the second approach" },
      message: { turnId: turn.turnId, liveInputStatus: "pending" },
    });
    expect(store.markLiveInputApplied(reserved.input.id)).toMatchObject({
      id: reserved.message.id,
      liveInputStatus: "applied",
    });
    expect(store.queuedLiveInputThreadIds()).toEqual([]);
    store.completeTurn(turn.turnId, "Applied");

    const detail = store.getThreadDetail(thread.id);
    expect(detail?.messages.map((message) => [message.role, message.liveInputStatus])).toEqual([
      ["user", undefined],
      ["user", "applied"],
      ["assistant", undefined],
    ]);
    store.close();
  });

  it("promotes a queued follow-up into the next durable turn", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const reserved = store.reserveLiveInput(thread.id, "Run after the current work");
    expect(reserved).toMatchObject({ offered: false, message: { liveInputStatus: "queued" } });

    const promoted = store.promoteNextQueuedLiveInput(thread.id);
    expect(promoted).toMatchObject({ text: "Run after the current work", userMessageId: reserved.message.id });
    expect(store.getThreadDetail(thread.id)?.messages).toEqual([
      expect.objectContaining({
        id: reserved.message.id,
        role: "user",
        turnId: promoted?.turnId,
        parts: [{ type: "text", text: "Run after the current work" }],
      }),
      expect.objectContaining({ role: "assistant", status: "running" }),
    ]);
    if (promoted !== undefined) store.completeTurn(promoted.turnId, "Done");
    store.close();
  });

  it("recovers an unsettled live follow-up as queued after restart", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.beginTurn({ threadId: thread.id, text: "Still running", attachmentIds: [] });
    const live = store.reserveLiveInput(thread.id, "Do not lose this");
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(thread.id)?.runState.status).toBe("interrupted");
    expect(reopened.getThreadDetail(thread.id)?.messages.find((message) => message.id === live.message.id))
      .toMatchObject({ liveInputStatus: "queued", parts: [{ type: "text", text: "Do not lose this" }] });
    expect(reopened.queuedLiveInputThreadIds()).toEqual([thread.id]);
    reopened.close();
  });

  it("persists quote metadata without exposing its storage telemetry as message content", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const otherThread = store.createThread("agent-one");
    const first = store.beginTurn({ threadId: thread.id, text: "Source prompt", attachmentIds: [] });
    store.completeTurn(first.turnId, "A source response");
    const other = store.beginTurn({ threadId: otherThread.id, text: "Other", attachmentIds: [] });
    store.completeTurn(other.turnId, "Other response");

    const quoted = store.beginTurn({
      threadId: thread.id,
      text: "Please expand on this.",
      attachmentIds: [],
      quote: { text: "source response", messageId: first.assistantMessageId },
    });
    const userMessage = store.getThreadDetail(thread.id)?.messages.at(-2);
    expect(quoted.quote).toEqual({
      text: "source response",
      messageId: first.assistantMessageId,
    });
    expect(userMessage).toMatchObject({
      quote: { text: "source response", messageId: first.assistantMessageId },
      parts: [{ type: "text", text: "Please expand on this." }],
    });
    expect(() => store.beginTurn({
      threadId: otherThread.id,
      text: "Cross-thread quote",
      attachmentIds: [],
      quote: { text: "source response", messageId: first.assistantMessageId },
    })).toThrowError(expect.objectContaining({ code: "invalid_quote" }));
    store.interruptTurn(quoted.turnId);
    store.close();

    const reopened = await WebStore.open({ stateDir: join(base, "state") });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-2)).toMatchObject({
      quote: { text: "source response", messageId: first.assistantMessageId },
      parts: [{ type: "text", text: "Please expand on this." }],
    });
    reopened.close();
  });

  it("recovers running turns as interrupted after an unclean restart", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    store.beginTurn({ threadId: thread.id, text: "unfinished", attachmentIds: [] });
    store.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(thread.id)?.runState).toMatchObject({ status: "interrupted", error: { code: "interrupted" } });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.status).toBe("interrupted");
    reopened.close();
  });

  it("commits ready staged attachments to the user message and never purges them", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const committed = store.createUpload({ name: "notes.txt", contentType: "text/plain", kind: "document", declaredSize: 5 });
    await writeFile(store.attachmentPath(committed), "hello", { mode: 0o600 });
    store.markUploadComplete(committed.id, 5);
    const staged = store.createUpload({ name: "stale.txt", contentType: "text/plain", kind: "document", declaredSize: 1 });

    const turn = store.beginTurn({ threadId: thread.id, text: "", attachmentIds: [committed.id] });
    expect(store.getThreadDetail(thread.id)?.messages[0]?.attachments[0]).toMatchObject({ name: "notes.txt", status: "committed", uploaded: true });
    expect(store.getStoredAttachment(committed.id)?.threadId).toBe(thread.id);
    expect(await store.purgeStagedAttachments("9999-01-01T00:00:00.000Z")).toBe(1);
    expect(store.getStoredAttachment(staged.id)).toBeUndefined();
    expect(store.getStoredAttachment(committed.id)).toBeDefined();
    store.interruptTurn(turn.turnId);
    store.close();
  });

  it("disables sends when the bound agent goes offline and uploads for legacy agents", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent("legacy", false)]);
    const thread = store.createThread("legacy");
    expect(store.getThread(thread.id)).toMatchObject({ canSend: true, canUpload: false });

    store.replaceAgents([]);
    expect(store.getThread(thread.id)).toMatchObject({ canSend: false, canUpload: false, sourceId: "legacy" });
    expect(() => store.beginTurn({ threadId: thread.id, text: "offline", attachmentIds: [] })).toThrowError(/offline/u);
    store.close();
  });

  it("keeps staged rows recoverable when file removal fails", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    const attachment = store.createUpload({ name: "keep.txt", contentType: "text/plain", kind: "document", declaredSize: 4 });
    await writeFile(store.attachmentPath(attachment), "keep", { mode: 0o600 });
    await chmod(store.paths.uploads, 0o500);
    try {
      await expect(store.removeStagedAttachment(attachment.id)).rejects.toBeDefined();
      expect(store.getStoredAttachment(attachment.id)).toBeDefined();
    } finally {
      await chmod(store.paths.uploads, 0o700);
    }
    await expect(store.removeStagedAttachment(attachment.id)).resolves.toBeUndefined();
    store.close();
  });

  it("maps warnings/failover/usage and persists runtime telemetry payloads", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "telemetry", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "event", event: { type: "runtime_warning", message: "fallback", warningKind: "provider" } },
      { kind: "event", event: { type: "provider_status", kind: "failover_started", from: "one", to: "two" } },
      { kind: "event", event: { type: "usage_update", model: "two", cumulativeUsd: 0.01 } },
      { kind: "event", event: { type: "runtime_telemetry", kind: "run_config", data: { model: "actual", effort: "xhigh" } } },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_usage",
          data: { contextWindow: 372_000, tokens: { total: 12_345 } },
        },
      },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    expect(detail.thread.runState).toMatchObject({ model: "actual", effort: "xhigh" });
    expect(detail.messages.at(-1)?.parts.map((part) => part.type === "telemetry" ? part.event : part.type)).toEqual([
      "runtime_warning", "provider_status", "usage_update", "runtime_telemetry", "runtime_telemetry",
    ]);
    expect(detail.messages.at(-1)?.parts.at(-1)).toEqual({
      type: "telemetry",
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_usage",
        data: { contextWindow: 372_000, tokens: { total: 12_345 } },
      },
    });
    store.close();
  });

  it("updates a compaction lifecycle in place while keeping distinct operations", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "compact", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-1", status: "running", sdk: "pi", trigger: "proactive" },
        },
      },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "succeeded",
            sdk: "pi",
            trigger: "proactive",
            tokensBefore: 80_000,
            tokensAfter: 20_000,
            tokenCountsExact: false,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-2", status: "skipped", sdk: "pi", trigger: "manual" },
        },
      },
    ]);

    const assistant = store.getThreadDetail(thread.id)?.messages.at(-1);
    expect(assistant?.parts).toEqual([
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "succeeded",
            sdk: "pi",
            trigger: "proactive",
            tokensBefore: 80_000,
            tokensAfter: 20_000,
            tokenCountsExact: false,
          },
        },
      },
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: { operationId: "compact-2", status: "skipped", sdk: "pi", trigger: "manual" },
        },
      },
    ]);
    store.close();
  });

  it("reconciles a divergent replace frame across interleaved text without dropping tools", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    const turn = store.beginTurn({ threadId: thread.id, text: "replace", attachmentIds: [] });
    store.applyStreamFrames(turn.turnId, [
      { kind: "append", delta: "a" },
      { kind: "event", event: { type: "tool_call_started", id: "tool-1", name: "Search", arguments: { q: "x" } } },
      { kind: "append", delta: "b" },
      { kind: "replace", text: "X" },
    ]);
    const detail = store.completeTurn(turn.turnId, "");
    const assistant = detail.messages.at(-1);
    expect(assistant?.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Search",
        args: { q: "x" },
        status: "running",
      },
      { type: "text", text: "X" },
    ]);
    store.close();
  });

  it("exposes a marked assistant-only notification only after durable-history completion", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const selected = store.createThread("agent-one");
    const reservation = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: "cron:daily:2026-07-21T09:00:00.000Z:success",
      text: "Morning brief",
    });

    expect(store.getThread(reservation.threadId)).toBeUndefined();
    expect(store.currentThreadId()).toBe(selected.id);
    const completed = store.completeNotification(reservation);
    expect(completed).toMatchObject({
      duplicate: false,
      thread: {
        id: reservation.threadId,
        title: "Cron notification",
        trigger: { kind: "cron" },
        messageCount: 1,
        runState: { status: "complete" },
      },
    });
    expect(store.getThreadDetail(reservation.threadId)?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "Morning brief" }],
      }),
    ]);
    expect(store.currentThreadId()).toBe(selected.id);
    expect(store.completeNotification(reservation)).toMatchObject({ duplicate: true });
    expect(() => store.reserveNotification({
      ...reservation,
      text: "Conflicting brief",
    })).toThrowError(expect.objectContaining({ code: "notification_idempotency_conflict" }));
    store.close();

    const reopened = await WebStore.open({ stateDir });
    reopened.replaceAgents([agent()]);
    const duplicate = reopened.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: reservation.deliveryKey,
      text: "Morning brief",
    });
    expect(duplicate.duplicate).toBe(true);
    expect(reopened.completeNotification(duplicate)).toMatchObject({ duplicate: true });
    reopened.close();
  });

  it("migrates schema v1 state through notification and live-input storage", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE live_inputs;
      DROP TABLE notification_deliveries;
      ALTER TABLE threads DROP COLUMN trigger_kind;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    const inspected = new DatabaseSync(databasePath);
    const version = inspected.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    const columns = inspected.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
    const ledger = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'").get();
    const liveInputs = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_inputs'").get();
    inspected.close();
    expect(version.user_version).toBe(3);
    expect(columns.map((column) => column.name)).toContain("trigger_kind");
    expect(ledger).toBeDefined();
    expect(liveInputs).toBeDefined();
  });

  it("rejects a future schema without retaining the failed database handle", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    const databasePath = initial.paths.database;
    initial.close();

    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 4");
    future.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "unsupported_storage_schema" });

    const restored = new DatabaseSync(databasePath);
    restored.exec("PRAGMA user_version = 3");
    restored.close();
    const reopened = await WebStore.open({ stateDir });
    reopened.close();
  });

  it("fails closed on malformed persisted message parts and recovers after external repair", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    initial.replaceAgents([agent()]);
    const thread = initial.createThread("agent-one");
    const turn = initial.beginTurn({ threadId: thread.id, text: "persist", attachmentIds: [] });
    initial.completeTurn(turn.turnId, "answer");
    const assistantId = initial.getThreadDetail(thread.id)?.messages.at(-1)?.id;
    if (assistantId === undefined) throw new Error("Expected a persisted assistant message.");
    const databasePath = initial.paths.database;
    initial.close();

    const corrupt = new DatabaseSync(databasePath);
    corrupt.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run("{not-json", assistantId);
    corrupt.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt" });

    const repaired = new DatabaseSync(databasePath);
    repaired.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run("[]", assistantId);
    repaired.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThreadDetail(thread.id)?.messages.at(-1)?.parts).toEqual([]);
    reopened.close();
  });
});
