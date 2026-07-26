// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { mkdtemp, chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { SlackInbox } from "../inbox.js";
import { acquireSlackInboxLease } from "../inbox-lease.js";
import type {
  SlackActionEvent,
  SlackMessageEvent,
  SlackSocketEvent,
} from "../socket.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SlackInbox", () => {
  it("reports an absent inbox without creating maintenance state", async () => {
    const directory = await dataDirectory();
    await expect(SlackInbox.openExisting(directory)).resolves.toBeUndefined();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("binds maintenance discovery, lease, and open to one directory identity", async () => {
    const root = await temporaryRoot();
    const activeDirectory = join(root, "active");
    const replacementDirectory = join(root, "replacement");
    const displacedDirectory = join(root, "displaced");
    const active = await SlackInbox.open(activeDirectory);
    await active.enqueue(event("E-original"));
    await active.close();
    await (await acquireSlackInboxLease(activeDirectory)).release();
    const replacement = await SlackInbox.open(replacementDirectory);
    await replacement.close();
    await (await acquireSlackInboxLease(replacementDirectory)).release();
    const replacementPayload = "replacement B private payload must not be read or changed\n";
    const replacementStatePath = join(replacementDirectory, "inbox-v1.json");
    await writeFile(replacementStatePath, replacementPayload);

    const discovered = await SlackInbox.discoverExistingDirectory(activeDirectory);
    if (discovered === undefined) throw new Error("Expected the active Slack inbox.");
    let swappedDuringLock = false;
    let replacementLeaseAcquired = false;
    try {
      await expect(acquireSlackInboxLease(
        discovered.directory,
        undefined,
        discovered,
        {
          async afterAnchorOpen() {
            await rename(activeDirectory, displacedDirectory);
            await rename(replacementDirectory, activeDirectory);
            swappedDuringLock = true;
          },
          async afterDescriptorLock() {
            const replacementLease = await acquireSlackInboxLease(activeDirectory);
            replacementLeaseAcquired = true;
            await replacementLease.release();
          },
        },
      )).rejects.toThrow(/lease validation failed/iu);
      expect(replacementLeaseAcquired).toBe(true);
      await expect(readFile(join(activeDirectory, "inbox-v1.json"), "utf8"))
        .resolves.toBe(replacementPayload);
    } finally {
      if (swappedDuringLock) {
        await rename(activeDirectory, replacementDirectory);
        await rename(displacedDirectory, activeDirectory);
      }
    }

    const lease = await acquireSlackInboxLease(
      discovered.directory,
      undefined,
      discovered,
    );
    let activeDisplaced = false;
    let replacementInstalled = false;
    try {
      await rename(activeDirectory, displacedDirectory);
      activeDisplaced = true;
      await rename(replacementDirectory, activeDirectory);
      replacementInstalled = true;

      const replacementLease = await acquireSlackInboxLease(activeDirectory);
      await replacementLease.release();
      await expect(SlackInbox.openExisting(
        discovered.directory,
        undefined,
        discovered,
      )).rejects.toMatchObject({
        code: "unsafe-path",
        message: "Slack durable inbox directory identity changed.",
      });
      await expect(readFile(join(activeDirectory, "inbox-v1.json"), "utf8"))
        .resolves.toBe(replacementPayload);
    } finally {
      if (replacementInstalled) await rename(activeDirectory, replacementDirectory);
      if (activeDisplaced) await rename(displacedDirectory, activeDirectory);
      await lease.release();
    }

    await expect(readFile(replacementStatePath, "utf8")).resolves.toBe(replacementPayload);
    const reopened = await SlackInbox.openExisting(activeDirectory);
    expect(reopened?.inspectEntries()).toEqual([
      expect.objectContaining({ envelopeId: "E-original", status: "pending" }),
    ]);
    await reopened?.close();
  });

  it("retains the OS lease across same-process discovery and contention", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.close();
    const lease = await acquireSlackInboxLease(directory);
    try {
      const discovered = await SlackInbox.discoverExistingDirectory(directory);
      if (discovered === undefined) throw new Error("Expected the Slack inbox.");
      await expect(acquireSlackInboxLease(
        discovered.directory,
        undefined,
        discovered,
      )).rejects.toThrow(/in use/iu);

      const { stdout } = await execFileAsync(process.execPath, [
        "-e",
        [
          "const { DatabaseSync } = require('node:sqlite');",
          "const database = new DatabaseSync(process.argv[1], { timeout: 0 });",
          "try {",
          " database.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');",
          " process.stdout.write('acquired');",
          " database.exec('ROLLBACK;');",
          "} catch (error) {",
          " process.stdout.write(/busy|locked/i.test(String(error)) ? 'busy' : 'unexpected');",
          "} finally { database.close(); }",
        ].join(""),
        join(directory, ".mono-agent-slack-inbox.lease.sqlite"),
      ], { encoding: "utf8" });
      expect(stdout).toBe("busy");
    } finally {
      await lease.release();
    }
  });

  it("retains completed receipts and deduplicates across reopen", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-complete"));
    await expect(inbox.claimNextPrimary(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-complete",
    });
    await inbox.complete("E-complete");
    expect(inbox.snapshot()).toMatchObject({ pending: 0, processing: 0, failed: 0, completed: 1 });
    await inbox.close();

    const reopened = await SlackInbox.open(directory);
    await expect(reopened.enqueue(event("E-complete"))).resolves.toBe("duplicate");
    await expect(reopened.claimNextPrimary(controlEligible)).resolves.toBeUndefined();
    expect(reopened.snapshot().completed).toBe(1);
    await reopened.close();
  });

  it("blocks crash-ambiguous processing and explicit failures without replay", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-uncertain"));
    await inbox.claimNextPrimary(controlEligible);
    await inbox.close();

    const uncertain = await SlackInbox.open(directory);
    expect(uncertain.snapshot()).toMatchObject({ processing: 1, blocked: expect.stringMatching(/uncertain/iu) });
    await expect(uncertain.claimNextPrimary(controlEligible)).resolves.toBeUndefined();
    await expect(uncertain.enqueue(event("E-new"))).rejects.toMatchObject({ code: "blocked" });
    await uncertain.fail("E-uncertain");
    expect(uncertain.snapshot()).toMatchObject({ processing: 0, failed: 1, blocked: expect.stringMatching(/failed/iu) });
    await uncertain.close();

    const failed = await SlackInbox.open(directory);
    await expect(failed.claimNextPrimary(controlEligible)).resolves.toBeUndefined();
    expect(failed.snapshot().failed).toBe(1);
    await failed.close();
  });

  it("durably bounds one primary and one control while preserving released order", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-primary"));
    await inbox.enqueue(event("E-probe"));
    await inbox.enqueue(action("E-control"));
    await inbox.enqueue(action("E-control-2"));

    await expect(inbox.claimNextPrimary(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-primary",
    });
    await expect(inbox.claimNextControl(
      (candidate) => candidate.envelopeId === "E-probe",
    )).resolves.toMatchObject({ envelopeId: "E-probe" });
    await expect(inbox.claimNextControl(controlEligible)).resolves.toBeUndefined();
    expect(inbox.snapshot()).toMatchObject({ pending: 2, processing: 2 });

    await inbox.release("E-probe");
    await inbox.complete("E-primary");
    await expect(inbox.claimNextControl(controlEligible)).resolves.toBeUndefined();
    await expect(inbox.claimNextPrimary(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-probe",
    });
    await inbox.complete("E-probe");
    await expect(inbox.claimNextControl(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-control",
    });
    await inbox.complete("E-control");
    await expect(inbox.claimNextControl(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-control-2",
    });
    await inbox.complete("E-control-2");
    expect(inbox.snapshot()).toMatchObject({ pending: 0, processing: 0, completed: 4 });
    await inbox.close();
  });

  it("atomically requeues both graceful-shutdown lanes without disturbing pending order", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-primary"));
    await inbox.enqueue(action("E-control"));
    await inbox.enqueue(event("E-pending"));
    await inbox.claimNextPrimary(controlEligible);
    await inbox.claimNextControl(controlEligible);

    await expect(inbox.requeueProcessingForShutdown([
      "E-primary",
      "E-control",
    ])).resolves.toBe(2);
    expect(inbox.inspectEntries()).toEqual([
      expect.objectContaining({ envelopeId: "E-primary", status: "pending" }),
      expect.objectContaining({ envelopeId: "E-control", status: "pending" }),
      expect.objectContaining({ envelopeId: "E-pending", status: "pending" }),
    ]);
    expect(inbox.inspectEntries().every((entry) => entry.lane === undefined)).toBe(true);
    await inbox.close();

    const reopened = await SlackInbox.open(directory);
    expect(reopened.snapshot()).toMatchObject({
      pending: 3,
      processing: 0,
      failed: 0,
    });
    expect(reopened.snapshot().blocked).toBeUndefined();
    await expect(reopened.claimNextPrimary(controlEligible)).resolves.toMatchObject({
      envelopeId: "E-primary",
    });
    await reopened.release("E-primary");
    await reopened.close();
  });

  it("refuses a second control lane and blocks restart on two stranded lanes", async () => {
    const directory = await dataDirectory();
    const inbox = await SlackInbox.open(directory);
    await inbox.enqueue(event("E-primary"));
    await inbox.enqueue(action("E-control"));
    await inbox.enqueue(action("E-second-control"));
    await inbox.claimNextPrimary(controlEligible);
    await inbox.claimNextControl(controlEligible);

    await expect(inbox.claimNextControl(controlEligible)).resolves.toBeUndefined();
    expect(inbox.snapshot()).toMatchObject({ pending: 1, processing: 2 });
    await inbox.close();

    const reopened = await SlackInbox.open(directory);
    expect(reopened.snapshot()).toMatchObject({
      pending: 1,
      processing: 2,
      blocked: expect.stringMatching(/uncertain|recovery/iu),
    });
    await expect(reopened.claimNextPrimary(controlEligible)).resolves.toBeUndefined();
    await expect(reopened.claimNextControl(controlEligible)).resolves.toBeUndefined();
    await expect(reopened.enqueue(event("E-new"))).rejects.toMatchObject({
      code: "blocked",
    });
    await reopened.close();
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

function action(envelopeId: string): SlackActionEvent {
  return {
    kind: "action",
    envelopeId,
    teamId: "T1",
    channelId: "C1",
    messageId: "1",
    threadId: "1",
    userId: "U1",
    actionId: "mono_agent_ask",
    value: "ask-token",
    receivedAt: new Date().toISOString(),
  };
}

function controlEligible(candidate: SlackSocketEvent): boolean {
  return candidate.kind === "action";
}

async function dataDirectory(): Promise<string> {
  return join(await temporaryRoot(), "inbox");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-slack-inbox-"));
  temporaryDirectories.push(root);
  return root;
}
