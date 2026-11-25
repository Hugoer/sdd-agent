// Spec 4 "Skill of a step run" (L6) steps 3–8, at one commit. A skill is text only and nothing is ever executed.
// 2026-11-20 (spec 11, SD4, SDW8): its SKILL.md goes into the prompt; the other files are listed by path and size,
// read only when the model loads one. SD12: its SKILL.md needs a valid Agent Skills header. P11: everything comes
// from the commit's reads (one tree listing, every SKILL.md), so nothing here reads GitHub.
import type { Logger } from '@nestjs/common';
import { StepConfigError } from '../contracts/llm-error.js';
import type { RepoFile } from '../contracts/repo-provider.js';
import type { LoadedSkill, StepName } from '../contracts/step.js';
import { findInjectionKinds } from './injection-patterns.js';
import type { CommitReads } from './repo-catalog.js';
import {
  NOT_TEXT,
  checkSkillHeader,
  invalidSkills,
  type SkillProblem,
} from './skill-header.js';
import type { WorkflowConfig } from './workflow-config.js';

/** Step 6 (spec 11, SDW8): the size of a step skill's SKILL.md, from the listing; the other files don't count. */
export const SKILL_BYTES_LIMIT = 204_800;
const SKILL_FILE = 'SKILL.md';
/** Step 5 (LW3): left out by extension, letter case ignored. */
const BINARY_EXTENSIONS = new Set(
  '.png .jpg .jpeg .gif .webp .ico .bmp .pdf .zip .gz .tgz .tar .7z .woff .woff2 .ttf .otf .mp3 .wav .mp4 .mov'.split(
    ' ',
  ),
);

/** What the listing says about a skill: its SKILL.md, the other text files and the binary files left out. */
export interface SkillListing {
  step: StepName;
  dir: string;
  skillFile: RepoFile;
  /** The other text files, sorted by path; never SKILL.md. */
  files: RepoFile[];
  skipped: RepoFile[];
}

/**
 * Steps 3–6 from the tree listing only (also the run-start check): null when the skill is missing (no entry, no
 * directory, no SKILL.md or an empty one); `skill too large` from SKILL.md's size, before any file is read.
 */
export function listSkill(
  listing: RepoFile[],
  skills: WorkflowConfig['skills'],
  step: StepName,
): SkillListing | null {
  const dir = skills[step];
  if (dir === undefined) return null;
  const root = dir.replace(/\/+$/, '');
  const listed = listing.filter((file) => file.path.startsWith(`${root}/`));
  const skillFile = listed.find(
    (file) => file.path === `${root}/${SKILL_FILE}`,
  );
  if (!skillFile || skillFile.size === 0) return null;

  if (skillFile.size > SKILL_BYTES_LIMIT) {
    throw new StepConfigError(
      `skill too large: ${step} (${skillFile.size.toLocaleString('en-US')} bytes, limit ${SKILL_BYTES_LIMIT.toLocaleString('en-US')})`,
    );
  }
  const skipped = listed.filter((file) => isBinary(file.path));
  const files = listed
    .filter((file) => file !== skillFile && !isBinary(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { step, dir, skillFile, files, skipped };
}

/**
 * Steps 3–8: the skill as the prompt gets it: SKILL.md as read at the commit (its header checked on that text) and
 * given redacted (spec 12 BDW5), the other files listed, never read.
 * One log line, never content; and (spec 6 GM13) one warning line when SKILL.md matches an injection pattern:
 * the skill still loads, since a skill on the base branch is trusted (overview §4 "Trust"), and nothing is
 * posted. The other files are checked when the model loads one (spec 11, SDW8).
 */
export function loadSkill(
  reads: CommitReads,
  skills: WorkflowConfig['skills'],
  step: StepName,
  logger: Pick<Logger, 'log' | 'warn'>,
): LoadedSkill {
  const { commit } = reads;
  const listing = listSkill(reads.listing, skills, step);
  if (!listing) throw missingSkills([step]);

  const read = readStepSkill(reads, listing);
  if (read.blank) throw missingSkills([step]);
  if (read.problem) throw invalidSkills([read.problem]);
  // Spec 12 plan DP10: checked as read, given redacted (both maps hold the same paths; never the text as read).
  const instructions = reads.redacted.skillMd.get(listing.skillFile.path) ?? '';

  const prefix = `${listing.dir.replace(/\/+$/, '')}/`;
  const others = listing.files.length;
  const skipped = listing.skipped.map((file) => file.path.slice(prefix.length));
  logger.log(
    `skill ${step} @${commit.slice(0, 7)}: SKILL.md ${instructions.length.toLocaleString('en-US')} chars, ` +
      `${others} other ${others === 1 ? 'file' : 'files'}, skipped ${skipped.length}` +
      (skipped.length > 0 ? ` (${skipped.join(', ')})` : ''),
  );
  const kinds = findInjectionKinds(instructions);
  if (kinds.length > 0)
    logger.warn(
      `skill ${step} @${commit.slice(0, 7)}: ${listing.skillFile.path} matches an injection pattern ` +
        `(${kinds.join(', ')}); loaded anyway, a skill on the base branch is trusted`,
    );
  return {
    step,
    path: listing.dir,
    commit,
    instructions,
    files: listing.files.map((file) => ({ path: file.path, bytes: file.size })),
  };
}

export function missingSkills(steps: StepName[]): StepConfigError {
  return new StepConfigError(`missing skills: ${steps.join(', ')}`);
}

/** A listed step skill's SKILL.md as read: blank (spec 4: missing), or its text and its SD12 problem, if any. */
export type StepSkillRead =
  | { blank: true }
  | { blank: false; text: string; problem: SkillProblem | null };

/**
 * A listed step skill's SKILL.md as read at the commit, checked (SD12): `not text` (LW3, plan P8), or its header
 * against the mapped folder's last non-empty segment (`.github-agent/skills/code/` → `code`).
 */
export function readStepSkill(
  reads: CommitReads,
  listing: SkillListing,
): StepSkillRead {
  const path = listing.skillFile.path;
  const text = reads.skillMd.get(path) ?? null;
  if (text === null)
    return { blank: false, text: '', problem: { path, reason: NOT_TEXT } };
  if (text.trim() === '') return { blank: true };
  return {
    blank: false,
    text,
    problem: checkSkillHeader(path, folderName(listing.dir), text),
  };
}

/** The last non-empty segment of a mapped directory: the name its skill must have. */
export function folderName(dir: string): string {
  return dir.split('/').filter(Boolean).at(-1) ?? '';
}

/** Spec 4 LW3: a known binary type, by extension in any letter case. */
export function isBinary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot));
}
