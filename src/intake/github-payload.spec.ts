import { describe, expect, it, vi } from 'vitest';
import {
  BOT_LOGIN,
  HUMAN,
  TARGET_REPO,
  checkSuiteRequested,
  issuesClosed,
  issuesOpened,
  ping,
  storedEvent,
  type Delivery,
} from '../../test/fixtures/github/payloads.js';
import { externalRefOf } from '../events/external-ref.js';
import {
  classifyGitHubEvent,
  senderLoginOf,
  type Classified,
} from './github-payload.js';

const isSelf = (login: string) => login.toLowerCase() === BOT_LOGIN;

function classify(delivery: Delivery, targetRepo = TARGET_REPO): Classified {
  return classifyGitHubEvent(storedEvent(delivery), targetRepo, isSelf);
}
const raw = (
  eventName: string,
  payload: Record<string, unknown>,
): Delivery => ({
  eventName,
  payload,
});

/** A copy of the payload with `path` set to `value` (undefined deletes it). */
function withField(delivery: Delivery, path: string, value: unknown): Delivery {
  const payload = structuredClone(delivery.payload);
  const keys = path.split('.');
  const last = keys.pop()!;
  let target = payload;
  for (const key of keys) target = target[key] as Record<string, unknown>;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return { ...delivery, payload };
}

describe('classifyGitHubEvent: checks 1–5, in order', () => {
  it('1: ping → ping, also from another repo', () => {
    expect(classify(ping())).toEqual({ outcome: 'ignored', reason: 'ping' });
    expect(
      classify(raw('ping', { zen: 'x', repository: { full_name: 'a/b' } })),
    ).toEqual({ outcome: 'ignored', reason: 'ping' });
  });

  it('2: another repo → other-repo, before every other check', () => {
    const other = 'someone/other-repo';
    expect(classify(issuesOpened({ repo: other }))).toEqual({
      outcome: 'ignored',
      reason: 'other-repo',
    });
    // an unsupported event from another repo
    expect(classify(checkSuiteRequested({ repo: other }))).toEqual({
      outcome: 'ignored',
      reason: 'other-repo',
    });
    // the bot's own event from another repo; a payload otherwise invalid
    expect(classify(issuesOpened({ repo: other, sender: BOT_LOGIN }))).toEqual({
      outcome: 'ignored',
      reason: 'other-repo',
    });
    expect(
      classify(raw('issues', { repository: { full_name: other } })),
    ).toEqual({ outcome: 'ignored', reason: 'other-repo' });
  });

  it('2: the repo name is compared case-insensitively', () => {
    const upper = TARGET_REPO.toUpperCase();
    expect(classify(issuesOpened({ repo: upper })).outcome).toBe('candidate');
    expect(classify(issuesOpened(), upper).outcome).toBe('candidate');
  });

  it('3: an unsupported event → unsupported-event, even without a sender', () => {
    expect(classify(checkSuiteRequested())).toEqual({
      outcome: 'ignored',
      reason: 'unsupported-event',
    });
    expect(classify(raw('installation', { action: 'created' }))).toEqual({
      outcome: 'ignored',
      reason: 'unsupported-event',
    });
  });

  it.each<[string, Delivery]>([
    ['no sender', withField(issuesOpened(), 'sender', undefined)],
    [
      'sender.login missing',
      withField(issuesOpened(), 'sender.login', undefined),
    ],
    ['sender.login a number', withField(issuesOpened(), 'sender.login', 7)],
    ['sender.login empty', withField(issuesOpened(), 'sender.login', '')],
    [
      'sender.login with a space',
      withField(issuesOpened(), 'sender.login', 'a b'),
    ],
    ['sender.login with @', withField(issuesOpened(), 'sender.login', '@dev')],
    [
      'sender.login 101 chars',
      withField(issuesOpened(), 'sender.login', 'a'.repeat(101)),
    ],
    [
      'sender.login with [bot] in the middle',
      withField(issuesOpened(), 'sender.login', 'a[bot]b'),
    ],
    ['no action', withField(issuesOpened(), 'action', undefined)],
    ['action empty', withField(issuesOpened(), 'action', '')],
    ['action a number', withField(issuesOpened(), 'action', 1)],
    ['no repository', withField(issuesOpened(), 'repository', undefined)],
    [
      'repository.full_name a number',
      withField(issuesOpened(), 'repository.full_name', 7),
    ],
    ['only an action', raw('issues', { action: 'opened' })],
    [
      'an array',
      {
        eventName: 'issues',
        payload: [] as unknown as Record<string, unknown>,
      },
    ],
  ])('4: %s → invalid-payload', (_name, delivery) => {
    expect(classify(delivery)).toEqual({
      outcome: 'ignored',
      reason: 'invalid-payload',
    });
  });

  it.each([
    'a',
    'a'.repeat(100),
    'Dev_User-1',
    'github-actions[bot]',
    'a'.repeat(100) + '[bot]',
  ])('4: %s is a valid sender login', (login) => {
    expect(classify(issuesOpened({ sender: login })).outcome).toBe('candidate');
  });

  it('5: the bot as sender of an issues event → own-event, in any letter case', () => {
    expect(classify(issuesOpened({ sender: BOT_LOGIN }))).toEqual({
      outcome: 'ignored',
      reason: 'own-event',
    });
    expect(classify(issuesClosed({ sender: 'Test-App[bot]' }))).toEqual({
      outcome: 'ignored',
      reason: 'own-event',
    });
  });

  it('5: another bot is an ordinary sender', () => {
    expect(classify(issuesOpened({ sender: 'dependabot[bot]' })).outcome).toBe(
      'candidate',
    );
  });

  it('4 before 5: an invalid payload from the bot → invalid-payload', () => {
    expect(
      classify(
        withField(issuesOpened({ sender: BOT_LOGIN }), 'action', undefined),
      ),
    ).toEqual({ outcome: 'ignored', reason: 'invalid-payload' });
  });

  it('isSelf is asked only after checks 1–4', () => {
    const spy = vi.fn(isSelf);
    for (const delivery of [
      ping(),
      issuesOpened({ repo: 'someone/else' }),
      checkSuiteRequested(),
      raw('issues', { action: 'opened' }),
    ]) {
      classifyGitHubEvent(storedEvent(delivery), TARGET_REPO, spy);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('classifyGitHubEvent: issues', () => {
  it('opened → ISSUE_OPENED with task, deliveryId, receivedAt and sender; needs a Participant', () => {
    const event = storedEvent(issuesOpened({ number: 12, issueId: 99887766 }), {
      deliveryId: 'd-1',
      receivedAt: new Date('2026-11-11T09:00:00Z'),
    });
    const task = {
      platform: 'GITHUB',
      id: '99887766',
      externalRef: `${TARGET_REPO}#12`,
    };

    expect(classifyGitHubEvent(event, TARGET_REPO, isSelf)).toEqual({
      outcome: 'candidate',
      input: {
        type: 'ISSUE_OPENED',
        deliveryId: 'd-1',
        receivedAt: new Date('2026-11-11T09:00:00Z'),
        sender: HUMAN,
        task,
      },
      needs: 'participant',
      subject: task,
    });
  });

  it('the reference keeps the repo name as GitHub wrote it', () => {
    const result = classify(issuesOpened({ repo: 'Test-Owner/Test-Repo' }));
    expect(result.outcome === 'candidate' && result.subject.externalRef).toBe(
      'Test-Owner/Test-Repo#7',
    );
  });

  it.each<[string, Delivery]>([
    ['no issue', withField(issuesOpened(), 'issue', undefined)],
    ['issue.id missing', withField(issuesOpened(), 'issue.id', undefined)],
    ['issue.id a string', withField(issuesOpened(), 'issue.id', '123')],
    ['issue.id not an integer', withField(issuesOpened(), 'issue.id', 1.5)],
    [
      'issue.number missing',
      withField(issuesOpened(), 'issue.number', undefined),
    ],
    ['issue.number a string', withField(issuesOpened(), 'issue.number', '7')],
    ['issue.number zero', withField(issuesOpened(), 'issue.number', 0)],
  ])('opened, %s → invalid-payload', (_name, delivery) => {
    expect(classify(delivery)).toEqual({
      outcome: 'ignored',
      reason: 'invalid-payload',
    });
  });

  it.each(['closed', 'reopened', 'edited', 'assigned', 'transferred'])(
    '%s → unsupported-event',
    (action) => {
      expect(classify(withField(issuesOpened(), 'action', action))).toEqual({
        outcome: 'ignored',
        reason: 'unsupported-event',
      });
    },
  );
});

describe('every builder that gives an input', () => {
  it.each<[string, Delivery]>([
    ['issues.opened', issuesOpened({ number: 31 })],
  ])(
    '%s: externalRefOf(payload) equals the input reference',
    (_name, delivery) => {
      const result = classify(delivery);
      if (result.outcome !== 'candidate') throw new Error('expected an input');
      const input = result.input;
      const ref =
        input.type === 'PR_UPDATED'
          ? `${input.pr.repo}#${input.pr.number}`
          : input.task.externalRef;
      expect(externalRefOf(delivery.payload)).toBe(ref);
    },
  );
});

describe('senderLoginOf', () => {
  it.each([
    [{ sender: { login: 'dev-user' } }, 'dev-user'],
    [{ sender: { login: 'app[bot]' } }, 'app[bot]'],
    [{ sender: { login: 'a b' } }, null],
    [{ sender: { login: 7 } }, null],
    [{ zen: 'x' }, null],
    [null, null],
  ])('%j → %j', (payload, expected) => {
    expect(senderLoginOf(payload)).toBe(expected);
  });
});
