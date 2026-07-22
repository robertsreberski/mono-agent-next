import { mkdtemp, chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SlackInbox } from "../inbox.js";
import type { SlackMessageEvent } from "../socket.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SlackInbox", () => {
  it("persists pending work atomically with owner-private state and reopens it", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await expect(inbox.enqueue(event("E-pending"))).resolves.toBe("enqueued");
    expect(inbox.snapshot()).toMatchObject({ pending: 1, processing: 0, failed: 0, completed: 0 });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(inbox.statePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(inbox.statePath, "utf8")).toContain("E-pending");
    await inbox.close();

    const reopened = await SlackInbox.open(directory);
    expect(reopened.snapshot()).toMatchObject({ pending: 1, processing: 0, failed: 0, completed: 0 });
    await reopened.close();
  });

  it("retains completed receipts and deduplicates across reopen", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-complete"));
    await expect(inbox.claimNext()).resolves.toMatchObject({ envelopeId: "E-complete" });
    await inbox.complete("E-complete");
    expect(inbox.snapshot()).toMatchObject({ pending: 0, processing: 0, failed: 0, completed: 1 });
    await inbox.close();

    const reopened = await SlackInbox.open(directory);
    await expect(reopened.enqueue(event("E-complete"))).resolves.toBe("duplicate");
    await expect(reopened.claimNext()).resolves.toBeUndefined();
    expect(reopened.snapshot().completed).toBe(1);
    await reopened.close();
  });

  it("blocks crash-ambiguous processing and explicit failures without replay", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-uncertain"));
    await inbox.claimNext();
    await inbox.close();

    const uncertain = await SlackInbox.open(directory);
    expect(uncertain.snapshot()).toMatchObject({ processing: 1, blocked: expect.stringMatching(/uncertain/iu) });
    await expect(uncertain.claimNext()).resolves.toBeUndefined();
    await expect(uncertain.enqueue(event("E-new"))).rejects.toMatchObject({ code: "blocked" });
    await uncertain.fail("E-uncertain");
    expect(uncertain.snapshot()).toMatchObject({ processing: 0, failed: 1, blocked: expect.stringMatching(/failed/iu) });
    await uncertain.close();

    const failed = await SlackInbox.open(directory);
    await expect(failed.claimNext()).resolves.toBeUndefined();
    expect(failed.snapshot().failed).toBe(1);
    await failed.close();
  });

  it("fails closed on corrupt, broad-mode, and symlinked inbox state", async () => {
    const corruptDirectory = await dataDirectory();
    const corrupt = await SlackInbox.open(corruptDirectory);
    const corruptPath = corrupt.statePath;
    await corrupt.close();
    await writeFile(corruptPath, "not json", { encoding: "utf8", mode: 0o600 });
    await expect(SlackInbox.open(corruptDirectory)).rejects.toMatchObject({ code: "corrupt" });

    const broadDirectory = await dataDirectory();
    const broad = await SlackInbox.open(broadDirectory);
    const broadPath = broad.statePath;
    await broad.close();
    await chmod(broadPath, 0o644);
    await expect(SlackInbox.open(broadDirectory)).rejects.toMatchObject({ code: "unsafe-path" });

    const root = await temporaryRoot();
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    await expect(SlackInbox.open(linked)).rejects.toMatchObject({ code: "unsafe-path" });
  });
});

function event(envelopeId: string): SlackMessageEvent {
  return {
    kind: "message",
    envelopeId,
    teamId: "T1",
    channelId: "C1",
    messageId: "1",
    threadId: "1",
    userId: "U1",
    text: "hello",
    files: [],
    receivedAt: new Date().toISOString(),
  };
}

async function dataDirectory(): Promise<string> {
  return join(await temporaryRoot(), "inbox");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-slack-inbox-"));
  temporaryDirectories.push(root);
  return root;
}
