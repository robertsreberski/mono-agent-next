import { readFile } from 'node:fs/promises';

import { buildAgentContext } from './context-builder.js';
import { ContextValidationError } from './errors.js';
import { resolveRequiredPath } from './fs-paths.js';
import { buildSkillIndex, loadSkillIndexFromDirectory } from './skill-index.js';
import type { BuildContextInput, BuiltAgentContext, FileContextInput, MarkdownContextBlock, SkillIndexEntry } from './types.js';

export async function loadContextFromFiles(input: FileContextInput): Promise<BuiltAgentContext> {
  const rawInput = input as unknown;
  if (rawInput === null || typeof rawInput !== 'object') {
    throw new ContextValidationError('invalid_context_block', 'File context input must be an object.');
  }

  const identity = await readMarkdownFile(input.identityPath, 'identityPath');
  const core = input.soulPath === undefined ? undefined : await readMarkdownFile(input.soulPath, 'soulPath');
  const skills = await loadMergedSkillIndex(input);

  const buildInput: BuildContextInput = {
    identity,
    userMessage: input.userMessage,
    ...(core === undefined ? {} : { core }),
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(input.skillDisclosure === undefined ? {} : { skillDisclosure: input.skillDisclosure }),
    ...(input.skillInstructions === undefined ? {} : { skillInstructions: input.skillInstructions }),
  };

  return buildAgentContext(buildInput);
}

async function loadMergedSkillIndex(input: FileContextInput): Promise<readonly SkillIndexEntry[]> {
  const discovered = input.skillsRoot === undefined ? [] : await loadSkillIndexFromDirectory(input.skillsRoot);
  const explicit = input.skills ?? [];
  if (explicit.length === 0 && discovered.length === 0) {
    return [];
  }

  // `skills` (explicit) and `skillsRoot` (discovered) can name the same skill — e.g. a caller
  // passing selected entries alongside the directory they came from. Prefer the explicit entry and
  // drop the discovered duplicate so buildSkillIndex (which rejects duplicate names) merges the two
  // sources instead of throwing.
  const explicitNames = new Set(explicit.map((entry) => entry.name.toLowerCase()));
  const merged = [...explicit, ...discovered.filter((entry) => !explicitNames.has(entry.name.toLowerCase()))];
  return buildSkillIndex(merged);
}

async function readMarkdownFile(filePath: string, field: string): Promise<MarkdownContextBlock> {
  const resolvedPath = resolveRequiredPath(filePath, field);
  try {
    return {
      kind: 'markdown',
      content: await readFile(resolvedPath, 'utf8'),
      source: resolvedPath,
    };
  } catch (error) {
    throw new ContextValidationError('file_read_failed', `Unable to read ${field}.`, {
      path: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
