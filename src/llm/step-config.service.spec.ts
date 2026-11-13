import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import { InMemoryRepoProvider } from '../../test/fakes/in-memory-repo-provider.js';
import { ScriptedChatModelFactory } from '../../test/fakes/scripted-chat-model.factory.js';
import type { Env } from '../config/env.schema.js';
import type { UnifiedTask } from '../contracts/issue-provider.js';
import { StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { StepName } from '../contracts/step.js';
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
      `Placeholder skill for ${step}.`,
    );
  }
  repo.seedFile(branch, 'README.md', 'sandbox');
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
  it('returns the commit, the skill and the model; one resolveRef, everything else read at that SHA', async () => {
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
        files: [{ path: 'SKILL.md', text: 'Placeholder skill for spec.' }],
      },
      model: {
        provider: 'scripted',
        name: 'gemini-4-argon',
        level: 'standard',
      },
    });
    expect(repo.calls).toEqual([
      { method: 'resolveRef', args: ['main'] },
      { method: 'readFile', args: [commit, WORKFLOW_CONFIG_PATH] },
      { method: 'listFiles', args: [commit, SKILL_DIRS.spec] },
      { method: 'readFile', args: [commit, `${SKILL_DIRS.spec}/SKILL.md`] },
    ]);
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
  it('passes when every step of the lane has a skill; reads no skill file', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.calls.length = 0;

    await expect(service.checkRun('full-sdd', false)).resolves.toBeUndefined();

    expect(
      repo.calls
        .filter((call) => call.method === 'readFile')
        .map((call) => call.args[1]),
    ).toEqual([WORKFLOW_CONFIG_PATH]);
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

  it('a skill over the size limit fails the check', async () => {
    const { repo, service } = setup();
    seed(repo);
    repo.seedFile('main', `${SKILL_DIRS.code}/big.md`, 'x'.repeat(204_800));

    expect(await configError(service.checkRun('code-only', false))).toMatch(
      /^skill too large: code \(204,8\d\d bytes, limit 204,800\)$/,
    );
  });

  it('an unknown base branch → the ProviderError passes through unchanged', async () => {
    const { service } = setup('no-such-branch');

    await expect(service.checkRun('full-sdd', false)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
