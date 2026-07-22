import { chmod, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
