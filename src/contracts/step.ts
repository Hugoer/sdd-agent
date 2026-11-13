// Overview §4 (normative), added 2026-11-12 (spec 4). Types only.

export type StepName = 'grill' | 'spec' | 'plan' | 'code' | 'qualityGate';

export type ModelLevel = 'standard' | 'max';

/** What a target-repo skill contributes to a step: instructions, nothing else. Text files only, read at one
 *  base-branch commit; nothing is executed (replaces StepSkill, 2026-11-12, spec 4). */
export interface LoadedSkill {
  step: StepName;
  path: string; // directory mapped in .github-agent/workflow.json
  commit: string; // commit SHA everything was read at
  files: { path: string; text: string }[]; // SKILL.md first, then by path; paths relative to `path`
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
}
