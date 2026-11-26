import { describe, expect, it } from 'vitest';
import { StepConfigError } from '../contracts/llm-error.js';
import type { StepName } from '../contracts/step.js';
import { protectedRuleFor, protectedRules } from './protected-paths.js';
import {
  parseWorkflowConfig,
  resolveModel,
  stepsFor,
  type WorkflowConfig,
} from './workflow-config.js';

/** The sandbox's starting file (spec 4 "`workflow.json`"). */
const SANDBOX = {
  skills: {
    grill: '.github-agent/skills/grill',
    spec: '.github-agent/skills/spec',
    plan: '.github-agent/skills/plan',
    code: '.github-agent/skills/code',
    qualityGate: '.github-agent/skills/quality-gate',
  },
  protectedPaths: [],
  models: {
    standard: { default: 'gemini-4-argon' },
    max: { default: 'gemini-4-carbon' },
  },
};

/** The sandbox file as text, with each `path` set to its value (undefined deletes it). */
function variant(...changes: [path: string, value: unknown][]): string {
  const file = structuredClone(SANDBOX) as Record<string, unknown>;
  for (const [path, value] of changes) {
    const keys = path.split('.');
    const last = keys.pop()!;
    let target = file;
    for (const key of keys) target = target[key] as Record<string, unknown>;
    if (value === undefined) delete target[last];
    else target[last] = value;
  }
  return JSON.stringify(file);
}

function errorOf(text: string | null): string {
  try {
    parseWorkflowConfig(text);
  } catch (error) {
    expect(error).toBeInstanceOf(StepConfigError);
    return (error as Error).message;
  }
  throw new Error('expected parseWorkflowConfig to fail');
}

describe('parseWorkflowConfig', () => {
  it("accepts the sandbox's starting file; spec 11: no repoSkills key → none", () => {
    expect(parseWorkflowConfig(JSON.stringify(SANDBOX))).toEqual({
      ...SANDBOX,
      repoSkills: [],
    });
  });

  it('ignores unknown top-level keys and accepts a step missing from skills', () => {
    const text = variant(
      ['comment', 'kept out'],
      ['skills.plan', undefined],
      ['models.standard.spec', 'gemini-4-carbon'],
    );

    const config = parseWorkflowConfig(text);

    expect(config).not.toHaveProperty('comment');
    expect(config.skills.plan).toBeUndefined();
    expect(config.models.standard).toEqual({
      default: 'gemini-4-argon',
      spec: 'gemini-4-carbon',
    });
  });

  it.each<[string, string | null, string]>([
    [
      'no file',
      null,
      'invalid workflow.json: no file .github-agent/workflow.json',
    ],
    ['not JSON', '{ "skills": ', 'invalid workflow.json: not JSON'],
    ['an array', '[]', 'invalid workflow.json: not a JSON object'],
    ['a string', '"x"', 'invalid workflow.json: not a JSON object'],
    ['null', 'null', 'invalid workflow.json: not a JSON object'],
    [
      'no skills',
      variant(['skills', undefined]),
      'invalid workflow.json: skills: missing',
    ],
    [
      'skills not an object',
      variant(['skills', ['a']]),
      'invalid workflow.json: skills: must be an object',
    ],
    [
      'an unknown step in skills',
      variant(['skills.review', 'x']),
      'invalid workflow.json: skills: unknown key "review"',
    ],
    [
      'a skill path with a leading slash',
      variant(['skills.spec', '/etc']),
      'invalid workflow.json: skills.spec: must be a directory path relative to the repo root (no leading "/", no ".." segment)',
    ],
    [
      'a skill path with a .. segment',
      variant(['skills.code', 'skills/../../x']),
      'invalid workflow.json: skills.code: must be a directory path',
    ],
    [
      'an empty skill path',
      variant(['skills.grill', '']),
      'invalid workflow.json: skills.grill: must be a directory path',
    ],
    [
      'a skill path that is not a string',
      variant(['skills.plan', 7]),
      'invalid workflow.json: skills.plan: must be a string',
    ],
    [
      'no models',
      variant(['models', undefined]),
      'invalid workflow.json: models: missing',
    ],
    [
      'no max level',
      variant(['models.max', undefined]),
      'invalid workflow.json: models.max: missing',
    ],
    [
      'a level without default',
      variant(['models.standard.default', undefined]),
      'invalid workflow.json: models.standard.default: missing',
    ],
    [
      'an unknown key in a level',
      variant(['models.max.review', 'gemini-4-carbon']),
      'invalid workflow.json: models.max: unknown key "review"',
    ],
    [
      'a model name with a space',
      variant(['models.standard.spec', 'gemini 4']),
      'invalid workflow.json: models.standard.spec: must be a model name: 1–100 letters, digits, ".", "_" or "-"',
    ],
    [
      'a model name of 101 characters',
      variant(['models.max.default', 'a'.repeat(101)]),
      'invalid workflow.json: models.max.default: must be a model name',
    ],
    [
      'an empty model name',
      variant(['models.max.default', '']),
      'invalid workflow.json: models.max.default: must be a model name',
    ],
  ])('%s → %j', (_name, text, message) => {
    expect(errorOf(text)).toContain(message);
  });

  it('names every problem at once', () => {
    const message = errorOf(
      variant(['skills.spec', '/x'], ['models.max', undefined]),
    );

    expect(message).toMatch(/^invalid workflow\.json: /);
    expect(message).toContain('skills.spec: must be a directory path');
    expect(message).toContain('models.max: missing');
  });

  it.each<[string, unknown, string[]]>([
    ['[]', [], []],
    ['one folder', ['.claude/skills'], ['.claude/skills']],
    [
      'two folders, a trailing / ignored',
      ['.claude/skills/', '.agents/skills'],
      ['.claude/skills', '.agents/skills'],
    ],
    [
      '10 folders',
      [...Array(10).keys()].map((n) => `s${n}`),
      [...Array(10).keys()].map((n) => `s${n}`),
    ],
  ])('spec 11: repoSkills %s → accepted', (_name, value, expected) => {
    expect(
      parseWorkflowConfig(variant(['repoSkills', value])).repoSkills,
    ).toEqual(expected);
  });

  it.each<[string, unknown, string]>([
    [
      'a .. segment',
      ['skills/../secrets'],
      'invalid workflow.json: repoSkills.0: must be a directory path relative to the repo root (no leading "/", no ".." segment)',
    ],
    [
      'a leading /',
      ['.claude/skills', '/etc'],
      'invalid workflow.json: repoSkills.1: must be a directory path',
    ],
    [
      'an empty path',
      [''],
      'invalid workflow.json: repoSkills.0: must be a directory path',
    ],
    [
      'a duplicate (a trailing / ignored)',
      ['.claude/skills', '.claude/skills/'],
      'invalid workflow.json: repoSkills: must not name a folder twice',
    ],
    [
      '11 folders',
      [...Array(11).keys()].map((n) => `s${n}`),
      'invalid workflow.json: repoSkills: must name at most 10 folders',
    ],
    [
      'not an array',
      '.claude/skills',
      'invalid workflow.json: repoSkills: must be an array',
    ],
    [
      'a number in it',
      [7],
      'invalid workflow.json: repoSkills.0: must be a string',
    ],
  ])(
    'spec 11: repoSkills with %s → %j, never quoting the value',
    (_name, value, message) => {
      const error = errorOf(variant(['repoSkills', value]));
      expect(error).toContain(message);
      expect(error).not.toContain('secrets');
      expect(error).not.toContain('/etc');
    },
  );

  it('accepts a model name of 100 characters with ".", "_" and "-"', () => {
    const name = `${'a'.repeat(96)}.b_-`;
    const config = parseWorkflowConfig(variant(['models.max.default', name]));
    expect(config.models.max.default).toBe(name);
  });
});

describe('resolveModel', () => {
  const models: WorkflowConfig['models'] = {
    standard: { default: 'std-default', spec: 'std-spec' },
    max: { default: 'max-default', code: 'max-code' },
  };

  it.each<[StepName, StepName[], string, string]>([
    ['plan', [], 'standard', 'std-default'],
    ['spec', [], 'standard', 'std-spec'],
    ['code', ['code'], 'max', 'max-code'],
    ['plan', ['plan'], 'max', 'max-default'],
    // An entry only in `standard`, with the label on → `max.default`.
    ['spec', ['spec'], 'max', 'max-default'],
    // An entry only in `max`, without the label → `standard.default`.
    ['code', [], 'standard', 'std-default'],
    // Another step's label changes nothing.
    ['grill', ['spec', 'code'], 'standard', 'std-default'],
  ])('%s with labels %j → %s %s', (step, labels, level, name) => {
    expect(resolveModel(models, step, labels)).toEqual({ level, name });
  });
});

describe('stepsFor', () => {
  it.each([
    ['full-sdd', false, ['grill', 'spec', 'plan', 'code', 'qualityGate']],
    ['full-sdd', true, ['spec', 'plan', 'code', 'qualityGate']],
    ['spec-code', false, ['grill', 'spec', 'code', 'qualityGate']],
    ['spec-code', true, ['spec', 'code', 'qualityGate']],
    ['code-only', false, ['code', 'qualityGate']],
    ['code-only', true, ['code', 'qualityGate']],
  ] as const)('%s, grillSkip %s → %j', (lane, grillSkip, steps) => {
    expect(stepsFor(lane, grillSkip)).toEqual(steps);
  });
});

describe('parseWorkflowConfig: protectedPaths (spec 12 BD8, BDW8, plan DP16)', () => {
  const RULE =
    'must be a path glob relative to the repo root: 1–256 characters, no leading "/", no ".." segment, no "\\", ' +
    'no control character';

  it('missing → the key named and how to fix it', () => {
    expect(errorOf(variant(['protectedPaths', undefined]))).toBe(
      'invalid workflow.json: protectedPaths: missing (list the paths the bot must never change, [] for none)',
    );
  });

  it.each<[string, string[]]>([
    ['[]', []],
    [
      'the recommended array',
      ['**/AGENTS.md', '**/.env.!(example)', '.claude/skills/**'],
    ],
    ['a glob that matches nothing, twice', ['nothing/**', 'nothing/**']],
    ['200 globs', [...Array(200).keys()].map((n) => `g${n}/**`)],
    ['256 characters', ['a'.repeat(256)]],
  ])('%s → accepted and returned', (_name, value) => {
    expect(
      parseWorkflowConfig(variant(['protectedPaths', value])).protectedPaths,
    ).toEqual(value);
  });

  it.each<[string, unknown, string]>([
    ['a leading /', ['/abs/**'], `protectedPaths.0: ${RULE}`],
    ['a .. segment', ['ok/**', 'a/../b'], `protectedPaths.1: ${RULE}`],
    ['a backslash', ['a\\b'], `protectedPaths.0: ${RULE}`],
    ['a control character', ['a\u0007b'], `protectedPaths.0: ${RULE}`],
    ['an empty glob', [''], `protectedPaths.0: ${RULE}`],
    ['257 characters', ['a'.repeat(257)], `protectedPaths.0: ${RULE}`],
    [
      '201 globs',
      [...Array(201).keys()].map((n) => `g${n}/**`),
      'protectedPaths: must list at most 200 globs',
    ],
    [
      'a number in it',
      ['a', 'b', 'c', 7],
      'protectedPaths.3: must be a string',
    ],
    ['not an array', '**/AGENTS.md', 'protectedPaths: must be an array'],
  ])('%s → %j', (_name, value, message) => {
    expect(errorOf(variant(['protectedPaths', value]))).toBe(
      `invalid workflow.json: ${message}`,
    );
  });

  it('the parsed config feeds protectedRules', () => {
    const config = parseWorkflowConfig(
      variant(['protectedPaths', ['**/AGENTS.md']]),
    );
    expect(protectedRuleFor('docs/AGENTS.md', protectedRules(config))).toEqual({
      glob: '**/AGENTS.md',
      source: 'workflow.json',
    });
    expect(
      protectedRuleFor(
        '.github-agent/skills/code/SKILL.md',
        protectedRules(config),
      ),
    ).toEqual({ glob: '.github-agent/**', source: 'bot' });
  });
});
