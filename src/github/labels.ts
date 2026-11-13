// The bot's labels on GitHub (overview §2, spec 3 "Labels created") and their mapping to neutral values.
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';
import type { StepName } from '../contracts/step.js';

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const STATUS_PREFIX = 'status: ';
export const WORKFLOW_PREFIX = 'workflow: ';
export const GRILL_SKIP = 'grill: skip';

/** Fixed order: readControls returns lanes in this order. */
export const LANES: readonly Lane[] = ['full-sdd', 'spec-code', 'code-only'];

/** Fixed order: readControls returns maxModelSteps in this order. */
export const STEPS: readonly StepName[] = [
  'grill',
  'spec',
  'plan',
  'code',
  'qualityGate',
];

/** The `<step>` part of `model: max-<step>` (spec 4 "Model labels"). */
const MODEL_LABEL_STEP: Record<StepName, string> = {
  grill: 'grill',
  spec: 'spec',
  plan: 'plan',
  code: 'code',
  qualityGate: 'quality-gate',
};

export const BOT_LABELS: readonly LabelDefinition[] = [
  {
    name: 'status: draft',
    color: 'ededed',
    description: 'Bot-managed: not started. Add a workflow label to start.',
  },
  {
    name: 'status: grilling',
    color: 'fbca04',
    description: 'Bot-managed: asking clarifying questions.',
  },
  {
    name: 'status: spec-review',
    color: 'c5def5',
    description: 'Bot-managed: Spec posted, waiting for /approve.',
  },
  {
    name: 'status: ready-for-dev',
    color: '0e8a16',
    description: 'Bot-managed: waiting for /approve to start the Coder.',
  },
  {
    name: 'status: executing',
    color: '1d76db',
    description: 'Bot-managed: the Coder is running.',
  },
  {
    name: 'status: in-review',
    color: '5319e7',
    description: 'Bot-managed: PR opened; Quality Gate and human review.',
  },
  {
    name: 'status: needs-human',
    color: 'b60205',
    description:
      'Bot-managed: stopped. Remove and re-add the workflow label to restart.',
  },
  {
    name: 'workflow: full-sdd',
    color: '0052cc',
    description:
      'Human-assigned: Grill Me → Spec → Plan → Coder → Quality Gate.',
  },
  {
    name: 'workflow: spec-code',
    color: '0052cc',
    description: 'Human-assigned: Grill Me → Spec → Coder → Quality Gate.',
  },
  {
    name: 'workflow: code-only',
    color: '0052cc',
    description: 'Human-assigned: Coder → Quality Gate, after /approve.',
  },
  {
    name: 'grill: skip',
    color: 'd4c5f9',
    description: 'Human-assigned: skip Grill Me (full-sdd, spec-code).',
  },
  {
    name: 'model: max-grill',
    color: 'fef2c0',
    description: 'Approvers only: Grill Me uses the most capable model.',
  },
  {
    name: 'model: max-spec',
    color: 'fef2c0',
    description:
      'Approvers only: the Spec is written with the most capable model.',
  },
  {
    name: 'model: max-plan',
    color: 'fef2c0',
    description:
      'Approvers only: the Plan is written with the most capable model.',
  },
  {
    name: 'model: max-code',
    color: 'fef2c0',
    description: 'Approvers only: the Coder uses the most capable model.',
  },
  {
    name: 'model: max-quality-gate',
    color: 'fef2c0',
    description:
      'Approvers only: the Quality Gate uses the most capable model.',
  },
];

export function statusLabel(status: TaskStatus): string {
  return `${STATUS_PREFIX}${status}`;
}

export function laneLabel(lane: Lane): string {
  return `${WORKFLOW_PREFIX}${lane}`;
}

export function isStatusLabel(name: string): boolean {
  return name.toLowerCase().startsWith(STATUS_PREFIX);
}

/** The only labels removeLabel may touch (spec 3 A4, spec 4): human-assigned lane, modifier and model labels. */
export function isHumanControlLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(WORKFLOW_PREFIX) ||
    lower === GRILL_SKIP ||
    stepOfModelLabel(name) !== null
  );
}

/** GitHub label names are case-insensitive. */
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The lane a label name stands for (`workflow: <lane>`, any letter case); null for any other label. */
export function laneOfLabel(name: string): Lane | null {
  return LANES.find((lane) => sameLabel(name, laneLabel(lane))) ?? null;
}

/** The label that switches one step to the `max` model: `model: max-<step>`. */
export function modelLabel(step: StepName): string {
  return `model: max-${MODEL_LABEL_STEP[step]}`;
}

/** The step a model label stands for (any letter case); null for any other label, `model: turbo` included. */
export function stepOfModelLabel(name: string): StepName | null {
  return STEPS.find((step) => sameLabel(name, modelLabel(step))) ?? null;
}
