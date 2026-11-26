// Spec 12 "Protected paths" (BD5, BD6, BDW9; plan DP17): the files the bot may never change. Pure: the floor (in
// code: `.github-agent/` and every step skill folder) first, then the target repo's `protectedPaths` globs. Specs 9
// and 10 are its callers (BDW10); a folder is checked file by file, a rename at both paths.
import picomatch from 'picomatch';
import type { StepName } from '../contracts/step.js';
import type { WorkflowConfig } from './workflow-config.js';

export interface ProtectedRule {
  glob: string;
  /** The floor or the developer's array. */
  source: 'bot' | 'workflow.json';
}

/** The bot's own folder: always protected, whatever `workflow.json` says (BD6). */
const BOT_FOLDER = '.github-agent';
const STEPS: readonly StepName[] = [
  'grill',
  'spec',
  'plan',
  'code',
  'qualityGate',
];

/** What the rules are built from: the step skill folders and the array. */
type ProtectedConfig = Pick<WorkflowConfig, 'skills' | 'protectedPaths'>;

/** The floor first (`.github-agent/**`, then `<skills.<step>>/**` in step order), then `protectedPaths` in order. */
export function protectedRules(config: ProtectedConfig): ProtectedRule[] {
  const floor = [
    BOT_FOLDER,
    ...STEPS.flatMap((step) => config.skills[step] ?? []),
  ].map((folder): ProtectedRule => ({
    glob: `${folder.replace(/\/+$/, '')}/**`,
    source: 'bot',
  }));
  return [
    ...floor,
    ...config.protectedPaths.map((glob): ProtectedRule => ({
      glob,
      source: 'workflow.json',
    })),
  ];
}

/**
 * The first rule that matches the file path (every leading `./` or `/` ignored): the floor by prefix, letter case
 * ignored; the array with picomatch (`dot`, `nocase`); null when none.
 */
export function protectedRuleFor(
  path: string,
  rules: readonly ProtectedRule[],
): ProtectedRule | null {
  const file = path.replace(/^(?:\.\/|\/)+/, '');
  const lower = file.toLowerCase();
  return (
    rules.find((rule) =>
      rule.source === 'bot'
        ? lower.startsWith(
            `${rule.glob.slice(0, -'/**'.length).toLowerCase()}/`,
          )
        : picomatch.isMatch(file, rule.glob, { dot: true, nocase: true }),
    ) ?? null
  );
}
