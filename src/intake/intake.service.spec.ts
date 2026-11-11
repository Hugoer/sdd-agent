import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import {
  BOT_LOGIN,
  HUMAN,
  TARGET_REPO,
  checkSuiteRequested,
  issuesClosed,
  issuesOpened,
  ping,
  storedEvent,
} from '../../test/fixtures/github/payloads.js';
import type { Env } from '../config/env.schema.js';
import type { AccessLevel } from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import { IntakeService } from './intake.service.js';

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
