// Spec 11 "The two tools" (SDW4, SDW6, SD7, SDW14; plan P15): the two tool declarations, the request rules in the
// flowchart's order and the answers the model gets. Pure: nothing is read here (ContextLoaderService reads).
import type { ToolCall } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { LoadedSkill, RepoSkill, StepSetup } from '../contracts/step.js';
import type { LoadOutcome } from './context-load.service.js';
import { AGENTS_FILE } from './repo-catalog.js';

export const LOAD_SKILL = 'load_skill';
export const LOAD_FILE = 'load_file';
/** Stored as the row's reason when the model gave none. */
export const NONE_GIVEN = '(none given)';
/** The Agent Skills maximum for a name; a path may be this long. */
const MAX_NAME = 64;
const MAX_PATH = 1024;
const MAX_REASON = 300;

/** SD6: the two limits of one call (`SKILL_DISCOVERY_MAX_LOADS`, `SKILL_DISCOVERY_MAX_BYTES`). */
export interface LoadLimits {
  maxLoads: number;
  maxBytes: number;
}

/** Plan P15: what one call may still load, and what it was given. Changed in place by the rules below. */
export interface LoadBudget {
  loadsLeft: number;
  bytesLeft: number;
  /** Repo paths given in this call: the start files, then every `loaded` one. */
  given: Set<string>;
  /** Repo skill names whose SKILL.md was loaded in this call. */
  loadedSkills: Set<string>;
  /** The limit a request was refused for; from then on, every request is `limit-reached`. */
  limitHit: 'files' | 'bytes' | null;
}

/** One request as the model wrote it. `tool` is any name: one the bot didn't offer is `not-found`. */
export interface LoadRequest {
  tool: string;
  name?: string;
  path?: string;
  reason?: string;
}

/** The file a request named: what its row records and the size the budget checks (from the listing). */
export interface RequestedFile {
  kind: 'step-skill' | 'repo-skill' | 'agents';
  /** The step name (`step-skill`) or the repo skill's name. */
  skill?: string;
  path: string;
  bytes: number;
  /** `load_skill`: the skill whose SKILL.md this is; its answer lists the skill's other files. */
  repoSkill?: RepoSkill;
}

/** A request the rules answer without reading, or the file to read now. */
export type CheckedRequest =
  | {
      outcome: Exclude<LoadOutcome, 'loaded' | 'unreadable' | 'error'>;
      answer: string;
      file?: RequestedFile;
    }
  | { outcome: 'read'; file: RequestedFile };

// The tools are only declared to the model: LlmService (and later the agent loops) run each request through
// ContextLoaderService.load(), never through LangChain.
const runByLoader = (): never => {
  throw new Error('the context tools are run by ContextLoaderService.load()');
};

const reason = z
  .string()
  .min(1)
  .max(MAX_REASON)
  .describe('One line: why this issue needs it.');

/** SDW4: the two bot-owned definitions; no prompt wording can change them. */
export const CONTEXT_TOOLS: StructuredToolInterface[] = [
  tool(runByLoader, {
    name: LOAD_SKILL,
    description:
      "Load one of this repository's skills by its name, as listed in the instructions. Gives the skill's " +
      'SKILL.md and the list of its other files.',
    schema: z.object({
      name: z
        .string()
        .min(1)
        .max(MAX_NAME)
        .describe("The skill's name, exactly as listed."),
      reason,
    }),
  }),
  tool(runByLoader, {
    name: LOAD_FILE,
    description:
      'Load one file by its repository path, exactly as listed: a file of the method, a file of a skill loaded ' +
      "with load_skill, or a folder's AGENTS.md.",
    schema: z.object({
      path: z
        .string()
        .min(1)
        .max(MAX_PATH)
        .describe("The file's repository path, exactly as listed."),
      reason,
    }),
  }),
];

/** SDW7: something can be loaded (a repo skill, a folder AGENTS.md or another step-skill file). */
export function canLoad({ skill, repo }: StepSetup): boolean {
  return (
    repo.skills.length > 0 || repo.agents.length > 0 || skill.files.length > 0
  );
}

/** The step skill's SKILL.md, by repo path. */
export function stepSkillFile(skill: LoadedSkill): string {
  return `${skill.path.replace(/\/+$/, '')}/SKILL.md`;
}

/** A new call's budget: the start files are already given. */
export function newBudget(setup: StepSetup, limits: LoadLimits): LoadBudget {
  const given = new Set([stepSkillFile(setup.skill)]);
  if (setup.repo.rootAgents) given.add(AGENTS_FILE);
  return {
    loadsLeft: limits.maxLoads,
    bytesLeft: limits.maxBytes,
    given,
    loadedSkills: new Set(),
    limitHit: null,
  };
}

/** A tool call from the model's message as a request; arguments that aren't text are left out. */
export function requestOf(call: ToolCall): LoadRequest {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' ? value : undefined;
  return {
    tool: call.name,
    name: text(args.name),
    path: text(args.path),
    reason: text(args.reason),
  };
}

/** The row's reason: the model's, or `(none given)` when it is missing or blank (never blocks the load). */
export function reasonOf(request: LoadRequest): string {
  return request.reason?.trim() ? request.reason : NONE_GIVEN;
}

/**
 * The request flowchart up to the read: loads left → count it → in a list → already given → bigger than the byte
 * limit alone → fits what's left. Changes `budget` (the count, the limit hit); only `markLoaded` adds bytes.
 * `skillMdBytes`: each repo skill's SKILL.md size from the listing, by repo path.
 */
export function checkRequest(
  request: LoadRequest,
  setup: StepSetup,
  budget: LoadBudget,
  limits: LoadLimits,
  skillMdBytes: ReadonlyMap<string, number>,
): CheckedRequest {
  if (budget.limitHit !== null || budget.loadsLeft <= 0) {
    budget.limitHit ??= 'files';
    return { outcome: 'limit-reached', answer: limitAnswer(limits) };
  }
  budget.loadsLeft -= 1;

  const found = findFile(request, setup, budget, skillMdBytes);
  if ('answer' in found) return { outcome: 'not-found', ...found };
  const { file } = found;
  if (budget.given.has(file.path)) {
    const what = file.repoSkill
      ? `Skill \`${file.repoSkill.name}\``
      : `\`${file.path}\``;
    return {
      outcome: 'already-loaded',
      answer: `${what} is already in this conversation.`,
      file,
    };
  }
  if (file.bytes > limits.maxBytes) {
    return {
      outcome: 'too-large',
      answer:
        `\`${file.path}\` has ${count(file.bytes)} bytes, more than the ${count(limits.maxBytes)} a whole answer ` +
        'may load; carry on without it.',
      file,
    };
  }
  if (file.bytes > budget.bytesLeft) {
    budget.limitHit = 'bytes';
    return { outcome: 'limit-reached', answer: limitAnswer(limits), file };
  }
  return { outcome: 'read', file };
}

/** A `loaded` file: its bytes are used, it is given, and a repo skill's other files can now be loaded. */
export function markLoaded(budget: LoadBudget, file: RequestedFile): void {
  budget.bytesLeft -= file.bytes;
  budget.given.add(file.path);
  if (file.repoSkill) budget.loadedSkills.add(file.repoSkill.name);
}

/** The tool answer of a loaded file: a repo skill's SKILL.md with the list of its other files, or the file. */
export function loadedAnswer(file: RequestedFile, text: string): string {
  const block = `<file path="${file.path}">\n${text}\n</file>`;
  const skill = file.repoSkill;
  if (!skill) return block;
  const others =
    skill.files.length === 0
      ? ''
      : '\nOther files of this skill, to load with load_file when the skill points to one:\n' +
        skill.files
          .map((other) => `- ${other.path} (${count(other.bytes)} bytes)`)
          .join('\n');
  return `<skill name="${skill.name}" path="${skill.path}">\n${block}${others}\n</skill>`;
}

/** SDW14: a file that can't be read as text. */
export function unreadableAnswer(file: RequestedFile): string {
  return `\`${file.path}\` can't be read as text; carry on without it.`;
}

/** "In a list, or the step SKILL.md or root AGENTS.md?": the file, or the `not-found` answer. */
function findFile(
  request: LoadRequest,
  { skill, repo }: StepSetup,
  budget: LoadBudget,
  skillMdBytes: ReadonlyMap<string, number>,
): { file: RequestedFile } | { answer: string; file?: RequestedFile } {
  if (request.tool === LOAD_SKILL) {
    const name = request.name ?? '';
    const found = repo.skills.find((candidate) => candidate.name === name);
    if (!found)
      return {
        answer:
          `No skill named \`${cleanText(name, MAX_NAME)}\` in this repository. The skills are listed in the ` +
          'instructions; carry on without it.',
      };
    const path = `${found.path}/SKILL.md`;
    return {
      file: {
        kind: 'repo-skill',
        skill: found.name,
        path,
        bytes: skillMdBytes.get(path) ?? 0,
        repoSkill: found,
      },
    };
  }
  if (request.tool !== LOAD_FILE)
    return {
      answer: `No tool named \`${cleanText(request.tool, MAX_NAME)}\`: use load_skill or load_file.`,
    };

  // A leading `./` or `/` is dropped; the letter case must match.
  const path = (request.path ?? '').replace(/^\.?\//, '');
  const notAvailable =
    `Not available: \`${cleanText(path, MAX_PATH)}\`. Only files listed in the instructions or in a loaded skill ` +
    'can be loaded';
  const ownFile = stepSkillFile(skill);
  if (path === ownFile)
    return {
      file: {
        kind: 'step-skill',
        skill: skill.step,
        path,
        bytes: Buffer.byteLength(skill.instructions),
      },
    };
  if (path === AGENTS_FILE && repo.rootAgents)
    return { file: { kind: 'agents', path, bytes: repo.rootAgents.bytes } };
  const stepFile = skill.files.find((file) => file.path === path);
  if (stepFile)
    return {
      file: { kind: 'step-skill', skill: skill.step, ...stepFile },
    };
  const agents = repo.agents.find((file) => file.path === path);
  if (agents) return { file: { kind: 'agents', ...agents } };
  for (const repoSkill of repo.skills) {
    const skillMd = `${repoSkill.path}/SKILL.md`;
    const listed =
      path === skillMd
        ? { path, bytes: skillMdBytes.get(path) ?? 0 }
        : repoSkill.files.find((file) => file.path === path);
    if (!listed) continue;
    const file: RequestedFile = {
      kind: 'repo-skill',
      skill: repoSkill.name,
      ...listed,
      ...(path === skillMd ? { repoSkill } : {}),
    };
    return budget.loadedSkills.has(repoSkill.name)
      ? { file }
      : {
          answer: `${notAvailable}: load skill \`${repoSkill.name}\` first.`,
          file,
        };
  }
  return { answer: `${notAvailable}.` };
}

function limitAnswer({ maxLoads, maxBytes }: LoadLimits): string {
  return (
    `Limit reached: this answer may load at most ${maxLoads === 1 ? '1 file' : `${count(maxLoads)} files`} and ` +
    `${count(maxBytes)} bytes. Answer now with what you have.`
  );
}

/** Model text in an answer or a log line: no backticks, one line, cut. */
export function cleanText(text: string, max: number): string {
  return [...text.replace(/`/g, '').replace(/[\r\n\t]+/g, ' ')]
    .slice(0, max)
    .join('');
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}
