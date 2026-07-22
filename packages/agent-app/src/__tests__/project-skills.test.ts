import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initMonoAgentFolder } from "../init.js";
import {
  checkManagedProjectSkills,
  PROJECT_SKILL_MANIFEST_PATH,
  PROJECT_SKILL_VERSION,
  updateManagedProjectSkills,
} from "../project-skills.js";
import { defaultAnswers } from "../wizard/answers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-project-skills-"));
  dirs.push(dir);
  await initMonoAgentFolder({
    dir,
    answers: defaultAnswers({ name: "Skill Test", purpose: "Test managed project skills." }),
  });
  return dir;
}

describe("managed project skills", () => {
  it("scaffolds both selected, indexed skills with a verified hash manifest", async () => {
    const dir = await scaffold();
    const config = JSON.parse(await readFile(join(dir, "mono-agent.config.json"), "utf8")) as {
      context: { skillsRoot: string; selectedSkills: string[]; skillDisclosure: string };
    };
    expect(config.context).toEqual({
      identityPath: "./IDENTITY.md",
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-configure", "mono-agent-memory"],
      skillDisclosure: "index",
    });
    expect((await checkManagedProjectSkills(dir)).ok).toBe(true);
    expect(PROJECT_SKILL_VERSION).toBe("1.2.0");
    const configureSkill = await readFile(join(dir, "skills", "mono-agent-configure", "SKILL.md"), "utf8");
    expect(configureSkill).toContain("ProposeAgentConfiguration once");
    expect(configureSkill).toContain("IDENTITY.md → ## Role");
    expect(configureSkill).toContain("authoritative background agent");
    expect(configureSkill).toContain("dedicated, multi-turn SELF-CONFIG session");
    expect(configureSkill).toContain("identity and knowledge; runtime and models");
    expect(configureSkill).toContain("channels, APIs, and A2A");
    expect(configureSkill).toContain("observability and operations; and acceptance criteria");
    expect(configureSkill).toContain("trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks");
    expect(configureSkill).toContain("Approval, rejection, a no-proposal turn, `done`, and `no changes` do not end SELF-CONFIG");
  });

  it("detects an operator edit and refuses to overwrite it", async () => {
    const dir = await scaffold();
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    await writeFile(path, "# operator copy\n");
    const check = await checkManagedProjectSkills(dir);
    expect(check.statuses.find((entry) => entry.name === "mono-agent-configure")?.status).toBe("modified");
    await expect(updateManagedProjectSkills(dir)).rejects.toThrow(/operator-modified/u);
    expect(await readFile(path, "utf8")).toBe("# operator copy\n");
  });

  it("backs up and atomically refreshes unchanged stale managed copies", async () => {
    const dir = await scaffold();
    const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
    manifest.version = "0.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect((await checkManagedProjectSkills(dir)).statuses.every((entry) => entry.status === "stale")).toBe(true);

    const result = await updateManagedProjectSkills(dir);
    expect(result.ok).toBe(true);
    expect(result.updated).toHaveLength(2);
    expect(result.backupDir).toBeDefined();
    expect(await readFile(join(result.backupDir!, "mono-agent-memory", "SKILL.md"), "utf8"))
      .toContain("# Configure memory");
  });

  it("restores a partial activation so a failed update remains retryable", async () => {
    const dir = await scaffold();
    const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
    const configurePath = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const memoryPath = join(dir, "skills", "mono-agent-memory", "SKILL.md");
    const oldConfigure = "# previous managed configure skill\n";
    const oldMemory = "# previous managed memory skill\n";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string;
      skills: Record<string, { sha256: string }>;
    };
    manifest.version = "0.0.0";
    manifest.skills["mono-agent-configure"] = {
      sha256: createHash("sha256").update(oldConfigure).digest("hex"),
    };
    manifest.skills["mono-agent-memory"] = {
      sha256: createHash("sha256").update(oldMemory).digest("hex"),
    };
    await writeFile(configurePath, oldConfigure);
    await writeFile(memoryPath, oldMemory);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let activations = 0;
    await expect(updateManagedProjectSkills(dir, {
      beforeActivate: async () => {
        activations += 1;
        if (activations === 2) throw new Error("injected second-skill activation failure");
      },
    })).rejects.toThrow(/restored.*retryable/u);

    expect(await readFile(configurePath, "utf8")).toBe(oldConfigure);
    expect(await readFile(memoryPath, "utf8")).toBe(oldMemory);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
    expect((await checkManagedProjectSkills(dir)).statuses.every((entry) => entry.status === "stale")).toBe(true);

    await expect(updateManagedProjectSkills(dir)).resolves.toMatchObject({ ok: true });
  });

  it("preserves an operator edit made after one file activates and rollback begins", async () => {
    const dir = await scaffold();
    const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
    const configurePath = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const memoryPath = join(dir, "skills", "mono-agent-memory", "SKILL.md");
    const oldConfigure = "# previous managed configure skill\n";
    const oldMemory = "# previous managed memory skill\n";
    const operatorEdit = "# operator edited during update\n";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string;
      skills: Record<string, { sha256: string }>;
    };
    manifest.version = "0.0.0";
    manifest.skills["mono-agent-configure"] = {
      sha256: createHash("sha256").update(oldConfigure).digest("hex"),
    };
    manifest.skills["mono-agent-memory"] = {
      sha256: createHash("sha256").update(oldMemory).digest("hex"),
    };
    await writeFile(configurePath, oldConfigure);
    await writeFile(memoryPath, oldMemory);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let activations = 0;
    await expect(updateManagedProjectSkills(dir, {
      beforeActivate: async () => {
        activations += 1;
        if (activations === 2) {
          await writeFile(configurePath, operatorEdit);
          throw new Error("injected failure after concurrent operator edit");
        }
      },
    })).rejects.toThrow(/rollback was incomplete|concurrently edited/u);

    expect(await readFile(configurePath, "utf8")).toBe(operatorEdit);
    expect(await readFile(memoryPath, "utf8")).toBe(oldMemory);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
  });

  it("refuses to activate over an operator edit made after the update check", async () => {
    const dir = await scaffold();
    const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
    const configurePath = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
    manifest.version = "0.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const operatorEdit = "# operator edit after check\n";
    let injected = false;

    await expect(updateManagedProjectSkills(dir, {
      beforeActivate: async (path) => {
        if (!injected && path.endsWith("/skills/mono-agent-configure/SKILL.md")) {
          injected = true;
          await writeFile(configurePath, operatorEdit);
        }
      },
    })).rejects.toThrow(/concurrently edited/u);

    expect(injected).toBe(true);
    expect(await readFile(configurePath, "utf8")).toBe(operatorEdit);
  });

  it("rejects a symlinked skills parent without writing outside the agent", async () => {
    const dir = await scaffold();
    const external = await mkdtemp(join(tmpdir(), "mono-agent-external-skills-"));
    dirs.push(external);
    await rm(join(dir, "skills"), { recursive: true, force: true });
    await symlink(external, join(dir, "skills"), "dir");

    await expect(checkManagedProjectSkills(dir)).rejects.toThrow(/real directory|symbolic link/u);
    await expect(updateManagedProjectSkills(dir)).rejects.toThrow(/real directory|symbolic link/u);
    expect(await readdir(external)).toEqual([]);
  });
});
