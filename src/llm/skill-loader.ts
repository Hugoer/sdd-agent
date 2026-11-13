// Spec 4 "Skill of a step run" (L6) steps 3–8, at one commit. A skill is text only: every file of its
// directory goes into the prompt, nothing is ever executed.
import type { Logger } from '@nestjs/common';
import { StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { RepoFile, RepoProvider } from '../contracts/repo-provider.js';
import type { LoadedSkill, StepName } from '../contracts/step.js';
import type { WorkflowConfig } from './workflow-config.js';

/** Step 6: the total size of a skill's files (after the binary skip), from the listing. */
export const SKILL_BYTES_LIMIT = 204_800;
const SKILL_FILE = 'SKILL.md';
/** Step 5 (LW3): left out by extension, letter case ignored. */
const BINARY_EXTENSIONS = new Set(
  '.png .jpg .jpeg .gif .webp .ico .bmp .pdf .zip .gz .tgz .tar .7z .woff .woff2 .ttf .otf .mp3 .wav .mp4 .mov'.split(
    ' ',
  ),
);

/** What the listing says about a skill: the files to read (SKILL.md first) and the binary files left out. */
export interface SkillListing {
  step: StepName;
  dir: string;
  files: RepoFile[];
  skipped: RepoFile[];
}

/**
 * Steps 3–6 from the listing only (also the run-start check): null when the skill is missing (no entry, no
 * directory, no SKILL.md or an empty one); `skill too large` from the sizes, before any file is read.
 */
export async function listSkill(
  repo: RepoProvider,
  skills: WorkflowConfig['skills'],
  step: StepName,
  commit: string,
): Promise<SkillListing | null> {
  const dir = skills[step];
  if (dir === undefined) return null;
  const listed = await repo.listFiles(commit, dir);
  if (listed === null) return null;
  const root = dir.replace(/\/+$/, '');
  const skillFile = listed.find(
    (file) => file.path === `${root}/${SKILL_FILE}`,
  );
  if (!skillFile || skillFile.size === 0) return null;

  const skipped = listed.filter((file) => isBinary(file.path));
  const others = listed
    .filter((file) => file !== skillFile && !isBinary(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = [skillFile, ...others];
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > SKILL_BYTES_LIMIT) {
    throw new StepConfigError(
      `skill too large: ${step} (${bytes.toLocaleString('en-US')} bytes, limit ${SKILL_BYTES_LIMIT.toLocaleString('en-US')})`,
    );
  }
  return { step, dir, files, skipped };
}

/** Steps 3–8: the skill as the prompt gets it, every file read at `commit`. One log line, never content. */
export async function loadSkill(
  repo: RepoProvider,
  skills: WorkflowConfig['skills'],
  step: StepName,
  commit: string,
  logger: Pick<Logger, 'log'>,
): Promise<LoadedSkill> {
  const listing = await listSkill(repo, skills, step, commit);
  if (!listing) throw missingSkills([step]);

  const prefix = `${listing.dir.replace(/\/+$/, '')}/`;
  const files: LoadedSkill['files'] = [];
  for (const file of listing.files) {
    files.push({
      path: file.path.slice(prefix.length),
      text: await readSkillFile(repo, commit, file.path),
    });
  }
  if (files[0].text.trim() === '') throw missingSkills([step]);

  const chars = files.reduce((sum, file) => sum + file.text.length, 0);
  const skipped = listing.skipped.map((file) => file.path.slice(prefix.length));
  logger.log(
    `skill ${step} @${commit.slice(0, 7)}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ` +
      `${chars.toLocaleString('en-US')} chars, skipped ${skipped.length}` +
      (skipped.length > 0 ? ` (${skipped.join(', ')})` : ''),
  );
  return { step, path: listing.dir, commit, files };
}

export function missingSkills(steps: StepName[]): StepConfigError {
  return new StepConfigError(`missing skills: ${steps.join(', ')}`);
}

/**
 * Step 7 (plan P6): the adapter raises a permanent ProviderError without an HTTP status only for a file over
 * 1 MB or not valid UTF-8, so that error, or a listed file that reads as missing, is an unreadable skill file.
 * Any error with a status is a GitHub failure and passes through unchanged.
 */
async function readSkillFile(
  repo: RepoProvider,
  commit: string,
  path: string,
): Promise<string> {
  let text: string | null;
  try {
    text = await repo.readFile(commit, path);
  } catch (error) {
    if (
      error instanceof ProviderError &&
      error.kind === 'permanent' &&
      error.detail.status === undefined
    ) {
      throw unreadable(path);
    }
    throw error;
  }
  if (text === null) throw unreadable(path);
  return text;
}

function unreadable(path: string): StepConfigError {
  return new StepConfigError(`unreadable skill file: ${path}`);
}

function isBinary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot));
}
