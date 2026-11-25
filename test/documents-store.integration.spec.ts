import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.schema.js';
import {
  DocumentsStore,
  type ActionRecord,
  type DocumentKind,
  type VersionRecord,
} from '../src/documents/documents.store.js';
import { EventsService } from '../src/events/events.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RunService } from '../src/workflow/run.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from '../src/workflow/session-lease.service.js';
import { TaskService } from '../src/workflow/task.service.js';
import { LeaseLostError } from '../src/workflow/workflow-errors.js';
import { newDeliveryId } from './app.js';
import { resetDatabase } from './db.js';
import { testScanner } from './fakes/in-memory-context-loads.js';
import { testEnv } from './test-env.js';

// Spec 7 "Owned tables" through their only writer, under the lease (plan T2).

const OTHER_EVENT = '00000000-0000-4000-8000-0000000000ff';

describe('DocumentsStore (PostgreSQL)', () => {
  let prisma: PrismaService;
  let leases: SessionLeaseService;
  let tasks: TaskService;
  let runs: RunService;
  let store: DocumentsStore;
  let lease: HeldLease;
  let runId: string;

  const lost = (): HeldLease => ({ ...lease, eventId: OTHER_EVENT });
  const version = (
    kind: DocumentKind,
    number: number,
    data: Partial<VersionRecord> = {},
  ): VersionRecord => {
    const id = randomUUID();
    return {
      id,
      runId,
      kind,
      version: number,
      origin: 'written',
      commit:
        kind === 'go-signal'
          ? null
          : '4f2c1ab0000000000000000000000000000000aa',
      logId: kind === 'go-signal' ? null : randomUUID(),
      text: kind === 'go-signal' ? '' : `${kind} v${number}`,
      notes: ['Model: `gemini-4-carbon` (standard)'],
      body: `<!-- sdd-agent:${kind}:${id} -->\n${kind} v${number}`,
      ...data,
    };
  };
  const action = (data: Partial<ActionRecord> = {}): ActionRecord => ({
    id: randomUUID(),
    runId,
    documentId: null,
    action: 'approve-refused',
    result: 'before-document',
    sourceCommentId: '501',
    sender: 'bob',
    replyBody: '<!-- sdd-agent:approve-refused:501 -->\nreply',
    ...data,
  });
  const posted = (commentId: string) => ({
    commentId,
    commentUrl: `https://github.com/o/r/issues/12#issuecomment-${commentId}`,
    postedAt: new Date('2026-11-22T10:00:00Z'),
  });
  const approve = (id: string) =>
    prisma.taskDocument.update({
      where: { id },
      data: { approvedAt: new Date(), approvedBy: 'bob' },
    });
  const superseded = async (id: string) =>
    (await prisma.taskDocument.findUniqueOrThrow({ where: { id } }))
      .supersededAt !== null;

  beforeAll(async () => {
    const config = new ConfigService<Env, true>({
      DATABASE_URL: testEnv.DATABASE_URL,
      SESSION_LEASE_SECONDS: 120,
    });
    prisma = new PrismaService(config);
    await prisma.$connect();
    leases = new SessionLeaseService(prisma, config);
    tasks = new TaskService(prisma, leases);
    runs = new RunService(
      prisma,
      leases,
      new EventsService(prisma, testScanner()),
    );
    store = new DocumentsStore(prisma, leases);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const task = await tasks.findOrCreate({
      platform: 'GITHUB',
      id: '1012',
      externalRef: 'o/r#12',
    });
    const holder = await prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issue_comment',
        action: 'created',
        payload: {},
      },
    });
    lease = { taskId: task.id, eventId: holder.id };
    expect(await leases.claim(lease)).toBe(true);
    const run = await runs.create(lease, {
      lane: 'full-sdd',
      grillSkip: false,
      startEventId: holder.id,
    });
    runId = run.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('has the spec’s indexes', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename IN ('task_documents', 'document_actions') AND indexname NOT LIKE '%_pkey'
      ORDER BY indexname`;
    expect(
      rows.map((row) => row.indexdef.replace(/^.* ON public\./, '')),
    ).toEqual([
      'document_actions USING btree (action, source_comment_id)',
      'document_actions USING btree (run_id, created_at)',
      'task_documents USING btree (comment_id)',
      'task_documents USING btree (run_id, kind, trigger_comment_id)',
      'task_documents USING btree (run_id, kind, version)',
    ]);
  });

  it('Tx1 stores the version PENDING_POST with its full comment; Tx2 records the posted comment', async () => {
    const record = version('spec', 1);

    const row = await store.insertVersion(lease, record);
    expect(row).toMatchObject({
      ...record,
      taskId: lease.taskId,
      basedOnId: null,
      checkedCommit: null,
      changes: [],
      triggerCommentId: null,
      postState: 'PENDING_POST',
      commentId: null,
      postedAt: null,
      supersededAt: null,
      approvedAt: null,
      staleFiles: [],
      changedPaths: [],
      changedFiles: null,
    });
    expect(await store.pendingVersion(runId)).toEqual(row);

    const done = await store.markPosted(lease, record.id, posted('900'));
    expect(done).toMatchObject({ ...posted('900'), postState: 'POSTED' });
    expect(await store.pendingVersion(runId)).toBeNull();
    expect(await store.current(runId, 'spec')).toEqual(done);
  });

  it('a Spec v2 supersedes v1 (approved or not) and the Plan that waits', async () => {
    const spec1 = version('spec', 1);
    await store.insertVersion(lease, spec1);
    await approve(spec1.id);
    const plan1 = version('plan', 1, { basedOnId: spec1.id });
    await store.insertVersion(lease, plan1);

    const spec2 = version('spec', 2, {
      origin: 'refreshed',
      basedOnId: spec1.id,
      triggerCommentId: '777',
    });
    await store.insertVersion(lease, spec2);

    expect(await superseded(spec1.id)).toBe(true);
    expect(await superseded(plan1.id)).toBe(true);
    expect((await store.current(runId, 'spec'))?.id).toBe(spec2.id);
    expect(await store.current(runId, 'plan')).toBeNull();
  });

  it('a new Spec leaves an approved Plan current', async () => {
    const spec1 = version('spec', 1);
    await store.insertVersion(lease, spec1);
    const plan1 = version('plan', 1, { basedOnId: spec1.id });
    await store.insertVersion(lease, plan1);
    await approve(plan1.id);

    await store.insertVersion(lease, version('spec', 2));

    expect(await superseded(plan1.id)).toBe(false);
  });

  it('a Plan v2 supersedes Plan v1 only', async () => {
    const spec1 = version('spec', 1);
    await store.insertVersion(lease, spec1);
    await approve(spec1.id);
    const plan1 = version('plan', 1, { basedOnId: spec1.id });
    await store.insertVersion(lease, plan1);

    const plan2 = version('plan', 2, {
      origin: 'refreshed',
      basedOnId: plan1.id,
    });
    await store.insertVersion(lease, plan2);

    expect(await superseded(plan1.id)).toBe(true);
    expect(await superseded(spec1.id)).toBe(false);
    expect((await store.current(runId, 'spec'))?.id).toBe(spec1.id);
    expect((await store.current(runId, 'plan'))?.id).toBe(plan2.id);
  });

  it('a run has at most one current Spec and one current Plan', async () => {
    const spec1 = version('spec', 1);
    await store.insertVersion(lease, spec1);
    await store.insertVersion(
      lease,
      version('spec', 1, { origin: 'restored', basedOnId: spec1.id }),
    );
    await store.insertVersion(lease, version('plan', 1));
    await store.insertVersion(lease, version('plan', 2));
    await store.insertVersion(lease, version('spec', 2));
    await store.insertVersion(lease, version('plan', 3));

    const current = await prisma.taskDocument.groupBy({
      by: ['kind'],
      where: { runId, supersededAt: null },
      _count: true,
    });
    expect(current.map(({ kind, _count }) => [kind, _count]).sort()).toEqual([
      ['plan', 1],
      ['spec', 1],
    ]);
  });

  it('refuses a second version for the same /refresh or /restore of a kind; versionFor finds the first', async () => {
    const first = version('spec', 2, {
      origin: 'refreshed',
      triggerCommentId: '777',
    });
    await store.insertVersion(lease, first);

    await expect(
      store.insertVersion(
        lease,
        version('spec', 3, { origin: 'refreshed', triggerCommentId: '777' }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect((await store.versionFor(runId, 'spec', '777'))?.id).toBe(first.id);
    expect(await store.versionFor(runId, 'plan', '777')).toBeNull();
    // The same /refresh may make a Plan version, and versions with no trigger don't collide.
    await store.insertVersion(
      lease,
      version('plan', 2, { triggerCommentId: '777' }),
    );
    await store.insertVersion(lease, version('plan', 3));
  });

  it('stores an action with its reply PENDING_POST, then POSTED; one without a reply has no post state', async () => {
    const record = action();

    const row = await store.insertAction(lease, record);
    expect(row).toMatchObject({
      ...record,
      taskId: lease.taskId,
      eventId: lease.eventId,
      logIds: [],
      replyPostState: 'PENDING_POST',
      replyCommentId: null,
    });
    expect(
      await store.markReplyPosted(lease, record.id, {
        id: '901',
        url: 'https://github.com/o/r/issues/12#issuecomment-901',
        createdAt: new Date('2026-11-22T10:01:00Z'),
      }),
    ).toMatchObject({
      replyPostState: 'POSTED',
      replyCommentId: '901',
      replyCommentUrl: 'https://github.com/o/r/issues/12#issuecomment-901',
      replyPostedAt: new Date('2026-11-22T10:01:00Z'),
    });

    const refresh = await store.insertAction(
      lease,
      action({
        action: 'refresh',
        result: 'spec-changed',
        sourceCommentId: '777',
        logIds: [randomUUID()],
        replyBody: null,
      }),
    );
    expect(refresh.replyPostState).toBeNull();
  });

  it('refuses a second action for the same comment; actionFor finds the first, also one with no run', async () => {
    const first = action({ runId: null, result: 'no-run' });
    await store.insertAction(lease, first);

    await expect(
      store.insertAction(lease, action({ result: 'empty' })),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await store.actionFor('approve-refused', '501')).toMatchObject({
      id: first.id,
      runId: null,
    });
    expect(await store.actionFor('approve-hint', '501')).toBeNull();
    // Another action on the same comment is its own row.
    await store.insertAction(
      lease,
      action({ action: 'approve-hint', result: 'hint' }),
    );
  });

  describe('the question (spec 14)', () => {
    const B1 = 'b71e4d80000000000000000000000000000000b1';
    const B2 = 'b71e4d80000000000000000000000000000000b2';
    const question = (
      documentId: string,
      data: Partial<ActionRecord> = {},
    ): ActionRecord =>
      action({
        documentId,
        action: 'approve-asked',
        result: 'stale',
        fromCommit: '4f2c1ab0000000000000000000000000000000aa',
        toCommit: B1,
        files: [{ path: 'src/index.ts', readers: ['own'] }],
        changedFiles: 2,
        filesComplete: true,
        replyBody: '<!-- sdd-agent:approve-asked:501 -->\nquestion',
        ...data,
      });
    const askedCommit = async (id: string) =>
      (await prisma.taskDocument.findUniqueOrThrow({ where: { id } }))
        .askedCommit;

    it('ask stores asked_commit and the approve-asked row in one transaction; lastQuestion answers the newest', async () => {
      const spec1 = version('spec', 1);
      await store.insertVersion(lease, spec1);
      expect(await store.lastQuestion(spec1.id)).toBeNull();
      const first = question(spec1.id);

      const row = await store.ask(lease, spec1.id, B1, first);

      expect(row).toMatchObject({
        ...first,
        replyPostState: 'PENDING_POST',
        replyPostedAt: null,
      });
      expect(await askedCommit(spec1.id)).toBe(B1);
      expect((await store.lastQuestion(spec1.id))?.id).toBe(first.id);

      const second = question(spec1.id, {
        sourceCommentId: '502',
        fromCommit: B1,
        toCommit: B2,
      });
      await store.ask(lease, spec1.id, B2, second);
      expect(await askedCommit(spec1.id)).toBe(B2);
      expect((await store.lastQuestion(spec1.id))?.id).toBe(second.id);
    });

    it('a not-compared question stores no files, no counts', async () => {
      const spec1 = version('spec', 1);
      await store.insertVersion(lease, spec1);
      const record = question(spec1.id, {
        result: 'not-compared',
        files: [],
        changedFiles: null,
        filesComplete: null,
      });

      expect(await store.ask(lease, spec1.id, B1, record)).toMatchObject({
        files: [],
        changedFiles: null,
        filesComplete: null,
      });
    });

    it('writes neither without the lease; a second question for the same comment is refused, asked_commit unchanged', async () => {
      const spec1 = version('spec', 1);
      await store.insertVersion(lease, spec1);

      await expect(
        store.ask(lost(), spec1.id, B1, question(spec1.id)),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await askedCommit(spec1.id)).toBeNull();
      expect(await prisma.documentAction.count()).toBe(0);

      await store.ask(lease, spec1.id, B1, question(spec1.id));
      await expect(
        store.ask(lease, spec1.id, B2, question(spec1.id, { toCommit: B2 })),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await askedCommit(spec1.id)).toBe(B1);
    });

    it('a refresh that moves the starting point clears asked_commit (markUpToDate, finishRefresh with checked)', async () => {
      const spec1 = version('spec', 1);
      await store.insertVersion(lease, spec1);
      await store.ask(lease, spec1.id, B1, question(spec1.id));

      await store.markUpToDate(
        lease,
        spec1.id,
        B2,
        action({
          documentId: spec1.id,
          action: 'refresh',
          result: 'up-to-date',
          sourceCommentId: '777',
        }),
      );
      expect(
        await prisma.taskDocument.findUniqueOrThrow({
          where: { id: spec1.id },
        }),
      ).toMatchObject({ checkedCommit: B2, askedCommit: null });

      const plan1 = version('plan', 1, { basedOnId: spec1.id });
      await store.insertVersion(lease, plan1);
      await store.ask(
        lease,
        plan1.id,
        B1,
        question(plan1.id, { sourceCommentId: '503' }),
      );
      const refresh = await store.insertAction(
        lease,
        action({
          action: 'refresh',
          result: 'pending',
          sourceCommentId: '778',
          replyBody: null,
        }),
      );
      await store.finishRefresh(
        lease,
        refresh.id,
        {
          result: 'up-to-date',
          documentId: plan1.id,
          replyBody: 'both up to date',
          logIds: [],
        },
        { checked: { id: plan1.id, commit: B2 } },
      );
      expect(
        await prisma.taskDocument.findUniqueOrThrow({
          where: { id: plan1.id },
        }),
      ).toMatchObject({ checkedCommit: B2, askedCommit: null });
    });
  });

  it('writes nothing without the lease', async () => {
    const record = version('spec', 1);

    await expect(store.insertVersion(lost(), record)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(store.insertAction(lost(), action())).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await store.insertVersion(lease, record);
    await expect(
      store.markPosted(lost(), record.id, posted('900')),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await prisma.taskDocument.count()).toBe(1);
    expect(await prisma.documentAction.count()).toBe(0);
    expect((await store.pendingVersion(runId))?.id).toBe(record.id);
  });

  describe('waiting() by status (plan P15)', () => {
    let spec1: VersionRecord;
    let plan1: VersionRecord;

    beforeEach(async () => {
      spec1 = version('spec', 1);
      await store.insertVersion(lease, spec1);
      await approve(spec1.id);
      plan1 = version('plan', 1, { basedOnId: spec1.id });
      await store.insertVersion(lease, plan1);
    });

    it('spec-review → the current Spec, even when a Plan is posted', async () => {
      expect((await store.waiting(runId, 'spec-review', null))?.id).toBe(
        spec1.id,
      );
    });

    it('ready-for-dev → the current Plan', async () => {
      expect((await store.waiting(runId, 'ready-for-dev', null))?.id).toBe(
        plan1.id,
      );
    });

    it('needs-human → the one of the status before the stop', async () => {
      expect(
        (await store.waiting(runId, 'needs-human', 'ready-for-dev'))?.id,
      ).toBe(plan1.id);
      expect(
        (await store.waiting(runId, 'needs-human', 'spec-review'))?.id,
      ).toBe(spec1.id);
      expect(await store.waiting(runId, 'needs-human', 'grilling')).toBeNull();
      expect(await store.waiting(runId, 'needs-human', null)).toBeNull();
    });

    it('any other status → nothing waits', async () => {
      for (const status of [
        'draft',
        'grilling',
        'executing',
        'in-review',
      ] as const) {
        expect(await store.waiting(runId, status, null)).toBeNull();
      }
    });
  });

  it('waiting() in ready-for-dev → the go-signal of a code-only run', async () => {
    const goSignal = version('go-signal', 1);
    await store.insertVersion(lease, goSignal);

    expect((await store.waiting(runId, 'ready-for-dev', null))?.id).toBe(
      goSignal.id,
    );
  });
});
