// The checks of `npm run llm:smoke` (spec 4 "Smoke script", L12). They use the ports, StepConfigService,
// InjectionWarningService and LlmService only, so they are unit-tested against the fakes before they reach
// GitHub and Google. The model is called only through LlmService.call() (plan P1, T24).
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type {
  IssueProvider,
  Lane,
  UnifiedTask,
} from '../../contracts/issue-provider.js';
import { LlmError, StepConfigError } from '../../contracts/llm-error.js';
import type { RepoProvider } from '../../contracts/repo-provider.js';
import type { RepoContext, StepName, StepSetup } from '../../contracts/step.js';
import { cutText } from '../input-guard.js';
import type { InjectionWarningService } from '../injection-warning.service.js';
import type { Block, LlmResult } from '../llm-call.js';
import type { LlmService } from '../llm.service.js';
import { withNotes } from '../prompt.js';
import { isBinary } from '../skill-loader.js';
import type {
  StepConfigService,
  WorkflowAtCommit,
} from '../step-config.service.js';

export const LLM_SMOKE_USAGE =
  'Usage: npm run llm:smoke -- --issue <n> --step <grill|spec|plan|code|qualityGate> [--base <branch>] ' +
  '[--model <name>] [--reask]';

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
/** A model name as workflow.json allows it. */
const MODEL_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Check 6's schema (spec "Smoke script"). */
export const summarySchema = z.object({
  summary: z.string().min(1).max(300),
  wordCount: z.number().int().min(0),
});
type Summary = z.infer<typeof summarySchema>;

const FRAME =
  'You help test a bot that works on GitHub issues. Summarize the issue below in one sentence and count the ' +
  'words of your sentence. Answer with JSON only: {"summary": "<one sentence>", "wordCount": <number>}.';

export interface LlmSmokeOptions {
  issue: number;
  step: StepName;
  /** `--base`, or TARGET_BASE_BRANCH: the branch the map and the skills are read at. */
  base: string;
  /** `--model`: check 6 calls this name instead and passes only when the call fails as `unknown-model`. */
  model?: string;
  /** `--reask`: check 6's schema gets a rule the model can't know, so the first answer is re-asked. */
  reask?: boolean;
  /** The rows' `run_id`: `smoke-<id>`. */
  runId: string;
}

/** What checks 6 and 8 read back from ExecutionLog. */
export interface SmokeRow {
  id: string;
  attempt: number;
  status: string;
  errorCode: string | null;
  model: string;
  modelLevel: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  frameChars: number;
  skillChars: number;
  untrustedChars: number;
  otherChars: number;
}

export interface LlmSmokeDeps {
  stepConfig: StepConfigService;
  warnings: InjectionWarningService;
  llm: LlmService;
  /** The port as every caller gets it: wrapped by the secret scanner. */
  issues: IssueProvider;
  repo: RepoProvider;
  /** The rows of one run, oldest first. */
  rowsOf: (runId: string) => Promise<SmokeRow[]>;
  targetRepo: string;
}

type Print = (line: string) => void;
/** A check returns what it saw, or `{ skipped }` with the reason, or throws. */
type Check = [name: string, run: () => Promise<string | { skipped: string }>];

/** `--issue <n> --step <step> [--base <branch>] [--model <name>] [--reask]`; null for anything else. */
export function parseSmokeArgs(
  args: string[],
): (Omit<LlmSmokeOptions, 'base' | 'runId'> & { base?: string }) | null {
  try {
    const { values } = parseArgs({
      args,
      options: {
        issue: { type: 'string' },
        step: { type: 'string' },
        base: { type: 'string' },
        model: { type: 'string' },
        reask: { type: 'boolean' },
      },
    });
    const { issue, step, base, model, reask } = values;
    if (!issue || !/^[1-9]\d{0,8}$/.test(issue)) return null;
    if (!STEPS.includes(step as StepName)) return null;
    if (base !== undefined && !BRANCH_NAME.test(base)) return null;
    if (model !== undefined && !MODEL_NAME.test(model)) return null;
    return {
      issue: Number(issue),
      step: step as StepName,
      base,
      model,
      reask: reask ?? false,
    };
  } catch {
    return null; // unknown option or missing value
  }
}

/** Prints one PASS / FAIL / SKIP line per check and stops at the first FAIL; true only if no check failed. */
export async function runLlmSmoke(
  deps: LlmSmokeDeps,
  options: LlmSmokeOptions,
  print: Print,
): Promise<boolean> {
  const { stepConfig } = deps;
  let task: UnifiedTask | undefined;
  let setup: StepSetup | undefined;
  let result: LlmResult<Summary> | undefined;

  const checks: Check[] = [
    [
      '1 workflow',
      async () => {
        const workflow = await stepConfig.readWorkflow(options.base);
        return describeWorkflow(workflow, options.base);
      },
    ],
    ['2 lanes', () => laneCheck(stepConfig, options.base)],
    [
      '3 skill',
      async () => {
        task = await deps.issues.getTaskDetails({
          platform: 'GITHUB',
          id: 'smoke',
          externalRef: `${deps.targetRepo}#${options.issue}`,
        });
        setup = await stepConfig.prepare(options.step, task, options.base);
        return describeSkill(deps.repo, setup);
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
    ['5 guard', () => guardCheck(deps.warnings, task!)],
    [
      '6 call',
      async () => {
        const called = await callCheck(deps, options, task!, setup!);
        result = called.result;
        return called.line;
      },
    ],
    [
      '7 comment',
      () =>
        result
          ? commentCheck(deps.issues, task!, result)
          : Promise.resolve({ skipped: 'no summary to post (--model)' }),
    ],
    ['8 row', () => rowCheck(deps, options)],
  ];
  for (const [name, run] of checks) {
    try {
      const seen = await run();
      print(
        typeof seen === 'string'
          ? `PASS ${name}: ${seen}`
          : `SKIP ${name}: ${seen.skipped}`,
      );
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
  const repoSkills =
    config.repoSkills.length > 0 ? config.repoSkills.join(', ') : '(none)';
  return `${base} @ ${commit}; skills ${skills}; repoSkills: ${repoSkills}; models ${models}`;
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

/**
 * Check 3: SKILL.md's size and characters, the number of other files, the binary files left out; then (spec 11)
 * the catalog: the root AGENTS.md's size, each repo skill with its description's length and its number of other
 * files, each listed AGENTS.md. Paths, names and sizes only, never content.
 */
async function describeSkill(
  repo: RepoProvider,
  { skill, commit, repo: context }: StepSetup,
): Promise<string> {
  const listed = (await repo.listFiles(commit, skill.path)) ?? [];
  const others = skill.files.length;
  const prefix = `${skill.path.replace(/\/+$/, '')}/`;
  const skipped = listed
    .filter((file) => isBinary(file.path))
    .map((file) => file.path.slice(prefix.length));
  return (
    `${skill.path} @ ${commit.slice(0, 7)}: SKILL.md (${Buffer.byteLength(skill.instructions)} B), ` +
    `${others} other ${others === 1 ? 'file' : 'files'}; ${skill.instructions.length} chars; skipped ` +
    (skipped.length > 0 ? skipped.join(', ') : 'none') +
    `; ${describeCatalog(context)}`
  );
}

function describeCatalog({ rootAgents, skills, agents }: RepoContext): string {
  const count = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const root = rootAgents
    ? `root AGENTS.md (${rootAgents.bytes} B)`
    : 'no root AGENTS.md';
  const repoSkills =
    count(skills.length, 'repo skill') +
    (skills.length === 0
      ? ''
      : `: ${skills
          .map(
            (s) =>
              `${s.name} (description ${s.description.length} chars, ${count(s.files.length, 'other file')})`,
          )
          .join(', ')}`);
  const listed =
    `${agents.length} AGENTS.md listed` +
    (agents.length === 0
      ? ''
      : `: ${agents.map((a) => `${a.path} (${a.bytes} B)`).join(', ')}`);
  return `${root}, ${repoSkills}, ${listed}`;
}

/** The issue's two untrusted texts, as check 5 checks them and check 6 sends them. */
function issueBlocks(
  task: UnifiedTask,
): Extract<Block, { kind: 'untrusted' }>[] {
  return [
    {
      kind: 'untrusted',
      source: { key: 'title', label: 'the issue title' },
      text: task.title,
    },
    {
      kind: 'untrusted',
      source: { key: 'description', label: 'the issue description' },
      text: task.description,
    },
  ];
}

/** Check 5: per text, cut or not, the pattern kinds and the warning. Never the text. */
async function guardCheck(
  warnings: InjectionWarningService,
  task: UnifiedTask,
): Promise<string> {
  const parts: string[] = [];
  for (const { source, text } of issueBlocks(task)) {
    const { kinds, warning } = await warnings.check(task, source, text);
    const cut = cutText(text).cutFrom;
    parts.push(
      `${source.key}: ${cut === undefined ? 'whole' : `cut (${cut} chars)`}, ` +
        `kinds ${kinds.length > 0 ? kinds.join(', ') : 'none'}, warning ${warning}`,
    );
  }
  return parts.join('; ');
}

/** Check 6: one real call through LlmService (or, with `--model`, the expected `unknown-model`). */
async function callCheck(
  deps: LlmSmokeDeps,
  options: LlmSmokeOptions,
  task: UnifiedTask,
  setup: StepSetup,
): Promise<{ line: string; result?: LlmResult<Summary> }> {
  const prefix = `RUN-${options.runId.replace(/^smoke-/, '')}:`;
  const schema = options.reask
    ? summarySchema.extend({
        // A refinement is not part of the JSON schema the model gets, so only the re-ask can tell it.
        summary: summarySchema.shape.summary.refine(
          (summary) => summary.startsWith(prefix),
          `must start with "${prefix}"`,
        ),
      })
    : summarySchema;
  const model = options.model
    ? { ...setup.model, name: options.model }
    : setup.model;
  const call = deps.llm.call<Summary>({
    context: { task, step: options.step, runId: options.runId },
    setup: { ...setup, model },
    frame: FRAME,
    turns: [
      {
        role: 'user',
        blocks: [{ kind: 'text', text: 'The issue:' }, ...issueBlocks(task)],
      },
    ],
    output: schema,
  });

  if (options.model) {
    try {
      await call;
    } catch (error) {
      if (error instanceof LlmError && error.code === 'unknown-model') {
        return { line: `unknown-model as expected: ${error.message}` };
      }
      throw error;
    }
    throw new Error(
      `model \`${options.model}\` answered; expected unknown-model`,
    );
  }

  const result = await call;
  const rows = await deps.rowsOf(options.runId);
  const row = rows.find((candidate) => candidate.id === result.logId);
  if (!row) throw new Error(`row ${result.logId} not found`);
  if (options.reask) {
    const attempts = rows
      .map((r) => `${r.attempt} ${r.errorCode ?? r.status}`)
      .join(', ');
    if (attempts !== '1 invalid-answer, 2 SUCCESS') {
      throw new Error(`expected one re-ask (rows: ${attempts})`);
    }
  }
  return {
    line: [
      `model ${row.model} (${row.modelLevel})`,
      `${row.durationMs} ms`,
      `tokens in ${show(row.inputTokens)} / out ${show(row.outputTokens)} / cached ${show(row.cachedInputTokens)} / ` +
        `reasoning ${show(row.reasoningTokens)}`,
      `chars frame ${row.frameChars} / skill ${row.skillChars} / untrusted ${row.untrustedChars} / other ${row.otherChars}`,
      `summary ${result.output.summary.length} chars, wordCount ${result.output.wordCount}`,
      `row ${row.id}${options.reask ? ' (after one re-ask)' : ''}`,
    ].join(', '),
    result,
  };
}

/** Check 7: one comment through the port: the summary, a token-shaped test string, the notes. */
async function commentCheck(
  issues: IssueProvider,
  task: UnifiedTask,
  result: LlmResult<Summary>,
): Promise<string> {
  // Built at run time, never written in the repo; the port's scanner must replace it.
  const testString = [
    'gh',
    's_',
    randomBytes(27).toString('base64url').replace(/[-_]/g, 'x'),
  ].join('');
  const body = withNotes(
    `**llm:smoke (spec 4):** ${result.output.summary}\n\n` +
      `A token-shaped test string the secret scanner must hide: ${testString}`,
    result.notes,
  );
  const comment = await issues.postComment(task, body);
  return comment.url;
}

/** Check 8: the run's rows read back from the database. */
async function rowCheck(
  deps: LlmSmokeDeps,
  options: LlmSmokeOptions,
): Promise<string> {
  const rows = await deps.rowsOf(options.runId);
  const newest = rows.at(-1);
  if (!newest) throw new Error(`no row with run_id ${options.runId}`);
  const expected = options.model ? 'unknown-model' : 'SUCCESS';
  if ((newest.errorCode ?? newest.status) !== expected) {
    throw new Error(
      `the newest row is ${newest.status} ${newest.errorCode ?? ''}, expected ${expected}`,
    );
  }
  return (
    `run_id ${options.runId}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}; newest ${newest.status}` +
    `${newest.errorCode ? ` ${newest.errorCode}` : ''}, attempt ${newest.attempt}, ${newest.model} (${newest.modelLevel})`
  );
}

function show(value: number | null): string {
  return value === null ? '–' : String(value);
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
