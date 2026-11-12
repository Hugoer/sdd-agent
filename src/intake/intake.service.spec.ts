import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import {
  BOT_LOGIN,
  HEAD_SHA,
  HUMAN,
  TARGET_REPO,
  checkSuiteRequested,
  issueCommentCreated,
  issuesClosed,
  issuesLabeled,
  issuesOpened,
  issuesUnlabeled,
  ping,
  pullRequestOpened,
  pullRequestSynchronize,
  storedEvent,
} from '../../test/fixtures/github/payloads.js';
import type { Env } from '../config/env.schema.js';
import type { AccessLevel } from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  IntakeService,
  approveDeniedComment,
  labelRevertComment,
} from './intake.service.js';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const issues = new InMemoryIssueProvider(TARGET_REPO, BOT_LOGIN);
  const config = new ConfigService<Env, true>({ TARGET_REPO });
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  return { issues, log, intake: new IntakeService(issues, config) };
}

/** The intake log lines (the first argument of each Logger.log call). */
const lines = (log: ReturnType<typeof setup>['log']) =>
  log.mock.calls.map((call) => String(call[0]));

describe('IntakeService: ISSUE_OPENED (needs a Participant)', () => {
  it.each<[AccessLevel, string]>([
    ['approver', 'accepted'],
    ['participant', 'accepted'],
  ])(
    '%s → %s, with exactly one lookup on the issue and the sender',
    async (level) => {
      const { issues, intake } = setup();
      issues.setAccessLevel(HUMAN, level);
      const event = storedEvent(issuesOpened({ number: 12, issueId: 555 }));

      const result = await intake.intake(event);

      const task = {
        platform: 'GITHUB',
        id: '555',
        externalRef: `${TARGET_REPO}#12`,
      };
      expect(result).toEqual({
        outcome: 'accepted',
        input: {
          type: 'ISSUE_OPENED',
          deliveryId: event.deliveryId,
          receivedAt: event.receivedAt,
          sender: HUMAN,
          task,
        },
      });
      expect(issues.calls).toEqual([
        { method: 'getAccessLevel', args: [task, HUMAN] },
      ]);
    },
  );

  it('none → ignored unauthorized; nothing but the lookup', async () => {
    const { issues, intake } = setup();

    await expect(intake.intake(storedEvent(issuesOpened()))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'unauthorized',
    });
    expect(issues.calls.map((call) => call.method)).toEqual(['getAccessLevel']);
  });

  it('a ProviderError from the lookup comes out unchanged (never read as "no access")', async () => {
    const { issues, intake, log } = setup();
    for (const kind of ['transient', 'permanent'] as const) {
      const error = new ProviderError('GitHub GET … → 503', kind);
      issues.failNext(error);
      await expect(intake.intake(storedEvent(issuesOpened()))).rejects.toBe(
        error,
      );
    }
    expect(log).not.toHaveBeenCalled(); // the worker logs the failure
  });
});

describe('IntakeService: label inputs (need a Participant)', () => {
  const cases = [
    ['LANE_ADDED', issuesLabeled({ label: 'workflow: full-sdd' })],
    ['LANE_REMOVED', issuesUnlabeled({ label: 'workflow: full-sdd' })],
    ['SKIP_ADDED', issuesLabeled({ label: 'grill: skip' })],
  ] as const;

  it.each(
    cases.flatMap(([type, delivery]) =>
      (['approver', 'participant'] as const).map(
        (level) => [type, level, delivery] as const,
      ),
    ),
  )(
    '%s from %s → accepted, one lookup, no label change',
    async (type, level, delivery) => {
      const { issues, intake } = setup();
      issues.setAccessLevel(HUMAN, level);

      const result = await intake.intake(storedEvent(delivery));

      expect(result.outcome === 'accepted' && result.input.type).toBe(type);
      expect(issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
      ]);
    },
  );

  it('LANE_REMOVED from a sender with no access → unauthorized, nothing changed', async () => {
    const { issues, intake } = setup();

    await expect(
      intake.intake(
        storedEvent(
          issuesUnlabeled({ label: 'workflow: code-only', sender: 'octocat' }),
        ),
      ),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'unauthorized' });
    expect(issues.calls.map((call) => call.method)).toEqual(['getAccessLevel']);
  });

  it.each([
    [
      'grill: skip removed',
      issuesUnlabeled({ label: 'grill: skip' }),
      'skip-removed',
    ],
    [
      'a status label',
      issuesLabeled({ label: 'status: draft' }),
      'status-label',
    ],
    ['another label', issuesLabeled({ label: 'bug' }), 'other-label'],
  ])(
    '%s → ignored %s with zero provider calls',
    async (_name, delivery, reason) => {
      const { issues, intake } = setup();
      await expect(intake.intake(storedEvent(delivery))).resolves.toEqual({
        outcome: 'ignored',
        reason,
      });
      expect(issues.calls).toEqual([]);
    },
  );

  it('logs the lane and the issue: accepted LANE_ADDED full-sdd <ref>', async () => {
    const { issues, intake, log } = setup();
    issues.setAccessLevel(HUMAN, 'approver');

    await intake.intake(
      storedEvent(issuesLabeled({ label: 'workflow: full-sdd', number: 3 }), {
        deliveryId: 'd-9',
      }),
    );

    expect(lines(log)).toEqual([
      `delivery=d-9 event=issues action=labeled sender=${HUMAN} accepted LANE_ADDED full-sdd ${TARGET_REPO}#3`,
    ]);
  });
});

describe('IntakeService: label revert (a sender with no access adds a lane or skip label)', () => {
  /** Issue #5 carrying the label, so the revert can be observed. */
  function seeded(labels: string[]) {
    const ctx = setup();
    const task = ctx.issues.seedIssue({ number: 5, id: '6335695005', labels });
    return { ...ctx, task };
  }
  const added = (label: string, sender = 'octocat') =>
    storedEvent(issuesLabeled({ number: 5, label, sender }));

  it('getAccessLevel → removeLabel (canonical name) → findCommentByMarker → postComment; label-reverted', async () => {
    const { issues, intake, task } = seeded(['workflow: code-only', 'bug']);

    await expect(intake.intake(added('Workflow: Code-Only'))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'label-reverted',
    });

    const text =
      '<!-- sdd-agent:label-revert:code-only -->\n' +
      'The `workflow: code-only` label was removed. It was added by `octocat`, who is not allowed to start or ' +
      'change a workflow on this repository (on GitHub that needs the Triage role or higher).';
    expect(issues.calls).toEqual([
      { method: 'getAccessLevel', args: [task, 'octocat'] },
      { method: 'removeLabel', args: [task, 'workflow: code-only'] },
      {
        method: 'findCommentByMarker',
        args: [task, '<!-- sdd-agent:label-revert:code-only -->'],
      },
      { method: 'postComment', args: [task, text] },
    ]);
    expect(issues.labelsOf(task)).toEqual(['bug']);
    expect(issues.commentsOf(task)).toEqual([
      { id: expect.any(String) as string, body: text, byBot: true },
    ]);
    expect(text).not.toContain('@');
  });

  it('grill: skip → removed, its own marker key grill-skip', async () => {
    const { intake, issues, task } = seeded(['grill: skip']);

    await intake.intake(added('grill: skip'));

    expect(issues.labelsOf(task)).toEqual([]);
    expect(issues.commentsOf(task).map((c) => c.body)).toEqual([
      labelRevertComment(
        { label: 'grill: skip', key: 'grill-skip' },
        'octocat',
      ),
    ]);
    expect(issues.commentsOf(task)[0].body).toMatch(
      /^<!-- sdd-agent:label-revert:grill-skip -->\nThe `grill: skip` label was removed\./,
    );
  });

  it('the same label again → removed again, NO second comment; another label → its own comment', async () => {
    const { intake, issues, task } = seeded(['workflow: code-only']);
    await intake.intake(added('workflow: code-only'));

    issues.calls.length = 0;
    issues.seedIssue({
      number: 5,
      id: '6335695005',
      labels: ['workflow: code-only'],
    });
    await expect(intake.intake(added('workflow: code-only'))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'label-reverted',
    });
    expect(issues.calls.map((call) => call.method)).toEqual([
      'getAccessLevel',
      'removeLabel',
      'findCommentByMarker',
    ]);
    expect(issues.commentsOf(task)).toHaveLength(1);

    await intake.intake(added('workflow: full-sdd'));
    expect(issues.commentsOf(task).map((c) => c.body)).toEqual([
      expect.stringContaining('label-revert:code-only') as string,
      expect.stringContaining('label-revert:full-sdd') as string,
    ]);
  });

  it('a label already gone is "removed" and the comment still comes once', async () => {
    const { intake, issues, task } = seeded([]);
    await intake.intake(added('workflow: full-sdd'));
    expect(issues.commentsOf(task)).toHaveLength(1);
  });

  it('after a human deleted the comment, the next revert posts it again, once', async () => {
    const { intake, issues, task } = seeded(['workflow: code-only']);
    await intake.intake(added('workflow: code-only'));
    issues.deleteComment(issues.commentsOf(task)[0].id);

    await intake.intake(added('workflow: code-only'));
    await intake.intake(added('workflow: code-only'));

    expect(issues.commentsOf(task)).toHaveLength(1);
  });

  it("a Participant's lane label is accepted and stays", async () => {
    const { intake, issues, task } = seeded(['workflow: full-sdd']);
    issues.setAccessLevel('octocat', 'participant');

    const result = await intake.intake(added('workflow: full-sdd'));

    expect(result.outcome).toBe('accepted');
    expect(issues.labelsOf(task)).toEqual(['workflow: full-sdd']);
  });

  it.each(['removeLabel', 'findCommentByMarker', 'postComment'] as const)(
    'a ProviderError from %s comes out unchanged; running the event again ends with exactly one comment',
    async (method) => {
      const { intake, issues, task } = seeded(['workflow: code-only']);
      const error = new ProviderError(`GitHub ${method} → 503`, 'transient');
      vi.spyOn(issues, method).mockRejectedValueOnce(error);
      const event = added('workflow: code-only');

      await expect(intake.intake(event)).rejects.toBe(error);
      await expect(intake.intake(event)).resolves.toEqual({
        outcome: 'ignored',
        reason: 'label-reverted',
      });
      await expect(intake.intake(event)).resolves.toEqual({
        outcome: 'ignored',
        reason: 'label-reverted',
      });

      expect(issues.labelsOf(task)).toEqual([]);
      expect(issues.commentsOf(task)).toHaveLength(1);
    },
  );

  it('a crash after the comment: the retry finds the marker and posts nothing', async () => {
    const { intake, issues, task } = seeded(['workflow: code-only']);
    const event = added('workflow: code-only');
    await intake.intake(event);

    await intake.intake(event);

    expect(issues.commentsOf(task)).toHaveLength(1);
  });
});

describe('IntakeService: COMMENT (Participant) and APPROVE (Approver)', () => {
  const comment = (body: string, sender = HUMAN) =>
    storedEvent(issueCommentCreated({ body, sender, number: 4 }));

  it.each<[string, AccessLevel, string]>([
    ['looks fine', 'approver', 'COMMENT'],
    ['looks fine', 'participant', 'COMMENT'],
    ['/approve', 'approver', 'APPROVE'],
  ])(
    '%j from %s → accepted %s, one lookup, nothing posted',
    async (body, level, type) => {
      const { issues, intake } = setup();
      issues.setAccessLevel(HUMAN, level);

      const result = await intake.intake(comment(body));

      expect(result).toMatchObject({
        outcome: 'accepted',
        input: { type, comment: { body } },
      });
      expect(issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
      ]);
    },
  );

  it.each<[string, AccessLevel]>([
    ['looks fine', 'none'],
    ['/approve', 'none'],
  ])('%j from %s → unauthorized, no reply', async (body, level) => {
    const { issues, intake } = setup();
    issues.setAccessLevel('octocat', level);

    await expect(intake.intake(comment(body, 'octocat'))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'unauthorized',
    });
    expect(issues.calls.map((call) => call.method)).toEqual(['getAccessLevel']);
  });

  it('the log line names the type and the issue, never the comment text', async () => {
    const { issues, intake, log } = setup();
    issues.setAccessLevel(HUMAN, 'approver');

    await intake.intake(
      storedEvent(
        issueCommentCreated({ body: 'secret-ish words', number: 4 }),
        { deliveryId: 'd-c' },
      ),
    );
    await intake.intake(
      storedEvent(issueCommentCreated({ body: '/approve', number: 4 }), {
        deliveryId: 'd-a',
      }),
    );

    expect(lines(log)).toEqual([
      `delivery=d-c event=issue_comment action=created sender=${HUMAN} accepted COMMENT ${TARGET_REPO}#4`,
      `delivery=d-a event=issue_comment action=created sender=${HUMAN} accepted APPROVE ${TARGET_REPO}#4`,
    ]);
  });
});

describe("IntakeService: a Participant's /approve gets one reply per comment", () => {
  function participant() {
    const ctx = setup();
    ctx.issues.setAccessLevel('pat', 'participant');
    const task = ctx.issues.seedIssue({ number: 4, id: '6335695004' });
    return { ...ctx, task };
  }
  const approve = (commentId: number) =>
    storedEvent(
      issueCommentCreated({
        number: 4,
        body: '/approve',
        sender: 'pat',
        commentId,
      }),
    );

  it('getAccessLevel → findCommentByMarker(marker of that comment) → postComment; approve-denied', async () => {
    const { issues, intake, task } = participant();

    await expect(intake.intake(approve(6775442980))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'approve-denied',
    });

    const text =
      '<!-- sdd-agent:approve-denied:6775442980 -->\n' +
      '@pat `/approve` needs write access to this repository, so nothing was approved. ' +
      'Ask someone with write access to comment `/approve`.';
    expect(issues.calls).toEqual([
      { method: 'getAccessLevel', args: [task, 'pat'] },
      {
        method: 'findCommentByMarker',
        args: [task, '<!-- sdd-agent:approve-denied:6775442980 -->'],
      },
      { method: 'postComment', args: [task, text] },
    ]);
  });

  it('the same event again (a retry) → no second reply; a second /approve comment → a second reply', async () => {
    const { issues, intake, task } = participant();

    await intake.intake(approve(101));
    await expect(intake.intake(approve(101))).resolves.toEqual({
      outcome: 'ignored',
      reason: 'approve-denied',
    });
    expect(issues.commentsOf(task)).toHaveLength(1);

    await intake.intake(approve(102));
    expect(issues.commentsOf(task).map((c) => c.body)).toEqual([
      approveDeniedComment('101', 'pat'),
      approveDeniedComment('102', 'pat'),
    ]);
  });

  it("a sender with no access gets no reply; an Approver's /approve is accepted with none", async () => {
    const { issues, intake, task } = participant();
    issues.setAccessLevel('boss', 'approver');

    await intake.intake(
      storedEvent(
        issueCommentCreated({ number: 4, body: '/approve', sender: 'octocat' }),
      ),
    );
    await intake.intake(
      storedEvent(
        issueCommentCreated({ number: 4, body: '/approve', sender: 'boss' }),
      ),
    );

    expect(issues.commentsOf(task)).toEqual([]);
  });

  it("a Participant's normal comment is accepted, no reply", async () => {
    const { intake, issues, task } = participant();
    const result = await intake.intake(
      storedEvent(
        issueCommentCreated({
          number: 4,
          body: '/approve please',
          sender: 'pat',
        }),
      ),
    );
    expect(result).toMatchObject({
      outcome: 'accepted',
      input: { type: 'COMMENT' },
    });
    expect(issues.commentsOf(task)).toEqual([]);
  });

  it.each(['findCommentByMarker', 'postComment'] as const)(
    'a ProviderError from %s comes out unchanged; the retry ends with exactly one reply',
    async (method) => {
      const { issues, intake, task } = participant();
      const error = new ProviderError(`GitHub ${method} → 503`, 'transient');
      vi.spyOn(issues, method).mockRejectedValueOnce(error);
      const event = approve(7);

      await expect(intake.intake(event)).rejects.toBe(error);
      await intake.intake(event);
      await intake.intake(event);

      expect(issues.commentsOf(task)).toHaveLength(1);
    },
  );
});

describe('IntakeService: PR_UPDATED', () => {
  it('bot PR, bot sender → accepted with zero provider calls', async () => {
    const { issues, intake } = setup();

    const result = await intake.intake(storedEvent(pullRequestOpened()));

    expect(result).toMatchObject({
      outcome: 'accepted',
      input: { type: 'PR_UPDATED', sender: BOT_LOGIN },
    });
    expect(issues.calls).toEqual([]);
  });

  it.each<[AccessLevel, string]>([
    ['approver', 'accepted'],
    ['participant', 'ignored'],
    ['none', 'ignored'],
  ])(
    'bot PR, human sender who is %s → %s, one lookup on <repo>#<PR number>',
    async (level, outcome) => {
      const { issues, intake } = setup();
      issues.setAccessLevel(HUMAN, level);

      const result = await intake.intake(
        storedEvent(pullRequestSynchronize({ sender: HUMAN, number: 15 })),
      );

      expect(result.outcome).toBe(outcome);
      if (result.outcome === 'ignored')
        expect(result.reason).toBe('unauthorized');
      expect(issues.calls).toEqual([
        {
          method: 'getAccessLevel',
          args: [
            {
              platform: 'GITHUB',
              id: String(5258563000 + 15),
              externalRef: `${TARGET_REPO}#15`,
            },
            HUMAN,
          ],
        },
      ]);
    },
  );

  it('a PR not opened by the bot → not-bot-pr with zero provider calls', async () => {
    const { issues, intake } = setup();
    await expect(
      intake.intake(storedEvent(pullRequestOpened({ author: HUMAN }))),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'not-bot-pr' });
    expect(issues.calls).toEqual([]);
  });

  it('logs the PR and its head: accepted PR_UPDATED <repo>#<n> <sha>', async () => {
    const { intake, log } = setup();
    await intake.intake(
      storedEvent(pullRequestOpened({ number: 15 }), { deliveryId: 'd-pr' }),
    );
    expect(lines(log)).toEqual([
      `delivery=d-pr event=pull_request action=opened sender=${BOT_LOGIN} accepted PR_UPDATED ${TARGET_REPO}#15 ${HEAD_SHA}`,
    ]);
  });
});

describe('IntakeService: decided by classify', () => {
  it.each([
    ['ping', ping(), 'ping'],
    ['another repo', issuesOpened({ repo: 'someone/else' }), 'other-repo'],
    ['an unsupported event', checkSuiteRequested(), 'unsupported-event'],
    ['an unsupported action', issuesClosed(), 'unsupported-event'],
    [
      'an invalid payload',
      { eventName: 'issues', payload: { action: 'opened' } },
      'invalid-payload',
    ],
    ['the bot itself', issuesOpened({ sender: BOT_LOGIN }), 'own-event'],
  ])(
    '%s → ignored %s with zero provider calls',
    async (_name, delivery, reason) => {
      const { issues, intake } = setup();

      await expect(intake.intake(storedEvent(delivery))).resolves.toEqual({
        outcome: 'ignored',
        reason,
      });
      expect(issues.calls).toEqual([]);
    },
  );
});

describe('IntakeService: log line', () => {
  it('one line per accepted event: delivery, event, action, sender, accepted TYPE and the issue', async () => {
    const { issues, intake, log } = setup();
    issues.setAccessLevel(HUMAN, 'approver');

    await intake.intake(
      storedEvent(issuesOpened({ number: 12 }), { deliveryId: 'd-1' }),
    );

    expect(lines(log)).toEqual([
      `delivery=d-1 event=issues action=opened sender=${HUMAN} accepted ISSUE_OPENED ${TARGET_REPO}#12`,
    ]);
  });

  it('one line per ignored event, with its reason', async () => {
    const { intake, log } = setup();

    await intake.intake(
      storedEvent(issuesOpened({ sender: 'octocat' }), { deliveryId: 'd-2' }),
    );
    await intake.intake(storedEvent(ping(), { deliveryId: 'd-3' }));

    expect(lines(log)).toEqual([
      'delivery=d-2 event=issues action=opened sender=octocat ignored unauthorized',
      'delivery=d-3 event=ping action=- sender=- ignored ping',
    ]);
  });

  it('a sender that is not a valid login is not written to the log', async () => {
    const { intake, log } = setup();
    const event = storedEvent(issuesOpened({ sender: 'x\ninjected line' }), {
      deliveryId: 'd-4',
    });

    await intake.intake(event);

    expect(lines(log)).toEqual([
      'delivery=d-4 event=issues action=opened sender=- ignored invalid-payload',
    ]);
  });
});
