// Spec 4 "`workflow.json`", "Model of a step run" (L3) and "Run-start check" step 1. Pure functions: the
// file's text comes in, a validated map or a StepConfigError goes out.
import { z } from 'zod';
import type { Lane } from '../contracts/issue-provider.js';
import { StepConfigError } from '../contracts/llm-error.js';
import type { ModelLevel, StepName } from '../contracts/step.js';

/** Where the map lives in the target repo, read at the base branch. */
export const WORKFLOW_CONFIG_PATH = '.github-agent/workflow.json';

/**
 * Spec 12 (BD7): every file path the bot reads from the target repo to configure itself. The floor of protected
 * paths must cover each one (`protected-paths.spec.ts` checks it): a new config file goes under `.github-agent/` or
 * the floor is extended in the same change.
 */
export const BOT_CONFIG_PATHS = [WORKFLOW_CONFIG_PATH] as const;

const SKILL_PATH_RULE =
  'must be a directory path relative to the repo root (no leading "/", no ".." segment)';
const MODEL_NAME_RULE =
  'must be a model name: 1–100 letters, digits, ".", "_" or "-"';

const skillPath = z
  .string()
  .min(1, SKILL_PATH_RULE)
  .refine(
    (path) => !path.startsWith('/') && !path.split('/').includes('..'),
    SKILL_PATH_RULE,
  );
const modelName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, MODEL_NAME_RULE);

/** Spec 11 (SD1, SDW11): 0–10 folders, each a skill path; a trailing `/` is ignored, so `a/` and `a` are one. */
const repoSkillsSchema = z
  .array(skillPath.transform((path) => path.replace(/\/+$/, '')))
  .max(10, 'must name at most 10 folders')
  .refine(
    (folders) => new Set(folders).size === folders.length,
    'must not name a folder twice',
  );

/** Spec 12 (BDW8, plan DP16): one sentence naming every rule, like spec 4's skill paths (LW11). */
const PROTECTED_GLOB_RULE =
  'must be a path glob relative to the repo root: 1–256 characters, no leading "/", no ".." segment, no "\\", ' +
  'no control character';

/** Spec 12 (BD8, BDW8): 0–200 picomatch globs; a glob that matches nothing and a duplicate are allowed. */
const protectedPathsSchema = z
  .array(
    z.string().refine(
      (glob) =>
        glob.length >= 1 &&
        glob.length <= 256 &&
        !glob.startsWith('/') &&
        !glob.split('/').includes('..') &&
        !glob.includes('\\') &&
        ![...glob].some((char) => {
          const code = char.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        }),
      PROTECTED_GLOB_RULE,
    ),
  )
  .max(200, 'must list at most 200 globs');

/** Spec 12 (BDW8): what a missing required key says to do. */
const MISSING_HINTS: Readonly<Record<string, string>> = {
  protectedPaths: ' (list the paths the bot must never change, [] for none)',
};

/** Steps may be absent: that is "missing skill" at run time, not an invalid file. */
const skillsSchema = z.strictObject({
  grill: skillPath.optional(),
  spec: skillPath.optional(),
  plan: skillPath.optional(),
  code: skillPath.optional(),
  qualityGate: skillPath.optional(),
});

const levelSchema = z.strictObject({
  default: modelName,
  grill: modelName.optional(),
  spec: modelName.optional(),
  plan: modelName.optional(),
  code: modelName.optional(),
  qualityGate: modelName.optional(),
});

/** Unknown top-level keys are ignored (z.object strips them). */
const workflowSchema = z.object({
  skills: skillsSchema,
  /** Spec 11: where the repo's own skills live; missing = none. */
  repoSkills: repoSkillsSchema.default([]),
  /** Spec 12 (BD8): required; `[]` is a deliberate "nothing beyond the bot's own files". */
  protectedPaths: protectedPathsSchema,
  models: z.object({ standard: levelSchema, max: levelSchema }),
});

export type WorkflowConfig = z.infer<typeof workflowSchema>;

/** The map's text (null = no file at the commit) → the validated map, or `invalid workflow.json: …` (LW11). */
export function parseWorkflowConfig(text: string | null): WorkflowConfig {
  if (text === null) throw invalid(`no file ${WORKFLOW_CONFIG_PATH}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('not a JSON object');
  }
  const result = workflowSchema.safeParse(value, { reportInput: true });
  if (!result.success) {
    throw invalid(result.error.issues.map(describeIssue).join('; '));
  }
  return result.data;
}

/** Spec "Model of a step run": `max` when the step's model label is on the task; the step's entry, else `default`. */
export function resolveModel(
  models: WorkflowConfig['models'],
  step: StepName,
  maxModelSteps: readonly StepName[],
): { name: string; level: ModelLevel } {
  const level: ModelLevel = maxModelSteps.includes(step) ? 'max' : 'standard';
  return { name: models[level][step] ?? models[level].default, level };
}

/** Spec "Run-start check" step 1: the steps a run of this lane uses, in order. */
export function stepsFor(lane: Lane, grillSkip: boolean): StepName[] {
  const steps: StepName[] =
    lane === 'full-sdd'
      ? ['grill', 'spec', 'plan', 'code', 'qualityGate']
      : lane === 'spec-code'
        ? ['grill', 'spec', 'code', 'qualityGate']
        : ['code', 'qualityGate'];
  return grillSkip ? steps.filter((step) => step !== 'grill') : steps;
}

function invalid(what: string): StepConfigError {
  return new StepConfigError(`invalid workflow.json: ${what}`);
}

/** `<where>: <what>`, from the schema's own rules; never quotes a value from the file. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : '(top level)';
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? `${where}: missing${MISSING_HINTS[where] ?? ''}`
        : `${where}: must be ${/^[aeiou]/.test(issue.expected) ? 'an' : 'a'} ${issue.expected}`;
    case 'unrecognized_keys':
      return `${where}: unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${issue.keys.map((key) => `"${key}"`).join(', ')}`;
    default:
      return `${where}: ${issue.message}`;
  }
}
