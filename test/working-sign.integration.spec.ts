import { Logger } from '@nestjs/common';
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
import { EventsService } from '../src/events/events.service.js';
import { SessionLeaseService } from '../src/workflow/session-lease.service.js';
import { TaskService } from '../src/workflow/task.service.js';
import {
  WorkingSignService,
  type SignTarget,
} from '../src/workflow/working-sign.service.js';
import { newDeliveryId, startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';

// Spec 13 (bot-feedback) BFW1–BFW3, plan FP6–FP8, T9: the sign's service alone, with the fake and the test database.

describe('WorkingSignService (spec 13)', () => {
  let t: TestApp;
  let sign: WorkingSignService;
  let number = 0;

  beforeAll(async () => {
    t = await startApp();
    sign = t.app.get(WorkingSignService);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  async function event(
    status: 'DONE' | 'FAILED' | 'PENDING' | 'PROCESSING' = 'PROCESSING',
  ) {
    return t.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issue_comment',
        action: 'created',
        payload: {},
        status,
        availableAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  /** An issue in the fake, its task row, and the lease held by `eventId`. */
  async function issue(eventId: string): Promise<SignTarget> {
    number++;
    const ref = t.issues.seedIssue({ number, labels: ['status: grilling'] });
    const task = await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: ref.id,
        externalRef: ref.externalRef,
        status: 'grilling',
        shownStatus: 'grilling',
      },
    });
    const lease = { taskId: task.id, eventId };
    expect(await t.app.get(SessionLeaseService).claim(lease)).toBe(true);
    return { lease, ref, tag: `#${number}` };
  }

  /** The same issue, the lease now held by another event. */
  async function handOver(target: SignTarget, eventId: string) {
    const leases = t.app.get(SessionLeaseService);
    await leases.release(target.lease);
    const lease = { taskId: target.lease.taskId, eventId };
    expect(await leases.claim(lease)).toBe(true);
    return { ...target, lease };
  }

  const markOf = async (target: SignTarget) =>
    (
      await t.prisma.task.findUniqueOrThrow({
        where: { id: target.lease.taskId },
      })
    ).workingEventId;
  const signCalls = () =>
    t.issues.calls
      .filter(({ method }) =>
        ['reactWorking', 'setWorkingLabel'].includes(method),
      )
      .map(({ method, args }) => `${method} ${String(args[1])}`);
  const times = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({
      where: { id },
      select: { workingStartedAt: true, workingEndedAt: true },
    });

  it('on → the mark, 🚀, the label, in that order; working_started_at set', async () => {
    const ev = await event();
    const target = await issue(ev.id);

    await sign.on(target, ev, '901');

    expect(await markOf(target)).toBe(ev.id);
    expect(signCalls()).toEqual(['reactWorking 901', 'setWorkingLabel true']);
    expect(t.issues.reactionsOf(target.ref, '901')).toEqual(['rocket']);
    expect(t.issues.labelsOf(target.ref)).toContain('bot: working');
    expect((await times(ev.id)).workingStartedAt).not.toBeNull();
  });

  it('no comment (a label event) → the mark and the label only', async () => {
    const ev = await event();
    const target = await issue(ev.id);

    await sign.on(target, ev, null);

    expect(signCalls()).toEqual(['setWorkingLabel true']);
  });

  it.each([
    ['the mark', 'nothing', null, []],
    ['🚀', 'a mark only', 'mark', ['reactWorking 902']],
    [
      'the label',
      'a mark and 🚀',
      'mark',
      ['reactWorking 902', 'setWorkingLabel true'],
    ],
  ] as const)(
    'a failure at %s leaves %s, and throws',
    async (step, _left, mark, calls) => {
      const ev = await event();
      const target = await issue(ev.id);
      const down = new ProviderError('GitHub down', 'transient');
      if (step === 'the mark')
        vi.spyOn(t.app.get(TaskService), 'markWorking').mockRejectedValueOnce(
          down,
        );
      if (step === '🚀') t.issues.failNextOn('reactWorking', down);
      if (step === 'the label') t.issues.failNextOn('setWorkingLabel', down);

      await expect(sign.on(target, ev, '902')).rejects.toBe(down);

      expect(await markOf(target)).toBe(mark ? ev.id : null);
      expect(signCalls()).toEqual(calls);
      expect(t.issues.labelsOf(target.ref)).not.toContain('bot: working');
    },
  );

  it('on twice (a retried attempt) → the label call each time, 🚀 once on the comment; working_started_at kept', async () => {
    const ev = await event();
    const target = await issue(ev.id);
    await sign.on(target, ev, '903');
    const started = (await times(ev.id)).workingStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await sign.on(target, ev, '903');

    expect(signCalls()).toEqual([
      'reactWorking 903',
      'setWorkingLabel true',
      'reactWorking 903',
      'setWorkingLabel true',
    ]);
    expect(t.issues.reactionsOf(target.ref, '903')).toEqual(['rocket']);
    expect((await times(ev.id)).workingStartedAt).toEqual(started);
  });

  it('on while another unfinished event holds the mark → 🚀 only, the mark unchanged (BFW2)', async () => {
    const first = await event('PENDING');
    const target = await issue(first.id);
    await sign.on(target, first, '904');
    const second = await event();
    const now = await handOver(target, second.id);
    t.issues.calls.length = 0;

    await sign.on(now, second, '905');

    expect(signCalls()).toEqual(['reactWorking 905']);
    expect(await markOf(now)).toBe(first.id);
  });

  it('end of the holder → the label removed, the mark null; end of a non-holder → nothing', async () => {
    const holder = await event();
    const target = await issue(holder.id);
    await sign.on(target, holder, '906');
    const other = await event();
    t.issues.calls.length = 0;

    await sign.end(target, other.id);
    expect(signCalls()).toEqual([]);
    expect(await markOf(target)).toBe(holder.id);

    await sign.end(target, holder.id);
    expect(signCalls()).toEqual(['setWorkingLabel false']);
    expect(t.issues.labelsOf(target.ref)).not.toContain('bot: working');
    expect(await markOf(target)).toBeNull();
  });

  it('end failing → one warning, the mark stays, no throw', async () => {
    const holder = await event();
    const target = await issue(holder.id);
    await sign.on(target, holder, null);
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    t.issues.failNextOn(
      'setWorkingLabel',
      new ProviderError('GitHub down', 'transient'),
    );

    await expect(sign.end(target, holder.id)).resolves.toBeUndefined();

    expect(await markOf(target)).toBe(holder.id);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      `${target.tag} working off failed: GitHub down`,
    ]);
  });

  it("pending: a finished or gone holder → removed; a PENDING holder → left; this event's own mark → left", async () => {
    const holder = await event('DONE');
    const target = await issue(holder.id);
    await sign.on(target, holder, null);
    const next = await event();
    const now = await handOver(target, next.id);
    t.issues.calls.length = 0;

    // A PENDING holder (between two tries) stays.
    await t.prisma.webhookEvent.update({
      where: { id: holder.id },
      data: { status: 'PENDING' },
    });
    await sign.pending(now, { workingEventId: holder.id }, next.id);
    expect(signCalls()).toEqual([]);
    // Its own mark stays.
    await sign.pending(now, { workingEventId: next.id }, next.id);
    expect(signCalls()).toEqual([]);

    await t.prisma.webhookEvent.update({
      where: { id: holder.id },
      data: { status: 'DONE' },
    });
    await sign.pending(now, { workingEventId: holder.id }, next.id);
    expect(signCalls()).toEqual(['setWorkingLabel false']);
    expect(await markOf(now)).toBeNull();
  });

  it('pending: a deleted holder ("gone") → removed', async () => {
    const holder = await event();
    const target = await issue(holder.id);
    await sign.on(target, holder, null);
    const next = await event();
    const now = await handOver(target, next.id);
    await t.prisma.webhookEvent.delete({ where: { id: holder.id } });

    await sign.pending(now, { workingEventId: holder.id }, next.id);

    expect(await markOf(now)).toBeNull();
    expect(t.issues.labelsOf(now.ref)).not.toContain('bot: working');
  });

  it('working_ended_at: written for an event that started, never for one that did not', async () => {
    const events = t.app.get(EventsService);
    const started = await event();
    const target = await issue(started.id);
    await sign.on(target, started, null);
    const idle = await event();

    await events.workingEnded(started.id);
    await events.workingEnded(idle.id);

    expect((await times(started.id)).workingEndedAt).not.toBeNull();
    expect(await times(idle.id)).toEqual({
      workingStartedAt: null,
      workingEndedAt: null,
    });
  });

  it('a /retry re-queue clears both times (plan FP3)', async () => {
    const ev = await event('FAILED');
    const target = await issue(ev.id);
    await sign.on(target, ev, null);
    await t.app.get(EventsService).workingEnded(ev.id);

    await t.app.get(EventsService).requeue(ev.id);

    expect(await times(ev.id)).toEqual({
      workingStartedAt: null,
      workingEndedAt: null,
    });
  });
});
