import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendCanonicalFile,
  assertCanonicalRelativePath,
  listCanonicalFileNames,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "../path-safety.js";

function tempRoot(prefix = "bujo-path-safety-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("canonical memory path safety", () => {
  it("rejects a configured root that is itself a symlink", () => {
    const base = tempRoot();
    const outside = tempRoot("bujo-path-outside-");
    const linkedRoot = join(base, "memory-link");
    symlinkSync(outside, linkedRoot, "dir");

    expect(() => appendCanonicalFile(linkedRoot, "daily/2026-07-11.md", "private\n")).toThrow(/root.*symlink/iu);
    expect(existsSync(join(outside, "daily/2026-07-11.md"))).toBe(false);
  });

  it("rejects a symlink in the configured root ancestor chain", () => {
    const base = tempRoot();
    const outside = tempRoot("bujo-path-outside-");
    symlinkSync(outside, join(base, "linked-parent"), "dir");
    const configuredRoot = join(base, "linked-parent", "memory");

    expect(() => appendCanonicalFile(configuredRoot, "daily/2026-07-11.md", "private\n")).toThrow(/root ancestor.*symlink/iu);
    expect(existsSync(join(outside, "memory"))).toBe(false);
  });

  it("rejects symlinked canonical directory ancestors", () => {
    const root = tempRoot();
    const outside = tempRoot("bujo-path-outside-");
    symlinkSync(outside, join(root, "daily"), "dir");

    expect(() => appendCanonicalFile(root, "daily/2026-07-11.md", "private\n")).toThrow(/directory.*symlink/iu);
    expect(existsSync(join(outside, "2026-07-11.md"))).toBe(false);
  });

  it("lists only canonical regular single-link files and rejects directory/file indirection", () => {
    const root = tempRoot();
    const outside = tempRoot("bujo-path-outside-");
    mkdirSync(join(root, "daily"));
    const secret = join(outside, "2026-07-11.md");
    writeFileSync(secret, "outside\n", "utf8");
    symlinkSync(secret, join(root, "daily/2026-07-11.md"));

    expect(() => listCanonicalFileNames(root, "daily", { include: (name) => name.endsWith(".md") }))
      .toThrow(/symlink|regular/iu);

    renameSync(join(root, "daily"), join(root, "linked-daily"));
    symlinkSync(outside, join(root, "daily"), "dir");
    expect(() => listCanonicalFileNames(root, "daily")).toThrow(/directory.*symlink/iu);
    expect(() => listCanonicalFileNames(root, "../outside")).toThrow(/unsafe canonical relative path/iu);

    const hardLinkRoot = tempRoot();
    mkdirSync(join(hardLinkRoot, "daily"));
    linkSync(secret, join(hardLinkRoot, "daily/2026-07-12.md"));
    expect(() => listCanonicalFileNames(hardLinkRoot, "daily")).toThrow(/single-link/iu);
  });

  it("rejects symlink and hard-link file targets without changing their referents", () => {
    const root = tempRoot();
    const outside = tempRoot("bujo-path-outside-");
    mkdirSync(join(root, "daily"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "unchanged\n", "utf8");
    symlinkSync(secret, join(root, "daily/2026-07-11.md"));

    expect(() => appendCanonicalFile(root, "daily/2026-07-11.md", "private\n")).toThrow(/symlink|regular/iu);
    expect(readFileSync(secret, "utf8")).toBe("unchanged\n");

    const hardLinked = join(root, "daily/2026-07-12.md");
    linkSync(secret, hardLinked);
    expect(() => appendCanonicalFile(root, "daily/2026-07-12.md", "private\n")).toThrow(/single-link/iu);
    expect(readFileSync(secret, "utf8")).toBe("unchanged\n");
  });

  it.each([
    "../escape.md",
    "daily/../../escape.md",
    "/tmp/escape.md",
    "daily//2026-07-11.md",
    "daily\\2026-07-11.md",
    "C:\\escape.md",
  ])("rejects non-canonical relative path %s", (path) => {
    expect(() => assertCanonicalRelativePath(path)).toThrow(/unsafe canonical relative path/iu);
  });

  it("compare-and-swap replacement rejects an identity-changed source", () => {
    const root = tempRoot();
    writeCanonicalFileAtomic(root, "daily/2026-07-11.md", "original\n");
    const snapshot = readCanonicalFileSnapshot(root, "daily/2026-07-11.md")!;
    const target = join(root, "daily/2026-07-11.md");
    renameSync(target, join(root, "daily/old.md"));
    writeFileSync(target, "replacement\n", { mode: 0o600 });

    expect(() => writeCanonicalFileAtomic(
      root,
      "daily/2026-07-11.md",
      "unsafe overwrite\n",
      snapshot.identity,
    )).toThrow(/replaced before rewrite/iu);
    expect(readFileSync(target, "utf8")).toBe("replacement\n");
  });

  it("compare-and-swap append rejects replacement and exclusive append rejects an existing name", () => {
    const root = tempRoot();
    appendCanonicalFile(root, "ledger/aa.log", "first\n", { requireMissing: true });
    expect(() => appendCanonicalFile(root, "ledger/aa.log", "duplicate\n", { requireMissing: true }))
      .toThrow(/already exists|EEXIST/iu);
    const snapshot = readCanonicalFileSnapshot(root, "ledger/aa.log")!;
    const target = join(root, "ledger/aa.log");
    renameSync(target, join(root, "ledger/old.log"));
    writeFileSync(target, "replacement\n", { mode: 0o600 });

    expect(() => appendCanonicalFile(root, "ledger/aa.log", "unsafe\n", {
      expectedIdentity: snapshot.identity,
    })).toThrow(/changed before append/iu);
    expect(readFileSync(target, "utf8")).toBe("replacement\n");
  });

  it("rejects a canonical append whose target is replaced after opening but before return", () => {
    const root = tempRoot();
    appendCanonicalFile(root, "ledger/aa.log", "first\n", { requireMissing: true });
    const snapshot = readCanonicalFileSnapshot(root, "ledger/aa.log")!;
    const target = join(root, "ledger/aa.log");
    const retired = join(root, "ledger/retired.log");

    expect(() => appendCanonicalFile(root, "ledger/aa.log", () => {
      renameSync(target, retired);
      writeFileSync(target, "replacement\n", { mode: 0o600 });
      return "unsafe\n";
    }, { expectedIdentity: snapshot.identity })).toThrow(/replaced during access/iu);
    expect(readFileSync(target, "utf8")).toBe("replacement\n");
  });

  it("atomic replacement refuses a symlink target", () => {
    const root = tempRoot();
    const outside = join(tempRoot("bujo-path-outside-"), "index.md");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, join(root, "index.md"));

    expect(() => writeCanonicalFileAtomic(root, "index.md", "inside\n")).toThrow(/symlink|regular/iu);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("creates a missing real root and canonical parent chain", () => {
    const base = tempRoot();
    const root = join(base, "nested", "memory");
    appendCanonicalFile(root, "audit/2026-07-11.md", "safe\n");
    expect(readFileSync(join(root, "audit/2026-07-11.md"), "utf8")).toBe("safe\n");
  });
});
