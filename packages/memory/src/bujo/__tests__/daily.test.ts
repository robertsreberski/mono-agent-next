import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appendAuditBullet,
  appendBullet,
  auditFilePath,
  dailyFilePath,
  normalizedContentHash,
  inspectJournalWriteLock,
  JOURNAL_WRITE_LOCK_STALE_AFTER_MS,
  withJournalWriteLock,
} from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import type { Bullet } from "../types.js";

describe("daily file", () => {
  it("computes the daily path from a date", () => {
    expect(dailyFilePath("/root", new Date("2026-06-15T23:00:00.000Z"))).toBe("/root/daily/2026-06-15.md");
  });

  it("appends a bullet and is re-parseable", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const bullet = appendBullet(root, {
      id: "01TESTID", type: "note", status: "open", text: "A captured fact.", salience: 0.6, isInsight: false, createdAt: now.toISOString(), refs: [],
    }, now);
    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets.map((b) => b.id)).toContain("01TESTID");
    expect(bullet.id).toBe("01TESTID");
  });

  it("does not duplicate the daily header on a second append", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const note = (id: string): Bullet => ({
      id, type: "note", status: "open", text: `fact ${id}`, salience: 0.5, isInsight: false, createdAt: now.toISOString(), refs: [],
    });
    appendBullet(root, note("01A"), now);
    appendBullet(root, note("01B"), now);
    const file = readFileSync(dailyFilePath(root, now), "utf8");
    expect((file.match(/^# 2026-06-15$/gmu) ?? []).length).toBe(1);
    expect(parseDailyFile(file).bullets.map((b) => b.id)).toEqual(["01A", "01B"]);
  });

  it("writes audit observations through a no-follow canonical file", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-audit-"));
    const outside = mkdtempSync(join(tmpdir(), "bujo-audit-outside-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    mkdirSync(join(root, "audit"));
    const outsideFile = join(outside, "audit.md");
    writeFileSync(outsideFile, "outside\n", "utf8");
    symlinkSync(outsideFile, auditFilePath(root, now));

    expect(() => appendAuditBullet(root, note("AUDIT"), now)).toThrow(/symlink|regular/iu);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  it("normalizes Unicode/whitespace for hashes without folding case-sensitive facts", () => {
    expect(normalizedContentHash("Token  ABC\nactive")).toBe(normalizedContentHash("Token ABC active"));
    expect(normalizedContentHash("Token ABC active")).not.toBe(normalizedContentHash("Token abc active"));
  });

  it("never steals a live lock or unlinks an identity-replaced lock", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-lock-"));
    expect(() => withJournalWriteLock(root, () => withJournalWriteLock(root, () => undefined))).toThrow(/held/i);

    const lockPath = join(root, ".journal-write.lock");
    withJournalWriteLock(root, () => {
      unlinkSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, replacement: true }), "utf8");
    });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does not follow or reclaim a symlinked journal lock", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-lock-"));
    const outside = join(mkdtempSync(join(tmpdir(), "bujo-lock-outside-")), "owner.json");
    writeFileSync(outside, JSON.stringify({ pid: 99_999_999 }), "utf8");
    symlinkSync(outside, join(root, ".journal-write.lock"));

    expect(() => withJournalWriteLock(root, () => undefined)).toThrow(/held|unverified/iu);
    expect(readFileSync(outside, "utf8")).toContain("99999999");
  });

  it("classifies live, fresh-acquisition, stale, and unsafe journal locks from one read-only contract", () => {
    const now = Date.now();
    const token = "00000000-0000-4000-8000-000000000000";

    const liveRoot = mkdtempSync(join(tmpdir(), "bujo-lock-live-"));
    writeFileSync(join(liveRoot, ".journal-write.lock"), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      token,
    })}\n`, { mode: 0o600 });
    expect(inspectJournalWriteLock(liveRoot, now)).toBe("active");

    const freshRoot = mkdtempSync(join(tmpdir(), "bujo-lock-fresh-"));
    const freshPath = join(freshRoot, ".journal-write.lock");
    writeFileSync(freshPath, "{}\n", { mode: 0o600 });
    utimesSync(freshPath, new Date(now), new Date(now));
    expect(inspectJournalWriteLock(freshRoot, now)).toBe("active");

    const staleRoot = mkdtempSync(join(tmpdir(), "bujo-lock-stale-"));
    const stalePath = join(staleRoot, ".journal-write.lock");
    writeFileSync(stalePath, "{}\n", { mode: 0o600 });
    const staleAt = now - JOURNAL_WRITE_LOCK_STALE_AFTER_MS;
    utimesSync(stalePath, new Date(staleAt), new Date(staleAt));
    expect(inspectJournalWriteLock(staleRoot, now)).toBe("stale");

    const unsafeRoot = mkdtempSync(join(tmpdir(), "bujo-lock-unsafe-"));
    const unsafePath = join(unsafeRoot, ".journal-write.lock");
    writeFileSync(unsafePath, "{}\n", { mode: 0o600 });
    chmodSync(unsafePath, 0o644);
    expect(inspectJournalWriteLock(unsafeRoot, now)).toBe("unsafe");
  });
});

function note(id: string): Bullet {
  return {
    id,
    type: "note",
    status: "open",
    text: `fact ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-06-15T09:00:00.000Z",
    refs: [],
  };
}

describe("createIdFactory", () => {
  it("is deterministic with injected clock+random and time-sortable", () => {
    const earlier = createIdFactory({ clock: () => new Date("2026-06-15T09:00:00.000Z"), random: () => 0 });
    const later = createIdFactory({ clock: () => new Date("2026-06-15T10:00:00.000Z"), random: () => 0 });
    const a = earlier();
    expect(earlier()).toBe(a); // same clock + random → identical id
    expect(a).toHaveLength(26); // 10 time chars + 16 random chars
    expect(later() > a).toBe(true); // later timestamp → lexicographically larger
  });
});
