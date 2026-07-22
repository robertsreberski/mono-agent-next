import { DEFAULT_SOUL_TEXT } from './default-soul.js';
import { ContextValidationError } from './errors.js';
import { normalizeJsonValue } from './json.js';
import { buildSkillIndex, renderSkillIndexEntries } from './skill-index.js';
import { normalizeInlineText } from './text.js';
import type {
  BuildContextInput,
  BuiltAgentContext,
  ContextBlockInput,
  ContextRole,
  ContextSection,
  ContextSectionId,
  HistoryMessage,
  SkillIndexEntry,
} from './types.js';

interface NormalizedBlock {
  readonly content: string;
  readonly source?: string;
}

const VALID_HISTORY_ROLES = new Set<ContextRole>(['system', 'user', 'assistant', 'tool']);

export function buildAgentContext(input: BuildContextInput): BuiltAgentContext {
  const rawInput = input as unknown;
  if (rawInput === null || typeof rawInput !== 'object') {
    throw new ContextValidationError('invalid_context_block', 'Context input must be an object.');
  }

  const usedDefaultCore = input.core === undefined;
  const core = normalizeContextBlock(input.core === undefined ? DEFAULT_SOUL_TEXT : input.core, 'core');
  const identity = normalizeContextBlock(input.identity, 'identity');
  const session = input.session === undefined ? undefined : normalizeContextBlock(input.session, 'session');
  const memory = normalizeMemory(input.memory);
  const history = normalizeHistory(input.history);
  const skills = input.skills === undefined ? [] : buildSkillIndex(input.skills);
  const skillInstructions = normalizeSkillInstructions(input.skillInstructions);
  const userMessage = normalizeRequiredMarkdown(input.userMessage, 'userMessage');

  const sections: ContextSection[] = [
    makeSection('core', 'Core Guardrails', core),
    makeSection('identity', 'Identity', identity),
  ];

  if (session !== undefined) {
    sections.push(makeSection('session', 'Session', session));
  }

  if (memory.length > 0) {
    sections.push(makeSection('memory', 'Memory', renderNumberedBlocks(memory, 'Memory')));
  }

  if (history.length > 0) {
    sections.push(makeSection('history', 'Conversation History', renderHistory(history)));
  }

  if (skills.length > 0) {
    sections.push(makeSection('skills', 'Skill Index', {
      content: renderSkillIndexEntries(skills, input.skillDisclosure),
    }));
  }

  if (skillInstructions.length > 0) {
    sections.push(makeSection('skill-instructions', 'Selected Skill Instructions', renderNumberedBlocks(skillInstructions, 'Skill Instruction')));
  }

  sections.push(makeSection('user-message', 'Current User Message', { content: userMessage }));

  return {
    prompt: sections.map(renderSection).join('\n\n'),
    sections,
    metadata: {
      usedDefaultCore,
      skillCount: skills.length,
      historyCount: history.length,
      sources: collectSources(core, identity, session, memory, skills, skillInstructions),
    },
  };
}

function normalizeMemory(memory: BuildContextInput['memory']): readonly NormalizedBlock[] {
  if (memory === undefined) {
    return [];
  }

  const blocks = Array.isArray(memory) ? memory : [memory];
  return blocks.map((block, index) => normalizeContextBlock(block, `memory[${index}]`));
}

function normalizeSkillInstructions(skillInstructions: BuildContextInput['skillInstructions']): readonly NormalizedBlock[] {
  if (skillInstructions === undefined) {
    return [];
  }

  const blocks = Array.isArray(skillInstructions) ? skillInstructions : [skillInstructions];
  return blocks.map((block, index) => normalizeContextBlock(block, `skillInstructions[${index}]`));
}

function normalizeHistory(history: BuildContextInput['history']): readonly HistoryMessage[] {
  if (history === undefined) {
    return [];
  }
  if (!Array.isArray(history)) {
    throw new ContextValidationError('invalid_history', 'History must be an ordered array of messages.');
  }

  return history.map((message, index) => {
    const raw = message as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') {
      throw new ContextValidationError('invalid_history', 'History messages must be objects.', { index });
    }

    const role = raw.role;
    if (typeof role !== 'string' || !VALID_HISTORY_ROLES.has(role as ContextRole)) {
      throw new ContextValidationError('invalid_history', 'History message role is invalid.', {
        index,
        role,
      });
    }

    const content = normalizeRequiredMarkdown(raw.content, `history[${index}].content`);
    const normalized: { role: ContextRole; content: string; name?: string; timestamp?: string } = {
      role: role as ContextRole,
      content,
    };

    if (raw.name !== undefined) {
      normalized.name = normalizeOptionalInlineString(raw.name, `history[${index}].name`);
    }
    if (raw.timestamp !== undefined) {
      normalized.timestamp = normalizeOptionalInlineString(raw.timestamp, `history[${index}].timestamp`);
    }

    return normalized;
  });
}

function normalizeContextBlock(block: ContextBlockInput, label: string): NormalizedBlock {
  if (typeof block === 'string') {
    return { content: normalizeRequiredMarkdown(block, label) };
  }

  const raw = block as unknown as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    throw new ContextValidationError('invalid_context_block', 'Context blocks must be strings or typed block objects.', {
      label,
    });
  }

  if (raw.kind === 'markdown') {
    return withOptionalSource(
      { content: normalizeRequiredMarkdown(raw.content, `${label}.content`) },
      raw.source,
      label,
    );
  }

  if (raw.kind === 'json') {
    const normalizedJson = normalizeJsonValue(raw.value);
    return withOptionalSource(
      { content: `\`\`\`json\n${JSON.stringify(normalizedJson, null, 2)}\n\`\`\`` },
      raw.source,
      label,
    );
  }

  throw new ContextValidationError('invalid_context_block', 'Context block kind must be markdown or json.', {
    label,
    kind: raw.kind,
  });
}

function withOptionalSource(block: NormalizedBlock, rawSource: unknown, label: string): NormalizedBlock {
  if (rawSource === undefined) {
    return block;
  }
  if (typeof rawSource !== 'string') {
    throw new ContextValidationError('invalid_context_block', 'Context block source must be a string when provided.', {
      label,
    });
  }

  const source = rawSource.trim();
  if (source.length === 0) {
    throw new ContextValidationError('invalid_context_block', 'Context block source must not be empty.', {
      label,
    });
  }

  return {
    ...block,
    source,
  };
}

function normalizeRequiredMarkdown(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ContextValidationError('empty_required_field', `${field} must be a string.`, {
      field,
    });
  }

  const normalized = normalizeMarkdown(value);
  if (normalized.length === 0) {
    throw new ContextValidationError('empty_required_field', `${field} must not be empty.`, {
      field,
    });
  }

  return normalized;
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function normalizeOptionalInlineString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ContextValidationError('invalid_history', `${field} must be a string when provided.`, {
      field,
    });
  }

  const normalized = normalizeInlineText(value);
  if (normalized.length === 0) {
    throw new ContextValidationError('invalid_history', `${field} must not be empty when provided.`, {
      field,
    });
  }

  return normalized;
}

function makeSection(id: ContextSectionId, title: string, block: NormalizedBlock): ContextSection {
  const section = {
    id,
    title,
    content: block.content,
  };

  if (block.source === undefined) {
    return section;
  }

  return {
    ...section,
    source: block.source,
  };
}

function renderSection(section: ContextSection): string {
  return `## ${section.title}\n\n${section.content}`;
}

function renderNumberedBlocks(blocks: readonly NormalizedBlock[], label: string): NormalizedBlock {
  if (blocks.length === 1) {
    const [onlyBlock] = blocks;
    if (onlyBlock === undefined) {
      throw new ContextValidationError('invalid_context_block', `${label} block is unexpectedly missing.`);
    }
    return onlyBlock;
  }

  return {
    content: blocks
      .map((block, index) => {
        const sourceSuffix = block.source === undefined ? '' : ` (${block.source})`;
        return `### ${label} ${index + 1}${sourceSuffix}\n\n${block.content}`;
      })
      .join('\n\n'),
  };
}

function renderHistory(history: readonly HistoryMessage[]): NormalizedBlock {
  return {
    content: history
      .map((message, index) => {
        const labelParts = [`${index + 1}. ${message.role}`];
        if (message.name !== undefined) {
          labelParts.push(message.name);
        }
        if (message.timestamp !== undefined) {
          labelParts.push(message.timestamp);
        }

        return `### ${labelParts.join(' — ')}\n\n${message.content}`;
      })
      .join('\n\n'),
  };
}

function collectSources(
  core: NormalizedBlock,
  identity: NormalizedBlock,
  session: NormalizedBlock | undefined,
  memory: readonly NormalizedBlock[],
  skills: readonly SkillIndexEntry[],
  skillInstructions: readonly NormalizedBlock[],
): readonly string[] {
  const sources: string[] = [];
  addSource(sources, core.source);
  addSource(sources, identity.source);
  if (session !== undefined) {
    addSource(sources, session.source);
  }
  for (const block of memory) {
    addSource(sources, block.source);
  }
  for (const skill of skills) {
    addSource(sources, skill.mainFile);
  }
  for (const block of skillInstructions) {
    addSource(sources, block.source);
  }
  return sources;
}

function addSource(sources: string[], source: string | undefined): void {
  if (source === undefined || sources.includes(source)) {
    return;
  }
  sources.push(source);
}
