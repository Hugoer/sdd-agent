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
  modelLabel,
  sameLabel,
  stepOfModelLabel,
} from '../github/labels.js';
import { isApproveCommand } from './approve-command.js';
import type { IgnoreReason } from './ignore-reason.js';

/** The level an input needs; `self` = the bot's own PR event, accepted with no lookup. */
export type Needs = 'participant' | 'approver' | 'self';

/** A label to revert: its canonical name and the key of its marker (spec 2, AW2; spec 4 "Model labels"). */
export interface Revert {
  label: string; // `workflow: <lane>`, `grill: skip` or `model: max-<step>`
  key: string; // `<lane>`, `grill-skip` or `model-max-<step>`
}

/**
 * An ignore decided from the payload alone, an input that still needs the sender's level, or an added model
 * label (spec 4, plan P5): never a WorkflowInput; kept for an Approver, reverted for anyone lower.
 */
export type Classified =
  | { outcome: 'ignored'; reason: IgnoreReason }
  | { outcome: 'model-label'; task: TaskRef; sender: string; revert: Revert }
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

/** A comment on a pull request: its `issue` carries a `pull_request` object. */
const onPullRequest = z.object({
  issue: z.object({ pull_request: z.object({}).loose() }),
});

const commentPayload = z.object({
  issue: z.object({ id, number: id }),
  comment: z.object({
    id,
    body: z.string(),
    created_at: z.iso.datetime({ offset: true }),
  }),
});

const pullRequestPayload = z.object({
  pull_request: z.object({
    id,
    number: id,
    html_url: z.url(),
    user: z.object({ login: z.string().regex(LOGIN) }),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }),
  }),
});

type Envelope = z.infer<typeof envelope>;

const senderLogin = z.object({
  sender: z.object({ login: z.string().regex(LOGIN) }),
});

/** The sender's login for the log line, only when it is a valid login (so nothing else reaches the log). */
export function senderLoginOf(
  event: Pick<WebhookEvent, 'payload'>,
): string | null {
  const parsed = senderLogin.safeParse(event.payload);
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
  if (eventName === 'issue_comment')
    return classifyComment(env, payload, common);
  return classifyPullRequest(env, payload, common, isSelf);
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
  const step = stepOfModelLabel(label.name);
  if (step) {
    if (!added) return ignored('model-label');
    const name = modelLabel(step);
    return withIssue(env, payload, (task) => ({
      outcome: 'model-label',
      task,
      sender: common.sender,
      revert: { label: name, key: name.replace(': ', '-') },
    }));
  }
  return ignored('other-label'); // also an unknown `workflow: *` or `model: *`
}

/** The `issue_comment` rows. The body is the text as it was created; later edits are ignored. */
function classifyComment(
  env: Envelope,
  payload: unknown,
  common: Common,
): Classified {
  switch (env.action) {
    case 'edited':
      return ignored('comment-edited');
    case 'deleted':
      return ignored('comment-deleted');
    case 'created':
      break;
    default:
      return ignored('unsupported-event');
  }
  if (onPullRequest.safeParse(payload).success) return ignored('pr-comment');
  const parsed = commentPayload.safeParse(payload);
  if (!parsed.success) return ignored('invalid-payload');

  const { issue, comment: raw } = parsed.data;
  const task = taskOf(env, issue);
  const comment = {
    id: String(raw.id),
    body: raw.body,
    createdAt: new Date(raw.created_at),
  };
  return isApproveCommand(raw.body)
    ? candidate({ ...common, type: 'APPROVE', task, comment }, 'approver', task)
    : candidate(
        { ...common, type: 'COMMENT', task, comment },
        'participant',
        task,
      );
}

/**
 * The `pull_request` rows: only `opened` and `synchronize` on a PR the bot opened. The bot as sender needs
 * no lookup; a human sender must be an Approver, asked on a ref built from the PR number (AW6: on GitHub a
 * PR is an issue in the same number space; the ref only addresses the repo).
 */
function classifyPullRequest(
  env: Envelope,
  payload: unknown,
  common: Common,
  isSelf: (login: string) => boolean,
): Classified {
  if (env.action !== 'opened' && env.action !== 'synchronize')
    return ignored('unsupported-event');
  const parsed = pullRequestPayload.safeParse(payload);
  if (!parsed.success) return ignored('invalid-payload');
  const pr = parsed.data.pull_request;
  if (!isSelf(pr.user.login)) return ignored('not-bot-pr');

  const repo = env.repository.full_name;
  const subject: TaskRef = {
    platform: 'GITHUB',
    id: String(pr.id),
    externalRef: `${repo}#${pr.number}`,
  };
  return candidate(
    {
      ...common,
      type: 'PR_UPDATED',
      pr: { platform: 'GITHUB', repo, number: pr.number, url: pr.html_url },
      headSha: pr.head.sha,
    },
    isSelf(common.sender) ? 'self' : 'approver',
    subject,
  );
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
