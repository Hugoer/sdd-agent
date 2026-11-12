// GitHub webhook payloads for tests (spec 2, plan P4): builder functions, trimmed from the sandbox repo's
// stored deliveries of 2026-11-11 (field paths and types as GitHub sent them). Repo, logins and IDs are
// test values. Real deliveries: issues.opened, issues.labeled, issues.unlabeled without `label` (a deleted
// label), issue_comment.created, pull_request.closed. The other kinds are derived from the nearest real one.
import { externalRefOf } from '../../../src/events/external-ref.js';
import type { WebhookEvent } from '../../../src/generated/prisma/client.js';
import { testEnv } from '../../test-env.js';

export const TARGET_REPO = testEnv.TARGET_REPO;
/** The bot login of the fakes (InMemoryIssueProvider, the harness's offline GitHub client). */
export const BOT_LOGIN = 'test-app[bot]';
export const HUMAN = 'dev-user';

export interface Delivery {
  eventName: string;
  payload: Record<string, unknown>;
}

export interface IssueOptions {
  repo?: string;
  sender?: string;
  number?: number;
  issueId?: number;
}

function repository(repo = TARGET_REPO) {
  return { id: 1452468999, full_name: repo, private: false };
}

function sender(login = HUMAN) {
  return {
    login,
    id: login.endsWith('[bot]') ? 354930466 : 6820634,
    type: login.endsWith('[bot]') ? 'Bot' : 'User',
  };
}

function issue({ number = 7, issueId }: IssueOptions) {
  return {
    id: issueId ?? 6335695000 + number,
    number,
    title: `Issue ${number}`,
    state: 'open',
    user: { login: HUMAN, type: 'User' },
    labels: [] as unknown[],
  };
}

function base(action: string, options: IssueOptions) {
  return {
    action,
    issue: issue(options),
    repository: repository(options.repo),
    sender: sender(options.sender),
    installation: { id: 180575705 },
  };
}

/** Real delivery: issues.opened. */
export function issuesOpened(options: IssueOptions = {}): Delivery {
  return { eventName: 'issues', payload: base('opened', options) };
}

/** Real delivery: issues.closed (an action the bot doesn't use). */
export function issuesClosed(options: IssueOptions = {}): Delivery {
  return { eventName: 'issues', payload: base('closed', options) };
}

/** The label object as GitHub sends it (real delivery: issues.labeled with `grill: skip`). */
function labelObject(name: string) {
  return {
    id: 13038037927,
    node_id: 'LA_kwDOVpLrB88AAAADCSCrpw',
    url: `https://api.github.com/repos/${TARGET_REPO}/labels/${encodeURIComponent(name)}`,
    name,
    color: 'd4c5f9',
    default: false,
    description: null,
  };
}

export interface LabelOptions extends IssueOptions {
  label: string;
}

/** Real delivery: issues.labeled. */
export function issuesLabeled(options: LabelOptions): Delivery {
  return {
    eventName: 'issues',
    payload: { ...base('labeled', options), label: labelObject(options.label) },
  };
}

/** Derived from issues.labeled (the sandbox has no unlabeled delivery with a label). */
export function issuesUnlabeled(options: LabelOptions): Delivery {
  return {
    eventName: 'issues',
    payload: {
      ...base('unlabeled', options),
      label: labelObject(options.label),
    },
  };
}

/** Real delivery: issues.unlabeled sent when a label is deleted from the repo: no `label` (AW3). */
export function issuesLabelDeleted(options: IssueOptions = {}): Delivery {
  return { eventName: 'issues', payload: base('unlabeled', options) };
}

export interface CommentOptions extends IssueOptions {
  body?: string;
  commentId?: number;
  createdAt?: string;
  /** The comment is on a pull request (its `issue` carries `pull_request`). */
  onPullRequest?: boolean;
}

function comment(action: string, options: CommentOptions) {
  const payload = base(action, options);
  const login = options.sender ?? HUMAN;
  const number = options.number ?? 7;
  const issueWithPr = options.onPullRequest
    ? {
        ...payload.issue,
        pull_request: {
          url: `https://api.github.com/repos/${TARGET_REPO}/pulls/${number}`,
          html_url: `https://github.com/${TARGET_REPO}/pull/${number}`,
          merged_at: null,
        },
      }
    : payload.issue;
  return {
    ...payload,
    issue: issueWithPr,
    comment: {
      id: options.commentId ?? 6805237143,
      html_url: `https://github.com/${TARGET_REPO}/issues/${number}#issuecomment-${options.commentId ?? 6805237143}`,
      body: options.body ?? 'looks fine',
      created_at: options.createdAt ?? '2026-11-11T19:26:25Z',
      updated_at: options.createdAt ?? '2026-11-11T19:26:25Z',
      user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
      author_association: 'OWNER',
    },
  };
}

/** Real delivery: issue_comment.created (also on a pull request: derived, adds `issue.pull_request`). */
export function issueCommentCreated(options: CommentOptions = {}): Delivery {
  return { eventName: 'issue_comment', payload: comment('created', options) };
}

/** Derived from issue_comment.created: GitHub adds `changes.body.from`. */
export function issueCommentEdited(options: CommentOptions = {}): Delivery {
  return {
    eventName: 'issue_comment',
    payload: {
      ...comment('edited', options),
      changes: { body: { from: 'the old text' } },
    },
  };
}

/** Derived from issue_comment.created. */
export function issueCommentDeleted(options: CommentOptions = {}): Delivery {
  return { eventName: 'issue_comment', payload: comment('deleted', options) };
}

export interface PullRequestOptions {
  repo?: string;
  sender?: string;
  number?: number;
  /** Who opened the PR (default: the bot). */
  author?: string;
  headSha?: string;
}

export const HEAD_SHA = 'bf7bda2a95c880e6f2fce8e493eb3df502ec654c';

function pullRequest(action: string, options: PullRequestOptions) {
  const number = options.number ?? 15;
  const author = options.author ?? BOT_LOGIN;
  const repo = options.repo ?? TARGET_REPO;
  return {
    action,
    number,
    pull_request: {
      id: 5258563000 + number,
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      state: 'open',
      title: 'sdd-agent smoke (spec 3)',
      user: { login: author, type: author.endsWith('[bot]') ? 'Bot' : 'User' },
      head: { ref: 'smoke/spec-2', sha: options.headSha ?? HEAD_SHA },
      base: { ref: 'main', sha: '0000000000000000000000000000000000000000' },
    },
    repository: repository(repo),
    sender: sender(options.sender ?? author),
    installation: { id: 180575705 },
  };
}

/** Derived from the real pull_request.closed delivery. */
export function pullRequestOpened(options: PullRequestOptions = {}): Delivery {
  return { eventName: 'pull_request', payload: pullRequest('opened', options) };
}

/** Derived from the real pull_request.closed delivery: `synchronize` = a new head commit. */
export function pullRequestSynchronize(
  options: PullRequestOptions = {},
): Delivery {
  return {
    eventName: 'pull_request',
    payload: pullRequest('synchronize', options),
  };
}

/** Real delivery: pull_request.closed (an action the bot doesn't use). */
export function pullRequestClosed(options: PullRequestOptions = {}): Delivery {
  return { eventName: 'pull_request', payload: pullRequest('closed', options) };
}

/** GitHub's webhook test: no repository, no sender. */
export function ping(): Delivery {
  return {
    eventName: 'ping',
    payload: { zen: 'Keep it logically awesome.', hook_id: 1 },
  };
}

/** An event the App gets unasked (real delivery: check_suite.requested). */
export function checkSuiteRequested(options: IssueOptions = {}): Delivery {
  return {
    eventName: 'check_suite',
    payload: {
      action: 'requested',
      check_suite: {
        id: 1,
        head_sha: 'bf7bda2a95c880e6f2fce8e493eb3df502ec654c',
      },
      repository: repository(options.repo),
      sender: sender(options.sender),
      installation: { id: 180575705 },
    },
  };
}

let stored = 0;

/** The row the worker hands to intake (status PROCESSING, first attempt). */
export function storedEvent(
  delivery: Delivery,
  overrides: Partial<WebhookEvent> = {},
): WebhookEvent {
  const { action } = delivery.payload;
  return {
    id: `00000000-0000-4000-8000-${String(++stored).padStart(12, '0')}`,
    deliveryId: `delivery-${stored}`,
    eventName: delivery.eventName,
    action: typeof action === 'string' ? action : null,
    payload: delivery.payload as WebhookEvent['payload'],
    status: 'PROCESSING',
    ignoreReason: null,
    attempts: 1,
    availableAt: new Date('2026-11-11T10:00:00Z'),
    lastError: null,
    receivedAt: new Date('2026-11-11T10:00:00Z'),
    processedAt: null,
    externalRef: externalRefOf(delivery.payload),
    ...overrides,
  };
}
