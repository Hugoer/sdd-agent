import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import { testScanner } from '../../test/fakes/in-memory-context-loads.js';
import { InMemoryRepoProvider } from '../../test/fakes/in-memory-repo-provider.js';
import { ScriptedChatModelFactory } from '../../test/fakes/scripted-chat-model.factory.js';
import { skillMd } from '../../test/fixtures/skills.js';
import type { Env } from '../config/env.schema.js';
import type { UnifiedTask } from '../contracts/issue-provider.js';
import { StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { StepName } from '../contracts/step.js';
import { RepoCatalogService } from './repo-catalog.service.js';
import { StepConfigService } from './step-config.service.js';
import { WORKFLOW_CONFIG_PATH } from './workflow-config.js';

afterEach(() => vi.restoreAllMocks());

const REPO = 'test-owner/test-repo';
const SKILL_DIRS: Record<StepName, string> = {
  grill: '.github-agent/skills/grill',
  spec: '.github-agent/skills/spec',
  plan: '.github-agent/skills/plan',
  code: '.github-agent/skills/code',
  qualityGate: '.github-agent/skills/quality-gate',
};
const WORKFLOW = {
  skills: SKILL_DIRS,
  models: {
    standard: { default: 'gemini-4-argon' },
    max: { default: 'gemini-4-carbon' },
  },
};

/** A repo whose `branch` holds the map and a one-file skill for each step in `steps`. */
function seed(
  repo: InMemoryRepoProvider,
  options: {
    branch?: string;
    steps?: StepName[];
    workflow?: string | null;
  } = {},
): void {
  const branch = options.branch ?? 'main';
  const workflow =
    options.workflow === undefined
      ? JSON.stringify(WORKFLOW)
      : options.workflow;
  if (workflow !== null) repo.seedFile(branch, WORKFLOW_CONFIG_PATH, workflow);
  for (const step of options.steps ?? Object.keys(SKILL_DIRS)) {
    repo.seedFile(
      branch,
      `${SKILL_DIRS[step as StepName]}/SKILL.md`,
      placeholder(step as StepName),
    );
  }
  repo.seedFile(branch, 'README.md', 'sandbox');
}

/** A step's placeholder skill with a valid header (SD12): `name` is its folder's. */
function placeholder(step: StepName): string {
  return skillMd(
    SKILL_DIRS[step].split('/').at(-1)!,
    `Placeholder skill for ${step}.`,
  );
}

function setup(base = 'main') {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const repo = new InMemoryRepoProvider(REPO);
  const issues = new InMemoryIssueProvider(REPO);
  const service = new StepConfigService(
    repo,
    issues,
    new ScriptedChatModelFactory(),
    new ConfigService<Env, true>({ TARGET_BASE_BRANCH: base }),
    new RepoCatalogService(repo, testScanner()),
  );
  return { repo, service };
}

const task = (labels: string[] = []): UnifiedTask => ({
  platform: 'GITHUB',
  id: '1014',
  externalRef: `${REPO}#14`,
  title: 'A task',
  description: 'Some text.',
  labels,
  author: 'octocat',
  url: `https://github.com/${REPO}/issues/14`,
  open: true,
});

async function configError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a StepConfigError');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StepConfigError);
  return (error as Error).message;
}

describe('StepConfigService.prepare', () => {
  it('returns the commit, the skill, the model and the repo; one resolveRef, everything else read at that SHA', async () => {
    const { repo, service } = setup();
    seed(repo);
    const commit = await repo.resolveRef('main');
    repo.calls.length = 0;

    const setupForSpec = await service.prepare('spec', task());

    expect(setupForSpec).toEqual({
      commit,
      skill: {
        step: 'spec',
        path: SKILL_DIRS.spec,
        commit,
        instructions: placeholder('spec'),
        files: [],
      },
      model: {
        provider: 'scripted',
        name: 'gemini-4-argon',
        level: 'standard',
      },
      repo: { rootAgents: null, skills: [], agents: [] },
    });
    // P11: one listing of the whole tree; every step skill's SKILL.md read once (SDW15).
    expect(repo.calls).toEqual([
      { method: 'resolveRef', args: ['main'] },
      { method: 'readFile', args: [commit, WORKFLOW_CONFIG_PATH] },
      { method: 'listFiles', args: [commit, ''] },
      ...Object.values(SKILL_DIRS).map((dir) => ({
        method: 'readFile',
        args: [commit, `${dir}/SKILL.md`],
      })),
    ]);
  });

  it('SDW15: a second prepare at the same commit reads nothing but the commit; checkRun too', async () => {
    const { repo, service } = setup();
    seed(repo);
    await service.prepare('grill', task());
    repo.calls.length = 0;

    await service.prepare('spec', task());
    await service.checkRun('full-sdd', false);

    expect(repo.calls).toEqual([
      { method: 'resolveRef', args: ['main'] },
      { method: 'resolveRef', args: ['main'] },
    ]);
  });

  it('SDW15: a new commit → everything read again', async () => {
    const { repo, service } = setup();
    seed(repo);
    await service.prepare('grill', task());
    repo.seedFile('main', 'NEW.md', 'someone merged');
    const commit = await repo.resolveRef('main');
    repo.calls.length = 0;

    await service.prepare('grill', task());

    expect(repo.calls.map((call) => call.method)).toEqual([
      'resolveRef',
      'readFile',
      'listFiles',
      ...Object.values(SKILL_DIRS).map(() => 'readFile'),
    ]);
    expect(repo.calls.slice(1).every((call) => call.args[0] === commit)).toBe(
      true,
    );
  });

  it("the step's model label (any letter case) → max; another step's label changes nothing", async () => {
    const { repo, service } = setup();
    seed(repo);

    await expect(
      service.prepare('spec', task(['Model: Max-Spec'])),
    ).resolves.toMatchObject({
      model: { name: 'gemini-4-carbon', level: 'max' },
    });
    await expect(
      service.prepare('code', task(['model: max-spec'])),
    ).resolves.toMatchObject({
      model: { name: 'gemini-4-argon', level: 'standard' },
    });
  });

  it('a missing workflow.json → invalid workflow.json, no skill read', async () => {
    const { repo, service } = setup();
    seed(repo, { workflow: null });

    expect(await configError(service.prepare('spec', task()))).toBe(
      'invalid workflow.json: no file .github-agent/workflow.json',
    );
    expect(repo.calls.map((call) => call.method)).toEqual([
      'resolveRef',
      'readFile',
    ]);
  });

  it('a step without a skill → missing skills: <step>', async () => {
    const { repo, service } = setup();
    seed(repo, { steps: ['spec'] });

    expect(await configError(service.prepare('plan', task()))).toBe(
      'missing skills: plan',
    );
  });

  it('an unknown base branch → the ProviderError passes through unchanged', async () => {
    const { service } = setup('no-such-branch');

    await expect(service.prepare('spec', task())).rejects.toMatchObject({
      constructor: ProviderError,
      kind: 'permanent',
      message: expect.stringContaining('"no-such-branch"') as string,
    });
  });

  it("reads another branch when asked (the smoke script's --base)", async () => {
    const { repo, service } = setup();
    seed(repo);
    seed(repo, { branch: 'other', steps: [] });

    expect(await configError(service.prepare('spec', task(), 'other'))).toBe(
      'missing skills: spec',
    );
  });
});

describe('StepConfigService.checkRun', () => {
  it("passes when every step of the lane has a valid skill; SD12: reads each step's SKILL.md once", async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.calls.length = 0;

    await expect(service.checkRun('full-sdd', false)).resolves.toBeUndefined();

    expect(
      repo.calls
        .filter((call) => call.method === 'readFile')
        .map((call) => call.args[1]),
    ).toEqual([
      WORKFLOW_CONFIG_PATH,
      ...Object.values(SKILL_DIRS).map((dir) => `${dir}/SKILL.md`),
    ]);
    expect(
      repo.calls.filter((call) => call.method === 'resolveRef'),
    ).toHaveLength(1);
  });

  it('names every missing step at once, in step order', async () => {
    const { repo, service } = setup();
    seed(repo, { steps: ['grill', 'spec', 'qualityGate'] });

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      'missing skills: plan, code',
    );
  });

  it.each([
    ['code-only', false, ['code', 'qualityGate']],
    ['spec-code', true, ['spec', 'code', 'qualityGate']],
    ['full-sdd', true, ['spec', 'plan', 'code', 'qualityGate']],
  ] as const)(
    '%s (grillSkip %s) checks only the steps it uses',
    async (lane, grillSkip, steps) => {
      const { repo, service } = setup();
      seed(repo, { steps: [...steps] });

      await expect(service.checkRun(lane, grillSkip)).resolves.toBeUndefined();
    },
  );

  it('an empty SKILL.md counts as missing from the listing alone', async () => {
    const { repo, service } = setup();
    seed(repo, { steps: ['spec', 'qualityGate'] });
    repo.seedFile('main', `${SKILL_DIRS.code}/SKILL.md`, '');

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'missing skills: code',
    );
  });

  it('an invalid models section fails even when the skills are fine', async () => {
    const { repo, service } = setup();
    seed(repo, {
      workflow: JSON.stringify({
        skills: SKILL_DIRS,
        models: { standard: { default: 'gemini-4-argon' } },
      }),
    });

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'invalid workflow.json: models.max: missing',
    );
  });

  it('a SKILL.md over the size limit fails the check', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.code}/SKILL.md`, 'x'.repeat(204_801));

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'skill too large: code (204,801 bytes, limit 204,800)',
    );
  });

  it('spec 11 (SDW8): a big other file no longer counts', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.code}/big.md`, 'x'.repeat(204_800));

    await expect(service.checkRun('code-only', false)).resolves.toBeUndefined();
  });

  it('an unknown base branch → the ProviderError passes through unchanged', async () => {
    const { service } = setup('no-such-branch');

    await expect(service.checkRun('full-sdd', false)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('SD12: every broken step skill of the lane in one invalid skills, in step order', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile(
      'main',
      `${SKILL_DIRS.plan}/SKILL.md`,
      '---\nname: plan\n---\nNo description.',
    );
    repo.seedFile(
      'main',
      `${SKILL_DIRS.spec}/SKILL.md`,
      '---\nname: Spec\ndescription: d\n---\n',
    );

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      `invalid skills: ${SKILL_DIRS.spec}/SKILL.md: name \`Spec\` is not lowercase letters, digits and hyphens; ` +
        `${SKILL_DIRS.plan}/SKILL.md: no description`,
    );
    // A lane without those steps passes.
    await expect(service.checkRun('code-only', false)).resolves.toBeUndefined();
  });

  it('P1: a missing step comes first: missing skills only, broken headers not named', async () => {
    const { repo, service } = setup();
    seed(repo, { steps: ['grill', 'spec', 'plan', 'qualityGate'] });
    repo.seedFile(
      'main',
      `${SKILL_DIRS.spec}/SKILL.md`,
      '---\nname: Spec\ndescription: d\n---\n',
    );

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      'missing skills: code',
    );
  });

  it('P1: missing skills before skill too large, whatever the step order', async () => {
    const { repo, service } = setup();
    seed(repo, { steps: ['grill', 'spec', 'plan', 'qualityGate'] });
    repo.seedFile('main', `${SKILL_DIRS.grill}/SKILL.md`, 'x'.repeat(204_801));

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      'missing skills: code',
    );
  });

  it('a whitespace-only SKILL.md found when read counts as missing', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.code}/SKILL.md`, '  \n');

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'missing skills: code',
    );
  });
});

describe('StepConfigService.prepare: SD12', () => {
  it("a broken header on the step's own skill → invalid skills", async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.grill}/SKILL.md`, '# Grill skill');

    expect(await configError(service.prepare('grill', task()))).toBe(
      `invalid skills: ${SKILL_DIRS.grill}/SKILL.md: no header`,
    );
  });

  it("a broken header on another step's skill doesn't stop this step", async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.spec}/SKILL.md`, '# Spec skill');

    await expect(service.prepare('grill', task())).resolves.toMatchObject({
      skill: { step: 'grill' },
    });
  });
});

describe('StepConfigService: the repo content stops (spec 11, plan P1)', () => {
  const MONEY = '.claude/skills/money-rules/SKILL.md';

  /** The sandbox map with `repoSkills`, a valid money-rules skill and a root AGENTS.md. */
  function discovery(repo: InMemoryRepoProvider) {
    seed(repo, {
      workflow: JSON.stringify({ ...WORKFLOW, repoSkills: ['.claude/skills'] }),
    });
    repo.seedFile('main', MONEY, skillMd('money-rules', 'Integer cents.'));
    repo.seedFile('main', 'AGENTS.md', 'Amounts are integer cents.');
  }

  it('SDW11: a repoSkills folder not in the tree → invalid workflow.json, before every other problem', async () => {
    const { repo, service } = setup();
    discovery(repo);
    seed(repo, {
      steps: ['spec'],
      workflow: JSON.stringify({ ...WORKFLOW, repoSkills: ['.claude/skill'] }),
    });
    repo.seedFile('main', 'AGENTS.md', 'x'.repeat(204_801));

    for (const check of [
      service.checkRun('full-sdd', false),
      service.prepare('grill', task()),
    ]) {
      expect(await configError(check)).toBe(
        'invalid workflow.json: repoSkills folder not found: .claude/skill',
      );
    }
  });

  it('P1: missing skills before the root AGENTS.md; the root AGENTS.md before invalid skills', async () => {
    const { repo, service } = setup();
    discovery(repo);
    repo.seedFile('main', 'AGENTS.md', 'x'.repeat(204_801));
    repo.seedFile('main', MONEY, '# no header');

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      'AGENTS.md too large (204,801 bytes, limit 204,800)',
    );
    expect(await configError(service.prepare('grill', task()))).toBe(
      'AGENTS.md too large (204,801 bytes, limit 204,800)',
    );

    const other = setup();
    discovery(other.repo);
    seed(other.repo, {
      steps: ['grill', 'spec', 'plan', 'qualityGate'],
      workflow: JSON.stringify({ ...WORKFLOW, repoSkills: ['.claude/skills'] }),
    });
    other.repo.removeFile('main', `${SKILL_DIRS.code}/SKILL.md`);
    other.repo.seedFile('main', 'AGENTS.md', 'x'.repeat(204_801));
    expect(await configError(other.service.checkRun('full-sdd', false))).toBe(
      'missing skills: code',
    );
  });

  it('LW3: a root AGENTS.md that is not text → unreadable AGENTS.md', async () => {
    const { repo, service } = setup();
    discovery(repo);
    const read = repo.readFile.bind(repo);
    vi.spyOn(repo, 'readFile').mockImplementation((ref, path) =>
      path === 'AGENTS.md'
        ? Promise.reject(
            new ProviderError(
              'readFile AGENTS.md: not valid UTF-8',
              'permanent',
            ),
          )
        : read(ref, path),
    );

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'unreadable AGENTS.md',
    );
  });

  it('SD12: a step skill and a repo skill broken → one invalid skills, the step skill first', async () => {
    const { repo, service } = setup();
    discovery(repo);
    repo.seedFile(
      'main',
      `${SKILL_DIRS.spec}/SKILL.md`,
      '---\nname: Spec\ndescription: d\n---\n',
    );
    repo.seedFile(
      'main',
      '.claude/skills/no-desc/SKILL.md',
      '---\nname: no-desc\n---\n',
    );

    expect(await configError(service.checkRun('full-sdd', false))).toBe(
      `invalid skills: ${SKILL_DIRS.spec}/SKILL.md: name \`Spec\` is not lowercase letters, digits and hyphens; ` +
        '.claude/skills/no-desc/SKILL.md: no description',
    );
    // code-only doesn't use `spec`: only the repo skill.
    expect(await configError(service.checkRun('code-only', false))).toBe(
      'invalid skills: .claude/skills/no-desc/SKILL.md: no description',
    );
  });

  it('SD12: a broken repo skill stops prepare() at every step, whether or not the model would load it', async () => {
    const { repo, service } = setup();
    discovery(repo);
    repo.seedFile('main', MONEY, '---\nname: money-rules\n---\n');

    expect(await configError(service.prepare('grill', task()))).toBe(
      `invalid skills: ${MONEY}: no description`,
    );
  });

  it('SD12: the same name in two folders → named once, without a path, after that folder', async () => {
    const { repo, service } = setup();
    discovery(repo);
    seed(repo, {
      workflow: JSON.stringify({
        ...WORKFLOW,
        repoSkills: ['.claude/skills', '.agents/skills'],
      }),
    });
    repo.seedFile(
      'main',
      '.agents/skills/money-rules/SKILL.md',
      skillMd('money-rules', 'Again.'),
    );

    expect(await configError(service.checkRun('code-only', false))).toBe(
      'invalid skills: `money-rules` is in both `.claude/skills` and `.agents/skills`',
    );
  });

  it("a step's own folder under repoSkills is checked once, as the step skill", async () => {
    const { repo, service } = setup();
    seed(repo, {
      workflow: JSON.stringify({
        ...WORKFLOW,
        repoSkills: ['.github-agent/skills'],
      }),
    });
    repo.seedFile('main', `${SKILL_DIRS.grill}/SKILL.md`, '# no header');

    expect(await configError(service.prepare('grill', task()))).toBe(
      `invalid skills: ${SKILL_DIRS.grill}/SKILL.md: no header`,
    );
    // For `spec`, `grill` is a repo skill like any other: still named once.
    expect(await configError(service.prepare('spec', task()))).toBe(
      `invalid skills: ${SKILL_DIRS.grill}/SKILL.md: no header`,
    );
  });

  it('valid content: prepare returns the repo context; the step folder under repoSkills is not listed', async () => {
    const { repo, service } = setup();
    discovery(repo);

    const prepared = await service.prepare('grill', task());

    expect(prepared.repo).toEqual({
      rootAgents: {
        text: 'Amounts are integer cents.',
        bytes: 'Amounts are integer cents.'.length,
      },
      skills: [
        {
          name: 'money-rules',
          description: 'Test skill money-rules.',
          path: '.claude/skills/money-rules',
          files: [],
        },
      ],
      agents: [],
    });
  });
});

describe('spec 12 (plan DP10): a key in a skill header', () => {
  const KEY = ['AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4-_o5p'].join('');

  it('a plain, unquoted description holding a key passes the header check; the prompt gets the redacted text', async () => {
    const { repo, service } = setup();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    seed(repo);
    repo.seedFile(
      'main',
      `${SKILL_DIRS.grill}/SKILL.md`,
      skillMd('grill', `Ask. ${KEY}`, `Grill ${KEY}.`),
    );

    await service.checkRun('full-sdd', false);
    const prepared = await service.prepare('grill', task());

    expect(prepared.skill.instructions).toBe(
      skillMd(
        'grill',
        'Ask. [REDACTED: google-api-key]',
        'Grill [REDACTED: google-api-key].',
      ),
    );
  });
});
