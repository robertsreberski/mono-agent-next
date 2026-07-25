// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installComposerSkillForTesting,
  type InstallComposerSkillOptions,
} from "../skill-installer.js";

type InternalControls = Parameters<typeof installComposerSkillForTesting>[1];
type InternalOverrides = Omit<InternalControls, "homeDirectory">;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("installComposerSkill", () => {
  it("installs the bounded bundled skill to Claude and Codex by default", async () => {
    const home = await temporaryDirectory("composer-home-");
    const result = await installAt(home);

    expect(result).toMatchObject({
      skillName: "mono-agent-composer",
      target: "both",
      installations: [
        { target: "claude", replaced: false },
        { target: "codex", replaced: false },
      ],
      retainedRecoveryPaths: [],
    });
    for (const product of [".claude", ".codex"]) {
      const skills = join(home, product, "skills");
      const destination = join(skills, "mono-agent-composer");
      expect(await readFile(join(destination, "SKILL.md"), "utf8"))
        .toContain("# Mono Agent Composer");
      expect(await readFile(join(destination, "references", "config.md"), "utf8"))
        .toContain("configVersion");
      expect(await readFile(join(destination, "references", "validation.md"), "utf8"))
        .toContain("node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js validate");
      expect(await readFile(join(destination, "agents", "openai.yaml"), "utf8"))
        .toContain("display_name");
      expect((await lstat(skills)).mode & 0o077).toBe(0);
      expect((await lstat(destination)).mode & 0o077).toBe(0);
      expect((await lstat(join(destination, "SKILL.md"))).mode & 0o077).toBe(0);
      expect(await readdir(skills)).toEqual(["mono-agent-composer"]);
    }
  });

  it("is no-clobber by default and retains the exact prior tree on force", async () => {
    const home = await temporaryDirectory("composer-force-");
    await installAt(home, { target: "codex" });
    const destination = join(home, ".codex", "skills", "mono-agent-composer");
    const skillPath = join(destination, "SKILL.md");
    await writeFile(skillPath, "operator-owned old install\n", { mode: 0o600 });

    await expect(installAt(home, { target: "codex" }))
      .rejects.toThrow(/already exists/u);
    expect(await readFile(skillPath, "utf8")).toBe("operator-owned old install\n");

    const invalid = await sourceFixture({
      "SKILL.md": "invalid staged replacement\n",
    });
    await writeFile(invalid.manifestPath, JSON.stringify({
      schemaVersion: 1,
      skillName: "mono-agent-composer",
      files: [{
        path: "SKILL.md",
        sha256: `sha256:${"0".repeat(64)}`,
        sizeBytes: 27,
      }],
    }), { mode: 0o600 });
    await expect(installAt(
      home,
      { target: "codex", force: true },
      invalid,
    )).rejects.toThrow(/does not match its manifest/u);
    expect(await readFile(skillPath, "utf8")).toBe("operator-owned old install\n");

    const result = await installAt(home, { target: "codex", force: true });
    expect(result.installations).toEqual([{
      target: "codex",
      destination: expect.any(String),
      replaced: true,
    }]);
    expect(result.retainedRecoveryPaths).toHaveLength(1);
    expect(await readFile(
      join(result.retainedRecoveryPaths[0]!, "SKILL.md"),
      "utf8",
    )).toBe("operator-owned old install\n");
    expect(await readFile(skillPath, "utf8")).toContain("# Mono Agent Composer");
    expect(await readdir(join(home, ".codex", "skills")))
      .toEqual(expect.arrayContaining([
        "mono-agent-composer",
        expect.stringMatching(/^\.mono-agent-composer\.backup-/u),
      ]));
  });

  it("rejects unsafe manifest paths, undeclared files, and source symlinks", async () => {
    const home = await temporaryDirectory("composer-invalid-source-");
    const unsafe = await sourceFixture({ "SKILL.md": "safe\n" });
    await writeFile(unsafe.manifestPath, JSON.stringify({
      schemaVersion: 1,
      skillName: "mono-agent-composer",
      files: [{
        path: "../SKILL.md",
        sha256: `sha256:${createHash("sha256").update("safe\n").digest("hex")}`,
        sizeBytes: 5,
      }],
    }), { mode: 0o600 });
    await expect(installAt(home, { target: "claude" }, unsafe))
      .rejects.toThrow(/unsafe path/u);

    const undeclared = await sourceFixture({ "SKILL.md": "safe\n" });
    await writeFile(join(undeclared.sourceDirectory, "extra.md"), "undeclared\n", {
      mode: 0o600,
    });
    await expect(installAt(home, { target: "claude" }, undeclared))
      .rejects.toThrow(/undeclared file/u);

    const linked = await sourceFixture({ "SKILL.md": "safe\n" });
    const external = join(await temporaryDirectory("composer-external-"), "outside.md");
    await writeFile(external, "safe\n", { mode: 0o600 });
    await rm(join(linked.sourceDirectory, "SKILL.md"));
    await symlink(external, join(linked.sourceDirectory, "SKILL.md"));
    await expect(installAt(home, { target: "claude" }, linked))
      .rejects.toThrow(/symbolic link/u);
    await expect(lstat(join(home, ".claude")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back every target when one target fails after publication", async () => {
    const home = await temporaryDirectory("composer-multi-rollback-");
    await installAt(home);
    const claudeSkill = join(
      home,
      ".claude",
      "skills",
      "mono-agent-composer",
      "SKILL.md",
    );
    const codexSkill = join(
      home,
      ".codex",
      "skills",
      "mono-agent-composer",
      "SKILL.md",
    );
    await writeFile(claudeSkill, "old claude\n", { mode: 0o600 });
    await writeFile(codexSkill, "old codex\n", { mode: 0o600 });
    const replacement = await sourceFixture({ "SKILL.md": "new staged\n" });

    await expect(installAt(
      home,
      { target: "both", force: true },
      {
        ...replacement,
        hooks: {
          afterPublish: ({ target }) => {
            if (target === "claude") {
              throw new Error("simulated published-target failure");
            }
          },
        },
      },
    )).rejects.toThrow("simulated published-target failure");
    expect(await readFile(claudeSkill, "utf8")).toBe("old claude\n");
    expect(await readFile(codexSkill, "utf8")).toBe("old codex\n");
  });

  it("restores the old install after an in-process post-backup failure", async () => {
    const home = await temporaryDirectory("composer-backup-rollback-");
    await installAt(home, { target: "codex" });
    const skillPath = join(
      home,
      ".codex",
      "skills",
      "mono-agent-composer",
      "SKILL.md",
    );
    await writeFile(skillPath, "old install\n", { mode: 0o600 });
    await expect(installAt(
      home,
      { target: "codex", force: true },
      {
        hooks: {
          afterBackup: () => {
            throw new Error("simulated failure after backup");
          },
        },
      },
    )).rejects.toThrow("simulated failure after backup");
    expect(await readFile(skillPath, "utf8")).toBe("old install\n");
  });

  it("recovers a real process exit after backup on the next invocation", async () => {
    const home = await temporaryDirectory("composer-process-crash-");
    await installAt(home, { target: "codex" });
    const destination = join(home, ".codex", "skills", "mono-agent-composer");
    const skillPath = join(destination, "SKILL.md");
    await writeFile(skillPath, "old process-boundary install\n", { mode: 0o600 });

    const moduleUrl = new URL("../skill-installer.ts", import.meta.url).href;
    const childSource = [
      `import { installComposerSkillForTesting } from ${JSON.stringify(moduleUrl)};`,
      "await installComposerSkillForTesting(",
      '{ target: "codex", force: true },',
      `{ homeDirectory: ${JSON.stringify(home)}, hooks: {`,
      "afterBackup: () => process.exit(88),",
      "} },",
      ");",
    ].join("\n");
    const child = await runChild(childSource);
    expect(child).toMatchObject({ code: 88, signal: null });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(home, ".codex", "skills")))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^\.mono-agent-composer\.backup-/u),
        expect.stringMatching(/^\.mono-agent-composer\.stage-/u),
      ]));

    await expect(installAt(home, { target: "codex" }))
      .rejects.toThrow(/already exists/u);
    expect(await readFile(skillPath, "utf8"))
      .toBe("old process-boundary install\n");
    expect(await readdir(join(home, ".codex", "skills")))
      .toEqual(expect.arrayContaining([
        "mono-agent-composer",
        expect.stringMatching(/^\.mono-agent-composer\.quarantine-/u),
      ]));
  }, 20_000);

  it("recovers an absent-target SIGKILL before the reservation identity frame", async () => {
    const home = await temporaryDirectory("composer-reservation-kill-absent-");
    const moduleUrl = new URL("../skill-installer.ts", import.meta.url).href;
    const childSource = [
      `import { installComposerSkillForTesting } from ${JSON.stringify(moduleUrl)};`,
      "await installComposerSkillForTesting(",
      '{ target: "codex" },',
      `{ homeDirectory: ${JSON.stringify(home)}, hooks: {`,
      "afterReservationCreatedBeforeJournal: () => process.kill(process.pid, \"SIGKILL\"),",
      "} },",
      ");",
    ].join("\n");

    const child = await runChild(childSource);
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
    const destination = join(home, ".codex", "skills", "mono-agent-composer");
    expect(await readdir(destination)).toEqual([]);

    const recovered = await installAt(home, { target: "codex" });
    expect(await readFile(join(destination, "SKILL.md"), "utf8"))
      .toContain("# Mono Agent Composer");
    expect(recovered.retainedRecoveryPaths)
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/\.quarantine-.*-codex-new$/u),
        expect.stringMatching(/\.quarantine-.*-codex-stage$/u),
      ]));
  }, 20_000);

  it("restores both exact priors after SIGKILL on target two's pre-frame reservation", async () => {
    const home = await temporaryDirectory("composer-reservation-kill-force-");
    await installAt(home);
    const claudeSkill = join(
      home,
      ".claude",
      "skills",
      "mono-agent-composer",
      "SKILL.md",
    );
    const codexSkill = join(
      home,
      ".codex",
      "skills",
      "mono-agent-composer",
      "SKILL.md",
    );
    await writeFile(claudeSkill, "old claude before SIGKILL\n", { mode: 0o600 });
    await writeFile(codexSkill, "old codex before SIGKILL\n", { mode: 0o600 });

    const moduleUrl = new URL("../skill-installer.ts", import.meta.url).href;
    const childSource = [
      `import { installComposerSkillForTesting } from ${JSON.stringify(moduleUrl)};`,
      "await installComposerSkillForTesting(",
      '{ target: "both", force: true },',
      `{ homeDirectory: ${JSON.stringify(home)}, hooks: {`,
      "afterReservationCreatedBeforeJournal: ({ target }) => {",
      'if (target === "codex") process.kill(process.pid, "SIGKILL");',
      "},",
      "} },",
      ");",
    ].join("\n");

    const child = await runChild(childSource);
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(await readdir(join(home, ".codex", "skills", "mono-agent-composer")))
      .toEqual([]);

    await expect(installAt(home))
      .rejects.toThrow(/already exists/u);
    expect(await readFile(claudeSkill, "utf8"))
      .toBe("old claude before SIGKILL\n");
    expect(await readFile(codexSkill, "utf8"))
      .toBe("old codex before SIGKILL\n");
  }, 20_000);

  it("rejects symlink and swapped destinations without touching their referents", async () => {
    const home = await temporaryDirectory("composer-target-swap-");
    const external = await temporaryDirectory("composer-target-external-");
    await writeFile(join(external, "sentinel"), "external\n", { mode: 0o600 });
    await mkdir(join(home, ".codex"), { mode: 0o700 });
    await mkdir(join(home, ".codex", "skills"), { mode: 0o700 });
    const destination = join(home, ".codex", "skills", "mono-agent-composer");
    await symlink(external, destination);
    await expect(installAt(home, { target: "codex", force: true }))
      .rejects.toThrow(/real directory/u);
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("external\n");

    await rm(destination);
    await installAt(home, { target: "codex" });
    const displaced = `${destination}.displaced`;
    await expect(installAt(
      home,
      { target: "codex", force: true },
      {
        hooks: {
          beforeCommit: async () => {
            await rename(destination, displaced);
            await symlink(external, destination);
          },
        },
      },
    )).rejects.toThrow(/automatic recovery refused|real directory/u);
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("external\n");
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(displaced, "SKILL.md"), "utf8"))
      .toContain("# Mono Agent Composer");
  });

  it("rejects an undeclared stage mutation immediately before commit", async () => {
    const home = await temporaryDirectory("composer-stage-mutation-");
    await expect(installAt(
      home,
      { target: "codex" },
      {
        hooks: {
          beforeCommit: ({ stage }) =>
            writeFile(join(stage, "UNDECLARED.md"), "attacker\n", { mode: 0o600 }),
        },
      },
    )).rejects.toThrow(/undeclared file/u);

    const skills = join(home, ".codex", "skills");
    await expect(lstat(join(skills, "mono-agent-composer")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = (await readdir(skills)).find((entry) =>
      entry.startsWith(".mono-agent-composer.quarantine-"));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(skills, quarantine!, "UNDECLARED.md"), "utf8"))
      .toBe("attacker\n");
  });

  it("never publishes or recursively deletes a substituted stage identity", async () => {
    const home = await temporaryDirectory("composer-stage-swap-");
    const attackerRoot = await temporaryDirectory("composer-stage-attacker-");
    const attackerTree = join(attackerRoot, "tree");
    await mkdir(attackerTree, { mode: 0o700 });
    await writeFile(join(attackerTree, "sentinel"), "attacker tree\n", { mode: 0o600 });
    let substitutedStage = "";
    let displacedStage = "";

    await expect(installAt(
      home,
      { target: "codex" },
      {
        hooks: {
          beforeCommit: async ({ stage }) => {
            substitutedStage = stage;
            displacedStage = `${stage}.journal-authorized`;
            await rename(stage, displacedStage);
            await rename(attackerTree, stage);
          },
        },
      },
    )).rejects.toThrow(/changed identity/u);

    const destination = join(home, ".codex", "skills", "mono-agent-composer");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(substitutedStage, "sentinel"), "utf8"))
      .toBe("attacker tree\n");
    expect(await readFile(join(displacedStage, "SKILL.md"), "utf8"))
      .toContain("# Mono Agent Composer");
  });

  it("does not overwrite a competitor that replaces its atomic reservation", async () => {
    const home = await temporaryDirectory("composer-reservation-race-");
    let competitor = "";
    let displacedReservation = "";
    await expect(installAt(
      home,
      { target: "codex" },
      {
        hooks: {
          beforePublish: async ({ destination }) => {
            competitor = destination;
            displacedReservation = `${destination}.installer-reservation`;
            await rename(destination, displacedReservation);
            await mkdir(destination, { mode: 0o700 });
            await writeFile(join(destination, "sentinel"), "competitor\n", {
              mode: 0o600,
            });
          },
        },
      },
    )).rejects.toThrow(/automatic recovery refused|changed identity/u);

    expect(await readFile(join(competitor, "sentinel"), "utf8"))
      .toBe("competitor\n");
    expect(await readdir(displacedReservation)).toEqual([]);
    await expect(readFile(join(competitor, "SKILL.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a swapped authority ancestor before publication", async () => {
    const home = await temporaryDirectory("composer-authority-swap-");
    const external = await temporaryDirectory("composer-authority-external-");
    await mkdir(join(external, "skills"), { mode: 0o700 });
    await writeFile(join(external, "sentinel"), "external\n", { mode: 0o600 });
    let displaced = "";

    await expect(installAt(
      home,
      { target: "codex" },
      {
        hooks: {
          beforeCommit: async () => {
            displaced = join(home, ".codex-journal-authorized");
            await rename(join(home, ".codex"), displaced);
            await symlink(external, join(home, ".codex"));
          },
        },
      },
    )).rejects.toThrow(/automatic recovery refused|real directory/u);

    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("external\n");
    await expect(lstat(join(external, "skills", "mono-agent-composer")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(displaced, "skills")))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^\.mono-agent-composer\.stage-/u),
      ]));
  });

  it("accepts owner-controlled ancestors but rejects group-writable authority", async () => {
    const standardHome = await temporaryDirectory("composer-standard-authority-");
    await chmod(standardHome, 0o750);
    await mkdir(join(standardHome, ".claude"), { mode: 0o700 });
    await chmod(join(standardHome, ".claude"), 0o755);
    await mkdir(join(standardHome, ".claude", "skills"), { mode: 0o700 });
    await chmod(join(standardHome, ".claude", "skills"), 0o755);
    await expect(installAt(standardHome, { target: "claude" }))
      .resolves.toMatchObject({
        installations: [{ target: "claude", replaced: false }],
      });
    const installed = join(
      standardHome,
      ".claude",
      "skills",
      "mono-agent-composer",
    );
    expect((await lstat(installed)).mode & 0o077).toBe(0);
    expect((await lstat(join(installed, "SKILL.md"))).mode & 0o077).toBe(0);

    const insecureHome = await temporaryDirectory("composer-insecure-home-");
    await chmod(insecureHome, 0o777);
    await expect(installAt(insecureHome, { target: "codex" }))
      .rejects.toThrow(/group or other write permissions/u);
    await chmod(insecureHome, 0o700);

    const insecureParent = await temporaryDirectory("composer-insecure-parent-");
    await mkdir(join(insecureParent, ".claude"), { mode: 0o700 });
    await chmod(join(insecureParent, ".claude"), 0o775);
    await expect(installAt(insecureParent, { target: "claude" }))
      .rejects.toThrow(/group or other write permissions/u);
    expect(await readdir(join(insecureParent, ".claude"))).toEqual([]);
  });

  it("fails closed when POSIX ownership proof is unavailable", async () => {
    const home = await temporaryDirectory("composer-unsupported-platform-");
    const originalGetuid = process.getuid;
    try {
      Object.defineProperty(process, "getuid", {
        configurable: true,
        value: undefined,
        writable: true,
      });
      await expect(installAt(home, { target: "codex" }))
        .rejects.toThrow(/unsupported.*current-UID.*O_NOFOLLOW.*O_DIRECTORY/u);
    } finally {
      Object.defineProperty(process, "getuid", {
        configurable: true,
        value: originalGetuid,
        writable: true,
      });
    }
  });

  it("serializes cooperative installers and leaves one exact final tree", async () => {
    const home = await temporaryDirectory("composer-concurrent-");
    const results = await Promise.allSettled([
      installAt(home, { target: "codex" }),
      installAt(home, { target: "codex" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(
      join(home, ".codex", "skills", "mono-agent-composer", "SKILL.md"),
      "utf8",
    )).toContain("# Mono Agent Composer");
  });

  it("keeps arbitrary source, manifest, and hook injection out of the root API", async () => {
    const publicApi = await import("../index.js");
    expect(publicApi).toHaveProperty("installComposerSkill");
    expect(publicApi).not.toHaveProperty("installComposerSkillForTesting");
  });
});

async function installAt(
  homeDirectory: string,
  options: InstallComposerSkillOptions = {},
  overrides: InternalOverrides = {},
) {
  return installComposerSkillForTesting(options, {
    ...overrides,
    homeDirectory,
  });
}

async function sourceFixture(
  files: Readonly<Record<string, string>>,
): Promise<{
  readonly sourceDirectory: string;
  readonly manifestPath: string;
}> {
  const root = await temporaryDirectory("composer-source-");
  const sourceDirectory = join(root, "mono-agent-composer");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const entries = [];
  for (const [path, contents] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right))) {
    const filePath = join(sourceDirectory, ...path.split("/"));
    await mkdir(join(filePath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(filePath, contents, { mode: 0o600 });
    entries.push({
      path,
      sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
      sizeBytes: Buffer.byteLength(contents),
    });
  }
  const manifestPath = join(root, "mono-agent-composer.manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    skillName: "mono-agent-composer",
    files: entries,
  }), { mode: 0o600 });
  return { sourceDirectory, manifestPath };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  await chmod(path, 0o700);
  return path;
}

async function runChild(source: string): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
