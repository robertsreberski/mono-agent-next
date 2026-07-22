import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SOUL_TEXT } from '../default-soul.js';
import { ContextValidationError } from '../errors.js';
import { loadContextFromFiles } from '../file-loader.js';

const fixturesRoot = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const filesRoot = join(fixturesRoot, 'files');
const skillsRoot = join(fixturesRoot, 'skills-valid');

describe('loadContextFromFiles', () => {
  it('reads IDENTITY.md, optional SOUL.md, and a skills root through the filesystem', async () => {
    const context = await loadContextFromFiles({
      identityPath: join(filesRoot, 'IDENTITY.md'),
      soulPath: join(filesRoot, 'SOUL.md'),
      skillsRoot,
      userMessage: 'Load fixture context.',
    });

    expect(context.metadata.usedDefaultCore).toBe(false);
    expect(context.metadata.skillCount).toBe(1);
    expect(context.prompt).toContain('You are the fixture context agent.');
    expect(context.prompt).toContain('Use fixture guardrails and verify real outcomes.');
    expect(context.prompt).toContain('- **research** — Find source-grounded evidence before making claims.');
    expect(context.prompt).not.toContain(join(skillsRoot, 'research', 'SKILL.md'));
    expect(context.prompt).not.toContain('ReadSkill');
    expect(context.metadata.sources).toEqual([
      join(filesRoot, 'SOUL.md'),
      join(filesRoot, 'IDENTITY.md'),
      join(skillsRoot, 'research', 'SKILL.md'),
    ]);
  });

  it('forwards index disclosure guidance without exposing discovered skill paths', async () => {
    const context = await loadContextFromFiles({
      identityPath: join(filesRoot, 'IDENTITY.md'),
      skillsRoot,
      skillDisclosure: 'index',
      userMessage: 'Load fixture context.',
    });

    expect(context.prompt).toContain('call `ReadSkill` with its name');
    expect(context.prompt).toContain('Do not use `Read` to open a skill\'s `SKILL.md`');
    expect(context.prompt).not.toContain(join(skillsRoot, 'research', 'SKILL.md'));
    expect(context.metadata.sources).toContain(join(skillsRoot, 'research', 'SKILL.md'));
  });

  it('merges explicit skills with skillsRoot discovery, deduping by name (prefers the explicit entry)', async () => {
    const context = await loadContextFromFiles({
      identityPath: join(filesRoot, 'IDENTITY.md'),
      userMessage: 'Load fixture context.',
      skills: [{ name: 'research', description: 'Explicit research blurb.', mainFile: join(skillsRoot, 'research', 'SKILL.md') }],
      skillsRoot,
    });

    // research is both explicit and discovered — it must appear once (no duplicate-name throw),
    // using the explicit description rather than the one derived from the file.
    expect(context.metadata.skillCount).toBe(1);
    expect(context.prompt).toContain('- **research** — Explicit research blurb.');
    expect(context.prompt).not.toContain('Find source-grounded evidence before making claims.');
  });

  it('uses the default SOUL text only when SOUL.md is omitted', async () => {
    const context = await loadContextFromFiles({
      identityPath: join(filesRoot, 'IDENTITY.md'),
      userMessage: 'Load fixture context.',
    });

    expect(context.metadata.usedDefaultCore).toBe(true);
    expect(context.sections[0]?.content).toBe(DEFAULT_SOUL_TEXT);
  });

  it('throws a typed error when an explicit file cannot be read', async () => {
    await expect(
      loadContextFromFiles({
        identityPath: join(filesRoot, 'IDENTITY.md'),
        soulPath: join(filesRoot, 'MISSING-SOUL.md'),
        userMessage: 'Load fixture context.',
      }),
    ).rejects.toThrow(ContextValidationError);
  });
});
