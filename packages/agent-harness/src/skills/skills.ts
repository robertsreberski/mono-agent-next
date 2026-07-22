import { ContextValidationError, loadSkillFilesFromDirectory, normalizeInlineText } from "../context/index.js";
import type { LoadedSkillFile, MarkdownContextBlock, SkillIndexEntry } from "../context/index.js";
import { clampUtf8Bytes } from "../context/text.js";

export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly mainFile: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface LoadSelectedSkillsInput {
  readonly skillsRoot: string;
  readonly names: readonly string[];
  readonly maxBytes?: number;
}

export interface LoadedSkillContext {
  readonly index: readonly SkillIndexEntry[];
  readonly instructions: readonly MarkdownContextBlock[];
  readonly loaded: readonly LoadedSkill[];
}

export class SkillActivationError extends Error {
  readonly code: "invalid_skill_selection" | "skill_not_found" | "skill_read_failed";
  readonly details: Record<string, unknown>;

  constructor(code: SkillActivationError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkillActivationError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_MAX_SKILL_BYTES = 48_000;

export async function loadSelectedSkills(input: LoadSelectedSkillsInput): Promise<LoadedSkillContext> {
  const names = normalizeSkillNames(input.names);
  if (names.length === 0) {
    return { index: [], instructions: [], loaded: [] };
  }
  if (typeof input.skillsRoot !== "string" || input.skillsRoot.trim().length === 0) {
    throw new SkillActivationError("invalid_skill_selection", "skillsRoot must be a non-empty path.");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new SkillActivationError("invalid_skill_selection", "maxBytes must be an integer of at least 256.");
  }

  const files = await readSkillFiles(input.skillsRoot);
  const byName = new Map(files.map((file) => [file.entry.name.toLowerCase(), file]));
  const available = files.map((file) => file.entry.name);
  const loaded: LoadedSkill[] = [];
  for (const name of names) {
    const file = byName.get(name.toLowerCase());
    if (file === undefined) {
      throw new SkillActivationError("skill_not_found", "Configured skill was not found in skillsRoot.", {
        name,
        available,
      });
    }
    loaded.push(loadSkillBody(file, maxBytes));
  }

  return {
    index: sortSkillEntries(loaded.map(({ name, description, mainFile }) => ({ name, description, mainFile }))),
    instructions: skillInstructionsToContextBlocks(loaded),
    loaded,
  };
}

export function skillInstructionsToContextBlocks(skills: readonly LoadedSkill[]): readonly MarkdownContextBlock[] {
  return skills.map((skill) => ({
    kind: "markdown",
    source: skill.mainFile,
    content: `# Skill: ${skill.name}\n\n${skill.content}${skill.truncated ? "\n\n<!-- skill truncated by maxBytes -->" : ""}`,
  }));
}

function normalizeSkillNames(names: readonly string[]): readonly string[] {
  if (!Array.isArray(names)) {
    throw new SkillActivationError("invalid_skill_selection", "names must be an array.");
  }
  const normalized = names.map((name, index) => normalizeSkillName(name, `names[${index}]`));
  const seen = new Set<string>();
  for (const name of normalized) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new SkillActivationError("invalid_skill_selection", "Skill names must not be duplicated.", { name });
    }
    seen.add(key);
  }
  return normalized;
}

async function readSkillFiles(skillsRoot: string): Promise<readonly LoadedSkillFile[]> {
  try {
    return await loadSkillFilesFromDirectory(skillsRoot);
  } catch (error) {
    if (error instanceof ContextValidationError && error.code === "file_read_failed") {
      const { code: _innerCode, ...details } = error.details;
      throw new SkillActivationError("skill_read_failed", "Unable to read selected skill body.", details);
    }
    throw error;
  }
}

function loadSkillBody(file: LoadedSkillFile, maxBytes: number): LoadedSkill {
  const { entry, markdown } = file;
  const buffer = Buffer.from(markdown, "utf8");
  const truncated = buffer.byteLength > maxBytes;
  const content = truncated
    ? `${clampUtf8Bytes(markdown, maxBytes)}\n<!-- truncated to first ${maxBytes} bytes -->`
    : markdown;
  return {
    name: entry.name,
    description: entry.description,
    mainFile: entry.mainFile,
    content: content.trim(),
    truncated,
  };
}

function normalizeSkillName(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SkillActivationError("invalid_skill_selection", `${field} must be a string.`, { field });
  }
  const normalized = normalizeInlineText(value);
  if (normalized.length === 0) {
    throw new SkillActivationError("invalid_skill_selection", `${field} must not be empty.`, { field });
  }
  return normalized;
}

function sortSkillEntries(entries: readonly SkillIndexEntry[]): readonly SkillIndexEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = left.name.toLowerCase();
    const rightKey = right.name.toLowerCase();
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }
    return 0;
  });
}
