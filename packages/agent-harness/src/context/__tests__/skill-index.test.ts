import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ContextValidationError } from '../errors.js';
import { buildSkillIndex, loadSkillIndexFromDirectory } from '../skill-index.js';

const fixturesRoot = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const validSkillsRoot = join(fixturesRoot, 'skills-valid');
const invalidSkillsRoot = join(fixturesRoot, 'skills-invalid');

describe('buildSkillIndex', () => {
  it('normalizes, validates, and sorts skill entries deterministically', () => {
    const skills = buildSkillIndex([
      { name: 'Writing ', description: ' Create plans\nfor agents ', mainFile: ' /skills/writing/SKILL.md ' },
      { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
    ]);

    expect(skills).toEqual([
      { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
      { name: 'Writing', description: 'Create plans for agents', mainFile: '/skills/writing/SKILL.md' },
    ]);
  });

  it('rejects duplicate skill names', () => {
    expect(() =>
      buildSkillIndex([
        { name: 'research', description: 'One', mainFile: '/one/SKILL.md' },
        { name: 'Research', description: 'Two', mainFile: '/two/SKILL.md' },
      ]),
    ).toThrow(ContextValidationError);
  });
});

describe('loadSkillIndexFromDirectory', () => {
  it('falls back to the first body paragraph when there is no frontmatter description', async () => {
    const skills = await loadSkillIndexFromDirectory(validSkillsRoot);

    expect(skills).toEqual([
      {
        name: 'research',
        description: 'Find source-grounded evidence before making claims.',
        mainFile: join(validSkillsRoot, 'research', 'SKILL.md'),
      },
    ]);
  });

  it('prefers the frontmatter description over body prose', async () => {
    const frontmatterSkillsRoot = join(fixturesRoot, 'skills-frontmatter');
    const skills = await loadSkillIndexFromDirectory(frontmatterSkillsRoot);

    expect(skills).toEqual([
      {
        name: 'frontmatter',
        description: 'Use the YAML frontmatter description as the canonical skill summary.',
        mainFile: join(frontmatterSkillsRoot, 'frontmatter', 'SKILL.md'),
      },
    ]);
  });

  it('rejects skill files without a description paragraph', async () => {
    await expect(loadSkillIndexFromDirectory(invalidSkillsRoot)).rejects.toThrow(ContextValidationError);
  });
});
