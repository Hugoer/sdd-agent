// Overview §4 (normative), added 2026-11-12 (spec 4). Types only.

export type StepName = 'grill' | 'spec' | 'plan' | 'code' | 'qualityGate';

export type ModelLevel = 'standard' | 'max';

/** A file from the repo's listing, by its repo path (spec 11). */
export interface ListedFile {
  path: string;
  bytes: number;
}

/** A step skill at one base-branch commit: instructions, nothing else; nothing is executed (replaces StepSkill,
 *  2026-11-12, spec 4). 2026-11-20 (spec 11): SKILL.md goes into the prompt; the other text files are listed and
 *  loaded on demand (was: every text file in the prompt). */
export interface LoadedSkill {
  step: StepName;
  path: string; // directory mapped in .github-agent/workflow.json
  commit: string; // commit SHA everything was read at
  instructions: string; // SKILL.md
  files: ListedFile[]; // the other text files, repo paths, sorted; never SKILL.md
}

/** A skill of the target repo, found under a `repoSkills` folder (spec 11). */
export interface RepoSkill {
  name: string; // its folder's name, as its header says (SD12)
  description: string; // from its SKILL.md header
  path: string; // the skill's folder, e.g. `.claude/skills/money-rules`
  files: ListedFile[]; // its other text files, repo paths, sorted; never SKILL.md
}

/** What the target repo offers a step besides its step skill, at the same commit (spec 11). */
export interface RepoContext {
  rootAgents: { text: string; bytes: number } | null;
  skills: RepoSkill[]; // sorted by name; never the step's own skill
  agents: ListedFile[]; // every AGENTS.md but the root one, sorted by path
}

/** The model a step run uses (D23) and what the run was read with (added 2026-11-12, spec 4). */
export interface ResolvedModel {
  provider: string;
  name: string;
  level: ModelLevel;
}

export interface StepSetup {
  commit: string;
  skill: LoadedSkill;
  model: ResolvedModel;
  repo: RepoContext; // spec 11: at the same commit
}
