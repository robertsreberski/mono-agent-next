// SPDX-License-Identifier: MIT
import {
  appendFile,
  chmod,
  link,
  lstat,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OperatorUsage } from "@mono-agent/operator";

import {
  ACTIVE_TURN_JOURNAL_LIMITS,
  journalName as activeTurnJournalName,
  type ActiveTurnJournalHeader,
} from "../active-turn-journal.js";
import { DurableWebStore } from "../store.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

afterEach(cleanup);

describe("durable web state", () => {
  it("atomically persists owner-private conversations and reloads them", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal", "Persistent thread");
    const turn = await store.startTurn(thread.id, "hello");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "hello back");
    await store.finishTurn(thread.id, turn.assistant.turnId!, "complete");
    await store.close();

    expect((await lstat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dataDirectory, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(dataDirectory, ".mono-agent-web-state"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(dataDirectory, "lease.sqlite"))).mode & 0o777).toBe(0o600);

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "complete", title: "Persistent thread" },
      messages: [
        { role: "user", text: "hello", status: "complete" },
        { role: "assistant", text: "hello back", status: "complete" },
      ],
    });
    await reopened.close();
  });

  it("fsyncs compact active-turn deltas without rewriting canonical state", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal", "Streaming");
    const turn = await store.startTurn(thread.id, "stream");
    const statePath = join(dataDirectory, "state.json");
    const canonical = await readFile(statePath, "utf8");

    await store.updateAssistant(thread.id, turn.assistant.turnId!, "hello");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "hello world");

    expect(await readFile(statePath, "utf8")).toBe(canonical);
    const journalDirectory = join(dataDirectory, ".active-turns");
    expect((await lstat(journalDirectory)).mode & 0o777).toBe(0o700);
    const [journalName] = await readdir(journalDirectory);
    expect(journalName).toMatch(/^[0-9a-f]{64}\.jsonl$/u);
    const journalPath = join(journalDirectory, journalName!);
    expect((await lstat(journalPath)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      kind: "assistant-delta",
      text: { kind: "append", value: "hello" },
    });
    expect(JSON.parse(lines[2]!)).toMatchObject({
      kind: "assistant-delta",
      text: { kind: "append", value: " world" },
    });

    await store.finishTurn(thread.id, turn.assistant.turnId!, "complete");
    expect(await readdir(journalDirectory)).toEqual([]);
    await store.close();
  });

  it("folds interleaved active journals into unrelated canonical mutations and rebases later frames", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let canonicalWrites = 0;
    const store = await DurableWebStore.open(dataDirectory, {
      afterStateRename() {
        canonicalWrites += 1;
      },
    });
    const first = await store.createThread("personal", "First");
    const second = await store.createThread("personal", "Second");
    const firstTurn = await store.startTurn(first.id, "first");
    const secondTurn = await store.startTurn(second.id, "second");
    const writesBeforeFrames = canonicalWrites;
    await store.updateAssistant(first.id, firstTurn.assistant.turnId!, "first answer");
    await store.updateAssistant(second.id, secondTurn.assistant.turnId!, "second answer");
    expect(canonicalWrites).toBe(writesBeforeFrames);
    expect(await readdir(join(dataDirectory, ".active-turns"))).toHaveLength(2);

    await store.setAgentPinned("personal", true);
    expect(canonicalWrites).toBe(writesBeforeFrames + 1);
    expect(await readdir(join(dataDirectory, ".active-turns"))).toEqual([]);
    expect(JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"))).toMatchObject({
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second" },
        { role: "assistant", text: "second answer" },
      ],
    });

    const canonicalRevision = store.revision();
    await store.updateAssistant(first.id, firstTurn.assistant.turnId!, "first answer continued");
    const [journalName] = await readdir(join(dataDirectory, ".active-turns"));
    const [headerLine] = (
      await readFile(join(dataDirectory, ".active-turns", journalName!), "utf8")
    ).split("\n");
    expect(JSON.parse(headerLine!)).toMatchObject({ baseRevision: canonicalRevision });
    await store.finishTurn(first.id, firstTurn.assistant.turnId!, "complete");
    await store.finishTurn(second.id, secondTurn.assistant.turnId!, "complete");
    await store.close();
  });

  it("omits unchanged AskUser snapshots and appends only new activity entries", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "choose");
    const ask = {
      interactionId: "ask-1",
      requestedAt: new Date().toISOString(),
      questions: [{
        id: "choice",
        prompt: "Continue?",
        allowFreeText: false,
        multiple: false,
        choices: [{ value: "yes", label: "Yes" }],
      }],
    };
    const call = {
      type: "tool_call" as const,
      call: {
        id: "call-1",
        name: "CalendarLookup",
        input: { range: "today" },
        inputOmitted: false,
      },
    };
    const result = {
      type: "tool_result" as const,
      result: {
        callId: "call-1",
        content: [{ type: "text" as const, text: "No events" }],
        contentOmitted: false,
      },
    };
    await store.updateAssistant(
      thread.id,
      turn.assistant.turnId!,
      "answer",
      ask,
      undefined,
      undefined,
      [call],
    );
    await store.updateAssistant(
      thread.id,
      turn.assistant.turnId!,
      "answer",
      ask,
      undefined,
      undefined,
      [call, result],
    );

    const [journalName] = await readdir(join(dataDirectory, ".active-turns"));
    const lines = (
      await readFile(join(dataDirectory, ".active-turns", journalName!), "utf8")
    ).trimEnd().split("\n");
    const firstRecord = JSON.parse(lines[1]!) as Record<string, unknown>;
    const secondRecord = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(firstRecord).toHaveProperty("pendingAsk");
    expect(secondRecord).not.toHaveProperty("pendingAsk");
    expect(secondRecord).toMatchObject({
      text: { kind: "append", value: "" },
      activities: { kind: "append", value: [result] },
    });
    await store.finishTurn(thread.id, turn.assistant.turnId!, "complete");
    await store.close();
  });

  it("migrates state without text loss and durably retains bounded content-free telemetry", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const scaffold = await DurableWebStore.open(dataDirectory);
    await scaffold.close();
    const now = "2026-07-23T10:11:12.000Z";
    const exactLegacyText = "<keep>& every\ncharacter — including telemetry-looking text";
    await writeFile(join(dataDirectory, "state.json"), `${JSON.stringify({
      schemaVersion: 1,
      threads: [{
        id: "legacy-thread",
        agentId: "personal",
        operatorConversationId: "web:legacy-thread",
        title: "Legacy",
        createdAt: now,
        updatedAt: now,
        status: "complete",
      }],
      messages: [{
        id: "legacy-message",
        threadId: "legacy-thread",
        role: "assistant",
        text: exactLegacyText,
        createdAt: now,
        updatedAt: now,
        status: "complete",
      }],
    })}\n`, { mode: 0o600 });

    const migrated = await DurableWebStore.open(dataDirectory);
    expect(migrated.getThreadDetail("legacy-thread")?.messages[0]?.text).toBe(exactLegacyText);
    expect(JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"))).toMatchObject({
      schemaVersion: 3,
      messages: [{ text: exactLegacyText }],
    });

    const thread = await migrated.createThread("personal", "Telemetry");
    const turn = await migrated.startTurn(thread.id, "measure");
    const turnId = turn.assistant.turnId!;
    const usageWithSecret: OperatorUsage & { readonly providerSecret: string } = {
      inputTokens: 12,
      outputTokens: 3,
      contextWindow: 128_000,
      contextUsed: 15,
      compacted: true,
      sessionEvicted: false,
      providerSecret: "must-not-persist",
    };
    await migrated.updateAssistant(thread.id, turnId, "complete response", undefined, undefined, usageWithSecret);
    await migrated.updateAssistant(thread.id, turnId, "complete response", undefined, undefined, {
      inputTokens: 14,
      outputTokens: 4,
      contextWindow: 128_000,
      contextUsed: 18,
      compacted: false,
      sessionEvicted: true,
    });
    await migrated.finishTurn(thread.id, turnId, "complete");
    await migrated.close();

    const raw = await readFile(join(dataDirectory, "state.json"), "utf8");
    expect(raw).not.toContain("must-not-persist");
    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      messages: [
        { role: "user", text: "measure" },
        {
          role: "assistant",
          text: "complete response",
          telemetry: {
            inputTokens: 14,
            outputTokens: 4,
            contextWindow: 128_000,
            contextUsed: 18,
            compacted: true,
            sessionEvicted: true,
          },
        },
      ],
    });
    await reopened.close();
  });

  it("recovers legacy long thread ids and maximum-size operator message ids", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const scaffold = await DurableWebStore.open(dataDirectory);
    const original = await scaffold.createThread("personal", "Legacy identity");
    await scaffold.close();
    const statePath = join(dataDirectory, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      threads: Array<{ id: string }>;
    };
    const legacyThreadId = `legacy\0${"t".repeat(300)}`;
    state.threads[0]!.id = legacyThreadId;
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const store = await DurableWebStore.open(dataDirectory);
    expect(store.getThread(original.id)).toBeUndefined();
    const turn = await store.startTurn(legacyThreadId, "continue");
    const operatorMessageId = `message~u16:${"a".repeat(1_350)}`;
    await store.updateAssistant(
      legacyThreadId,
      turn.assistant.turnId!,
      "durable",
      undefined,
      operatorMessageId,
    );
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(legacyThreadId)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [
        { role: "user" },
        {
          role: "assistant",
          text: "durable",
          operatorMessageId,
          status: "interrupted",
        },
      ],
    });
    await reopened.close();
  });

  it("recovers a durably running turn as interrupted after an unclean stop", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    await store.startTurn(thread.id, "unfinished");
    await store.close();

    // Simulate the process disappearing after its last durable running commit.
    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [{ role: "user" }, { role: "assistant", status: "interrupted" }],
    });
    await reopened.close();
  });

  it("replays complete deltas before interrupting a turn and ignores a torn tail", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "unfinished");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "durable");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "durable response");
    await store.close();

    const journalDirectory = join(dataDirectory, ".active-turns");
    const [journalName] = await readdir(journalDirectory);
    await appendFile(
      join(journalDirectory, journalName!),
      Buffer.concat([
        Buffer.from('{"kind":"assistant-delta"', "utf8"),
        Buffer.from([0xff, 0xfe]),
      ]),
    );

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [
        { role: "user", text: "unfinished" },
        { role: "assistant", text: "durable response", status: "interrupted" },
      ],
    });
    expect(await readdir(journalDirectory)).toEqual([]);
    await reopened.close();
  });

  it("globally replays interleaved journals before interrupting every active turn", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const first = await store.createThread("personal", "First");
    const second = await store.createThread("personal", "Second");
    const firstTurn = await store.startTurn(first.id, "first");
    const secondTurn = await store.startTurn(second.id, "second");
    await store.updateAssistant(first.id, firstTurn.assistant.turnId!, "A");
    await store.updateAssistant(second.id, secondTurn.assistant.turnId!, "B");
    await store.updateAssistant(first.id, firstTurn.assistant.turnId!, "A2");
    expect(await readdir(join(dataDirectory, ".active-turns"))).toHaveLength(2);
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(first.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [{ role: "user" }, { role: "assistant", text: "A2", status: "interrupted" }],
    });
    expect(reopened.getThreadDetail(second.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [{ role: "user" }, { role: "assistant", text: "B", status: "interrupted" }],
    });
    expect(await readdir(join(dataDirectory, ".active-turns"))).toEqual([]);
    await reopened.close();
  });

  it("ignores a torn header with no complete record and interrupts from canonical state", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    await store.startTurn(thread.id, "unfinished");
    await store.close();
    const journalDirectory = join(dataDirectory, ".active-turns");
    await writeFile(
      join(journalDirectory, `${"0".repeat(64)}.jsonl`),
      '{"kind":"mono-agent-web-active-turn"',
      { mode: 0o600 },
    );

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [{ role: "user" }, { role: "assistant", text: "", status: "interrupted" }],
    });
    expect(await readdir(journalDirectory)).toEqual([]);
    await reopened.close();
  });

  it("fails closed on a malformed complete delta and preserves the journal bytes", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "unfinished");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "durable");
    await store.close();

    const journalDirectory = join(dataDirectory, ".active-turns");
    const [journalName] = await readdir(journalDirectory);
    const journalPath = join(journalDirectory, journalName!);
    await appendFile(journalPath, "not-json\n", "utf8");
    const exactBytes = await readFile(journalPath);

    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({
      code: "state_corrupt",
    });
    expect(await readFile(journalPath)).toEqual(exactBytes);
  });

  it("treats a canonical commit before journal reset as stale and keeps the terminal state", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let failReset = false;
    const store = await DurableWebStore.open(dataDirectory, {
      beforeJournalReset() {
        if (failReset) throw new Error("injected crash before journal reset");
      },
    });
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "finish");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "finished response");
    failReset = true;
    await expect(
      store.finishTurn(thread.id, turn.assistant.turnId!, "complete"),
    ).rejects.toMatchObject({ code: "state_store_poisoned" });
    expect(await readdir(join(dataDirectory, ".active-turns"))).toHaveLength(1);
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "complete" },
      messages: [
        { role: "user" },
        { role: "assistant", text: "finished response", status: "complete" },
      ],
    });
    expect(await readdir(join(dataDirectory, ".active-turns"))).toEqual([]);
    await reopened.close();
  });

  it("fails closed on duplicate global revisions even when every journal is stale", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let failReset = false;
    const store = await DurableWebStore.open(dataDirectory, {
      beforeJournalReset() {
        if (failReset) throw new Error("injected crash before journal reset");
      },
    });
    const first = await store.createThread("personal", "First");
    const second = await store.createThread("personal", "Second");
    const firstTurn = await store.startTurn(first.id, "first");
    const secondTurn = await store.startTurn(second.id, "second");
    await store.updateAssistant(first.id, firstTurn.assistant.turnId!, "A");
    await store.updateAssistant(second.id, secondTurn.assistant.turnId!, "B");
    failReset = true;
    await expect(store.setAgentPinned("personal", true)).rejects.toMatchObject({
      code: "state_store_poisoned",
    });
    await store.close();

    const journalDirectory = join(dataDirectory, ".active-turns");
    const journals = await Promise.all((await readdir(journalDirectory)).map(async (name) => {
      const path = join(journalDirectory, name);
      const [headerLine, recordLine] = (await readFile(path, "utf8")).trimEnd().split("\n");
      return {
        path,
        header: JSON.parse(headerLine!) as { baseRevision: number },
        record: JSON.parse(recordLine!) as { fromRevision: number; revision: number },
      };
    }));
    journals.sort((left, right) => left.record.revision - right.record.revision);
    const source = journals[0]!;
    const duplicate = journals[1]!;
    duplicate.header.baseRevision = source.record.fromRevision;
    duplicate.record.fromRevision = source.record.fromRevision;
    duplicate.record.revision = source.record.revision;
    await writeFile(
      duplicate.path,
      `${JSON.stringify(duplicate.header)}\n${JSON.stringify(duplicate.record)}\n`,
      { mode: 0o600 },
    );
    const exactBytes = await readFile(duplicate.path);

    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({
      code: "state_corrupt",
    });
    expect(await readFile(duplicate.path)).toEqual(exactBytes);
  });

  it("fails closed on a complete journal header from a future canonical revision", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "unfinished");
    await store.updateAssistant(thread.id, turn.assistant.turnId!, "durable");
    await store.close();

    const journalDirectory = join(dataDirectory, ".active-turns");
    const [journalName] = await readdir(journalDirectory);
    const journalPath = join(journalDirectory, journalName!);
    const [headerLine] = (await readFile(journalPath, "utf8")).split("\n");
    const header = JSON.parse(headerLine!) as { baseRevision: number };
    header.baseRevision += 100;
    await writeFile(journalPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    const exactBytes = await readFile(journalPath);

    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({
      code: "state_corrupt",
    });
    expect(await readFile(journalPath)).toEqual(exactBytes);
  });

  it("fails closed on a current-revision header-only journal for a terminal turn", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "complete");
    await store.finishTurn(thread.id, turn.assistant.turnId!, "complete");
    const header: ActiveTurnJournalHeader = {
      kind: "mono-agent-web-active-turn",
      version: 1,
      threadId: thread.id,
      turnId: turn.assistant.turnId!,
      assistantMessageId: turn.assistant.id,
      baseRevision: store.revision(),
    };
    await store.close();
    const journalPath = join(
      dataDirectory,
      ".active-turns",
      activeTurnJournalName(header),
    );
    await writeFile(journalPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    const exactBytes = await readFile(journalPath);

    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({
      code: "state_corrupt",
    });
    expect(await readFile(journalPath)).toEqual(exactBytes);
  });

  it("persists pins, first-turn automatic titles, manual titles, and archive-before-delete guards", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    expect(store.revision()).toBe(0);
    await store.setAgentPinned("personal", true);
    expect(store.isAgentPinned("personal")).toBe(true);

    const thread = await store.createThread("personal");
    expect(thread).toMatchObject({ title: "New conversation", titleManual: false });
    await expect(store.deleteThread(thread.id)).rejects.toMatchObject({ code: "thread_not_archived" });
    const first = await store.startTurn(thread.id, "First durable title");
    await store.finishTurn(thread.id, first.assistant.turnId!, "complete");
    expect(store.getThread(thread.id)).toMatchObject({ title: "First durable title", titleManual: false });
    const second = await store.startTurn(thread.id, "Must not replace the first title");
    await store.finishTurn(thread.id, second.assistant.turnId!, "complete");
    expect(store.getThread(thread.id)?.title).toBe("First durable title");

    await store.patchThread(thread.id, { title: "Operator title" });
    await store.patchThread(thread.id, { archived: true });
    expect(store.getThread(thread.id)).toMatchObject({
      title: "Operator title",
      titleManual: true,
      archivedAt: expect.any(String),
    });
    await store.deleteThread(thread.id);
    expect(store.getThread(thread.id)).toBeUndefined();
    expect(store.revision()).toBeGreaterThan(0);
    await store.close();
  });

  it("refuses concurrent ownership and preserves corrupt state bytes", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({ code: "web_already_running" });
    await expect(store.createThread("still-exclusive")).resolves.toMatchObject({ agentId: "still-exclusive" });
    await store.close();

    const afterRelease = await DurableWebStore.open(dataDirectory);
    expect(afterRelease.listThreads()).toHaveLength(1);
    await afterRelease.close();

    const statePath = join(dataDirectory, "state.json");
    await writeFile(statePath, "not-json", { mode: 0o600 });
    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({ code: "state_corrupt" });
    expect(await readFile(statePath, "utf8")).toBe("not-json");
  });

  it("poisons the writer after a post-rename durability failure and never overwrites the committed disk state", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let failAfterRename = true;
    const store = await DurableWebStore.open(dataDirectory, {
      afterStateRename() {
        if (!failAfterRename) return;
        failAfterRename = false;
        throw new Error("injected directory fsync failure");
      },
    });

    await expect(store.createThread("committed-before-fsync")).rejects.toMatchObject({ code: "state_store_poisoned" });
    await expect(store.createThread("must-not-overwrite")).rejects.toMatchObject({ code: "state_store_poisoned" });
    expect(() => store.listThreads()).toThrow(/close and reopen/u);
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.listThreads()).toMatchObject([{ agentId: "committed-before-fsync" }]);
    await reopened.close();
  });

  it("poisons after journal write uncertainty and requires reopen before replay", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    let injectFailure = true;
    const store = await DurableWebStore.open(dataDirectory, {
      afterJournalRecordWrite() {
        if (!injectFailure) return;
        injectFailure = false;
        throw new Error("injected journal fsync failure");
      },
    });
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "uncertain");
    await expect(
      store.updateAssistant(thread.id, turn.assistant.turnId!, "possibly durable"),
    ).rejects.toMatchObject({ code: "state_store_poisoned" });
    await expect(
      store.finishTurn(thread.id, turn.assistant.turnId!, "failed"),
    ).rejects.toMatchObject({ code: "state_store_poisoned" });
    expect(() => store.getThreadDetail(thread.id)).toThrow(/close and reopen/u);
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [
        { role: "user" },
        { role: "assistant", text: "possibly durable", status: "interrupted" },
      ],
    });
    await reopened.close();
  });

  it("poisons when the canonical journal path is swapped after append", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const displacedPath = join(root, "displaced-journal");
    const store = await DurableWebStore.open(dataDirectory, {
      async afterJournalRecordWrite() {
        const journalDirectory = join(dataDirectory, ".active-turns");
        const [journalName] = await readdir(journalDirectory);
        await rename(join(journalDirectory, journalName!), displacedPath);
      },
    });
    const thread = await store.createThread("personal");
    const turn = await store.startTurn(thread.id, "swap");
    await expect(
      store.updateAssistant(thread.id, turn.assistant.turnId!, "not accepted"),
    ).rejects.toMatchObject({ code: "state_store_poisoned" });
    expect(await readFile(displacedPath, "utf8")).toContain("not accepted");
    await store.close();

    const reopened = await DurableWebStore.open(dataDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "interrupted" },
      messages: [
        { role: "user" },
        { role: "assistant", text: "", status: "interrupted" },
      ],
    });
    await reopened.close();
  });

  it("enforces active-turn, per-journal, global-byte, and record-count limits before append", async () => {
    const root = await temporaryDirectory();
    expect(ACTIVE_TURN_JOURNAL_LIMITS).toEqual({
      maxActiveTurns: 32,
      maxBytes: 16 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxRecords: 131_072,
    });

    const activeDirectory = join(root, "active");
    const activeStore = await DurableWebStore.open(activeDirectory, {
      activeTurnJournalLimits: { maxActiveTurns: 1 },
    });
    const first = await activeStore.createThread("personal", "First");
    const second = await activeStore.createThread("personal", "Second");
    await activeStore.startTurn(first.id, "first");
    await expect(activeStore.startTurn(second.id, "second")).rejects.toMatchObject({
      code: "capacity_exceeded",
    });
    await activeStore.close();

    const recordDirectory = join(root, "records");
    const recordStore = await DurableWebStore.open(recordDirectory, {
      activeTurnJournalLimits: { maxRecords: 1 },
    });
    const recordThread = await recordStore.createThread("personal");
    const recordTurn = await recordStore.startTurn(recordThread.id, "records");
    await recordStore.updateAssistant(recordThread.id, recordTurn.assistant.turnId!, "one");
    await expect(
      recordStore.updateAssistant(recordThread.id, recordTurn.assistant.turnId!, "two"),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(
      recordStore.finishTurn(recordThread.id, recordTurn.assistant.turnId!, "failed"),
    ).resolves.toMatchObject({ text: "one", status: "failed" });
    await recordStore.close();

    const bytesDirectory = join(root, "bytes");
    const bytesStore = await DurableWebStore.open(bytesDirectory, {
      activeTurnJournalLimits: { maxBytes: 512, maxTotalBytes: 1024 },
    });
    const bytesThread = await bytesStore.createThread("personal");
    const bytesTurn = await bytesStore.startTurn(bytesThread.id, "bytes");
    await expect(
      bytesStore.updateAssistant(
        bytesThread.id,
        bytesTurn.assistant.turnId!,
        "x".repeat(1_024),
      ),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(
      bytesStore.finishTurn(bytesThread.id, bytesTurn.assistant.turnId!, "failed"),
    ).resolves.toMatchObject({ text: "", status: "failed" });
    await bytesStore.close();

    const totalDirectory = join(root, "total");
    const totalStore = await DurableWebStore.open(totalDirectory, {
      activeTurnJournalLimits: {
        maxBytes: 4_096,
        maxTotalBytes: 1_024,
        maxActiveTurns: 2,
      },
    });
    const totalFirst = await totalStore.createThread("personal", "First");
    const totalSecond = await totalStore.createThread("personal", "Second");
    const totalFirstTurn = await totalStore.startTurn(totalFirst.id, "first");
    const totalSecondTurn = await totalStore.startTurn(totalSecond.id, "second");
    await totalStore.updateAssistant(
      totalFirst.id,
      totalFirstTurn.assistant.turnId!,
      "a".repeat(300),
    );
    await expect(
      totalStore.updateAssistant(
        totalSecond.id,
        totalSecondTurn.assistant.turnId!,
        "b".repeat(300),
      ),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(
      totalStore.finishTurn(totalSecond.id, totalSecondTurn.assistant.turnId!, "failed"),
    ).resolves.toMatchObject({ status: "failed" });
    await totalStore.close();
  });

  it("rejects permissive and symlinked existing state instead of repairing or touching targets", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const store = await DurableWebStore.open(dataDirectory);
    await store.close();
    await chmod(join(dataDirectory, "state.json"), 0o644);
    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({ code: "invalid_state_mode" });

    await chmod(join(dataDirectory, "state.json"), 0o600);
    const original = join(dataDirectory, "state.original.json");
    await rename(join(dataDirectory, "state.json"), original);
    const originalBytes = await readFile(original, "utf8");
    await symlink(original, join(dataDirectory, "state.json"));
    await expect(DurableWebStore.open(dataDirectory)).rejects.toMatchObject({ code: "invalid_state_file" });
    expect(await readFile(original, "utf8")).toBe(originalBytes);
  });

  it("rejects linked or permissive active-turn storage without touching link targets", async () => {
    const root = await temporaryDirectory();
    const linkedDirectory = join(root, "linked-directory");
    const linkedStore = await DurableWebStore.open(linkedDirectory);
    await linkedStore.close();
    const activeDirectory = join(linkedDirectory, ".active-turns");
    const activeTarget = join(linkedDirectory, "active-target");
    await rename(activeDirectory, activeTarget);
    await symlink(activeTarget, activeDirectory);
    await expect(DurableWebStore.open(linkedDirectory)).rejects.toMatchObject({
      code: "invalid_state_directory",
    });
    expect(await readdir(activeTarget)).toEqual([]);

    const permissiveDirectory = join(root, "permissive-directory");
    const permissiveStore = await DurableWebStore.open(permissiveDirectory);
    await permissiveStore.close();
    await chmod(join(permissiveDirectory, ".active-turns"), 0o755);
    await expect(DurableWebStore.open(permissiveDirectory)).rejects.toMatchObject({
      code: "invalid_state_mode",
    });

    const linkedFileDirectory = join(root, "linked-file");
    const journalStore = await DurableWebStore.open(linkedFileDirectory);
    const thread = await journalStore.createThread("personal");
    const turn = await journalStore.startTurn(thread.id, "journal");
    await journalStore.updateAssistant(thread.id, turn.assistant.turnId!, "durable");
    await journalStore.close();
    const journalDirectory = join(linkedFileDirectory, ".active-turns");
    const [journalName] = await readdir(journalDirectory);
    const journalPath = join(journalDirectory, journalName!);
    const hardLinkTarget = join(root, "journal-hard-link");
    await link(journalPath, hardLinkTarget);
    const targetBytes = await readFile(hardLinkTarget);
    await expect(DurableWebStore.open(linkedFileDirectory)).rejects.toMatchObject({
      code: "invalid_state_file",
    });
    expect(await readFile(hardLinkTarget)).toEqual(targetBytes);

    const symlinkedFileDirectory = join(root, "symlinked-file");
    const symlinkedFileStore = await DurableWebStore.open(symlinkedFileDirectory);
    const symlinkedThread = await symlinkedFileStore.createThread("personal");
    const symlinkedTurn = await symlinkedFileStore.startTurn(symlinkedThread.id, "journal");
    await symlinkedFileStore.updateAssistant(
      symlinkedThread.id,
      symlinkedTurn.assistant.turnId!,
      "durable",
    );
    await symlinkedFileStore.close();
    const symlinkedJournalDirectory = join(symlinkedFileDirectory, ".active-turns");
    const [symlinkedJournalName] = await readdir(symlinkedJournalDirectory);
    const symlinkedJournalPath = join(symlinkedJournalDirectory, symlinkedJournalName!);
    const symlinkTarget = join(root, "journal-symlink-target");
    await rename(symlinkedJournalPath, symlinkTarget);
    const symlinkTargetBytes = await readFile(symlinkTarget);
    await symlink(symlinkTarget, symlinkedJournalPath);
    await expect(DurableWebStore.open(symlinkedFileDirectory)).rejects.toMatchObject({
      code: "invalid_state_file",
    });
    expect(await readFile(symlinkTarget)).toEqual(symlinkTargetBytes);

    const permissiveFileDirectory = join(root, "permissive-file");
    const permissiveFileStore = await DurableWebStore.open(permissiveFileDirectory);
    const permissiveThread = await permissiveFileStore.createThread("personal");
    const permissiveTurn = await permissiveFileStore.startTurn(permissiveThread.id, "journal");
    await permissiveFileStore.updateAssistant(
      permissiveThread.id,
      permissiveTurn.assistant.turnId!,
      "durable",
    );
    await permissiveFileStore.close();
    const permissiveJournalDirectory = join(permissiveFileDirectory, ".active-turns");
    const [permissiveJournalName] = await readdir(permissiveJournalDirectory);
    await chmod(join(permissiveJournalDirectory, permissiveJournalName!), 0o644);
    await expect(DurableWebStore.open(permissiveFileDirectory)).rejects.toMatchObject({
      code: "invalid_state_mode",
    });
  });
});
