import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAgentContext } from '../context-builder.js';
import { DEFAULT_SOUL_TEXT } from '../default-soul.js';
import { ContextValidationError } from '../errors.js';
import type { JsonValue } from '../json.js';
import * as skillIndex from '../skill-index.js';

function expectValidationCode(callback: () => unknown, code: ContextValidationError['code']): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextValidationError);
    expect((error as ContextValidationError).code).toBe(code);
    return;
  }

  throw new Error(`Expected ContextValidationError with code ${code}.`);
}

describe('buildAgentContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes default core, identity, and current user message with minimal input', () => {
    const context = buildAgentContext({
      identity: 'You are Test Agent.',
      userMessage: 'Summarize the current task.',
    });

    expect(context.metadata).toEqual({
      usedDefaultCore: true,
      skillCount: 0,
      historyCount: 0,
      sources: [],
    });
    expect(context.sections.map((section) => section.id)).toEqual(['core', 'identity', 'user-message']);
    expect(context.sections[0]?.content).toBe(DEFAULT_SOUL_TEXT);
    expect(context.prompt).toContain('## Core Guardrails');
    expect(context.prompt).toContain('## Identity\n\nYou are Test Agent.');
    expect(context.prompt).toContain('## Current User Message\n\nSummarize the current task.');
  });

  it('uses explicit core text instead of the default core', () => {
    const context = buildAgentContext({
      identity: 'Identity text',
      core: { kind: 'markdown', content: 'Custom SOUL guardrails.', source: 'SOUL.md' },
      userMessage: 'Do the work.',
    });

    expect(context.metadata.usedDefaultCore).toBe(false);
    expect(context.sections[0]).toMatchObject({
      id: 'core',
      content: 'Custom SOUL guardrails.',
      source: 'SOUL.md',
    });
    expect(context.metadata.sources).toEqual(['SOUL.md']);
  });

  it('includes a session block source in the metadata sources', () => {
    const context = buildAgentContext({
      identity: 'Identity text',
      session: { kind: 'markdown', content: 'Session state.', source: 'session.md' },
      userMessage: 'Do the work.',
    });

    expect(context.sections.find((section) => section.id === 'session')).toMatchObject({
      content: 'Session state.',
      source: 'session.md',
    });
    expect(context.metadata.sources).toEqual(['session.md']);
  });

  it('omits memory when absent and renders markdown and JSON memory when provided', () => {
    const withoutMemory = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Do the work.',
    });
    expect(withoutMemory.sections.some((section) => section.id === 'memory')).toBe(false);

    const withMemory = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Do the work.',
      memory: [
        { kind: 'markdown', content: 'Remember this fact.', source: 'MEMORY.md' },
        { kind: 'json', value: { z: 2, a: 1 }, source: 'memory.json' },
      ],
    });

    const memory = withMemory.sections.find((section) => section.id === 'memory');
    expect(memory?.content).toContain('### Memory 1 (MEMORY.md)\n\nRemember this fact.');
    expect(memory?.content).toContain('### Memory 2 (memory.json)');
    expect(memory?.content).toContain('```json\n{\n  "a": 1,\n  "z": 2\n}\n```');
    expect(withMemory.metadata.sources).toEqual(['MEMORY.md', 'memory.json']);
  });

  it('preserves history ordering and role labels', () => {
    const context = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Continue.',
      history: [
        { role: 'user', content: 'First question', name: 'Ada', timestamp: '2026-05-15T10:00:00Z' },
        { role: 'assistant', content: 'First answer' },
      ],
    });

    const history = context.sections.find((section) => section.id === 'history');
    expect(context.metadata.historyCount).toBe(2);
    expect(history?.content).toBe(
      '### 1. user — Ada — 2026-05-15T10:00:00Z\n\nFirst question\n\n### 2. assistant\n\nFirst answer',
    );
  });

  it('renders a sorted skill index without exposing main files', () => {
    const context = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Use a skill if needed.',
      skills: [
        { name: 'writing', description: 'Write plans', mainFile: '/skills/writing/SKILL.md' },
        { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
      ],
    });

    const skills = context.sections.find((section) => section.id === 'skills');
    expect(context.metadata.skillCount).toBe(2);
    expect(skills?.content).toBe(
      '- **research** — Find sources\n- **writing** — Write plans',
    );
    expect(context.metadata.sources).toEqual(['/skills/research/SKILL.md', '/skills/writing/SKILL.md']);
  });

  it('instructs the agent to use ReadSkill only for index disclosure', () => {
    const skills = [
      { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
    ];
    const indexed = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Use a skill if needed.',
      skills,
      skillDisclosure: 'index',
    });
    const full = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Use a skill if needed.',
      skills,
      skillDisclosure: 'full',
    });

    expect(indexed.sections.find((section) => section.id === 'skills')?.content).toBe(
      "When a skill applies, call `ReadSkill` with its name before acting in that domain. Do not use `Read` to open a skill's `SKILL.md`; reserve ordinary file reads for files referenced by the loaded skill.\n\n- **research** — Find sources",
    );
    expect(indexed.prompt).not.toContain('/skills/research/SKILL.md');
    expect(indexed.metadata.sources).toEqual(['/skills/research/SKILL.md']);
    expect(full.sections.find((section) => section.id === 'skills')?.content).toBe(
      '- **research** — Find sources',
    );
  });

  it('renders selected skill instructions in a separate section', () => {
    const context = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Use a skill if needed.',
      skillInstructions: [
        { kind: 'markdown', content: '# Research\n\nFind sources.', source: '/skills/research/SKILL.md' },
        { kind: 'markdown', content: '# Writing\n\nWrite clearly.', source: '/skills/writing/SKILL.md' },
      ],
    });

    expect(context.sections.map((section) => section.id)).toEqual([
      'core',
      'identity',
      'skill-instructions',
      'user-message',
    ]);
    const instructions = context.sections.find((section) => section.id === 'skill-instructions');
    expect(instructions?.content).toContain('### Skill Instruction 1 (/skills/research/SKILL.md)\n\n# Research');
    expect(instructions?.content).toContain('### Skill Instruction 2 (/skills/writing/SKILL.md)\n\n# Writing');
    expect(context.metadata.sources).toEqual(['/skills/research/SKILL.md', '/skills/writing/SKILL.md']);
  });

  it('builds the skill index exactly once when rendering skills', () => {
    const buildSpy = vi.spyOn(skillIndex, 'buildSkillIndex');

    const context = buildAgentContext({
      identity: 'Identity text',
      userMessage: 'Use a skill if needed.',
      skills: [
        { name: 'writing', description: 'Write plans', mainFile: '/skills/writing/SKILL.md' },
        { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
      ],
    });

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(context.sections.find((section) => section.id === 'skills')?.content).toBe(
      '- **research** — Find sources\n- **writing** — Write plans',
    );
  });

  it('rejects duplicate skill names', () => {
    expectValidationCode(
      () =>
        buildAgentContext({
          identity: 'Identity text',
          userMessage: 'Use a skill if needed.',
          skills: [
            { name: 'Research', description: 'One', mainFile: '/one/SKILL.md' },
            { name: 'research', description: 'Two', mainFile: '/two/SKILL.md' },
          ],
        }),
      'invalid_skill_index',
    );
  });

  it('rejects empty identity and empty user message', () => {
    expectValidationCode(
      () => buildAgentContext({ identity: '  ', userMessage: 'Do the work.' }),
      'empty_required_field',
    );
    expectValidationCode(
      () => buildAgentContext({ identity: 'Identity text', userMessage: '\n\n' }),
      'empty_required_field',
    );
  });

  it('rejects non-serializable JSON memory', () => {
    expectValidationCode(
      () =>
        buildAgentContext({
          identity: 'Identity text',
          userMessage: 'Do the work.',
          memory: { kind: 'json', value: { unsupported: BigInt(1) as unknown as JsonValue } },
        }),
      'invalid_json',
    );
  });
});
