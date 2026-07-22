import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSkillsCache, loadSelectedSkills, type LoadSelectedSkillsInput } from "../index.js";

const tempDirs: string[] = [];
async function createSkillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-cache-test-"));
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

describe("createSkillsCache", () => {
  it("loads from disk on the first call", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    const result = await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["writing"] });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.index).toEqual([
      { name: "writing", description: "Write concise plans.", mainFile: join(root, "writing", "SKILL.md") },
    ]);
  });

  it("returns the cached result without re-reading contents when nothing changed", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    const first = await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["writing", "research"] });
    const second = await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["writing", "research"] });

    // Loader (which reads file contents) is only invoked once across two calls.
    expect(loader).toHaveBeenCalledTimes(1);
    // Identical reference proves the cached object was returned, not a fresh load.
    expect(second).toBe(first);
  });

  it("invalidates and reloads when a selected skill source file mtime changes", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });
    const input: LoadSelectedSkillsInput = { skillsRoot: root, names: ["writing"] };

    const first = await cache.loadSelectedSkillsCached(input);
    expect(loader).toHaveBeenCalledTimes(1);

    // Rewrite the body and bump the mtime forward so it is observably newer.
    const skillFile = join(root, "writing", "SKILL.md");
    await writeFile(skillFile, "# Writing\n\nWrite very concise plans now.", "utf8");
    const future = new Date(Date.now() + 5_000);
    await utimes(skillFile, future, future);

    const second = await cache.loadSelectedSkillsCached(input);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.index[0]?.description).toBe("Write very concise plans now.");
  });

  it("treats a different selection of names as a cache miss", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["writing"] });
    await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["research"] });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("treats a different maxBytes as a cache miss", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["research"], maxBytes: 1_000 });
    await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["research"], maxBytes: 2_000 });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("preserves selection order in loaded output and treats a reversed order as a cache miss", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    const first = await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["writing", "research"] });
    expect(loader).toHaveBeenCalledTimes(1);
    // loaded follows input order; index is always sorted independent of input order.
    expect(first.loaded.map((skill) => skill.name)).toEqual(["writing", "research"]);
    expect(first.index.map((entry) => entry.name)).toEqual(["research", "writing"]);

    // Reversing the order changes the produced instructions/loaded, so it must be
    // a cache MISS (otherwise the wrong-ordered cached result would be returned).
    const second = await cache.loadSelectedSkillsCached({ skillsRoot: root, names: ["research", "writing"] });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(second.loaded.map((skill) => skill.name)).toEqual(["research", "writing"]);
    expect(second.index.map((entry) => entry.name)).toEqual(["research", "writing"]);
  });

  it("treats a cache entry whose source files all failed to stat as stale and reloads", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    // stat throws on every call, so the first load records no mtimes.
    const statSpy = vi.fn(async (_path: string): Promise<never> => {
      throw new Error("stat failed");
    });
    const cache = createSkillsCache({ loader, stat: statSpy as never });
    const input: LoadSelectedSkillsInput = { skillsRoot: root, names: ["writing"] };

    await cache.loadSelectedSkillsCached(input);
    expect(loader).toHaveBeenCalledTimes(1);

    // Empty mtimes for a non-empty selection must NOT be treated as fresh.
    await cache.loadSelectedSkillsCached(input);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("stats the selected skill source files on a cache hit (cheap, no content read)", async () => {
    const root = await createSkillsRoot();
    const loader = vi.fn(loadSelectedSkills);
    const statSpy = vi.fn((path: string) => stat(path));
    const cache = createSkillsCache({ loader, stat: statSpy });
    const input: LoadSelectedSkillsInput = { skillsRoot: root, names: ["writing"] };

    await cache.loadSelectedSkillsCached(input);
    statSpy.mockClear();
    await cache.loadSelectedSkillsCached(input);

    // On the hit we stat the selected skill's source file (mainFile) to validate mtime.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(statSpy).toHaveBeenCalledWith(join(root, "writing", "SKILL.md"));
  });

  it("returns empty context for an empty selection without invoking the loader path twice", async () => {
    const loader = vi.fn(loadSelectedSkills);
    const cache = createSkillsCache({ loader });

    const result = await cache.loadSelectedSkillsCached({ skillsRoot: "/not/read", names: [] });
    expect(result).toEqual({ index: [], instructions: [], loaded: [] });
  });
});
