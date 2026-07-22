import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";
import { installComposerSkill } from "../install-skill.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "install-skill-test-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("installComposerSkill", () => {
  it("installs the bundled skill into both harness skill folders by default", async () => {
    const homeDir = await tempHome();
    const result = await installComposerSkill({ target: "both", force: false, homeDir });

    const claudeDir = join(homeDir, ".claude", "skills", "mono-agent-composer");
    const codexDir = join(homeDir, ".agents", "skills", "mono-agent-composer");
    expect(result.installed).toEqual([claudeDir, codexDir]);
    for (const dir of [claudeDir, codexDir]) {
      expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("mono-agent-composer");
      expect(await exists(join(dir, "agents", "openai.yaml"))).toBe(true);
      expect(await exists(join(dir, "references", "config-blueprint.md"))).toBe(true);
      expect(await exists(join(dir, "references", "validation.md"))).toBe(true);
    }
  });

  it("installs into a single target without touching the other", async () => {
    const homeDir = await tempHome();
    await installComposerSkill({ target: "claude", force: false, homeDir });

    expect(await exists(join(homeDir, ".claude", "skills", "mono-agent-composer", "SKILL.md"))).toBe(true);
    expect(await exists(join(homeDir, ".agents"))).toBe(false);
  });

  it("refuses to overwrite an existing install without force", async () => {
    const homeDir = await tempHome();
    await installComposerSkill({ target: "claude", force: false, homeDir });

    await expect(installComposerSkill({ target: "claude", force: false, homeDir })).rejects.toThrow(/--force/u);
    await expect(installComposerSkill({ target: "claude", force: true, homeDir })).resolves.toMatchObject({
      installed: [join(homeDir, ".claude", "skills", "mono-agent-composer")],
    });
  });

  it("fails clearly when the bundled skill source is missing", async () => {
    const homeDir = await tempHome();
    await expect(
      installComposerSkill({ target: "both", force: false, homeDir, sourceDir: join(homeDir, "nowhere") }),
    ).rejects.toThrow(/SKILL\.md/u);
  });
});

describe("runCli install-skill --project --check --json", () => {
  it("emits a flat JSON drift envelope with per-skill state and no ANSI", async () => {
    const projectDir = await tempHome();
    const previousCwd = process.cwd();
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    try {
      process.chdir(projectDir);
      // An empty project has no managed skills installed, so drift check reports
      // them missing (ok:false, exit 1) — the cheap induced-failure shape.
      await expect(runCli(["install-skill", "--project", "--check", "--json"])).resolves.toBe(1);
      const out = chunks.join("");
      expect(out).not.toContain(String.fromCharCode(27));
      const parsed = JSON.parse(out) as {
        readonly ok: boolean;
        readonly skills: readonly { readonly name: string; readonly status: string; readonly path: string }[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.skills.length).toBeGreaterThan(0);
      expect(parsed.skills.every((skill) => skill.status === "missing")).toBe(true);
      expect(parsed.skills.every((skill) => typeof skill.path === "string")).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(previousCwd);
    }
  });
});
