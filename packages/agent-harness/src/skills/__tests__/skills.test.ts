import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadSelectedSkills, SkillActivationError } from "../index.js";

const tempDirs: string[] = [];
async function createSkillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-test-"));
  tempDirs.push(root);
  await mkdir(join(root, "research"));
  await writeFile(join(root, "research", "SKILL.md"), "# Research\n\nFind source-backed evidence.\n\nDetails.", "utf8");
  await mkdir(join(root, "writing"));
  await writeFile(join(root, "writing", "SKILL.md"), "# Writing\n\nWrite concise plans.", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadSelectedSkills", () => {
  it("loads only configured skill bodies and context blocks", async () => {
    const root = await createSkillsRoot();

    const result = await loadSelectedSkills({ skillsRoot: root, names: ["writing"] });

    expect(result.index).toEqual([
      { name: "writing", description: "Write concise plans.", mainFile: join(root, "writing", "SKILL.md") },
    ]);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.content).toContain("# Skill: writing");
    expect(result.instructions[0]?.content).toContain("Write concise plans.");
  });

  it("returns empty context when no skills are configured", async () => {
    const result = await loadSelectedSkills({ skillsRoot: "/not/read", names: [] });
    expect(result).toEqual({ index: [], instructions: [], loaded: [] });
  });

  it("fails readably when configured skill is missing", async () => {
    const root = await createSkillsRoot();
    await expect(loadSelectedSkills({ skillsRoot: root, names: ["missing"] })).rejects.toBeInstanceOf(SkillActivationError);
  });

  it("caps selected skill body reads", async () => {
    const root = await createSkillsRoot();
    const result = await loadSelectedSkills({ skillsRoot: root, names: ["research"], maxBytes: 256 });
    expect(result.loaded[0]?.truncated).toBe(false);
  });

  it("truncates skill bodies that exceed maxBytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-test-"));
    tempDirs.push(root);
    await mkdir(join(root, "long"));
    const body = `Long skill description paragraph.\n\n${"x".repeat(2000)}`;
    await writeFile(join(root, "long", "SKILL.md"), `# Long\n\n${body}`, "utf8");

    const result = await loadSelectedSkills({ skillsRoot: root, names: ["long"], maxBytes: 256 });

    expect(result.loaded[0]?.truncated).toBe(true);
    expect(result.loaded[0]?.content).toContain("<!-- truncated to first 256 bytes -->");
    expect(result.instructions[0]?.content).toContain("<!-- skill truncated by maxBytes -->");
  });

  it("keeps a skill body ending exactly at maxBytes untruncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-test-"));
    tempDirs.push(root);
    await mkdir(join(root, "exact"));
    const heading = "# Exact\n\n";
    const markdown = `${heading}${"a".repeat(256 - Buffer.byteLength(heading, "utf8") - 4)}🧠`;
    expect(Buffer.byteLength(markdown, "utf8")).toBe(256);
    await writeFile(join(root, "exact", "SKILL.md"), markdown, "utf8");

    const result = await loadSelectedSkills({ skillsRoot: root, names: ["exact"], maxBytes: 256 });

    expect(result.loaded[0]?.truncated).toBe(false);
    expect(result.loaded[0]?.content).toBe(markdown);
  });

  it("walks back a straddling UTF-8 sequence deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-test-"));
    tempDirs.push(root);
    await mkdir(join(root, "astral"));
    const heading = "# Astral\n\n";
    const safePrefix = `${heading}${"a".repeat(255 - Buffer.byteLength(heading, "utf8"))}`;
    const markdown = `${safePrefix}🧠tail`;
    await writeFile(join(root, "astral", "SKILL.md"), markdown, "utf8");

    const first = await loadSelectedSkills({ skillsRoot: root, names: ["astral"], maxBytes: 256 });
    const second = await loadSelectedSkills({ skillsRoot: root, names: ["astral"], maxBytes: 256 });
    const expected = `${safePrefix}\n<!-- truncated to first 256 bytes -->`;

    expect(first.loaded[0]?.truncated).toBe(true);
    expect(first.loaded[0]?.content).toBe(expected);
    expect(second.loaded[0]?.content).toBe(expected);
    expect(Buffer.byteLength(safePrefix, "utf8")).toBe(255);
    expect(first.loaded[0]?.content).not.toContain("�");
    expect(first.loaded[0]?.content).not.toMatch(/\p{Cs}/u);
  });

  it("rejects duplicate skill names", async () => {
    const root = await createSkillsRoot();
    const error = await loadSelectedSkills({ skillsRoot: root, names: ["research", "Research"] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SkillActivationError);
    expect((error as SkillActivationError).code).toBe("invalid_skill_selection");
  });

  it("rejects a non-integer or too-small maxBytes", async () => {
    const root = await createSkillsRoot();
    const error = await loadSelectedSkills({ skillsRoot: root, names: ["research"], maxBytes: 10 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SkillActivationError);
    expect((error as SkillActivationError).code).toBe("invalid_skill_selection");
  });

  it("surfaces skill_read_failed when a SKILL.md cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-test-"));
    tempDirs.push(root);
    // A directory named SKILL.md exists, so readFile fails with EISDIR (not ENOENT).
    await mkdir(join(root, "broken", "SKILL.md"), { recursive: true });

    const error = await loadSelectedSkills({ skillsRoot: root, names: ["broken"] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SkillActivationError);
    expect((error as SkillActivationError).code).toBe("skill_read_failed");
  });
});
