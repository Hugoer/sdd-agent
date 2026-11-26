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
import type { TaskRef } from '../src/contracts/issue-provider.js';
import {
  approveRefusedMarker,
  refusedMarker,
} from '../src/documents/document-comments.js';
import { needsHumanMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  SPEC_TEXT,
  actionRows,
  commentNow,
  documentRows,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import { ProviderError } from '../src/contracts/provider-error.js';
import type { StepContext } from '../src/workflow/step-handler.registry.js';
import { ScriptedStepHandler } from './fakes/scripted-step-handler.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
} from './fixtures/github/payloads.js';
import {
  askedRound1,
  captureLogs,
  commented,
  grillAnswer,
  laneAdded,
} from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 13 (bot-feedback): the statuses (`plan-review`, `ready-for-dev` after every approval) and the working sign,
// through the router and the real handlers (plan FP20).

const OTHER = 'carol';

function approveBy(number: number, commentId: number, sender: string = HUMAN) {
  return issueCommentCreated({
    number,
    commentId,
    body: '/approve',
    sender,
    createdAt: new Date().toISOString(),
  });
}

describe('bot feedback: the statuses (spec 13)', () => {
  let t: TestApp;

  const task = () => t.prisma.task.findFirstOrThrow();
  const replies = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, approveRefusedMarker(String(commentId)));

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    t.issues.setAccessLevel(OTHER, 'approver');
    seedWorkflow(t.repo);
    captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  const statusLabels = () =>
    t.issues.calls
      .filter(({ method }) => method === 'setStatusLabel')
      .map(({ args }) => args[1]);
  const run = async () =>
    t.prisma.run.findUniqueOrThrow({
      where: { id: (await task()).currentRunId! },
    });

  /** `full-sdd`: Spec v1 approved, Plan v1 written (one scripted model reply). */
  async function planWritten(number: number) {
    const issue = await specWritten(t, number);
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, approveBy(number, number * 100 + 1));
    return issue;
  }

  /** Every approval in, the `workspace` stop cleared by SQL: `ready-for-dev` with no stop (BFW6's state). */
  async function readyWithoutStop() {
    await t.prisma.run.update({
      where: { id: (await task()).currentRunId! },
      data: { stoppedAt: null, statusBeforeStop: null },
    });
    await t.prisma.task.updateMany({
      data: { status: 'ready-for-dev', shownStatus: 'ready-for-dev' },
    });
  }

  it("full-sdd: the Spec's /approve → Plan v1 under plan-review (row 17)", async () => {
    await planWritten(41);

    expect(await task()).toMatchObject({
      status: 'plan-review',
      shownStatus: 'plan-review',
    });
    expect(statusLabels()).toContain('plan-review');
    expect(statusLabels()).not.toContain('ready-for-dev');
  });

  it("full-sdd: the Plan's /approve → ready-for-dev, then the workspace stop (before it ready-for-dev); /retry → the /approve again as done → the same stop, NO reply", async () => {
    const issue = await planWritten(42);
    t.issues.calls.length = 0;

    const approve = await deliver(t, approveBy(42, 4202));

    // The `workspace` step isn't built (spec 8): `step-not-built`, a failure, so the event ends FAILED.
    expect(approve).toMatchObject({ status: 'FAILED' });
    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
    });
    const { id: runId } = await run();
    expect(withMarker(t, issue, needsHumanMarker(runId, 1))).toHaveLength(1);
    t.issues.calls.length = 0;

    await deliver(t, commentNow(42, 4203, '/retry'));

    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
      stops: 2,
    });
    expect(replies(issue, 4202)).toEqual([]);
    expect(await actionRows(t)).toEqual([]);
  });

  it('spec-code: /approve → ready-for-dev, then the workspace stop; NO Plan (row 18)', async () => {
    await specWritten(t, 43, { lane: 'spec-code' });
    t.issues.calls.length = 0;

    await deliver(t, approveBy(43, 4301));

    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
    });
    expect((await documentRows(t)).map(({ kind }) => kind)).toEqual(['spec']);
  });

  it('ready-for-dev, every approval in: /approve by another person → "already approved" naming the Plan (full-sdd) (plan FP12)', async () => {
    const issue = await planWritten(44);
    await deliver(t, approveBy(44, 4402));
    await readyWithoutStop();

    const event = await deliver(t, approveBy(44, 4403, OTHER));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(replies(issue, 4403)).toEqual([
      expect.objectContaining({
        body: expect.stringContaining(
          `${yours('`/approve`', 44, 4403)} changes nothing: Plan v1 is already approved (by \`${HUMAN}\`).`,
        ) as string,
      }),
    ]);
  });

  it('ready-for-dev, every approval in: /approve by another person → "already approved" naming the Spec (spec-code) (plan FP12)', async () => {
    const issue = await specWritten(t, 45, { lane: 'spec-code' });
    await deliver(t, approveBy(45, 4501));
    await readyWithoutStop();

    const event = await deliver(t, approveBy(45, 4502, OTHER));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(replies(issue, 4502)).toEqual([
      expect.objectContaining({
        body: expect.stringContaining(
          `${yours('`/approve`', 45, 4502)} changes nothing: Spec v1 is already approved (by \`${HUMAN}\`).`,
        ) as string,
      }),
    ]);
    expect(await actionRows(t)).toMatchObject([
      { action: 'approve-refused', result: 'already-approved' },
    ]);
  });

  it("ready-for-dev, every approval in: /refresh, /restore → FP1's replies; a near-miss /approve → nothing (row 35)", async () => {
    const issue = await planWritten(46);
    await deliver(t, approveBy(46, 4602));
    await readyWithoutStop();
    const calls = t.models.calls.length;

    const refresh = await deliver(t, commentNow(46, 4603, '/refresh'));
    const restore = await deliver(t, commentNow(46, 4604, '/restore'));
    const nearMiss = await deliver(t, commentNow(46, 4605, '/approve please'));

    expect(refresh).toMatchObject({ ignoreReason: 'refresh-refused' });
    expect(restore).toMatchObject({ ignoreReason: 'restore-refused' });
    expect(nearMiss).toMatchObject({ ignoreReason: 'no-transition' });
    expect(
      withMarker(t, issue, refusedMarker('refresh', '4603'))[0].body,
    ).toContain(
      `${yours('`/refresh`', 46, 4603)} comes too late: every approval of run 1 is in, and the bot codes from the approved texts.`,
    );
    expect(
      withMarker(t, issue, refusedMarker('restore', '4604'))[0].body,
    ).toContain(
      `${yours('`/restore`', 46, 4604)} has nothing to restore: every approval of run 1 is in, and the bot keeps the approved texts.`,
    );
    expect(t.models.calls).toHaveLength(calls);
    expect(await task()).toMatchObject({ status: 'ready-for-dev' });
  });
});

describe('bot feedback: the working sign through the router (spec 13, scripted handlers)', () => {
  let t: TestApp;
  const grill = new ScriptedStepHandler();

  const transient = () => new ProviderError('Google answered 503', 'transient');
  const permanent = () =>
    new ProviderError('GitHub 403: no access', 'permanent', { status: 403 });
  const signCalls = () =>
    t.issues.calls
      .filter(({ method }) =>
        [
          'reactWorking',
          'setWorkingLabel',
          'setStatusLabel',
          'postComment',
        ].includes(method),
      )
      .map(({ method, args }) =>
        method === 'postComment' ? method : `${method} ${String(args[1])}`,
      );
  const mark = async () =>
    (await t.prisma.task.findFirstOrThrow()).workingEventId;
  const asks = (context: StepContext) =>
    t.issues
      .postComment(context.task.ref, 'Q1 …')
      .then(() => ({ type: 'ASKED' as const }));

  beforeAll(async () => {
    t = await startApp({ grill });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    grill.reset();
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    captureLogs();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  /** Issue `number` on `full-sdd`, asking: its run start posted questions (no sign: the script never calls it). */
  async function asking(number: number) {
    const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
    grill.then(asks);
    await deliver(t, issuesLabeled({ number, label: 'workflow: full-sdd' }));
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'grilling',
    });
    t.issues.calls.length = 0;
    return issue;
  }

  const answer = (number: number, commentId: number, body = 'A1: yes') =>
    issueCommentCreated({ number, commentId, body });

  it('working() twice in one job → one mark, one 🚀, one label; off after the comment and the status label; mark null', async () => {
    const issue = await asking(51);
    grill.then(async (context) => {
      await context.working();
      await context.working();
      return asks(context);
    });

    const event = await deliver(t, answer(51, 5101));

    expect(event).toMatchObject({ status: 'DONE' });
    expect(signCalls()).toEqual([
      'reactWorking 5101',
      'setWorkingLabel true',
      'postComment',
      'setStatusLabel grilling',
      'setWorkingLabel false',
    ]);
    expect(t.issues.reactionsOf(issue, '5101')).toEqual(['rocket']);
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      workingStartedAt: expect.any(Date) as Date,
      workingEndedAt: expect.any(Date) as Date,
    });
  });

  it('a run start (a label event) → the label only, no reaction', async () => {
    const issue = seedIssue(t, 52, { labels: ['workflow: full-sdd'] });
    grill.then(async (context) => {
      await context.working();
      return asks(context);
    });

    await deliver(
      t,
      issuesLabeled({ number: 52, label: 'workflow: full-sdd' }),
    );

    expect(
      signCalls().filter((call) => call.startsWith('reactWorking')),
    ).toEqual([]);
    expect(signCalls()).toContain('setWorkingLabel true');
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
  });

  it('a transient error after working() → the label stays; the retried attempt adds it again (FP2) and ends it: one removal', async () => {
    const issue = await asking(53);
    grill.then(
      async (context) => {
        await context.working();
        throw transient();
      },
      async (context) => {
        await context.working();
        return asks(context);
      },
    );

    const first = await deliver(t, answer(53, 5301));

    expect(first).toMatchObject({ status: 'PENDING' });
    expect(t.issues.labelsOf(issue)).toContain('bot: working');
    expect(await mark()).toBe(first.id);

    await drainDueNow(t);

    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
    const labels = signCalls().filter((call) =>
      call.startsWith('setWorkingLabel'),
    );
    expect(labels).toEqual([
      'setWorkingLabel true',
      'setWorkingLabel true',
      'setWorkingLabel false',
    ]);
  });

  it('a permanent error after working() → the stop comment and needs-human first, then the label off', async () => {
    const issue = await asking(54);
    grill.then(async (context) => {
      await context.working();
      throw permanent();
    });

    const event = await deliver(t, answer(54, 5401));

    expect(event).toMatchObject({ status: 'FAILED' });
    expect(signCalls()).toEqual([
      'reactWorking 5401',
      'setWorkingLabel true',
      'setStatusLabel needs-human',
      'postComment',
      'setWorkingLabel false',
    ]);
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({ workingEndedAt: expect.any(Date) as Date });
  });

  it('an attempt after working() that fails in intake (FAILED, no router mark) → the label off, mark null', async () => {
    const issue = await asking(55);
    grill.then(async (context) => {
      await context.working();
      throw transient();
    });
    const first = await deliver(t, answer(55, 5501));
    expect(t.issues.labelsOf(issue)).toContain('bot: working');

    for (let attempt = 2; attempt <= 3; attempt++) {
      t.issues.failNextOn('getAccessLevel', transient());
      await drainDueNow(t);
    }

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
  });

  it('an attempt after working() that intake ignores (the sender lost access) → the label off, mark null', async () => {
    const issue = await asking(56);
    grill.then(async (context) => {
      await context.working();
      throw transient();
    });
    const first = await deliver(t, answer(56, 5601));
    t.issues.setAccessLevel(HUMAN, 'none');

    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'IGNORED' });
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
  });

  it("the holder's removal fails → its outcome unchanged, the mark stays; the next event on the issue removes it first (BFW3)", async () => {
    const issue = await asking(57);
    grill.then(
      async (context) => {
        await context.working();
        // The end's removal (the next setWorkingLabel call) fails.
        t.issues.failNextOn('setWorkingLabel', transient());
        return asks(context);
      },
      () => Promise.resolve(),
    );
    const first = await deliver(t, answer(57, 5701));
    expect(first).toMatchObject({ status: 'DONE' });
    expect(t.issues.labelsOf(issue)).toContain('bot: working');
    expect(await mark()).toBe(first.id);
    t.issues.calls.length = 0;

    await deliver(t, answer(57, 5702, 'a plain remark'));

    expect(signCalls()[0]).toBe('setWorkingLabel false');
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await mark()).toBeNull();
  });

  it('/retry accepted → 🚀 on it before the status label; refused → no 🚀', async () => {
    const issue = await asking(58);
    grill.failNext(permanent());
    await deliver(t, answer(58, 5801));
    grill.then(asks);
    t.issues.calls.length = 0;

    await deliver(t, answer(58, 5802, '/retry'));

    expect(t.issues.reactionsOf(issue, '5802')).toEqual(['rocket']);
    const calls = signCalls();
    expect(calls.indexOf('reactWorking 5802')).toBeLessThan(
      calls.indexOf('setStatusLabel grilling'),
    );

    await deliver(t, answer(58, 5803, '/retry'));
    expect(t.issues.reactionsOf(issue, '5803')).toEqual([]);
  });
});

describe('bot feedback: the handlers call working() (spec 13 T11, real handlers, scripted model)', () => {
  let t: TestApp;

  /** The sign's calls since the last reset: `🚀 <comment>`, `label on`, `label off`. */
  const sign = () =>
    t.issues.calls
      .filter(({ method }) =>
        ['reactWorking', 'setWorkingLabel'].includes(method),
      )
      .map(({ method, args }) =>
        method === 'reactWorking'
          ? `🚀 ${String(args[1])}`
          : args[1]
            ? 'label on'
            : 'label off',
      );
  const times = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({
      where: { id },
      select: { workingStartedAt: true, workingEndedAt: true },
    });
  const bothTimes = {
    workingStartedAt: expect.any(Date) as Date,
    workingEndedAt: expect.any(Date) as Date,
  };
  const noTimes = { workingStartedAt: null, workingEndedAt: null };

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it("a run start (Grill's first evaluation) → the label on and off, no reaction; the times set", async () => {
    const issue = seedIssue(t, 61, { labels: ['workflow: full-sdd'] });
    t.models.replyJson(grillAnswer({ confidence: 50, questions: 2 }));

    const event = await deliver(t, laneAdded(61));

    expect(sign()).toEqual(['label on', 'label off']);
    expect(t.issues.labelsOf(issue)).not.toContain('bot: working');
    expect(await times(event.id)).toEqual(bothTimes);
  });

  it('a run start with grill: skip → the Spec: the label only', async () => {
    seedIssue(t, 62, { labels: ['workflow: full-sdd', 'grill: skip'] });
    t.models.reply({ answer: SPEC_TEXT });

    await deliver(t, laneAdded(62));

    expect(sign()).toEqual(['label on', 'label off']);
  });

  it('a Grill answer that ends Grill Me → 🚀 on it + the label, one sign for the evaluation and the Spec', async () => {
    const issue = await askedRound1(t, 63);
    t.issues.calls.length = 0;
    t.models
      .replyJson(grillAnswer({ confidence: 96 }))
      .reply({ answer: SPEC_TEXT });

    const event = await deliver(t, commented(63, 6301, 'Q1: yes. Q2: no.'));

    expect(sign()).toEqual(['🚀 6301', 'label on', 'label off']);
    expect(t.issues.reactionsOf(issue, '6301')).toEqual(['rocket']);
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'spec-review',
      workingEventId: null,
    });
    expect(await times(event.id)).toEqual(bothTimes);
  });

  it('a Grill answer that waits → 👀 and NO 🚀 at the end (BF8)', async () => {
    const issue = await askedRound1(t, 64, 3);
    t.issues.calls.length = 0;
    t.models.replyJson(grillAnswer({ confidence: 60, open: [2, 3] }));

    await deliver(t, commented(64, 6401, 'Q1: yes. The rest later.'));

    expect(sign()).toEqual(['🚀 6401', 'label on', 'label off']);
    expect(t.issues.reactionsOf(issue, '6401')).toEqual(['eyes']);
  });

  it("a burst of three answers → 🚀 on the event's comment only; the others read with it get none", async () => {
    const issue = await askedRound1(t, 65, 3);
    t.issues.calls.length = 0;
    t.models.replyJson(grillAnswer({ confidence: 70, questions: 1 }));
    const events = [];
    for (const [id, body] of [
      [6501, 'Q1: yes.'],
      [6502, 'Q2: no.'],
      [6503, 'Q3: twice.'],
    ] as const)
      events.push(await store(t, commented(65, id, body)));

    await t.worker.drainOnce();

    expect(t.issues.reactionsOf(issue, '6501')).toEqual(['rocket']);
    expect(t.issues.reactionsOf(issue, '6502')).toEqual([]);
    expect(t.issues.reactionsOf(issue, '6503')).toEqual([]);
    expect(sign()).toEqual(['🚀 6501', 'label on', 'label off']);
    expect(await times(events[0].id)).toEqual(bothTimes);
    expect(await times(events[1].id)).toEqual(noTimes);
  });

  it('grill: skip added while asking → the Spec with the label only', async () => {
    const issue = await askedRound1(t, 66);
    t.issues.calls.length = 0;
    t.issues.setHumanLabels(issue, ['workflow: full-sdd', 'grill: skip']);
    t.models.reply({ answer: SPEC_TEXT });

    await deliver(t, issuesLabeled({ number: 66, label: 'grill: skip' }));

    expect(sign()).toEqual(['label on', 'label off']);
  });

  it('/approve → the Plan: 🚀 + the label; the last /approve (the workspace stop) and a plain comment → NO sign', async () => {
    await specWritten(t, 67);
    t.issues.calls.length = 0;
    t.models.reply({ answer: PLAN_TEXT });

    const approve = await deliver(t, approveBy(67, 6701));

    expect(sign()).toEqual(['🚀 6701', 'label on', 'label off']);
    expect(await times(approve.id)).toEqual(bothTimes);
    t.issues.calls.length = 0;

    const comment = await deliver(t, commentNow(67, 6702, 'Looks good to me.'));
    const last = await deliver(t, approveBy(67, 6703));

    expect(last).toMatchObject({ status: 'FAILED' }); // the workspace step isn't built
    expect(sign()).toEqual([]);
    expect(await times(comment.id)).toEqual(noTimes);
    expect(await times(last.id)).toEqual(noTimes);
  });

  it('/refresh with main moved → 🚀 + the label; with main unmoved → NO sign', async () => {
    t.repo.seedFile('main', 'src/r68.ts', 'export const a = 1;\n');
    await specWritten(t, 68, { reads: ['src/r68.ts'] });
    t.issues.calls.length = 0;

    const unmoved = await deliver(t, commentNow(68, 6801, '/refresh'));
    expect(sign()).toEqual([]);
    expect(await times(unmoved.id)).toEqual(noTimes);

    t.repo.seedFile('main', 'src/other68.ts', 'export const b = 1;\n');
    t.models.replyJson({ upToDate: true, changes: [], document: '' });
    const moved = await deliver(t, commentNow(68, 6802, '/refresh'));

    expect(sign()).toEqual(['🚀 6802', 'label on', 'label off']);
    expect(await times(moved.id)).toEqual(bothTimes);
  });

  it("NO sign: spec 14's question, a refused /approve, /approve while grilling", async () => {
    t.repo.seedFile('main', 'src/r69.ts', 'export const a = 1;\n');
    await specWritten(t, 69, { reads: ['src/r69.ts'] });
    t.repo.seedFile('main', 'src/r69.ts', 'export const a = 2;\n');
    t.issues.calls.length = 0;

    const asked = await deliver(t, approveBy(69, 6901));
    expect(asked).toMatchObject({ ignoreReason: 'approve-asked' });
    const refused = await deliver(t, commentNow(69, 6902, '/approve', 600));
    expect(refused).toMatchObject({ ignoreReason: 'approve-refused' });

    await askedRound1(t, 70);
    t.issues.calls.length = 0;
    await deliver(t, approveBy(70, 7001));

    expect(sign()).toEqual([]);
  });

  it("a step-config stop before the call (the Plan's skill has no header) → the stop, NO sign", async () => {
    await specWritten(t, 71);
    t.repo.seedFile(
      'main',
      '.github-agent/skills/plan/SKILL.md',
      'No header.\n',
    );
    t.issues.calls.length = 0;

    const event = await deliver(t, approveBy(71, 7101));

    expect(event).toMatchObject({ status: 'FAILED' });
    expect(sign()).toEqual([]);
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'needs-human',
    });
  });
});
