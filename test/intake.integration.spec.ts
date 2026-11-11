import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ProviderError } from '../src/contracts/provider-error.js';
import { resetDatabase } from './db.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import {
  HUMAN,
  TARGET_REPO,
  issuesLabeled,
  issuesOpened,
  issuesUnlabeled,
  ping,
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
});
