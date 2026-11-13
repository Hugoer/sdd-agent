import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../../test/fakes/in-memory-issue-provider.js';
import { InMemoryRepoProvider } from '../../../test/fakes/in-memory-repo-provider.js';
import {
  SCRIPTED_USAGE,
  ScriptedChatModelFactory,
  type ScriptedReply,
} from '../../../test/fakes/scripted-chat-model.factory.js';
import type { Env } from '../../config/env.schema.js';
import { LlmError } from '../../contracts/llm-error.js';
import { StepConfigService } from '../step-config.service.js';
import { WORKFLOW_CONFIG_PATH } from '../workflow-config.js';
import {
  LLM_SMOKE_USAGE,
  parseSmokeArgs,
  runLlmSmoke,
  type LlmSmokeOptions,
} from './run-llm-smoke.js';

afterEach(() => vi.restoreAllMocks());

const REPO = 'test-owner/test-repo';
const SKILLS = {
  grill: '.github-agent/skills/grill',
  spec: '.github-agent/skills/spec',
  plan: '.github-agent/skills/plan',
  code: '.github-agent/skills/code',
  qualityGate: '.github-agent/skills/quality-gate',
};
const WORKFLOW = {
  skills: SKILLS,
  models: {
    standard: { default: 'gemini-4-argon' },
    max: { default: 'gemini-4-carbon' },
  },
};
const PLACEHOLDER = 'Placeholder until spec 7 writes this skill.';
// Stand-ins for what must never be printed, built at run time.
const KEY = ['secret', 'key', 'value'].join('-');
const ANSWER_TEXT = ['the', 'raw', 'answer', 'text'].join(' ');
const ISSUE_TEXT = ['private', 'issue', 'description'].join(' ');
const OK_ANSWER: ScriptedReply = {
  answer: JSON.stringify({ summary: ANSWER_TEXT, wordCount: 4 }),
};

interface World {
  workflow?: unknown;
  skipSteps?: string[];
  labels?: string[];
  extraFiles?: Record<string, string>;
}

/** The fakes behind the smoke: a sandbox with the map, one placeholder per step and issue #14. */
function world(options: World = {}) {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const repo = new InMemoryRepoProvider(REPO);
  const issues = new InMemoryIssueProvider(REPO);
  const factory = new ScriptedChatModelFactory();
  repo.seedFile(
    'main',
    WORKFLOW_CONFIG_PATH,
    typeof options.workflow === 'string'
      ? options.workflow
      : JSON.stringify(options.workflow ?? WORKFLOW),
  );
  for (const [step, dir] of Object.entries(SKILLS)) {
    if (!options.skipSteps?.includes(step))
      repo.seedFile('main', `${dir}/SKILL.md`, PLACEHOLDER);
  }
  for (const [path, text] of Object.entries(options.extraFiles ?? {}))
    repo.seedFile('main', path, text);
  issues.seedIssue({
    number: 14,
    description: ISSUE_TEXT,
    labels: options.labels ?? [],
  });
  const stepConfig = new StepConfigService(
    repo,
    issues,
    factory,
    new ConfigService<Env, true>({ TARGET_BASE_BRANCH: 'main' }),
  );
  return { repo, issues, factory, stepConfig };
}

async function run(
  w: ReturnType<typeof world>,
  replies: ScriptedReply[] = [OK_ANSWER],
  options: Partial<LlmSmokeOptions> = {},
) {
  w.factory.reply(...replies);
  const lines: string[] = [];
  let clock = 1_000;
  const ok = await runLlmSmoke(
    { ...w, targetRepo: REPO },
    { issue: 14, step: 'spec', base: 'main', ...options },
    (line) => lines.push(line),
    () => (clock += 250),
  );
  return { ok, lines, output: lines.join('\n') };
}

function expectNothingSecret(output: string): void {
  for (const value of [
    KEY,
    ANSWER_TEXT,
    ISSUE_TEXT,
    PLACEHOLDER,
    'x-goog-api-key',
  ]) {
    expect(output).not.toContain(value);
  }
}

describe('runLlmSmoke: checks 1–4', () => {
  it('a complete setup → checks 1–4 and the call PASS, with the commit, the maps, the files, the model', async () => {
    const w = world();
    const commit = await w.repo.resolveRef('main');

    const { ok, lines } = await run(w);

    expect(ok).toBe(true);
    expect(lines).toEqual([
      `PASS 1 workflow: main @ ${commit}; skills grill=${SKILLS.grill}, spec=${SKILLS.spec}, ` +
        `plan=${SKILLS.plan}, code=${SKILLS.code}, qualityGate=${SKILLS.qualityGate}; ` +
        'models standard default=gemini-4-argon; max default=gemini-4-carbon',
      'PASS 2 lanes: full-sdd ok; spec-code ok; code-only ok',
      `PASS 3 skill: ${SKILLS.spec} @ ${commit.slice(0, 7)}: SKILL.md (${PLACEHOLDER.length} B); ` +
        `${PLACEHOLDER.length} chars; skipped none`,
      'PASS 4 model: spec on #14: gemini-4-argon (standard, provider scripted)',
      `PASS call: model gemini-4-argon, 250 ms, tokens in ${SCRIPTED_USAGE.input_tokens} / out ${SCRIPTED_USAGE.output_tokens} / cached 0 / reasoning 12, finish STOP, summary ${ANSWER_TEXT.length} chars, wordCount 4`,
    ]);
    expectNothingSecret(lines.join('\n'));
    expect(w.factory.created).toEqual(['gemini-4-argon']);
  });

  it("the step's model label → max model in check 4 and in the call; another step stays standard", async () => {
    const max = await run(world({ labels: ['model: max-spec'] }));
    expect(max.output).toContain(
      'PASS 4 model: spec on #14: gemini-4-carbon (max, provider scripted)',
    );
    expect(max.output).toContain('PASS call: model gemini-4-carbon,');

    const code = await run(world({ labels: ['model: max-spec'] }), undefined, {
      step: 'code',
    });
    expect(code.output).toContain(
      'PASS 4 model: code on #14: gemini-4-argon (standard, provider scripted)',
    );
  });

  it('check 2 is informative: a lane with missing steps is shown and the smoke goes on', async () => {
    const { ok, lines } = await run(world({ skipSteps: ['plan', 'grill'] }));

    expect(ok).toBe(true);
    expect(lines[1]).toBe(
      'PASS 2 lanes: full-sdd missing skills: grill, plan; spec-code missing skills: grill; code-only ok',
    );
  });

  it('check 3 lists the files with sizes and the binary files left out, never their content', async () => {
    const { lines } = await run(
      world({
        extraFiles: {
          [`${SKILLS.spec}/notes.md`]: 'abc',
          [`${SKILLS.spec}/logo.png`]: 'png',
        },
      }),
    );

    expect(lines[2]).toMatch(
      new RegExp(
        `^PASS 3 skill: .*SKILL\\.md \\(${PLACEHOLDER.length} B\\), notes\\.md \\(3 B\\); ` +
          `${PLACEHOLDER.length + 3} chars; skipped logo\\.png$`,
      ),
    );
  });

  it('a broken map → check 1 FAIL, nothing else runs and no model is called', async () => {
    const w = world({ workflow: '{ "skills": ' });

    const { ok, lines } = await run(w);

    expect(ok).toBe(false);
    expect(lines).toEqual([
      'FAIL 1 workflow: StepConfigError: invalid workflow.json: not JSON',
    ]);
    expect(w.factory.created).toEqual([]);
  });

  it('an unknown base branch → check 1 FAIL naming the branch; no model call', async () => {
    const w = world();

    const { ok, lines } = await run(w, [OK_ANSWER], {
      base: 'no-such-branch',
    });

    expect(ok).toBe(false);
    expect(lines).toEqual([
      expect.stringMatching(
        /^FAIL 1 workflow: ProviderError: .*"no-such-branch"/,
      ) as string,
    ]);
    expect(w.factory.created).toEqual([]);
  });

  it("the step's skill missing → check 3 FAIL; no model call", async () => {
    const w = world({ skipSteps: ['spec'] });

    const { ok, lines } = await run(w);

    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe(
      'FAIL 3 skill: StepConfigError: missing skills: spec',
    );
    expect(w.factory.created).toEqual([]);
  });

  it('an issue that does not exist → check 3 FAIL with the provider error', async () => {
    const { ok, lines } = await run(world(), [OK_ANSWER], { issue: 99 });

    expect(ok).toBe(false);
    expect(lines.at(-1)).toMatch(/^FAIL 3 skill: ProviderError: /);
  });
});

describe('runLlmSmoke: the call', () => {
  it('shows "–" for token values the provider did not report', async () => {
    const { ok, output } = await run(world(), [
      { answer: JSON.stringify({ summary: 'ok', wordCount: 1 }), usage: null },
    ]);

    expect(ok).toBe(true);
    expect(output).toContain('tokens in – / out – / cached – / reasoning –');
  });

  it('a provider error → FAIL with its code and the HTTP status', async () => {
    const { ok, lines } = await run(world(), [
      {
        error: new LlmError(
          'Google has no model `gemini-4-argon` (HTTP 404, NOT_FOUND)',
          'permanent',
          'unknown-model',
        ),
      },
    ]);

    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe(
      'FAIL call: unknown-model (permanent): Google has no model `gemini-4-argon` (HTTP 404, NOT_FOUND)',
    );
  });

  it('a raw error from the package is mapped by the factory and never printed as is', async () => {
    const { ok, output } = await run(world(), [
      { error: new Error(`request failed, x-goog-api-key: ${KEY}`) },
    ]);

    expect(ok).toBe(false);
    expect(output).toMatch(/\nFAIL call: bad-request \(permanent\): /);
    expectNothingSecret(output);
  });

  it('an answer that is not JSON → FAIL invalid-answer, without quoting it', async () => {
    const { ok, output } = await run(world(), [{ answer: ANSWER_TEXT }]);

    expect(ok).toBe(false);
    expect(output).toMatch(
      /\nFAIL call: invalid-answer \(permanent\): .*not JSON/,
    );
    expectNothingSecret(output);
  });

  it('an answer that breaks the schema → FAIL invalid-answer naming the paths', async () => {
    const { ok, output } = await run(world(), [
      { answer: JSON.stringify({ summary: '', wordCount: -1 }) },
    ]);

    expect(ok).toBe(false);
    expect(output).toContain('invalid-answer');
    expect(output).toContain('summary: too_small');
    expect(output).toContain('wordCount: too_small');
  });

  it('a cut answer → FAIL from checkAnswer', async () => {
    const { ok, output } = await run(world(), [
      {
        answer: JSON.stringify({ summary: 'ok', wordCount: 1 }),
        finishReason: 'MAX_TOKENS',
      },
    ]);

    expect(ok).toBe(false);
    expect(output).toMatch(/\nFAIL call: answer-cut/);
  });
});

describe('parseSmokeArgs', () => {
  it('reads --issue, --step and --base', () => {
    expect(
      parseSmokeArgs([
        '--issue',
        '14',
        '--step',
        'qualityGate',
        '--base',
        'smoke/spec-4',
      ]),
    ).toEqual({ issue: 14, step: 'qualityGate', base: 'smoke/spec-4' });
    expect(parseSmokeArgs(['--issue', '3', '--step', 'spec'])).toEqual({
      issue: 3,
      step: 'spec',
      base: undefined,
    });
  });

  it.each([
    [[]],
    [['--issue', '14']],
    [['--step', 'spec']],
    [['--issue', '0', '--step', 'spec']],
    [['--issue', 'x', '--step', 'spec']],
    [['--issue', '14', '--step', 'review']],
    [['--issue', '14', '--step', 'quality-gate']],
    [['--issue', '14', '--step', 'spec', '--base', 'a..b']],
    [['--issue', '14', '--step', 'spec', '--base', '/main']],
    [['--issue', '14', '--step', 'spec', '--try', 'gemini-4-argon']],
    [['--issue', '14', '--step']],
  ])('%j → null (the entry prints the usage and exits 1)', (args) => {
    expect(parseSmokeArgs(args)).toBeNull();
  });

  it('the usage line names every option', () => {
    expect(LLM_SMOKE_USAGE).toBe(
      'Usage: npm run llm:smoke -- --issue <n> --step <grill|spec|plan|code|qualityGate> [--base <branch>]',
    );
  });
});
