import { describe, expect, it } from 'vitest';
import {
  protectedRuleFor,
  protectedRules,
  type ProtectedRule,
} from './protected-paths.js';
import { BOT_CONFIG_PATHS } from './workflow-config.js';

// Spec 12 "Protected paths" (BD5, BD6, BD7, BDW9; plan DP17, DP18), matrix P and Q.

/** The guide's recommended starting array (spec 12 "Protected paths"), as the sandbox uses it. */
const RECOMMENDED = [
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/GEMINI.md',
  '**/.cursorrules',
  '**/.windsurfrules',
  '**/.cursor/**',
  '.github/copilot-instructions.md',
  '.github/workflows/**',
  '**/.env',
  '**/.env.!(example)',
  '.claude/skills/**',
];
const SKILLS = {
  grill: '.github-agent/skills/grill',
  spec: 'skills/spec/', // a step skill outside .github-agent/, with a trailing slash
  code: 'Tools/Code',
};
const RULES = protectedRules({ skills: SKILLS, protectedPaths: RECOMMENDED });
const bot = (glob: string): ProtectedRule => ({ glob, source: 'bot' });
const array = (glob: string): ProtectedRule => ({
  glob,
  source: 'workflow.json',
});

describe('protectedRules', () => {
  it('the floor first (.github-agent, then each mapped step skill folder in step order), then the array in order', () => {
    expect(RULES).toEqual([
      bot('.github-agent/**'),
      bot('.github-agent/skills/grill/**'),
      bot('skills/spec/**'),
      bot('Tools/Code/**'),
      ...RECOMMENDED.map(array),
    ]);
  });

  it('a step missing from skills adds no floor rule; [] adds nothing beyond the floor', () => {
    expect(protectedRules({ skills: {}, protectedPaths: [] })).toEqual([
      bot('.github-agent/**'),
    ]);
  });
});

describe('protectedRuleFor (matrix P)', () => {
  it.each<[string, ProtectedRule | null]>([
    // The floor first, even when the array names the path too.
    ['.github-agent/workflow.json', bot('.github-agent/**')],
    ['.GITHUB-AGENT/notices/x.md', bot('.github-agent/**')],
    ['skills/spec/SKILL.md', bot('skills/spec/**')],
    ['skills/spec/references/a.md', bot('skills/spec/**')],
    ['tools/code/SKILL.md', bot('Tools/Code/**')],
    // A prefix, not a name: a sibling folder isn't under it.
    ['skills/specs/x.md', null],
    ['.github-agent-old/x', null],
    // The array: any folder, any letter case.
    ['AGENTS.md', array('**/AGENTS.md')],
    ['docs/agents.md', array('**/AGENTS.md')],
    ['.github/AGENTS.md', array('**/AGENTS.md')],
    ['./AGENTS.md', array('**/AGENTS.md')],
    ['/AGENTS.md', array('**/AGENTS.md')],
    ['.//./AGENTS.md', array('**/AGENTS.md')],
    ['src/.cursor/rules/a.mdc', array('**/.cursor/**')],
    ['.github/workflows/ci.yml', array('.github/workflows/**')],
    ['.env', array('**/.env')],
    ['.devcontainer/.env', array('**/.env')],
    ['.env.local', array('**/.env.!(example)')],
    ['.env.example', null],
    ['.claude/skills/money-rules/SKILL.md', array('.claude/skills/**')],
    ['src/index.ts', null],
    ['README.md', null],
  ])('%s → %o', (path, rule) => {
    expect(protectedRuleFor(path, RULES)).toEqual(rule);
  });

  it('no rules → null; a glob that matches nothing protects nothing', () => {
    expect(protectedRuleFor('a.ts', [])).toBeNull();
    expect(
      protectedRuleFor(
        'a.ts',
        protectedRules({ skills: {}, protectedPaths: ['nothing/**'] }),
      ),
    ).toBeNull();
  });
});

describe('the floor covers every config path the bot reads (BD7, matrix Q)', () => {
  it.each(BOT_CONFIG_PATHS)(
    '%s is protected by the floor with protectedPaths: []',
    (path) => {
      expect(
        protectedRuleFor(
          path,
          protectedRules({ skills: {}, protectedPaths: [] }),
        ),
      ).toMatchObject({ source: 'bot' });
    },
  );
});
