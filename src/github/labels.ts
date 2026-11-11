// The bot's labels on GitHub (overview §2, spec 3 "Labels created") and their mapping to neutral values.
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';

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

/** The only labels removeLabel may touch (spec A4): human-assigned lane and modifier labels. */
export function isHumanControlLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(WORKFLOW_PREFIX) || lower === GRILL_SKIP;
}

/** GitHub label names are case-insensitive. */
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The lane a label name stands for (`workflow: <lane>`, any letter case); null for any other label. */
export function laneOfLabel(name: string): Lane | null {
  return LANES.find((lane) => sameLabel(name, laneLabel(lane))) ?? null;
}
