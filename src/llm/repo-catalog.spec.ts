import { describe, expect, it } from 'vitest';
import type { RepoFile } from '../contracts/repo-provider.js';
import type { LoadedSkill } from '../contracts/step.js';
import {
  buildCatalog,
  contextLine,
  missingFoldersError,
  rootAgentsTooLarge,
  skillsForStep,
  unreadableAgents,
} from './repo-catalog.js';

/** A listing from paths and sizes, in any order. */
function listing(files: Record<string, number>): RepoFile[] {
  return Object.entries(files).map(([path, size]) => ({
    path,
    size,
    executable: false,
  }));
}

/** SD9-like content. */
const SANDBOX = listing({
  'README.md': 300,
  'AGENTS.md': 1840,
  'CLAUDE.md': 60,
  'src/AGENTS.md': 1210,
  'src/agents.md': 10,
  'src/split.ts': 900,
  'vendor/pay-lib/AGENTS.md': 400,
  '.claude/skills/money-rules/SKILL.md': 1500,
  '.claude/skills/money-rules/references/rounding.md': 1240,
  '.claude/skills/money-rules/logo.png': 5000,
  '.claude/skills/money-rules/scripts/check.sh': 87,
  '.claude/skills/empty/SKILL.md': 0,
  '.claude/skills/nested/deeper/SKILL.md': 50,
  '.claude/skills/README.md': 20,
  '.github-agent/workflow.json': 400,
  '.github-agent/skills/grill/SKILL.md': 3000,
});

describe('buildCatalog', () => {
  it('the root AGENTS.md, the folder AGENTS.md files and the repo skills, from the listing alone', () => {
    const catalog = buildCatalog(SANDBOX, ['.claude/skills']);

    expect(catalog).toEqual({
      rootAgents: { path: 'AGENTS.md', size: 1840, executable: false },
      agents: [
        { path: 'src/AGENTS.md', bytes: 1210 },
        { path: 'vendor/pay-lib/AGENTS.md', bytes: 400 },
      ],
      skills: [
        {
          name: 'money-rules',
          folder: '.claude/skills',
          path: '.claude/skills/money-rules',
          skillFile: {
            path: '.claude/skills/money-rules/SKILL.md',
            size: 1500,
            executable: false,
          },
          files: [
            {
              path: '.claude/skills/money-rules/references/rounding.md',
              bytes: 1240,
            },
            { path: '.claude/skills/money-rules/scripts/check.sh', bytes: 87 },
          ],
        },
      ],
      missingFolders: [],
      duplicates: [],
    });
  });

  it('never lists CLAUDE.md, agents.md in another letter case or any other file as instructions', () => {
    const catalog = buildCatalog(SANDBOX, ['.claude/skills']);
    const paths = JSON.stringify(catalog);

    expect(paths).not.toContain('CLAUDE.md');
    expect(paths).not.toContain('src/agents.md');
    expect(paths).not.toContain('README.md');
  });

  it('an empty SKILL.md and a deeper SKILL.md are not skills; a binary file is left out of a skill', () => {
    const { skills } = buildCatalog(SANDBOX, ['.claude/skills']);

    expect(skills.map((skill) => skill.name)).toEqual(['money-rules']);
    expect(JSON.stringify(skills)).not.toContain('logo.png');
  });

  it('without repoSkills: no repo skill, the AGENTS.md files still found (SD1)', () => {
    const catalog = buildCatalog(SANDBOX, []);

    expect(catalog.skills).toEqual([]);
    expect(catalog.rootAgents?.path).toBe('AGENTS.md');
    expect(catalog.agents).toHaveLength(2);
  });

  it('an empty root AGENTS.md is absent; no AGENTS.md at all → null and an empty list', () => {
    expect(buildCatalog(listing({ 'AGENTS.md': 0 }), []).rootAgents).toBeNull();
    expect(buildCatalog(listing({ 'README.md': 1 }), [])).toEqual({
      rootAgents: null,
      agents: [],
      skills: [],
      missingFolders: [],
      duplicates: [],
    });
  });

  it('SDW11: a repoSkills folder not in the tree → its error naming it; an existing folder without skills is fine', () => {
    const catalog = buildCatalog(SANDBOX, [
      '.claude/skill',
      '.github-agent',
      '.agents/skills',
    ]);

    expect(catalog.missingFolders).toEqual(['.claude/skill', '.agents/skills']);
    expect(missingFoldersError(catalog)?.message).toBe(
      'invalid workflow.json: repoSkills folder not found: .claude/skill, .agents/skills',
    );
    expect(
      missingFoldersError(buildCatalog(SANDBOX, ['.claude/skills'])),
    ).toBeNull();
  });

  it('SD12: the same name in two folders → one duplicate problem; the first folder keeps the skill', () => {
    const catalog = buildCatalog(
      [...SANDBOX, ...listing({ '.agents/skills/money-rules/SKILL.md': 300 })],
      ['.claude/skills', '.agents/skills'],
    );

    expect(catalog.skills.map((skill) => skill.path)).toEqual([
      '.claude/skills/money-rules',
    ]);
    expect(catalog.duplicates).toEqual([
      {
        name: 'money-rules',
        first: '.claude/skills',
        second: '.agents/skills',
      },
    ]);
  });

  it('SDW2: the root AGENTS.md over 204,800 bytes → AGENTS.md too large; at the cap it is fine', () => {
    expect(
      rootAgentsTooLarge(buildCatalog(listing({ 'AGENTS.md': 204_801 }), []))
        ?.message,
    ).toBe('AGENTS.md too large (204,801 bytes, limit 204,800)');
    expect(
      rootAgentsTooLarge(buildCatalog(listing({ 'AGENTS.md': 204_800 }), [])),
    ).toBeNull();
    expect(unreadableAgents().message).toBe('unreadable AGENTS.md');
  });
});

describe('skillsForStep', () => {
  const steps = listing({
    '.github-agent/skills/grill/SKILL.md': 100,
    '.github-agent/skills/spec/SKILL.md': 100,
    '.github-agent/skills/spec/references/template.md': 10,
    '.github-agent/skills/code/SKILL.md': 100,
  });

  it("the step's own folder under repoSkills is left out; another step's folder is listed, sorted by name", () => {
    const catalog = buildCatalog(steps, ['.github-agent/skills']);

    expect(
      skillsForStep(catalog, '.github-agent/skills/spec/').map((s) => s.name),
    ).toEqual(['code', 'grill']);
    expect(
      skillsForStep(catalog, '.github-agent/skills/grill').map((s) => s.name),
    ).toEqual(['code', 'spec']);
  });

  it('sorted by name across folders', () => {
    const catalog = buildCatalog(
      listing({
        'b/zeta/SKILL.md': 1,
        'a/alpha/SKILL.md': 1,
        'a/omega/SKILL.md': 1,
      }),
      ['b', 'a'],
    );

    expect(skillsForStep(catalog, undefined).map((s) => s.name)).toEqual([
      'alpha',
      'omega',
      'zeta',
    ]);
  });
});

describe('contextLine', () => {
  const skill = (files: number): LoadedSkill => ({
    step: 'grill',
    path: '.github-agent/skills/grill',
    commit: '4f2c1ab'.padEnd(40, '0'),
    instructions: 'secret-looking text',
    files: [...Array(files).keys()].map((n) => ({ path: `f${n}`, bytes: 1 })),
  });

  it('the root AGENTS.md size, the counts, never content', () => {
    const line = contextLine(
      'grill',
      '4f2c1ab'.padEnd(40, '0'),
      {
        rootAgents: { text: 'integer cents', bytes: 1840 },
        skills: [
          { name: 'money-rules', description: 'd', path: 'p', files: [] },
        ],
        agents: [{ path: 'src/AGENTS.md', bytes: 1210 }],
      },
      skill(0),
    );

    expect(line).toBe(
      'context grill @4f2c1ab: root AGENTS.md 1,840 bytes; 1 repo skill; 1 AGENTS.md listed; step skill + 0 files',
    );
    expect(line).not.toContain('integer cents');
  });

  it('no root AGENTS.md; plurals', () => {
    expect(
      contextLine(
        'spec',
        'abcdef0123',
        { rootAgents: null, skills: [], agents: [] },
        skill(1),
      ),
    ).toBe(
      'context spec @abcdef0: no root AGENTS.md; 0 repo skills; 0 AGENTS.md listed; step skill + 1 file',
    );
  });
});
