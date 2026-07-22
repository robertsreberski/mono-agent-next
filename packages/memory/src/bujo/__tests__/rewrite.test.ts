import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteBullet } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("rewriteBullet", () => {
  it("patches a bullet's status/text in place, preserving other lines", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    const file = "daily/2026-06-15.md";
    writeFileSync(join(root, file), [
      "# 2026-06-15", "",
      "- [ ] task one  <!--mem id=01A type=task status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "prose line",
      "- – note two  <!--mem id=01B type=note status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));
    const ok = rewriteBullet(root, file, "01A", { status: "done", text: "task one (done)" });
    expect(ok).toBe(true);
    const parsed = parseDailyFile(readFileSync(join(root, file), "utf8"));
    const a = parsed.bullets.find((b) => b.id === "01A");
    expect(a).toMatchObject({ status: "done", text: "task one (done)" });
    expect(parsed.bullets.find((b) => b.id === "01B")?.text).toBe("note two"); // untouched
    expect(readFileSync(join(root, file), "utf8")).toContain("prose line"); // prose preserved
  });

  it("returns false when the id is not present", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily/2026-06-15.md"), "# 2026-06-15\n");
    expect(rewriteBullet(root, "daily/2026-06-15.md", "nope", { status: "done" })).toBe(false);
  });

  it("supports the canonical root-level legacy YYYY-MM-DD.md source", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-legacy-"));
    const file = "2026-06-15.md";
    writeFileSync(join(root, file), [
      "# 2026-06-15", "",
      "- [ ] legacy task  <!--mem id=LEGACY type=task status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));

    expect(rewriteBullet(root, file, "LEGACY", { status: "done" })).toBe(true);
    expect(parseDailyFile(readFileSync(join(root, file), "utf8")).bullets[0]?.status).toBe("done");
  });

  it.each([
    "../outside.md",
    "daily/../../outside.md",
    "/tmp/outside.md",
    "daily/2026-06-15.md/extra",
    "daily/2026-02-30.md",
    "monthly/2026-06.md",
  ])("rejects non-canonical rewrite source %s", (file) => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-unsafe-"));
    expect(() => rewriteBullet(root, file, "01A", { status: "done" })).toThrow(/unsafe|rewrite source/iu);
  });

  it("rejects symlinked daily directories and source files", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-link-"));
    const outside = mkdtempSync(join(tmpdir(), "bujo-rw-outside-"));
    writeFileSync(join(outside, "2026-06-15.md"), "outside\n", "utf8");
    symlinkSync(outside, join(root, "daily"), "dir");
    expect(() => rewriteBullet(root, "daily/2026-06-15.md", "01A", { status: "done" })).toThrow(/directory.*symlink/iu);
    expect(readFileSync(join(outside, "2026-06-15.md"), "utf8")).toBe("outside\n");

    const root2 = mkdtempSync(join(tmpdir(), "bujo-rw-link-"));
    mkdirSync(join(root2, "daily"));
    symlinkSync(join(outside, "2026-06-15.md"), join(root2, "daily/2026-06-15.md"));
    expect(() => rewriteBullet(root2, "daily/2026-06-15.md", "01A", { status: "done" })).toThrow(/symlink|regular/iu);
    expect(readFileSync(join(outside, "2026-06-15.md"), "utf8")).toBe("outside\n");
  });
});
