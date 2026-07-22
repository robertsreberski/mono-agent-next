import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSlackChannelDriver } from "../channels.js";
import {
  appendPostedMessage,
  compactPostedMessageIndex,
  lookupProducingConversation,
  resolvePostedMessageIndexPath,
} from "../posted-message-index.js";

let dir: string;
let indexPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-post-index-"));
  indexPath = resolvePostedMessageIndexPath(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);
const DEFAULT_COMPACT_MAX_ENTRIES = 5000;
const DETERMINISTIC_ENTRY_START = Date.parse("2026-01-01T00:00:00.000Z");

function deterministicEntry(index: number): Record<string, string> {
  return {
    channelId: `C${String(index)}`,
    ts: `${String(index)}.0`,
    conversationId: `conv-${String(index)}`,
    writtenAt: new Date(DETERMINISTIC_ENTRY_START + index).toISOString(),
  };
}

function deterministicEntries(count: number): string {
  return `${Array.from({ length: count }, (_, index) =>
    JSON.stringify(deterministicEntry(index)),
  ).join("\n")}\n`;
}

function newestDeterministicEntries(total: number, count: number): string {
  return `${Array.from({ length: count }, (_, offset) =>
    JSON.stringify(deterministicEntry(total - offset - 1)),
  ).join("\n")}\n`;
}

function singleEntryWithByteLength(byteLength: number): string {
  const entry = {
    channelId: "C-cached",
    ts: "cached.1",
    conversationId: "x",
    writtenAt: "2025-01-01T00:00:00.000Z",
  };
  const minimum = `${JSON.stringify(entry)}\n`;
  const padding = byteLength - Buffer.byteLength(minimum);
  if (padding < 0) {
    throw new Error("Requested posted-message test entry is smaller than its JSON encoding.");
  }
  entry.conversationId += "x".repeat(padding);
  const encoded = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(encoded) !== byteLength) {
    throw new Error("Posted-message test entry did not reach its requested byte length.");
  }
  return encoded;
}

function legacyEntriesWithoutWrittenAt(count: number): string {
  return `${Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      channelId: `C${String(index)}`,
      ts: `${String(index)}.0`,
      conversationId: `conv-${String(index)}`,
    }),
  ).join("\n")}\n`;
}

function nonEmptyLineCount(raw: string): number {
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

async function plantAlias(
  kind: "hard link" | "symbolic link",
  target: string,
  candidate: string,
): Promise<void> {
  if (kind === "hard link") {
    await link(target, candidate);
    return;
  }
  await symlink(target, candidate);
}

async function pathFingerprint(path: string): Promise<Record<string, number>> {
  const info = await lstat(path);
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
  };
}

describe("posted-message-index", () => {
  it("round-trips a (channel, ts) → producing conversationId", async () => {
    await appendPostedMessage(indexPath, {
      channelId: "C100",
      ts: "170.000100",
      conversationId: "scheduled-scan",
    });

    expect(await lookupProducingConversation(indexPath, "C100", "170.000100")).toBe("scheduled-scan");
    expect(await lookupProducingConversation(indexPath, "C100", "999.000000")).toBeUndefined();
    expect(await lookupProducingConversation(indexPath, "C200", "170.000100")).toBeUndefined();
  });

  it("stores the de-bucketed base producing id", async () => {
    await appendPostedMessage(indexPath, {
      channelId: "C1",
      ts: "100.1",
      conversationId: "scheduled-scan#2026-06-22",
    });

    expect(await lookupProducingConversation(indexPath, "C1", "100.1")).toBe("scheduled-scan");
  });

  it("newest write wins for the same (channel, ts)", async () => {
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-old" }, at("2026-06-22T10:00:00Z"));
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-new" }, at("2026-06-22T11:00:00Z"));

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-new");
  });

  it("returns undefined when the file is missing", async () => {
    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBeUndefined();
  });

  it("skips malformed lines but still returns valid ones", async () => {
    await writeFile(
      indexPath,
      [
        "not json at all",
        JSON.stringify({ channelId: "C1", ts: "1.1", conversationId: "conv-a", writtenAt: "2026-06-22T10:00:00Z" }),
        "{ partial",
        "",
      ].join("\n"),
    );

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
  });

  it("creates the artifact dir on first append when it does not exist yet", async () => {
    const nested = resolvePostedMessageIndexPath(join(dir, "not", "made", "yet"));
    await appendPostedMessage(nested, { channelId: "C1", ts: "1.1", conversationId: "conv-a" });

    expect(await lookupProducingConversation(nested, "C1", "1.1")).toBe("conv-a");
  });

  it("two interleaved writers are both readable", async () => {
    await Promise.all([
      appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-a" }),
      appendPostedMessage(indexPath, { channelId: "C2", ts: "2.2", conversationId: "conv-b" }),
    ]);

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
    expect(await lookupProducingConversation(indexPath, "C2", "2.2")).toBe("conv-b");
  });

  it("waits for the same OS lock when another process owns the index", async () => {
    await appendPostedMessage(indexPath, {
      channelId: "C-seed",
      ts: "seed.1",
      conversationId: "conv-seed",
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { DatabaseSync } from "node:sqlite";',
          "const database = new DatabaseSync(process.argv[1]);",
          'database.exec("PRAGMA journal_mode=MEMORY");',
          'database.exec("BEGIN IMMEDIATE");',
          'process.stdout.write("locked\\n");',
          "setTimeout(() => { database.exec(\"ROLLBACK\"); database.close(); }, 180);",
        ].join("\n"),
        `${indexPath}.lock.sqlite`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exit = once(child, "exit");
    const [ready] = await once(child.stdout!, "data");
    expect(String(ready)).toContain("locked");

    const startedAt = Date.now();
    await appendPostedMessage(indexPath, {
      channelId: "C-process",
      ts: "process.1",
      conversationId: "conv-process",
    });
    const elapsedMs = Date.now() - startedAt;
    const [exitCode] = await exit;

    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(75);
    expect(await lookupProducingConversation(indexPath, "C-process", "process.1")).toBe("conv-process");
  });

  it.skipIf(process.platform === "win32")(
    "recovers the kernel lock and reconciles bounded state after a lock holder is killed",
    async () => {
      const cap = 10;
      await appendPostedMessage(
        indexPath,
        { channelId: "C-seed", ts: "seed.1", conversationId: "conv-seed" },
        at("2026-12-31T00:00:00.000Z"),
        cap,
      );
      // Preserve the secure inode but invalidate the in-process size hint, so the
      // post-crash writer must reconcile from JSONL before compacting.
      await writeFile(indexPath, deterministicEntries(cap), "utf8");

      let child: ReturnType<typeof spawn> | undefined = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            'import { DatabaseSync } from "node:sqlite";',
            "const database = new DatabaseSync(process.argv[1]);",
            'database.exec("PRAGMA journal_mode=MEMORY");',
            'database.exec("BEGIN IMMEDIATE");',
            'process.stdout.write("locked\\n");',
            "setInterval(() => undefined, 1_000);",
          ].join("\n"),
          `${indexPath}.lock.sqlite`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const exit = once(child, "exit");
        const [ready] = await once(child.stdout!, "data");
        expect(String(ready)).toContain("locked");

        expect(child.kill("SIGKILL")).toBe(true);
        const [exitCode, signal] = await exit;
        child = undefined;
        expect(exitCode).toBeNull();
        expect(signal).toBe("SIGKILL");

        const reacquireStartedAt = Date.now();
        await appendPostedMessage(
          indexPath,
          { channelId: "C-after-kill", ts: "kill.1", conversationId: "conv-after-kill" },
          at("2027-01-01T00:00:00.000Z"),
          cap,
        );
        expect(Date.now() - reacquireStartedAt).toBeLessThan(1_500);

        const raw = await readFile(indexPath, "utf8");
        const lines = raw.split("\n").filter((line) => line.length > 0);
        expect(lines.length).toBeLessThanOrEqual(cap);
        expect(lines.every((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        })).toBe(true);
        expect(await lookupProducingConversation(indexPath, "C-after-kill", "kill.1"))
          .toBe("conv-after-kill");
        expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBeUndefined();
      } finally {
        child?.kill("SIGKILL");
      }
    },
  );

  it("compaction keeps the newest entries, de-dupes, and stays parseable", async () => {
    for (let i = 0; i < 10; i++) {
      const minute = String(i).padStart(2, "0");
      await appendPostedMessage(
        indexPath,
        { channelId: "C1", ts: `${String(i)}.0`, conversationId: `conv-${String(i)}` },
        at(`2026-06-22T10:${minute}:00Z`),
      );
    }
    // A newer re-sighting of an older ts must survive de-dup.
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "0.0", conversationId: "conv-0-new" }, at("2026-06-22T12:00:00Z"));

    await compactPostedMessageIndex(indexPath, 3);

    const lines = (await readFile(indexPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    // Newest three by write time: the re-sighting (12:00), then 10:09, then 10:08.
    expect(await lookupProducingConversation(indexPath, "C1", "0.0")).toBe("conv-0-new");
    expect(await lookupProducingConversation(indexPath, "C1", "9.0")).toBe("conv-9");
    expect(await lookupProducingConversation(indexPath, "C1", "8.0")).toBe("conv-8");
    // Trimmed out.
    expect(await lookupProducingConversation(indexPath, "C1", "5.0")).toBeUndefined();
  });

  it("compaction is a no-op below the cap", async () => {
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-a" });
    await compactPostedMessageIndex(indexPath, 100);
    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
  });

  it("runs exported compaction at Slack-driver startup before adapter transport", async () => {
    await writeFile(indexPath, deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES + 1), "utf8");
    let countSeenByAdapter = Number.POSITIVE_INFINITY;
    const driver = createSlackChannelDriver({
      startAdapter: async () => {
        countSeenByAdapter = nonEmptyLineCount(await readFile(indexPath, "utf8"));
        return {
          stop: async () => undefined,
          adapter: { notify: async () => ({ delivered: true }) },
        } as never;
      },
    });

    const running = await driver.start({
      config: {
        enabled: true,
        botToken: "offline-test-bot-token",
        appToken: "offline-test-app-token",
        allowedChannelIds: ["C1"],
        allowAllChannels: false,
        botUserIds: [],
        mentionTextAliases: [],
        stripMentionText: false,
      } as never,
      coreConfig: { tools: { allowedTools: [], disallowedTools: [] } } as never,
      responder: {} as never,
      cwd: dir,
      postedMessageIndexPath: indexPath,
      onFailure: () => undefined,
    });

    expect(countSeenByAdapter).toBe(DEFAULT_COMPACT_MAX_ENTRIES);
    await running.stop();
  });

  it("enforces the default cap in the production append path after reopening a full index", async () => {
    await writeFile(indexPath, deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES), "utf8");

    await appendPostedMessage(
      indexPath,
      { channelId: "C-reopen", ts: "reopen.1", conversationId: "conv-reopen" },
      at("2027-01-01T00:00:00.000Z"),
    );

    const count = nonEmptyLineCount(await readFile(indexPath, "utf8"));
    expect(count).toBeLessThanOrEqual(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(count).toBeLessThan(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(await lookupProducingConversation(indexPath, "C-reopen", "reopen.1")).toBe("conv-reopen");
    expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBeUndefined();
  });

  it("invalidates a cached count after child compaction rewrites the same inode to the same size", async () => {
    const childEntryTotal = DEFAULT_COMPACT_MAX_ENTRIES + 1;
    const childCompacted = newestDeterministicEntries(
      childEntryTotal,
      DEFAULT_COMPACT_MAX_ENTRIES,
    );
    const cachedSingleEntry = singleEntryWithByteLength(Buffer.byteLength(childCompacted));
    await writeFile(indexPath, cachedSingleEntry, "utf8");

    // A no-op compaction securely snapshots and caches count=1 in this process.
    await compactPostedMessageIndex(indexPath);
    const cachedIdentity = await stat(indexPath);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(1);

    const builtModuleUrl = new URL("../../dist/posted-message-index.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { writeFile } from "node:fs/promises";',
          "const start = Date.parse(\"2026-01-01T00:00:00.000Z\");",
          "const count = Number(process.argv[3]);",
          "const body = `${Array.from({ length: count }, (_, index) => JSON.stringify({",
          "  channelId: `C${String(index)}` ,",
          "  ts: `${String(index)}.0`,",
          "  conversationId: `conv-${String(index)}` ,",
          "  writtenAt: new Date(start + index).toISOString(),",
          '})).join("\\n")}\\n`;',
          "await writeFile(process.argv[2], body, \"utf8\");",
          "const { compactPostedMessageIndex } = await import(process.argv[1]);",
          "await compactPostedMessageIndex(process.argv[2]);",
        ].join("\n"),
        builtModuleUrl,
        indexPath,
        String(childEntryTotal),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let childStderr = "";
    child.stderr?.on("data", (chunk) => {
      childStderr += String(chunk);
    });
    const [exitCode, signal] = await once(child, "exit");
    expect({ exitCode, signal, childError: exitCode === 0 ? "" : childStderr }).toEqual({
      exitCode: 0,
      signal: null,
      childError: "",
    });

    const rewrittenIdentity = await stat(indexPath);
    const rewritten = await readFile(indexPath, "utf8");
    expect(rewrittenIdentity.dev).toBe(cachedIdentity.dev);
    expect(rewrittenIdentity.ino).toBe(cachedIdentity.ino);
    expect(rewrittenIdentity.size).toBe(cachedIdentity.size);
    expect(rewritten).toBe(childCompacted);
    expect(nonEmptyLineCount(rewritten)).toBe(DEFAULT_COMPACT_MAX_ENTRIES);

    await appendPostedMessage(
      indexPath,
      { channelId: "C-parent", ts: "parent.1", conversationId: "conv-parent" },
      at("2027-01-01T00:00:00.000Z"),
    );

    // A stale count=1 cache would append directly and produce 5,001 lines.
    // Freshness invalidation forces a recount and the normal 10% headroom rewrite.
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(4_501);
    expect(await lookupProducingConversation(indexPath, "C-parent", "parent.1"))
      .toBe("conv-parent");
  });

  it("stays bounded across many completed writes and multiple amortized compactions", async () => {
    const cap = 50;
    const observedCounts: number[] = [];
    for (let index = 0; index < 120; index++) {
      await appendPostedMessage(
        indexPath,
        {
          channelId: `C-long-${String(index)}`,
          ts: `long.${String(index)}`,
          conversationId: `conv-long-${String(index)}`,
        },
        at(new Date(Date.parse("2027-02-01T00:00:00.000Z") + index).toISOString()),
        cap,
      );
      const count = nonEmptyLineCount(await readFile(indexPath, "utf8"));
      observedCounts.push(count);
      expect(count).toBeLessThanOrEqual(cap);
    }

    const compactionCount = observedCounts.filter(
      (count, index) => index > 0 && count < (observedCounts[index - 1] ?? 0),
    ).length;
    expect(compactionCount).toBeGreaterThan(1);
    expect(await lookupProducingConversation(indexPath, "C-long-119", "long.119")).toBe("conv-long-119");
    expect(await lookupProducingConversation(indexPath, "C-long-0", "long.0")).toBeUndefined();
  });

  it("serializes an append behind compaction so the descriptor rewrite cannot lose it", async () => {
    await writeFile(indexPath, deterministicEntries(10), "utf8");
    let releaseReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      releaseReplace = resolve;
    });
    let reachedReplace!: () => void;
    const replaceReached = new Promise<void>((resolve) => {
      reachedReplace = resolve;
    });
    const compaction = compactPostedMessageIndex(indexPath, 3, {
      beforeReplace: async () => {
        reachedReplace();
        await replaceGate;
      },
    });
    await replaceReached;

    let appendSettled = false;
    const append = appendPostedMessage(
      indexPath,
      { channelId: "C-race", ts: "race.1", conversationId: "conv-race" },
      at("2027-03-01T00:00:00.000Z"),
      3,
    ).finally(() => {
      appendSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settledWhileReplacePaused = appendSettled;
    releaseReplace();
    await Promise.all([compaction, append]);

    expect(settledWhileReplacePaused).toBe(false);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBeLessThanOrEqual(3);
    expect(await lookupProducingConversation(indexPath, "C-race", "race.1")).toBe("conv-race");
  });

  it("refuses to replace a destination inode swapped during compaction", async () => {
    const original = deterministicEntries(10);
    const replacement = deterministicEntries(2);
    const originalBackup = join(dir, "original-index-backup.jsonl");
    await writeFile(indexPath, original, "utf8");

    await compactPostedMessageIndex(indexPath, 3, {
      beforeReplace: async () => {
        await rename(indexPath, originalBackup);
        await writeFile(indexPath, replacement, { encoding: "utf8", mode: 0o600 });
      },
    });

    expect(await readFile(originalBackup, "utf8")).toBe(original);
    expect(await readFile(indexPath, "utf8")).toBe(replacement);
  });

  it("cannot install a source inode swapped after the final promotion checks", async () => {
    const original = deterministicEntries(10);
    const savedOriginal = join(dir, "saved-original-index.jsonl");
    const attacker = "ATTACKER-CONTENT\n";
    let attackerFingerprint: Record<string, number> | undefined;
    await writeFile(indexPath, original, "utf8");
    const originalIndexFingerprint = await pathFingerprint(indexPath);

    await compactPostedMessageIndex(indexPath, 3, {
      afterPromotionChecks: async (path) => {
        expect(path).toBe(indexPath);
        await rename(path, savedOriginal);
        await writeFile(path, attacker, { encoding: "utf8", mode: 0o600 });
        attackerFingerprint = await pathFingerprint(path);
      },
    });

    const compactedOriginalFingerprint = await pathFingerprint(savedOriginal);
    expect(compactedOriginalFingerprint).toMatchObject({
      dev: originalIndexFingerprint.dev,
      ino: originalIndexFingerprint.ino,
      mode: originalIndexFingerprint.mode,
      nlink: originalIndexFingerprint.nlink,
    });
    expect(nonEmptyLineCount(await readFile(savedOriginal, "utf8"))).toBe(3);
    expect(await readFile(savedOriginal, "utf8")).not.toContain("ATTACKER-CONTENT");
    expect(await readFile(indexPath, "utf8")).toBe(attacker);
    expect(await pathFingerprint(indexPath)).toEqual(attackerFingerprint);
  });

  it("does not overwrite or unlink a destination hard link raced after final checks", async () => {
    const original = deterministicEntries(10);
    const originalBackup = join(dir, "post-check-original-index.jsonl");
    const victimPath = join(dir, "post-check-destination-victim.txt");
    const victim = "destination victim must remain byte-identical\n";
    let racedCandidateFingerprint: Record<string, number> | undefined;
    let racedVictimFingerprint: Record<string, number> | undefined;
    await writeFile(indexPath, original, "utf8");
    await writeFile(victimPath, victim, { encoding: "utf8", mode: 0o600 });

    await compactPostedMessageIndex(indexPath, 3, {
      afterPromotionChecks: async () => {
        await rename(indexPath, originalBackup);
        await link(victimPath, indexPath);
        racedCandidateFingerprint = await pathFingerprint(indexPath);
        racedVictimFingerprint = await pathFingerprint(victimPath);
      },
    });

    expect(await readFile(indexPath, "utf8")).toBe(victim);
    expect(await readFile(victimPath, "utf8")).toBe(victim);
    expect(await pathFingerprint(indexPath)).toEqual(racedCandidateFingerprint);
    expect(await pathFingerprint(victimPath)).toEqual(racedVictimFingerprint);
    expect(racedVictimFingerprint?.nlink).toBe(2);
    expect(nonEmptyLineCount(await readFile(originalBackup, "utf8"))).toBe(3);
  });

  it.skipIf(process.platform === "win32")(
    "preserves a production append across a coordinator split during prepare",
    async () => {
      await writeFile(indexPath, deterministicEntries(10), "utf8");
      const lockPath = `${indexPath}.lock.sqlite`;
      const savedLockPath = `${lockPath}.pre-split`;
      const builtModuleUrl = new URL("../../dist/posted-message-index.js", import.meta.url).href;

      await compactPostedMessageIndex(indexPath, 3, {
        afterPrepareBody: async () => {
          await rename(lockPath, savedLockPath);
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              [
                "const { appendPostedMessage } = await import(process.argv[1]);",
                "await appendPostedMessage(process.argv[2], {",
                '  channelId: "C-split",',
                '  ts: "split.1",',
                '  conversationId: "conv-split",',
                "});",
              ].join("\n"),
              builtModuleUrl,
              indexPath,
            ],
            { stdio: ["ignore", "ignore", "ignore"] },
          );
          const [exitCode, signal] = await once(child, "exit");
          expect(exitCode).toBe(0);
          expect(signal).toBeNull();
        },
      });

      expect(await lookupProducingConversation(indexPath, "C-split", "split.1"))
        .toBe("conv-split");
      await compactPostedMessageIndex(indexPath, 3);
      expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(3);
      expect(await lookupProducingConversation(indexPath, "C-split", "split.1"))
        .toBe("conv-split");
      expect((await stat(savedLockPath)).nlink).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a coordinator split after the final promotion checks",
    async () => {
      await writeFile(indexPath, deterministicEntries(10), "utf8");
      const lockPath = `${indexPath}.lock.sqlite`;
      const savedLockPath = `${lockPath}.post-check-split`;
      const builtModuleUrl = new URL("../../dist/posted-message-index.js", import.meta.url).href;

      await compactPostedMessageIndex(indexPath, 3, {
        afterPromotionChecks: async () => {
          await rename(lockPath, savedLockPath);
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              [
                "const { appendPostedMessage } = await import(process.argv[1]);",
                "await appendPostedMessage(process.argv[2], {",
                '  channelId: "C-post-check-split",',
                '  ts: "split.2",',
                '  conversationId: "conv-post-check-split",',
                "});",
              ].join("\n"),
              builtModuleUrl,
              indexPath,
            ],
            { stdio: ["ignore", "ignore", "ignore"] },
          );
          const [exitCode, signal] = await once(child, "exit");
          expect(exitCode).toBe(0);
          expect(signal).toBeNull();
        },
      });

      expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(3);
      expect(await lookupProducingConversation(indexPath, "C-post-check-split", "split.2"))
        .toBeUndefined();

      await appendPostedMessage(indexPath, {
        channelId: "C-post-check-split",
        ts: "split.2",
        conversationId: "conv-post-check-split",
      });
      expect(await lookupProducingConversation(indexPath, "C-post-check-split", "split.2"))
        .toBe("conv-post-check-split");
      expect((await stat(savedLockPath)).nlink).toBe(1);
    },
  );

  it("recovers a durable prepared compaction before the next locked reader", async () => {
    const original = deterministicEntries(10);
    await writeFile(indexPath, original, "utf8");

    await compactPostedMessageIndex(indexPath, 3, {
      afterPromotionChecks: async () => {
        throw new Error("simulate process death after durable prepare");
      },
    });
    expect((await stat(indexPath)).size).toBeGreaterThan(Buffer.byteLength(original));

    expect(await lookupProducingConversation(indexPath, "C9", "9.0")).toBe("conv-9");
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(3);
    expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "recovers an expanding compaction killed after its replacement prefix is durable",
    async () => {
      const original = legacyEntriesWithoutWrittenAt(10);
      const expandedBody = `${Array.from({ length: 9 }, (_, index) =>
        JSON.stringify({
          channelId: `C${String(index)}`,
          ts: `${String(index)}.0`,
          conversationId: `conv-${String(index)}`,
          writtenAt: "",
        }),
      ).join("\n")}\n`;
      expect(Buffer.byteLength(expandedBody)).toBeGreaterThan(Buffer.byteLength(original));
      await writeFile(indexPath, original, "utf8");
      const builtModuleUrl = new URL("../../dist/posted-message-index.js", import.meta.url).href;
      let child: ReturnType<typeof spawn> | undefined = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "const { compactPostedMessageIndex } = await import(process.argv[1]);",
            "await compactPostedMessageIndex(process.argv[2], 9, {",
            "  afterRewriteSync: async () => {",
            '    process.stdout.write("prefix-synced\\n");',
            "    setInterval(() => undefined, 1_000);",
            "    await new Promise(() => undefined);",
            "  },",
            "});",
          ].join("\n"),
          builtModuleUrl,
          indexPath,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const exit = once(child, "exit");
        const [ready] = await once(child.stdout!, "data");
        expect(String(ready)).toContain("prefix-synced");

        expect(child.kill("SIGKILL")).toBe(true);
        const [exitCode, signal] = await exit;
        child = undefined;
        expect(exitCode).toBeNull();
        expect(signal).toBe("SIGKILL");
        expect((await stat(indexPath)).size).toBeGreaterThan(Buffer.byteLength(original));

        expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBe("conv-0");
        expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(9);
      } finally {
        child?.kill("SIGKILL");
      }
    },
  );

  it("retries safely after compaction is interrupted before the commit footer", async () => {
    const original = deterministicEntries(10);
    await writeFile(indexPath, original, "utf8");

    await compactPostedMessageIndex(indexPath, 3, {
      afterPrepareBody: async () => {
        throw new Error("simulate death before the commit footer");
      },
    });

    expect((await readFile(indexPath, "utf8")).startsWith(original)).toBe(true);
    expect(await lookupProducingConversation(indexPath, "C9", "9.0")).toBe("conv-9");

    await compactPostedMessageIndex(indexPath, 3);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(3);
    expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBeUndefined();
  });

  it("terminates an incomplete non-newline trailer before the next append", async () => {
    const tornTrailer = '{"marker":"mono-agent-posted-index-compaction"';
    await writeFile(indexPath, `${deterministicEntries(3)}${tornTrailer}`, "utf8");

    await appendPostedMessage(
      indexPath,
      { channelId: "C-after-torn", ts: "torn.1", conversationId: "conv-after-torn" },
      at("2027-03-02T00:00:00.000Z"),
      10,
    );

    const raw = await readFile(indexPath, "utf8");
    expect(raw).toContain(`${tornTrailer}\n{`);
    expect(await lookupProducingConversation(indexPath, "C-after-torn", "torn.1"))
      .toBe("conv-after-torn");
  });

  it("preserves the original index when compaction fails", async () => {
    const original = deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES + 1);
    await writeFile(indexPath, original, "utf8");

    await compactPostedMessageIndex(indexPath, DEFAULT_COMPACT_MAX_ENTRIES, {
      beforePrepare: async () => {
        throw new Error("injected prepare failure");
      },
    });

    expect(await readFile(indexPath, "utf8")).toBe(original);

    await compactPostedMessageIndex(indexPath);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8")))
      .toBe(DEFAULT_COMPACT_MAX_ENTRIES);
  });

  it("does not append past the cap when amortized compaction fails", async () => {
    const original = deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES);
    await writeFile(indexPath, original, "utf8");
    await appendPostedMessage(
      indexPath,
      { channelId: "C-failed", ts: "failed.1", conversationId: "conv-failed" },
      at("2027-04-01T00:00:00.000Z"),
      DEFAULT_COMPACT_MAX_ENTRIES,
      {
        beforePrepare: async () => {
          throw new Error("injected prepare failure");
        },
      },
    );

    expect(await readFile(indexPath, "utf8")).toBe(original);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(await lookupProducingConversation(indexPath, "C-failed", "failed.1")).toBeUndefined();
  });

  for (const kind of ["symbolic link", "hard link"] as const) {
    it(`rejects a pre-planted ${kind} at the index path without touching its victim`, async () => {
      const victimPath = join(dir, `index-${kind.replace(" ", "-")}-victim.txt`);
      const victim = `index ${kind} victim\n`;
      await writeFile(victimPath, victim, "utf8");
      await plantAlias(kind, victimPath, indexPath);
      const victimBefore = await pathFingerprint(victimPath);
      const candidateBefore = await pathFingerprint(indexPath);

      await appendPostedMessage(indexPath, {
        channelId: "C-attacker",
        ts: "attack.1",
        conversationId: "conv-attacker",
      });

      expect(await readFile(victimPath, "utf8")).toBe(victim);
      expect(await readFile(indexPath, "utf8")).toBe(victim);
      expect(await pathFingerprint(victimPath)).toEqual(victimBefore);
      expect(await pathFingerprint(indexPath)).toEqual(candidateBefore);
    });
    it(`rejects a pre-planted ${kind} at the SQLite coordinator without touching index or victim`, async () => {
      const original = deterministicEntries(3);
      const victimPath = join(dir, `lock-${kind.replace(" ", "-")}-victim.txt`);
      const victim = `lock ${kind} victim\n`;
      await writeFile(indexPath, original, "utf8");
      await writeFile(victimPath, victim, "utf8");
      const candidatePath = `${indexPath}.lock.sqlite`;
      await plantAlias(kind, victimPath, candidatePath);
      const victimBefore = await pathFingerprint(victimPath);
      const candidateBefore = await pathFingerprint(candidatePath);

      await compactPostedMessageIndex(indexPath, 1);

      expect(await readFile(victimPath, "utf8")).toBe(victim);
      expect(await readFile(indexPath, "utf8")).toBe(original);
      expect(await pathFingerprint(victimPath)).toEqual(victimBefore);
      expect(await pathFingerprint(candidatePath)).toEqual(candidateBefore);
    });

    it(`rejects a pre-planted ${kind} at a SQLite journal path without touching index or victim`, async () => {
      const original = deterministicEntries(3);
      const victimPath = join(dir, `journal-${kind.replace(" ", "-")}-victim.txt`);
      const victim = `journal ${kind} victim\n`;
      await writeFile(indexPath, original, "utf8");
      await writeFile(victimPath, victim, "utf8");
      const candidatePath = `${indexPath}.lock.sqlite-journal`;
      await plantAlias(kind, victimPath, candidatePath);
      const victimBefore = await pathFingerprint(victimPath);
      const candidateBefore = await pathFingerprint(candidatePath);

      await compactPostedMessageIndex(indexPath, 1);

      expect(await readFile(victimPath, "utf8")).toBe(victim);
      expect(await readFile(indexPath, "utf8")).toBe(original);
      expect(await pathFingerprint(victimPath)).toEqual(victimBefore);
      expect(await pathFingerprint(candidatePath)).toEqual(candidateBefore);
    });

  }

  it.skipIf(process.platform === "win32")(
    "fails closed in a group-writable artifact directory before creating coordinator paths",
    async () => {
      const original = deterministicEntries(3);
      await writeFile(indexPath, original, { encoding: "utf8", mode: 0o600 });
      await chmod(dir, 0o770);
      try {
        await compactPostedMessageIndex(indexPath, 1);
        expect(await readFile(indexPath, "utf8")).toBe(original);
        await expect(lstat(`${indexPath}.lock.sqlite`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await chmod(dir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the index and coordinator owner-only without SQLite sidecars",
    async () => {
      await appendPostedMessage(indexPath, {
        channelId: "C-secure",
        ts: "secure.1",
        conversationId: "conv-secure",
      });
      await appendPostedMessage(indexPath, {
        channelId: "C-secure",
        ts: "secure.2",
        conversationId: "conv-secure",
      });
      await compactPostedMessageIndex(indexPath, 1);

      const indexInfo = await stat(indexPath);
      const lockInfo = await stat(`${indexPath}.lock.sqlite`);
      const directoryInfo = await stat(dir);
      expect(directoryInfo.mode & 0o777).toBe(0o700);
      expect(indexInfo.mode & 0o777).toBe(0o600);
      expect(indexInfo.nlink).toBe(1);
      expect(lockInfo.mode & 0o777).toBe(0o600);
      expect(lockInfo.nlink).toBe(1);
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        await expect(lstat(`${indexPath}.lock.sqlite${suffix}`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );
});
