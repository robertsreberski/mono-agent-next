import { cp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallSkillTarget = "claude" | "codex" | "both";

export interface InstallSkillOptions {
  readonly target: InstallSkillTarget;
  /** Overwrite an existing installed copy instead of refusing. */
  readonly force: boolean;
  /** Test injection; defaults to os.homedir(). */
  readonly homeDir?: string;
  /** Test injection; defaults to the skill bundled with this package. */
  readonly sourceDir?: string;
}

export interface InstallSkillResult {
  readonly installed: readonly string[];
}

export const COMPOSER_SKILL_NAME = "mono-agent-composer";

// dist/install-skill.js and src/install-skill.ts both sit one level below the
// package root, so ../skills resolves to the bundled skills folder either way.
const BUNDLED_SKILL_DIR = fileURLToPath(new URL(`../skills/${COMPOSER_SKILL_NAME}`, import.meta.url));

const TARGET_HARNESS_DIRS: Readonly<Record<Exclude<InstallSkillTarget, "both">, string>> = {
  claude: ".claude",
  codex: ".agents",
};

/**
 * Copies the bundled mono-agent-composer skill into the harness skill folders
 * (~/.claude/skills and/or ~/.agents/skills) so Claude Code and Codex can use
 * it to compose new agents.
 */
export async function installComposerSkill(options: InstallSkillOptions): Promise<InstallSkillResult> {
  const sourceDir = options.sourceDir ?? BUNDLED_SKILL_DIR;
  await assertSkillSource(sourceDir);

  const destinations = composerSkillDestinations(options.target, options.homeDir ?? homedir());

  if (!options.force) {
    for (const destination of destinations) {
      if (await pathExists(destination)) {
        throw new Error(`Destination ${destination} already exists. Re-run with --force to overwrite.`);
      }
    }
  }

  const installed: string[] = [];
  for (const destination of destinations) {
    if (options.force) {
      await rm(destination, { recursive: true, force: true });
    }
    await cp(sourceDir, destination, { recursive: true, force: true });
    installed.push(destination);
  }
  return { installed };
}

/** Internal CLI helper; intentionally not re-exported from the package root. */
export function composerSkillDestinations(target: InstallSkillTarget, homeDir: string): readonly string[] {
  const targets = target === "both" ? (["claude", "codex"] as const) : ([target] as const);
  return targets.map((harness) => join(homeDir, TARGET_HARNESS_DIRS[harness], "skills", COMPOSER_SKILL_NAME));
}

async function assertSkillSource(sourceDir: string): Promise<void> {
  if (!(await pathExists(join(sourceDir, "SKILL.md")))) {
    throw new Error(`Bundled skill is missing SKILL.md at ${sourceDir}; the package looks broken.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
