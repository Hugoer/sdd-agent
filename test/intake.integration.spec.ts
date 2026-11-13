import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { Logger } from '@nestjs/common';
import { ProviderError } from '../src/contracts/provider-error.js';
import { resetDatabase } from './db.js';
import {
  newDeliveryId,
  postWebhook,
  startApp,
  waitFor,
  type TestApp,
} from './app.js';
import { InMemoryIssueProvider } from './fakes/in-memory-issue-provider.js';
import {
  HUMAN,
  TARGET_REPO,
  issueCommentCreated,
  issuesLabeled,
  issuesOpened,
  issuesUnlabeled,
  ping,
  pullRequestOpened,
  pullRequestSynchronize,
  type Delivery,
} from './fixtures/github/payloads.js';

// Spec 2: signed requests through the controller, the real worker drain, the fake provider.

describe('intake (signed webhooks → rows)', () => {
  let t: TestApp;

  /** Posts a signed delivery, drains the worker once, returns its row. */
  async function deliver(
    delivery: Delivery | { eventName: string; body: string },
  ) {
    const deliveryId = newDeliveryId();
    const body =
      'body' in delivery ? delivery.body : JSON.stringify(delivery.payload);
    const res = await postWebhook(t.baseUrl, body, {
      'x-github-event': delivery.eventName,
      'x-github-delivery': deliveryId,
    });
    expect(res.status).toBe(202);
    await t.worker.drainOnce();
    return t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
  }

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'none');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('issues.opened from an Approver → DONE, no comment, one lookup', async () => {
    t.issues.setAccessLevel(HUMAN, 'approver');

    const row = await deliver(issuesOpened({ number: 12 }));

    expect(row).toMatchObject({
      status: 'DONE',
      ignoreReason: null,
      attempts: 1,
      externalRef: `${TARGET_REPO}#12`,
    });
    expect(t.issues.calls.map((call) => call.method)).toEqual([
      'getAccessLevel',
    ]);
  });

  it('issues.opened from a Participant → DONE', async () => {
    t.issues.setAccessLevel(HUMAN, 'participant');
    expect(await deliver(issuesOpened())).toMatchObject({ status: 'DONE' });
  });

  it('issues.opened from a sender with no access → IGNORED unauthorized, nothing posted', async () => {
    const row = await deliver(issuesOpened({ sender: 'octocat' }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'unauthorized',
    });
    expect(t.issues.calls.map((call) => call.method)).toEqual([
      'getAccessLevel',
    ]);
  });

  it('another repo → IGNORED other-repo with zero provider calls', async () => {
    const row = await deliver(issuesOpened({ repo: 'someone/other-repo' }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'other-repo',
      externalRef: 'someone/other-repo#7',
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('a body without sender → IGNORED invalid-payload after one attempt', async () => {
    const row = await deliver({
      eventName: 'issues',
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: TARGET_REPO },
        issue: { id: 1, number: 7 },
      }),
    });

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'invalid-payload',
      attempts: 1,
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('only {"action":"opened"} → IGNORED invalid-payload, stored with no reference', async () => {
    const row = await deliver({
      eventName: 'issues',
      body: '{"action":"opened"}',
    });

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'invalid-payload',
      attempts: 1,
      externalRef: null,
    });
  });

  it('ping → IGNORED ping', async () => {
    expect(await deliver(ping())).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'ping',
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('an event the bot does not use → IGNORED unsupported-event', async () => {
    expect(
      await deliver({
        eventName: 'installation',
        body: '{"action":"created"}',
      }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'unsupported-event' });
  });

  describe('label events', () => {
    it.each(['approver', 'participant'] as const)(
      'an %s adds workflow: full-sdd → DONE; the issue keeps its labels; nothing posted',
      async (level) => {
        t.issues.setAccessLevel(HUMAN, level);
        const task = t.issues.seedIssue({
          number: 21,
          labels: ['workflow: full-sdd'],
        });

        const row = await deliver(
          issuesLabeled({ number: 21, label: 'workflow: full-sdd' }),
        );

        expect(row).toMatchObject({ status: 'DONE', ignoreReason: null });
        expect(t.issues.labelsOf(task)).toEqual(['workflow: full-sdd']);
        expect(t.issues.commentsOf(task)).toEqual([]);
        expect(t.issues.calls.map((call) => call.method)).toEqual([
          'getAccessLevel',
        ]);
      },
    );

    it('a sender with no access removes a lane label → IGNORED unauthorized, nothing changed', async () => {
      const task = t.issues.seedIssue({ number: 22, labels: ['bug'] });

      const row = await deliver(
        issuesUnlabeled({
          number: 22,
          label: 'workflow: code-only',
          sender: 'octocat',
        }),
      );

      expect(row).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'unauthorized',
      });
      expect(t.issues.labelsOf(task)).toEqual(['bug']);
      expect(t.issues.commentsOf(task)).toEqual([]);
    });

    it.each([
      [issuesLabeled({ label: 'bug' }), 'other-label'],
      [issuesLabeled({ label: 'status: grilling' }), 'status-label'],
      [issuesUnlabeled({ label: 'grill: skip' }), 'skip-removed'],
    ])('%# → IGNORED %s, no provider call', async (delivery, reason) => {
      expect(await deliver(delivery)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: reason,
      });
      expect(t.issues.calls).toEqual([]);
    });

    it('a sender with no access adds workflow: code-only → label removed, one comment, IGNORED label-reverted', async () => {
      const task = t.issues.seedIssue({
        number: 23,
        labels: ['workflow: code-only', 'bug'],
      });

      const row = await deliver(
        issuesLabeled({
          number: 23,
          label: 'workflow: code-only',
          sender: 'octocat',
        }),
      );

      expect(row).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'label-reverted',
        attempts: 1,
      });
      expect(t.issues.labelsOf(task)).toEqual(['bug']);
      expect(t.issues.commentsOf(task)).toEqual([
        expect.objectContaining({
          byBot: true,
          body: expect.stringContaining(
            'The `workflow: code-only` label was removed. It was added by `octocat`,',
          ) as string,
        }),
      ]);
    });

    it('postComment fails once → the retry removes the label again and ends with exactly one comment', async () => {
      const task = t.issues.seedIssue({
        number: 24,
        labels: ['grill: skip'],
      });
      vi.spyOn(t.issues, 'postComment').mockRejectedValueOnce(
        new ProviderError('GitHub POST … → 502: Bad Gateway', 'transient', {
          status: 502,
        }),
      );

      const first = await deliver(
        issuesLabeled({ number: 24, label: 'grill: skip', sender: 'octocat' }),
      );
      expect(first).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'GitHub POST … → 502: Bad Gateway',
      });
      expect(t.issues.labelsOf(task)).toEqual([]);
      expect(t.issues.commentsOf(task)).toEqual([]);

      await t.prisma.webhookEvent.update({
        where: { id: first.id },
        data: { availableAt: new Date(Date.now() - 1) },
      });
      await t.worker.drainOnce();

      expect(
        await t.prisma.webhookEvent.findUniqueOrThrow({
          where: { id: first.id },
        }),
      ).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'label-reverted',
        attempts: 2,
      });
      expect(t.issues.commentsOf(task)).toHaveLength(1);
      // The failing postComment is the spy's, so the fake did not record it.
      expect(t.issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
        'removeLabel',
        'findCommentByMarker',
        'getAccessLevel',
        'removeLabel',
        'findCommentByMarker',
        'postComment',
      ]);
    });
  });

  describe('model label events (spec 4)', () => {
    it('an Approver adds model: max-spec → IGNORED model-label, the label stays, nothing posted; removing it → model-label with no call', async () => {
      t.issues.setAccessLevel(HUMAN, 'approver');
      const task = t.issues.seedIssue({
        number: 71,
        labels: ['model: max-spec'],
      });

      const added = await deliver(
        issuesLabeled({ number: 71, label: 'model: max-spec' }),
      );

      expect(added).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'model-label',
        attempts: 1,
      });
      expect(t.issues.labelsOf(task)).toEqual(['model: max-spec']);
      expect(t.issues.commentsOf(task)).toEqual([]);
      expect(t.issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
      ]);

      t.issues.calls.length = 0;
      const removed = await deliver(
        issuesUnlabeled({ number: 71, label: 'model: max-spec' }),
      );
      expect(removed).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'model-label',
      });
      expect(t.issues.calls).toEqual([]);
    });

    it.each([
      ['octocat', 'none', 72],
      ['a-triager', 'participant', 73],
    ] as const)(
      '%s (%s) adds model: max-code twice → removed both times, exactly one comment, IGNORED label-reverted',
      async (sender, level, number) => {
        t.issues.setAccessLevel(sender, level);
        onTestFinished(() => t.issues.setAccessLevel(sender, 'none'));
        const labels = ['model: max-code', 'bug'];
        const task = t.issues.seedIssue({ number, labels });

        const first = await deliver(
          issuesLabeled({ number, label: 'model: max-code', sender }),
        );
        t.issues.seedIssue({ number, labels });
        const second = await deliver(
          issuesLabeled({ number, label: 'model: max-code', sender }),
        );

        for (const row of [first, second]) {
          expect(row).toMatchObject({
            status: 'IGNORED',
            ignoreReason: 'label-reverted',
            attempts: 1,
          });
        }
        expect(t.issues.labelsOf(task)).toEqual(['bug']);
        expect(t.issues.commentsOf(task)).toEqual([
          {
            id: expect.any(String) as string,
            byBot: true,
            body:
              '<!-- sdd-agent:label-revert:model-max-code -->\n' +
              `The \`model: max-code\` label was removed. It was added by \`${sender}\`, who is not allowed to ` +
              'choose the model on this repository (on GitHub that needs the Write role or higher).',
          },
        ]);
      },
    );

    it.each([
      [issuesLabeled({ label: 'model: turbo' }), 'other-label'],
      [issuesUnlabeled({ label: 'model: turbo' }), 'other-label'],
      [issuesUnlabeled({ label: 'Model: Max-Plan' }), 'model-label'],
    ])('%# → IGNORED %s, no provider call', async (delivery, reason) => {
      expect(await deliver(delivery)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: reason,
      });
      expect(t.issues.calls).toEqual([]);
    });
  });

  describe('comment events', () => {
    it('a Participant comments → DONE, nothing posted', async () => {
      t.issues.setAccessLevel(HUMAN, 'participant');
      const task = t.issues.seedIssue({ number: 31 });

      const row = await deliver(
        issueCommentCreated({ number: 31, body: 'looks fine' }),
      );

      expect(row).toMatchObject({
        status: 'DONE',
        externalRef: `${TARGET_REPO}#31`,
      });
      expect(t.issues.commentsOf(task)).toEqual([]);
    });

    it('an Approver comments /approve → DONE', async () => {
      t.issues.setAccessLevel(HUMAN, 'approver');

      expect(
        await deliver(issueCommentCreated({ number: 31, body: '/approve' })),
      ).toMatchObject({ status: 'DONE' });
    });

    it('/approve from a sender with no access → IGNORED unauthorized, no reply', async () => {
      const task = t.issues.seedIssue({ number: 32 });

      const row = await deliver(
        issueCommentCreated({
          number: 32,
          body: '/approve',
          sender: 'octocat',
        }),
      );

      expect(row).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'unauthorized',
      });
      expect(t.issues.commentsOf(task)).toEqual([]);
      expect(t.issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
      ]);
    });

    it('a comment on a pull request → IGNORED pr-comment, with the PR reference', async () => {
      expect(
        await deliver(
          issueCommentCreated({
            number: 15,
            body: '/approve',
            onPullRequest: true,
          }),
        ),
      ).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'pr-comment',
        externalRef: `${TARGET_REPO}#15`,
      });
      expect(t.issues.calls).toEqual([]);
    });

    it('the captured log never holds the comment text', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) => vi.spyOn(Logger.prototype, level),
      );
      t.issues.setAccessLevel(HUMAN, 'approver');

      await deliver(
        issueCommentCreated({
          number: 33,
          body: 'looks fine, unique-text-7f3a',
        }),
      );
      await deliver(
        issueCommentCreated({
          number: 33,
          body: 'by a stranger unique-text-7f3a',
          sender: 'octocat',
        }),
      );

      const logged = spies.flatMap((spy) =>
        spy.mock.calls.map((call) => JSON.stringify(call)),
      );
      expect(logged.some((line) => line.includes('accepted COMMENT'))).toBe(
        true,
      );
      expect(
        logged.filter((line) => line.includes('unique-text-7f3a')),
      ).toEqual([]);
    });

    it('a Participant comments /approve → one reply mentioning them, row IGNORED approve-denied', async () => {
      t.issues.setAccessLevel('pat', 'participant');
      const task = t.issues.seedIssue({ number: 34 });
      const delivery = issueCommentCreated({
        number: 34,
        body: '/approve',
        sender: 'pat',
        commentId: 555,
      });

      const row = await deliver(delivery);
      await deliver(delivery); // a second delivery of the same comment: no second reply

      expect(row).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'approve-denied',
      });
      expect(t.issues.commentsOf(task)).toEqual([
        expect.objectContaining({
          byBot: true,
          body: expect.stringMatching(
            /^<!-- sdd-agent:approve-denied:555 -->\n@pat `\/approve` needs write access/,
          ) as string,
        }),
      ]);
    });
  });

  describe('pull request events', () => {
    it('the bot opens its PR → DONE with zero provider calls; external_ref is the PR', async () => {
      const row = await deliver(pullRequestOpened({ number: 41 }));

      expect(row).toMatchObject({
        status: 'DONE',
        externalRef: `${TARGET_REPO}#41`,
      });
      expect(t.issues.calls).toEqual([]);
    });

    it('an Approver pushes to the bot PR → DONE after one lookup', async () => {
      t.issues.setAccessLevel(HUMAN, 'approver');
      expect(
        await deliver(pullRequestSynchronize({ number: 41, sender: HUMAN })),
      ).toMatchObject({ status: 'DONE' });
      expect(t.issues.calls.map((call) => call.method)).toEqual([
        'getAccessLevel',
      ]);
    });

    it('a PR opened by a human → IGNORED not-bot-pr; external_ref is the PR', async () => {
      expect(
        await deliver(pullRequestOpened({ number: 42, author: HUMAN })),
      ).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'not-bot-pr',
        externalRef: `${TARGET_REPO}#42`,
      });
      expect(t.issues.calls).toEqual([]);
    });
  });
});

describe('intake failure paths (spec 2 IA9, IA13)', () => {
  let t: TestApp;
  const unavailable = () =>
    new ProviderError('GitHub GET … → 503: Unavailable', 'transient', {
      status: 503,
    });

  function post(delivery: Delivery, deliveryId: string) {
    return postWebhook(t.baseUrl, JSON.stringify(delivery.payload), {
      'x-github-event': delivery.eventName,
      'x-github-delivery': deliveryId,
    });
  }
  const row = (deliveryId: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
  /** Drains, then makes a backed-off row due, `times` times. */
  async function drainWithRetries(deliveryId: string, times: number) {
    for (let i = 0; i < times; i++) {
      await t.worker.drainOnce();
      await t.prisma.webhookEvent.updateMany({
        where: { deliveryId, status: 'PENDING' },
        data: { availableAt: new Date(Date.now() - 1) },
      });
    }
  }

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('a transient error on every lookup → three attempts, then FAILED; never decided, nothing changed on the issue', async () => {
    vi.spyOn(t.issues, 'getAccessLevel').mockRejectedValue(unavailable());
    const task = t.issues.seedIssue({
      number: 51,
      labels: ['workflow: code-only'],
    });
    const deliveryId = newDeliveryId();
    await post(
      issuesLabeled({
        number: 51,
        label: 'workflow: code-only',
        sender: 'octocat',
      }),
      deliveryId,
    );

    await t.worker.drainOnce();
    expect(await row(deliveryId)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });
    await drainWithRetries(deliveryId, 3);

    expect(await row(deliveryId)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      ignoreReason: null,
      lastError: 'GitHub GET … → 503: Unavailable',
    });
    expect(t.issues.labelsOf(task)).toEqual(['workflow: code-only']);
    expect(t.issues.commentsOf(task)).toEqual([]);
    expect(t.issues.calls.map((call) => call.method)).toEqual([]); // only the failing spy ran
  });

  it('a redelivery of the FAILED row once GitHub answers → requeued, DONE with attempts 1; one more redelivery changes nothing', async () => {
    t.issues.setAccessLevel(HUMAN, 'approver');
    const lookup = vi
      .spyOn(t.issues, 'getAccessLevel')
      .mockRejectedValue(unavailable());
    const delivery = issuesLabeled({
      number: 52,
      label: 'workflow: code-only',
    });
    const deliveryId = newDeliveryId();
    await post(delivery, deliveryId);
    await drainWithRetries(deliveryId, 3);
    expect(await row(deliveryId)).toMatchObject({ status: 'FAILED' });

    lookup.mockRestore();
    expect((await post(delivery, deliveryId)).status).toBe(202);
    expect(await t.worker.drainOnce()).toBe(1);

    const done = await row(deliveryId);
    expect(done).toMatchObject({
      status: 'DONE',
      attempts: 1,
      lastError: 'GitHub GET … → 503: Unavailable', // kept as history
    });

    expect((await post(delivery, deliveryId)).status).toBe(202);
    expect(await t.worker.drainOnce()).toBe(0);
    expect(await row(deliveryId)).toEqual(done);
    expect(await t.prisma.webhookEvent.count()).toBe(1);
  });
});

describe('intake with the polling worker', () => {
  it('a signed labeled event from a sender with no access ends label-reverted with one comment', async () => {
    const issues = new InMemoryIssueProvider(TARGET_REPO);
    const task = issues.seedIssue({
      number: 61,
      labels: ['workflow: full-sdd'],
    });
    const t = await startApp({ pollingWorker: true, issues });
    try {
      const deliveryId = newDeliveryId();
      const delivery = issuesLabeled({
        number: 61,
        label: 'workflow: full-sdd',
        sender: 'octocat',
      });
      await postWebhook(t.baseUrl, JSON.stringify(delivery.payload), {
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
      });

      const reverted = await waitFor(() =>
        t.prisma.webhookEvent.findFirst({
          where: { deliveryId, status: 'IGNORED' },
        }),
      );
      expect(reverted.ignoreReason).toBe('label-reverted');
      expect(issues.labelsOf(task)).toEqual([]);
      expect(issues.commentsOf(task)).toHaveLength(1);
    } finally {
      await t.app.close();
    }
  });
});
