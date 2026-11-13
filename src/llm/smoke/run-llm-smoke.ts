// The checks of `npm run llm:smoke` (spec 4 "Smoke script", plan P1). They use the ports and the provider seam
// only, so they are unit-tested against the fakes before they reach GitHub and Google.
//
// Second form (T16): checks 1–4 read the target repo's setup; the provisional call uses the resolved model,
// not guarded and not recorded. T24 replaces that call with LlmService.call() and adds checks 5–8.
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { IssueProvider, Lane } from '../../contracts/issue-provider.js';
import { LlmError, StepConfigError } from '../../contracts/llm-error.js';
import type { RepoProvider } from '../../contracts/repo-provider.js';
import type { StepName, StepSetup } from '../../contracts/step.js';
import type { ChatModelFactory } from '../chat-model.factory.js';
import { listSkill } from '../skill-loader.js';
import type {
  StepConfigService,
  WorkflowAtCommit,
} from '../step-config.service.js';

/** Spec 4 LlmService.call() step 3 (plan P2). Provisional here until LlmService owns it (T21). */
const CALL_TIMEOUT_MS = 300_000;

export const LLM_SMOKE_USAGE =
  'Usage: npm run llm:smoke -- --issue <n> --step <grill|spec|plan|code|qualityGate> [--base <branch>]';

const STEPS: readonly StepName[] = [
  'grill',
  'spec',
  'plan',
  'code',
  'qualityGate',
];
const LANES: readonly Lane[] = ['full-sdd', 'spec-code', 'code-only'];
/** Like TARGET_BASE_BRANCH's rule in the env schema, so `--base` goes into a URL path safely. */
const BRANCH_NAME =
  /^(?!\/)(?!.*\/$)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[a-z0-9._/-]{1,255}$/i;

/** The provisional call's schema. */
export const summarySchema = z.object({
  summary: z.string().min(1).max(300),
  wordCount: z.number().int().min(0),
});

const SMOKE_TEXT =
  'The bot reads a skill from the target repository, asks a model for an answer and posts it as a comment.';

export interface LlmSmokeOptions {
  issue: number;
  step: StepName;
  /** `--base`, or TARGET_BASE_BRANCH: the branch the map and the skills are read at. */
  base: string;
}

export interface LlmSmokeDeps {
  factory: ChatModelFactory;
  stepConfig: StepConfigService;
  issues: IssueProvider;
  repo: RepoProvider;
  targetRepo: string;
}

type Print = (line: string) => void;
/** A check returns what it saw, or throws. */
type Check = [name: string, run: () => Promise<string>];

/** `--issue <n> --step <step> [--base <branch>]`; null for anything else (the caller prints the usage). */
export function parseSmokeArgs(
  args: string[],
): (Omit<LlmSmokeOptions, 'base'> & { base?: string }) | null {
  try {
    const { values } = parseArgs({
      args,
      options: {
        issue: { type: 'string' },
        step: { type: 'string' },
        base: { type: 'string' },
      },
    });
    const { issue, step, base } = values;
    if (!issue || !/^[1-9]\d{0,8}$/.test(issue)) return null;
    if (!STEPS.includes(step as StepName)) return null;
    if (base !== undefined && !BRANCH_NAME.test(base)) return null;
    return { issue: Number(issue), step: step as StepName, base };
  } catch {
    return null; // unknown option or missing value
  }
}

/** Prints one PASS / FAIL line per check and stops at the first FAIL; true only if every check passed. */
export async function runLlmSmoke(
  deps: LlmSmokeDeps,
  options: LlmSmokeOptions,
  print: Print,
  now: () => number = () => performance.now(),
): Promise<boolean> {
  const { stepConfig } = deps;
  let workflow: WorkflowAtCommit | undefined;
  let setup: StepSetup | undefined;

  const checks: Check[] = [
    [
      '1 workflow',
      async () => {
        workflow = await stepConfig.readWorkflow(options.base);
        return describeWorkflow(workflow, options.base);
      },
    ],
    ['2 lanes', () => laneCheck(stepConfig, options.base)],
    [
      '3 skill',
      async () => {
        const task = await deps.issues.getTaskDetails({
          platform: 'GITHUB',
          id: 'smoke',
          externalRef: `${deps.targetRepo}#${options.issue}`,
        });
        setup = await stepConfig.prepare(options.step, task, options.base);
        return describeSkill(deps.repo, workflow!, setup);
      },
    ],
    [
      '4 model',
      () => {
        const { model } = setup!;
        return Promise.resolve(
          `${options.step} on #${options.issue}: ${model.name} (${model.level}, provider ${model.provider})`,
        );
      },
    ],
    ['call', () => callCheck(deps.factory, setup!.model.name, now)],
  ];
  for (const [name, run] of checks) {
    try {
      print(`PASS ${name}: ${await run()}`);
    } catch (error) {
      print(`FAIL ${name}: ${describeFailure(error)}`);
      return false;
    }
  }
  return true;
}

/** Check 1: the commit, the skills map and the models. */
function describeWorkflow(
  { commit, config }: WorkflowAtCommit,
  base: string,
): string {
  const skills = STEPS.map(
    (step) => `${step}=${config.skills[step] ?? '(none)'}`,
  ).join(', ');
  const models = (['standard', 'max'] as const)
    .map(
      (level) =>
        `${level} ${Object.entries(config.models[level])
          .map(([key, name]) => `${key}=${name}`)
          .join(', ')}`,
    )
    .join('; ');
  return `${base} @ ${commit}; skills ${skills}; models ${models}`;
}

/** Check 2 (informative): a lane with missing steps doesn't fail the smoke; any other error does. */
async function laneCheck(
  stepConfig: StepConfigService,
  base: string,
): Promise<string> {
  const results: string[] = [];
  for (const lane of LANES) {
    try {
      await stepConfig.checkRun(lane, false, base);
      results.push(`${lane} ok`);
    } catch (error) {
      if (!(error instanceof StepConfigError)) throw error;
      results.push(`${lane} ${error.message}`);
    }
  }
  return results.join('; ');
}

/** Check 3: the files and their sizes, the total characters, the binary files left out. Never content. */
async function describeSkill(
  repo: RepoProvider,
  { config }: WorkflowAtCommit,
  { skill, commit }: StepSetup,
): Promise<string> {
  const listing = await listSkill(repo, config.skills, skill.step, commit);
  const files = skill.files
    .map((file) => `${file.path} (${Buffer.byteLength(file.text)} B)`)
    .join(', ');
  const chars = skill.files.reduce((sum, file) => sum + file.text.length, 0);
  const prefix = `${skill.path.replace(/\/+$/, '')}/`;
  const skipped =
    listing?.skipped.map((file) => file.path.slice(prefix.length)) ?? [];
  return (
    `${skill.path} @ ${commit.slice(0, 7)}: ${files}; ${chars} chars; skipped ` +
    (skipped.length > 0 ? skipped.join(', ') : 'none')
  );
}

async function callCheck(
  factory: ChatModelFactory,
  model: string,
  now: () => number,
): Promise<string> {
  const started = now();
  let raw;
  try {
    const structured = factory
      .create(model)
      .withStructuredOutput(summarySchema, {
        method: 'jsonSchema',
        includeRaw: true,
      });
    ({ raw } = await structured.invoke(
      [
        new SystemMessage(
          'Answer with JSON only: a one-sentence summary of the text and its number of words.',
        ),
        new HumanMessage(SMOKE_TEXT),
      ],
      { timeout: CALL_TIMEOUT_MS },
    ));
  } catch (error) {
    throw factory.toLlmError(error, model);
  }
  const durationMs = Math.round(now() - started);
  if (!AIMessage.isInstance(raw)) {
    throw new LlmError(
      `model \`${model}\` gave no answer message`,
      'permanent',
      'invalid-answer',
    );
  }
  const refused = factory.checkAnswer(raw, model);
  if (refused) throw refused;

  const output = judge(raw.text, model);
  return [
    `model ${model}`,
    `${durationMs} ms`,
    `tokens ${tokenLine(raw)}`,
    `finish ${finishReason(raw)}`,
    `summary ${output.summary.length} chars, wordCount ${output.wordCount}`,
  ].join(', ');
}

/** Zod is the judge (spec 4 LlmService.call() step 4). Never quotes the answer. */
function judge(text: string, model: string): z.infer<typeof summarySchema> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse's message quotes the text: not shown.
    throw new LlmError(
      `the answer of \`${model}\` is not JSON (${text.length} chars)`,
      'permanent',
      'invalid-answer',
    );
  }
  const result = summarySchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    throw new LlmError(
      `the answer of \`${model}\` does not match the schema (${issues})`,
      'permanent',
      'invalid-answer',
    );
  }
  return result.data;
}

/** The four token values of ExecutionLog: input, output, cached input, reasoning ("–" = not reported). */
function tokenLine(answer: AIMessage): string {
  const usage = answer.usage_metadata;
  const show = (value: number | undefined) =>
    value === undefined ? '–' : String(value);
  return [
    `in ${show(usage?.input_tokens)}`,
    `out ${show(usage?.output_tokens)}`,
    `cached ${show(usage?.input_token_details?.cache_read)}`,
    `reasoning ${show(usage?.output_token_details?.reasoning)}`,
  ].join(' / ');
}

function finishReason(answer: AIMessage): string {
  const reason = (
    answer.response_metadata as { finish_reason?: unknown } | undefined
  )?.finish_reason;
  return typeof reason === 'string' ? reason : '–';
}

/**
 * An LlmError's message is safe to show by contract; a StepConfigError's is safe to post; a ProviderError's
 * holds the method, path, status and GitHub's message only (spec 3).
 */
function describeFailure(error: unknown): string {
  if (error instanceof LlmError) {
    return `${error.code} (${error.kind}): ${error.message}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
