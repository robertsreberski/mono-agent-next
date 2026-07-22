import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installComposerCompanion,
} from "../docs-mcp-pairing.js";
import type {
  DocsMcpEntry,
  DocsMcpHarnessAdapter,
  DocsMcpPairingDependencies,
} from "../docs-mcp-pairing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("composer documentation MCP pairing", () => {
  it("pairs both available harnesses and installs both skill copies", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies();
    const result = await installComposerCompanion({
      target: "both",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies);

    expect(result.pairings.map(({ target, state }) => [target, state])).toEqual([
      ["claude", "paired"],
      ["codex", "paired"],
    ]);
    expect(fake.states.claude).toEqual(managedEntry("0.12.0"));
    expect(fake.states.codex).toEqual(managedEntry("0.12.0"));
    expect(await readFile(join(homeDir, ".claude", "skills", "mono-agent-composer", "SKILL.md"), "utf8")).toContain("Mono Agent Composer");
    expect(await readFile(join(homeDir, ".agents", "skills", "mono-agent-composer", "SKILL.md"), "utf8")).toContain("Mono Agent Composer");
  });

  it("pairs the available target and returns an exact later command for a missing target", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies({ available: { claude: false, codex: true } });
    const result = await installComposerCompanion({
      target: "both",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies);

    expect(result.pairings).toEqual([
      expect.objectContaining({ target: "claude", state: "skipped-missing", command: expect.stringContaining("claude mcp add --scope user") }),
      expect.objectContaining({ target: "codex", state: "paired" }),
    ]);
    expect(await exists(join(homeDir, ".claude", "skills", "mono-agent-composer", "SKILL.md"))).toBe(true);
  });

  it("fails without mutation when no selected harness is available", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies({ available: { claude: false, codex: false } });
    await expect(installComposerCompanion({
      target: "both",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies)).rejects.toThrow(/none of the selected harness CLIs/iu);
    expect(await exists(join(homeDir, ".claude"))).toBe(false);
    expect(fake.operations).toEqual([]);
  });

  it("supports a file-only opt-out without requiring harness CLIs", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies({ available: { claude: false, codex: false } });
    const result = await installComposerCompanion({
      target: "codex",
      force: false,
      pairDocsMcp: false,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies);
    expect(result.pairings).toEqual([]);
    expect(await exists(join(homeDir, ".agents", "skills", "mono-agent-composer", "SKILL.md"))).toBe(true);
  });

  it("is idempotent for the exact entry and upgrades only a recognized older entry", async () => {
    const currentHome = await temporaryHome();
    const current = fakeDependencies({ initial: { codex: managedEntry("0.12.0") } });
    const currentResult = await installComposerCompanion({
      target: "codex",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir: currentHome,
    }, current.dependencies);
    expect(currentResult.pairings[0]).toMatchObject({ state: "already-current" });
    expect(current.operations).toEqual([]);

    const upgradeHome = await temporaryHome();
    const upgrade = fakeDependencies({ initial: { codex: managedEntry("0.11.0") } });
    const upgradeResult = await installComposerCompanion({
      target: "codex",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir: upgradeHome,
    }, upgrade.dependencies);
    expect(upgradeResult.pairings[0]).toMatchObject({ state: "upgraded" });
    expect(upgrade.states.codex).toEqual(managedEntry("0.12.0"));
    expect(upgrade.operations).toEqual(["codex:remove", "codex:add:@mono-agent/docs-mcp@0.12.0"]);
  });

  it("refuses an unmanaged same-name entry even with force", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies({ initial: { codex: { command: "python", args: ["custom-server.py"] } } });
    await expect(installComposerCompanion({
      target: "codex",
      force: true,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies)).rejects.toThrow(/unmanaged configuration/iu);
    expect(fake.states.codex).toEqual({ command: "python", args: ["custom-server.py"] });
    expect(fake.operations).toEqual([]);
    expect(await exists(join(homeDir, ".agents"))).toBe(false);
  });

  it("rolls the first harness back when the second harness fails", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies({ failAdd: "codex" });
    await expect(installComposerCompanion({
      target: "both",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
    }, fake.dependencies)).rejects.toThrow(/synthetic codex add failure/iu);
    expect(fake.states.claude).toBeUndefined();
    expect(fake.states.codex).toBeUndefined();
    expect(await exists(join(homeDir, ".claude"))).toBe(false);
  });

  it("rolls pairing back when the bundled skill cannot be installed", async () => {
    const homeDir = await temporaryHome();
    const fake = fakeDependencies();
    await expect(installComposerCompanion({
      target: "both",
      force: false,
      pairDocsMcp: true,
      docsMcpVersion: "0.12.0",
      homeDir,
      sourceDir: join(homeDir, "missing-source"),
    }, fake.dependencies)).rejects.toThrow(/missing SKILL\.md/iu);
    expect(fake.states.claude).toBeUndefined();
    expect(fake.states.codex).toBeUndefined();
  });
});

function fakeDependencies(options: {
  readonly available?: Partial<Record<"claude" | "codex", boolean>>;
  readonly initial?: Partial<Record<"claude" | "codex", DocsMcpEntry>>;
  readonly failAdd?: "claude" | "codex";
} = {}): {
  readonly dependencies: DocsMcpPairingDependencies;
  readonly states: Partial<Record<"claude" | "codex", DocsMcpEntry>>;
  readonly operations: string[];
} {
  const states: Partial<Record<"claude" | "codex", DocsMcpEntry>> = { ...options.initial };
  const operations: string[] = [];
  const adapter = (target: "claude" | "codex"): DocsMcpHarnessAdapter => ({
    target,
    isAvailable: async () => options.available?.[target] ?? true,
    read: async () => states[target],
    add: async (entry) => {
      if (options.failAdd === target) throw new Error(`synthetic ${target} add failure`);
      states[target] = { command: entry.command, args: [...entry.args], ...(entry.env === undefined ? {} : { env: { ...entry.env } }) };
      operations.push(`${target}:add:${entry.args[1]}`);
    },
    remove: async () => {
      delete states[target];
      operations.push(`${target}:remove`);
    },
  });
  return {
    states,
    operations,
    dependencies: {
      isNpxAvailable: async () => true,
      harnesses: { claude: adapter("claude"), codex: adapter("codex") },
    },
  };
}

function managedEntry(version: string): DocsMcpEntry {
  return { command: "npx", args: ["-y", `@mono-agent/docs-mcp@${version}`] };
}

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mono-agent-docs-pairing-"));
  temporaryDirectories.push(path);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
