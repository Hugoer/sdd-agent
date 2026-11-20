// Spec 11 "What the bot finds at the commit" (SD1, SD2, SD11, SDW2, SDW5, SDW11): one tree listing and the
// `repoSkills` folders → the root AGENTS.md, the folder AGENTS.md list and the repo's skills. Pure: the listing
// comes in, the catalog and its problems go out; nothing is read here.
import { StepConfigError } from '../contracts/llm-error.js';
import type { RepoFile } from '../contracts/repo-provider.js';
import type {
  ListedFile,
  LoadedSkill,
  RepoContext,
  StepName,
} from '../contracts/step.js';
import {
  NOT_TEXT,
  checkSkillHeader,
  duplicateSkill,
  readSkillHeader,
  shown,
  type SkillProblem,
} from './skill-header.js';
import { isBinary } from './skill-loader.js';
import type { WorkflowConfig } from './workflow-config.js';

/** Only files named exactly this are read as a repo's instructions (D27). */
export const AGENTS_FILE = 'AGENTS.md';
/** SDW2: the root AGENTS.md goes into every prompt, so it has a step skill's cap. */
export const ROOT_AGENTS_BYTES_LIMIT = 204_800;
const SKILL_FILE = 'SKILL.md';

/** A repo skill as the listing shows it: its header is read and checked with the commit's reads. */
export interface CatalogSkill {
  name: string;
  /** The `repoSkills` folder it is under. */
  folder: string;
  /** Its own folder: `<folder>/<name>`. */
  path: string;
  skillFile: RepoFile;
  /** Its other files, minus known binary types, sorted by path. */
  files: ListedFile[];
}

export interface RepoCatalog {
  /** The root AGENTS.md; null when there is none or it is empty. */
  rootAgents: RepoFile | null;
  /** Every other file named exactly AGENTS.md, sorted by path. */
  agents: ListedFile[];
  /** The `repoSkills` folders in order, each by name; of a name found twice, the first. */
  skills: CatalogSkill[];
  /** `repoSkills` folders with no file in the tree (SDW11), in order. */
  missingFolders: string[];
  /** The same name in two `repoSkills` folders (SD12): the name, the folder that has it, the later folder. */
  duplicates: { name: string; first: string; second: string }[];
}

/**
 * Everything the bot reads at one base-branch commit (SDW15, plan P10), kept in memory for the latest commit by
 * `RepoCatalogService`. Content problems are recorded here, never thrown: `prepare()` and `checkRun()` turn them
 * into StepConfigErrors in plan P1's order.
 */
export interface CommitReads {
  commit: string;
  /** The map, or why it is invalid (then nothing else was read). */
  workflow: { config: WorkflowConfig } | { error: StepConfigError };
  /** Every regular file of the tree. */
  listing: RepoFile[];
  catalog: RepoCatalog;
  /** Its text (null: absent, empty or only whitespace; not read when over the cap) or `unreadable` (LW3). */
  rootAgents: { text: string; bytes: number } | null | 'unreadable';
  /** Every mapped step skill's and every repo skill's SKILL.md, by repo path: its text, or null when not text. */
  skillMd: ReadonlyMap<string, string | null>;
}

/** The catalog of one listing (every regular file of the tree) for the map's `repoSkills` folders. */
export function buildCatalog(
  listing: RepoFile[],
  repoSkills: string[],
): RepoCatalog {
  const files = [...listing].sort(byPath);
  const root = files.find((file) => file.path === AGENTS_FILE);
  const agents = files
    .filter((file) => file.path.endsWith(`/${AGENTS_FILE}`))
    .map(listed);

  const skills: CatalogSkill[] = [];
  const missingFolders: string[] = [];
  const duplicates: RepoCatalog['duplicates'] = [];
  for (const folder of repoSkills) {
    const prefix = `${folder}/`;
    const under = files.filter((file) => file.path.startsWith(prefix));
    if (under.length === 0) {
      missingFolders.push(folder);
      continue;
    }
    for (const skillFile of under) {
      const rest = skillFile.path.slice(prefix.length).split('/');
      if (rest.length !== 2 || rest[1] !== SKILL_FILE || skillFile.size === 0)
        continue;
      const name = rest[0];
      const first = skills.find((skill) => skill.name === name);
      if (first) {
        duplicates.push({ name, first: first.folder, second: folder });
        continue;
      }
      const path = `${folder}/${name}`;
      skills.push({
        name,
        folder,
        path,
        skillFile,
        files: under
          .filter(
            (file) =>
              file.path.startsWith(`${path}/`) &&
              file !== skillFile &&
              !isBinary(file.path),
          )
          .map(listed),
      });
    }
  }
  return {
    rootAgents: root && root.size > 0 ? root : null,
    agents,
    skills,
    missingFolders,
    duplicates,
  };
}

/**
 * The repo skills a step lists: every catalog skill but the folder mapped to that step (its files are already
 * the step skill's), sorted by name. `stepDir` is the step's mapped directory (a trailing `/` ignored).
 */
export function skillsForStep(
  catalog: RepoCatalog,
  stepDir: string | undefined,
): CatalogSkill[] {
  const own = stepDir?.replace(/\/+$/, '');
  return catalog.skills
    .filter((skill) => skill.path !== own)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `StepSetup.repo` for a step: the root AGENTS.md, its repo skills with their header's description, the list. */
export function repoContext(
  reads: CommitReads,
  stepDir: string | undefined,
): RepoContext {
  const root = reads.rootAgents;
  return {
    rootAgents: root === 'unreadable' ? null : root,
    skills: skillsForStep(reads.catalog, stepDir).map((skill) => ({
      name: skill.name,
      description: descriptionOf(reads.skillMd.get(skill.skillFile.path)),
      path: skill.path,
      files: skill.files,
    })),
    agents: reads.catalog.agents,
  };
}

/** One log line per step run, never content: `context grill @4f2c1ab: root AGENTS.md 1,840 bytes; …`. */
export function contextLine(
  step: StepName,
  commit: string,
  repo: RepoContext,
  skill: LoadedSkill,
): string {
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  return (
    `context ${step} @${commit.slice(0, 7)}: ` +
    (repo.rootAgents
      ? `root AGENTS.md ${repo.rootAgents.bytes.toLocaleString('en-US')} bytes`
      : 'no root AGENTS.md') +
    `; ${plural(repo.skills.length, 'repo skill')}; ${repo.agents.length} AGENTS.md listed; ` +
    `step skill + ${plural(skill.files.length, 'file')}`
  );
}

/**
 * SD12 for the repo skills: each one's SKILL.md (`not text`, or its header against its folder's name) and each
 * duplicate name, in `repoSkills` folder order. `skip`: SKILL.md paths already checked as step skills.
 */
export function repoSkillProblems(
  reads: CommitReads,
  repoSkills: string[],
  skip: ReadonlySet<string>,
): SkillProblem[] {
  const problems: SkillProblem[] = [];
  for (const folder of repoSkills) {
    for (const skill of reads.catalog.skills) {
      const path = skill.skillFile.path;
      if (skill.folder !== folder || skip.has(path)) continue;
      const text = reads.skillMd.get(path) ?? null;
      const problem =
        text === null
          ? { path, reason: NOT_TEXT }
          : checkSkillHeader(path, skill.name, text);
      if (problem) problems.push(problem);
    }
    for (const { name, first, second } of reads.catalog.duplicates) {
      if (second === folder) problems.push(duplicateSkill(name, first, second));
    }
  }
  return problems;
}

/** SDW2 and LW3 on the root AGENTS.md: too large (from the listing) or not text; or null. */
export function rootAgentsProblem(reads: CommitReads): StepConfigError | null {
  return (
    rootAgentsTooLarge(reads.catalog) ??
    (reads.rootAgents === 'unreadable' ? unreadableAgents() : null)
  );
}

/** SDW11: `repoSkills` names a folder the tree doesn't have, or null. */
export function missingFoldersError(
  catalog: RepoCatalog,
): StepConfigError | null {
  return catalog.missingFolders.length === 0
    ? null
    : new StepConfigError(
        `invalid workflow.json: repoSkills folder not found: ${catalog.missingFolders.map(shown).join(', ')}`,
      );
}

/** SDW2: the root AGENTS.md over the cap, from the listing; or null. */
export function rootAgentsTooLarge(
  catalog: RepoCatalog,
): StepConfigError | null {
  const bytes = catalog.rootAgents?.size ?? 0;
  return bytes > ROOT_AGENTS_BYTES_LIMIT
    ? new StepConfigError(
        `AGENTS.md too large (${bytes.toLocaleString('en-US')} bytes, limit ${ROOT_AGENTS_BYTES_LIMIT.toLocaleString('en-US')})`,
      )
    : null;
}

/** LW3 on the root AGENTS.md (not valid UTF-8, or a listed file that reads as missing). */
export function unreadableAgents(): StepConfigError {
  return new StepConfigError('unreadable AGENTS.md');
}

function descriptionOf(text: string | null | undefined): string {
  const field = text ? readSkillHeader(text)?.description : undefined;
  return field?.kind === 'value' ? field.value.trim() : '';
}

function listed(file: RepoFile): ListedFile {
  return { path: file.path, bytes: file.size };
}

function byPath(a: RepoFile, b: RepoFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
