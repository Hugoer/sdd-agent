import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { StepSetup } from '../contracts/step.js';
import {
  CONTEXT_TOOLS,
  NONE_GIVEN,
  canLoad,
  checkRequest,
  loadedAnswer,
  markLoaded,
  newBudget,
  reasonOf,
  requestOf,
  unreadableAnswer,
  type LoadLimits,
  type LoadRequest,
} from './context-tools.js';

const COMMIT = 'ab12'.repeat(10);
const MONEY_DIR = '.claude/skills/money-rules';
const MONEY_MD = `${MONEY_DIR}/SKILL.md`;
const ROUNDING = `${MONEY_DIR}/references/rounding.md`;
const QUESTIONS = '.github-agent/skills/grill/references/questions.md';
const SETUP: StepSetup = {
  commit: COMMIT,
  model: { provider: 'google', name: 'gemini-4-carbon', level: 'standard' },
  skill: {
    step: 'grill',
    path: '.github-agent/skills/grill/',
    commit: COMMIT,
    instructions: '# Grill method',
    files: [{ path: QUESTIONS, bytes: 3120 }],
  },
  repo: {
    rootAgents: { text: '# Conventions', bytes: 13 },
    skills: [
      {
        name: 'money-rules',
        description: 'How this project stores, splits and rounds money.',
        path: MONEY_DIR,
        files: [{ path: ROUNDING, bytes: 1240 }],
      },
    ],
    agents: [{ path: 'src/AGENTS.md', bytes: 1210 }],
  },
};
const LIMITS: LoadLimits = { maxLoads: 10, maxBytes: 204_800 };
const SKILL_MD_BYTES = new Map([[MONEY_MD, 1335]]);
const LIMIT_ANSWER =
  'Limit reached: this answer may load at most 10 files and 204,800 bytes. Answer now with what you have.';

const file = (path: string, reason = 'the issue touches it'): LoadRequest => ({
  tool: 'load_file',
  path,
  reason,
});
const skill = (name: string): LoadRequest => ({
  tool: 'load_skill',
  name,
  reason: 'the issue splits money',
});

function check(
  request: LoadRequest,
  budget = newBudget(SETUP, LIMITS),
  limits = LIMITS,
  setup = SETUP,
) {
  return checkRequest(request, setup, budget, limits, SKILL_MD_BYTES);
}

describe('the two tool declarations', () => {
  it('load_skill (name 1–64, reason 1–300) and load_file (path 1–1,024, reason 1–300)', () => {
    const [loadSkill, loadFile] = CONTEXT_TOOLS;
    const accepts = (schema: unknown, value: unknown) =>
      (schema as z.ZodType).safeParse(value).success;

    expect(CONTEXT_TOOLS.map((tool) => tool.name)).toEqual([
      'load_skill',
      'load_file',
    ]);
    expect(
      accepts(loadSkill.schema, { name: 'x'.repeat(64), reason: 'r' }),
    ).toBe(true);
    expect(
      accepts(loadSkill.schema, { name: 'x'.repeat(65), reason: 'r' }),
    ).toBe(false);
    expect(accepts(loadSkill.schema, { name: 'x', reason: '' })).toBe(false);
    expect(
      accepts(loadFile.schema, { path: 'p'.repeat(1024), reason: 'r' }),
    ).toBe(true);
    expect(
      accepts(loadFile.schema, { path: 'p'.repeat(1025), reason: 'r' }),
    ).toBe(false);
    expect(
      accepts(loadFile.schema, { path: 'p', reason: 'r'.repeat(301) }),
    ).toBe(false);
  });

  it('are never run through LangChain', async () => {
    await expect(
      CONTEXT_TOOLS[0].invoke({ name: 'money-rules', reason: 'r' }),
    ).rejects.toThrow('ContextLoaderService.load()');
  });
});

describe('canLoad (SDW7) and newBudget', () => {
  const none: StepSetup = {
    ...SETUP,
    skill: { ...SETUP.skill, files: [] },
    repo: { rootAgents: SETUP.repo.rootAgents, skills: [], agents: [] },
  };

  it('nothing to load with no repo skill, no folder AGENTS.md and no other step-skill file (a root AGENTS.md is no reason)', () => {
    expect(canLoad(none)).toBe(false);
    expect(canLoad({ ...none, skill: SETUP.skill })).toBe(true);
    expect(canLoad({ ...none, repo: { ...none.repo, agents: [] } })).toBe(
      false,
    );
    expect(
      canLoad({ ...none, repo: { ...none.repo, skills: SETUP.repo.skills } }),
    ).toBe(true);
    expect(
      canLoad({ ...none, repo: { ...none.repo, agents: SETUP.repo.agents } }),
    ).toBe(true);
  });

  it('a new budget: the limits, and the start files already given (the root AGENTS.md only when there is one)', () => {
    expect(newBudget(SETUP, LIMITS)).toEqual({
      loadsLeft: 10,
      bytesLeft: 204_800,
      given: new Set(['.github-agent/skills/grill/SKILL.md', 'AGENTS.md']),
      loadedSkills: new Set(),
      limitHit: null,
    });
    expect(
      newBudget({ ...SETUP, repo: { ...SETUP.repo, rootAgents: null } }, LIMITS)
        .given,
    ).toEqual(new Set(['.github-agent/skills/grill/SKILL.md']));
  });
});

describe('checkRequest: the request flowchart, box by box', () => {
  it('1. no loads left → limit-reached, the files limit hit; not counted', () => {
    const budget = { ...newBudget(SETUP, LIMITS), loadsLeft: 0 };

    expect(check(file('src/AGENTS.md'), budget)).toEqual({
      outcome: 'limit-reached',
      answer: LIMIT_ANSWER,
    });
    expect(budget).toMatchObject({ loadsLeft: 0, limitHit: 'files' });
  });

  it('2–3. counted, then not in any list → not-found (a file, a skill, a tool the bot did not offer)', () => {
    const budget = newBudget(SETUP, LIMITS);

    expect(check(file('CLAUDE.md'), budget)).toEqual({
      outcome: 'not-found',
      answer:
        'Not available: `CLAUDE.md`. Only files listed in the instructions or in a loaded skill can be loaded.',
    });
    expect(check(skill('tax-rules'), budget)).toEqual({
      outcome: 'not-found',
      answer:
        'No skill named `tax-rules` in this repository. The skills are listed in the instructions; carry on ' +
        'without it.',
    });
    expect(
      check({ tool: 'read_file', path: 'src/x.ts', reason: 'r' }, budget),
    ).toEqual({
      outcome: 'not-found',
      answer: 'No tool named `read_file`: use load_skill or load_file.',
    });
    expect(budget).toMatchObject({
      loadsLeft: 7,
      bytesLeft: 204_800,
      limitHit: null,
    });
  });

  it('4. already given → already-loaded, counted: the step SKILL.md, the root AGENTS.md, a file loaded before', () => {
    const budget = newBudget(SETUP, LIMITS);

    expect(check(file('.github-agent/skills/grill/SKILL.md'), budget)).toEqual({
      outcome: 'already-loaded',
      answer:
        '`.github-agent/skills/grill/SKILL.md` is already in this conversation.',
      file: {
        kind: 'step-skill',
        skill: 'grill',
        path: '.github-agent/skills/grill/SKILL.md',
        bytes: 14,
      },
    });
    expect(check(file('AGENTS.md'), budget)).toMatchObject({
      outcome: 'already-loaded',
      answer: '`AGENTS.md` is already in this conversation.',
      file: { kind: 'agents', path: 'AGENTS.md', bytes: 13 },
    });
    const first = check(file('src/AGENTS.md'), budget);
    if (first.outcome !== 'read') throw new Error(first.outcome);
    markLoaded(budget, first.file);
    expect(check(file('src/AGENTS.md'), budget)).toMatchObject({
      outcome: 'already-loaded',
      answer: '`src/AGENTS.md` is already in this conversation.',
    });
    expect(budget).toMatchObject({ loadsLeft: 6, bytesLeft: 204_800 - 1210 });
  });

  it('5. bigger than the byte limit on its own → too-large; no limit is hit, so the tools stay on', () => {
    const budget = newBudget(SETUP, LIMITS);
    const small = { ...LIMITS, maxBytes: 3000 };

    expect(check(file(QUESTIONS), budget, small)).toEqual({
      outcome: 'too-large',
      answer: `\`${QUESTIONS}\` has 3,120 bytes, more than the 3,000 a whole answer may load; carry on without it.`,
      file: {
        kind: 'step-skill',
        skill: 'grill',
        path: QUESTIONS,
        bytes: 3120,
      },
    });
    expect(budget).toMatchObject({
      loadsLeft: 9,
      bytesLeft: 204_800,
      limitHit: null,
    });
  });

  it('6. more than the bytes left → limit-reached, the bytes limit hit', () => {
    const budget = { ...newBudget(SETUP, LIMITS), bytesLeft: 3119 };

    expect(check(file(QUESTIONS), budget)).toMatchObject({
      outcome: 'limit-reached',
      answer: LIMIT_ANSWER,
      file: { path: QUESTIONS },
    });
    expect(budget).toMatchObject({ loadsLeft: 9, limitHit: 'bytes' });
  });

  it('7. it fits → read; only markLoaded adds bytes and marks it given', () => {
    const budget = newBudget(SETUP, LIMITS);

    const checked = check(file(QUESTIONS), budget);
    expect(checked).toEqual({
      outcome: 'read',
      file: {
        kind: 'step-skill',
        skill: 'grill',
        path: QUESTIONS,
        bytes: 3120,
      },
    });
    expect(budget.bytesLeft).toBe(204_800);
    if (checked.outcome !== 'read') throw new Error(checked.outcome);
    markLoaded(budget, checked.file);
    expect(budget.bytesLeft).toBe(204_800 - 3120);
    expect(budget.given.has(QUESTIONS)).toBe(true);
  });

  it('three requests with one load left → read, limit-reached, limit-reached', () => {
    const budget = { ...newBudget(SETUP, LIMITS), loadsLeft: 1 };

    expect(
      [
        check(file('src/AGENTS.md'), budget),
        check(file(QUESTIONS), budget),
        check(skill('money-rules'), budget),
      ].map(({ outcome }) => outcome),
    ).toEqual(['read', 'limit-reached', 'limit-reached']);
    expect(budget.limitHit).toBe('files');
  });

  it('after the bytes limit, a file that would fit → limit-reached too', () => {
    const budget = { ...newBudget(SETUP, LIMITS), bytesLeft: 2000 };

    expect(check(file(QUESTIONS), budget).outcome).toBe('limit-reached');
    expect(check(file('src/AGENTS.md'), budget)).toEqual({
      outcome: 'limit-reached',
      answer: LIMIT_ANSWER,
    });
    expect(budget.limitHit).toBe('bytes');
  });

  it('a limit of 1 file reads "at most 1 file"', () => {
    const budget = { ...newBudget(SETUP, LIMITS), loadsLeft: 0 };

    expect(
      check(file('src/AGENTS.md'), budget, { maxLoads: 1, maxBytes: 1024 }),
    ).toMatchObject({
      answer:
        'Limit reached: this answer may load at most 1 file and 1,024 bytes. Answer now with what you have.',
    });
  });
});

describe('checkRequest: paths and repo skills', () => {
  it('a leading ./ or / is dropped; the letter case must match', () => {
    expect(check(file('./src/AGENTS.md'))).toMatchObject({
      outcome: 'read',
      file: { kind: 'agents', path: 'src/AGENTS.md', bytes: 1210 },
    });
    expect(check(file('/src/AGENTS.md')).outcome).toBe('read');
    expect(check(file('src/agents.md'))).toEqual({
      outcome: 'not-found',
      answer:
        'Not available: `src/agents.md`. Only files listed in the instructions or in a loaded skill can be loaded.',
    });
  });

  it("a repo skill's file before its SKILL.md is loaded → not-found, load the skill first; after → read", () => {
    const budget = newBudget(SETUP, LIMITS);

    expect(check(file(ROUNDING), budget)).toEqual({
      outcome: 'not-found',
      answer:
        `Not available: \`${ROUNDING}\`. Only files listed in the instructions or in a loaded skill can be ` +
        'loaded: load skill `money-rules` first.',
      file: {
        kind: 'repo-skill',
        skill: 'money-rules',
        path: ROUNDING,
        bytes: 1240,
      },
    });
    expect(check(file(MONEY_MD), budget).outcome).toBe('not-found');

    const loaded = check(skill('money-rules'), budget);
    expect(loaded).toEqual({
      outcome: 'read',
      file: {
        kind: 'repo-skill',
        skill: 'money-rules',
        path: MONEY_MD,
        bytes: 1335,
        repoSkill: SETUP.repo.skills[0],
      },
    });
    if (loaded.outcome !== 'read') throw new Error(loaded.outcome);
    markLoaded(budget, loaded.file);
    expect(budget.loadedSkills).toEqual(new Set(['money-rules']));

    expect(check(file(ROUNDING), budget)).toEqual({
      outcome: 'read',
      file: {
        kind: 'repo-skill',
        skill: 'money-rules',
        path: ROUNDING,
        bytes: 1240,
      },
    });
    expect(check(skill('money-rules'), budget)).toMatchObject({
      outcome: 'already-loaded',
      answer: 'Skill `money-rules` is already in this conversation.',
    });
    expect(check(file(MONEY_MD), budget).outcome).toBe('already-loaded');
  });

  it('model text in an answer has no backticks or line breaks, and a name is cut at 64 characters', () => {
    expect(check(skill(`\`@team\`\n${'x'.repeat(80)}`))).toMatchObject({
      answer: `No skill named \`@team ${'x'.repeat(58)}\` in this repository. The skills are listed in the instructions; carry on without it.`,
    });
  });
});

describe('the request, its reason, the answers', () => {
  it('requestOf takes the text arguments of a tool call and leaves out the others', () => {
    expect(
      requestOf({
        name: 'load_file',
        args: { path: 'src/AGENTS.md', reason: 42 },
        id: 'c1',
      }),
    ).toEqual({
      tool: 'load_file',
      name: undefined,
      path: 'src/AGENTS.md',
      reason: undefined,
    });
  });

  it('a missing or blank reason → (none given); a reason is kept as written', () => {
    expect(reasonOf(file('src/AGENTS.md', '  '))).toBe(NONE_GIVEN);
    expect(reasonOf({ tool: 'load_skill', name: 'x' })).toBe('(none given)');
    expect(reasonOf(file('src/AGENTS.md', 'the issue edits src/'))).toBe(
      'the issue edits src/',
    );
  });

  it("a loaded repo skill: its SKILL.md and its other files' list; a file: its block; unreadable", () => {
    const checked = check(skill('money-rules'));
    if (checked.outcome !== 'read') throw new Error(checked.outcome);

    expect(loadedAnswer(checked.file, '# Money rules')).toBe(
      `<skill name="money-rules" path="${MONEY_DIR}">\n` +
        `<file path="${MONEY_MD}">\n# Money rules\n</file>\n` +
        'Other files of this skill, to load with load_file when the skill points to one:\n' +
        `- ${ROUNDING} (1,240 bytes)\n` +
        '</skill>',
    );
    expect(
      loadedAnswer({ kind: 'agents', path: 'src/AGENTS.md', bytes: 9 }, 'x'),
    ).toBe('<file path="src/AGENTS.md">\nx\n</file>');
    expect(
      unreadableAnswer({ kind: 'agents', path: 'src/AGENTS.md', bytes: 9 }),
    ).toBe("`src/AGENTS.md` can't be read as text; carry on without it.");
  });

  it('a repo skill with no other file → its SKILL.md alone', () => {
    const setup: StepSetup = {
      ...SETUP,
      repo: {
        ...SETUP.repo,
        skills: [{ ...SETUP.repo.skills[0], files: [] }],
      },
    };
    const checked = check(skill('money-rules'), undefined, LIMITS, setup);
    if (checked.outcome !== 'read') throw new Error(checked.outcome);

    expect(loadedAnswer(checked.file, 'm')).toBe(
      `<skill name="money-rules" path="${MONEY_DIR}">\n<file path="${MONEY_MD}">\nm\n</file>\n</skill>`,
    );
  });
});
