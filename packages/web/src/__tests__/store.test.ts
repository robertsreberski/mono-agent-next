// SPDX-License-Identifier: MIT
import { chmod, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OperatorUsage } from "@mono-agent/operator";

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
});
