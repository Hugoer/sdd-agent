// Spec 2 "Classify" (AW8): the only file in src/intake that reads a GitHub payload. Pure: no NestJS, no
// provider; the bot's identity comes in as a function. Every field is checked with Zod before use.
import { z } from 'zod';
import type { TaskRef } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import {
  GRILL_SKIP,
  isStatusLabel,
  laneLabel,
  laneOfLabel,
  sameLabel,
} from '../github/labels.js';
import type { IgnoreReason } from './ignore-reason.js';

/** The level an input needs; `self` = the bot's own PR event, accepted with no lookup. */
export type Needs = 'participant' | 'approver' | 'self';

/** A label to revert: its canonical name and the key of its marker (spec 2, AW2). */
export interface Revert {
  label: string; // `workflow: <lane>` or `grill: skip`
  key: string; // `<lane>` or `grill-skip`
}

/** An ignore decided from the payload alone, or an input that still needs the sender's level. */
export type Classified =
  | { outcome: 'ignored'; reason: IgnoreReason }
  | {
      outcome: 'candidate';
      input: WorkflowInput;
      needs: Needs;
      /** What the level is asked on (a PR event: the ref of AW6). */
      subject: TaskRef;
      /** LANE_ADDED and SKIP_ADDED: the label to remove when the sender has no access (D21). */
      revert?: Revert;
    };

/** 1–100 letters, digits, `-` and `_`, with an optional `[bot]` suffix. */
const LOGIN = /^[A-Za-z0-9_-]{1,100}(\[bot\])?$/;
const SUPPORTED_EVENTS = new Set(['issues', 'issue_comment', 'pull_request']);

const id = z.number().int().positive();

const repositoryName = z.object({
  repository: z.object({ full_name: z.string() }),
});

const envelope = z.object({
  action: z.string().min(1),
  repository: z.object({ full_name: z.string().min(1) }),
  sender: z.object({ login: z.string().regex(LOGIN) }),
});

const issuePayload = z.object({
  issue: z.object({ id, number: id }),
});

/** No `label` (or null): the label was deleted from the repo (AW3). */
const labelPayload = z.object({
  label: z.object({ name: z.string().min(1) }).nullish(),
});

type Envelope = z.infer<typeof envelope>;

const senderLogin = z.object({
  sender: z.object({ login: z.string().regex(LOGIN) }),
});

/** The sender's login for the log line, only when it is a valid login (so nothing else reaches the log). */
export function senderLoginOf(payload: unknown): string | null {
  const parsed = senderLogin.safeParse(payload);
  return parsed.success ? parsed.data.sender.login : null;
}

/** Spec 2 "Classify": the checks run in order and the first that matches decides. */
export function classifyGitHubEvent(
  event: Pick<
    WebhookEvent,
    'deliveryId' | 'eventName' | 'payload' | 'receivedAt'
  >,
  targetRepo: string,
  isSelf: (login: string) => boolean,
): Classified {
  const { eventName, payload } = event;
  // 1
  if (eventName === 'ping') return ignored('ping');
  // 2
  const named = repositoryName.safeParse(payload);
  if (
    named.success &&
    named.data.repository.full_name.toLowerCase() !== targetRepo.toLowerCase()
  ) {
    return ignored('other-repo');
  }
  // 3
  if (!SUPPORTED_EVENTS.has(eventName)) return ignored('unsupported-event');
  // 4
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return ignored('invalid-payload');
  const env = parsed.data;
  // 5
  if (eventName !== 'pull_request' && isSelf(env.sender.login)) {
    return ignored('own-event');
  }
  // 6
  const common = {
    deliveryId: event.deliveryId,
    receivedAt: event.receivedAt,
    sender: env.sender.login,
  };
  if (eventName === 'issues') return classifyIssues(env, payload, common);
  return ignored('unsupported-event');
}

type Common = Pick<WorkflowInput, 'deliveryId' | 'receivedAt' | 'sender'>;

function classifyIssues(
  env: Envelope,
  payload: unknown,
  common: Common,
): Classified {
  switch (env.action) {
    case 'opened':
      return withIssue(env, payload, (task) =>
        candidate(
          { ...common, type: 'ISSUE_OPENED', task },
          'participant',
          task,
        ),
      );
    case 'labeled':
    case 'unlabeled':
      return classifyLabel(env.action === 'labeled', env, payload, common);
    default:
      return ignored('unsupported-event');
  }
}

/** The label rows. Label names are compared case-insensitively (spec 3 "Labels created"). */
function classifyLabel(
  added: boolean,
  env: Envelope,
  payload: unknown,
  common: Common,
): Classified {
  const parsed = labelPayload.safeParse(payload);
  if (!parsed.success) return ignored('invalid-payload');
  const label = parsed.data.label;
  if (!label) return ignored('label-deleted');

  const lane = laneOfLabel(label.name);
  if (lane) {
    return withIssue(env, payload, (task) =>
      candidate(
        { ...common, type: added ? 'LANE_ADDED' : 'LANE_REMOVED', task, lane },
        'participant',
        task,
        added ? { label: laneLabel(lane), key: lane } : undefined,
      ),
    );
  }
  if (sameLabel(label.name, GRILL_SKIP)) {
    if (!added) return ignored('skip-removed');
    return withIssue(env, payload, (task) =>
      candidate({ ...common, type: 'SKIP_ADDED', task }, 'participant', task, {
        label: GRILL_SKIP,
        key: 'grill-skip',
      }),
    );
  }
  if (isStatusLabel(label.name)) return ignored('status-label');
  return ignored('other-label'); // also an unknown `workflow: *`
}

/** The rows that build an input from the issue: `issue.id` and `issue.number` must be valid. */
function withIssue(
  env: Envelope,
  payload: unknown,
  build: (task: TaskRef) => Classified,
): Classified {
  const parsed = issuePayload.safeParse(payload);
  if (!parsed.success) return ignored('invalid-payload');
  return build(taskOf(env, parsed.data.issue));
}

function candidate(
  input: WorkflowInput,
  needs: Needs,
  subject: TaskRef,
  revert?: Revert,
): Classified {
  return revert
    ? { outcome: 'candidate', input, needs, subject, revert }
    : { outcome: 'candidate', input, needs, subject };
}

function taskOf(env: Envelope, issue: { id: number; number: number }): TaskRef {
  return {
    platform: 'GITHUB',
    id: String(issue.id),
    externalRef: `${env.repository.full_name}#${issue.number}`,
  };
}

function ignored(reason: IgnoreReason): Classified {
  return { outcome: 'ignored', reason };
}
