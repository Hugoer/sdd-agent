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
