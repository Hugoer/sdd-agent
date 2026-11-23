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
import { LlmError } from '../src/contracts/llm-error.js';
import {
  approveRefusedMarker,
  documentDeletedMarker,
  refreshMarker,
  refusedMarker,
  restoreMarker,
} from '../src/documents/document-comments.js';
import { issueClosedMarker } from '../src/workflow/workflow-comments.js';
import type { TaskDocument } from '../src/generated/prisma/client.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  SPEC_TEXT,
  actionRows,
  commentNow,
  documentRows,
  runAgain,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import {
  BOT_LOGIN,
  HUMAN,
  issueCommentDeleted,
} from './fixtures/github/payloads.js';
import { captureLogs, laneAdded } from './grill-helpers.js';
import { deliver, seedIssue, seedWorkflow } from './router-helpers.js';

// Spec 7 "Deleted documents and `/restore`" (SP9, SPW18, SPW23; plan P15, P21, P34): deletions (plan T21).

describe('Deleted documents (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const rows = async (kind: string) =>
    (await documentRows(t)).filter((row) => row.kind === kind);
  const explanations = (issue: TaskRef) =>
    withMarker(t, issue, 'sdd-agent:doc-deleted:');
  /** Someone deletes this bot comment: gone from the issue, then GitHub's event with its last text. */
  const deleteBotComment = (
    number: number,
    doc: Pick<TaskDocument, 'commentId' | 'body'>,
    body = doc.body,
  ) => {
    t.issues.deleteComment(doc.commentId!);
    return deliver(
      t,
      issueCommentDeleted({
        number,
        commentId: Number(doc.commentId),
        author: BOT_LOGIN,
        body,
      }),
    );
  };

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('Spec v1 edited, then deleted → ONE explanation naming who deleted it; its last text stored; the event run again posts no second one', async () => {
    const issue = await specWritten(t, 201);
    const [spec] = await rows('spec');
    const edited = spec.body.replace(
      'Split a bill evenly',
      'Split a bill evenly, in whole cents',
    );

    const event = await deleteBotComment(201, spec, edited);

    expect(event).toMatchObject({ status: 'DONE' });
    expect(explanations(issue)).toEqual([
      expect.objectContaining({
        body:
          `${documentDeletedMarker(spec.commentId!)}\nThe Spec comment (v1) was deleted by \`${HUMAN}\`, so ` +
          "there's nothing to approve. To get it back, comment `/restore`: the bot posts it again as it read when " +
          'it was deleted. To start over instead, remove the `workflow: full-sdd` label and add it again.',
      }),
    ]);
    const [deleted] = await rows('spec');
    expect(deleted).toMatchObject({ deletedBy: HUMAN });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedText).toContain(
      'Split a bill evenly, in whole cents',
    );
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        action: 'deleted',
        result: 'spec',
        documentId: spec.id,
        sourceCommentId: spec.commentId,
        sender: HUMAN,
        replyPostState: 'POSTED',
      }),
    ]);
    expect(logs).toContain(`#201 run 1 documents: spec v1 deleted by ${HUMAN}`);

    await runAgain(t, event.id);

    expect(explanations(issue)).toHaveLength(1);
    expect(await actionRows(t)).toHaveLength(1);
  });

  it('after the deletion: `/approve` → ONE "deleted" reply pointing to `/restore`; `/refresh` → SPW23\'s reply', async () => {
    const issue = await specWritten(t, 202);
    const [spec] = await rows('spec');
    await deleteBotComment(202, spec);

    await deliver(t, commentNow(202, 20201, '/approve'));
    await deliver(t, commentNow(202, 20202, '/refresh'));

    expect(
      withMarker(t, issue, approveRefusedMarker('20201'))[0].body,
    ).toContain(
      'has nothing to approve: Spec v1 was deleted. Comment `/restore` to get it back',
    );
    expect(withMarker(t, issue, refreshMarker('20202'))[0].body).toContain(
      'has nothing to refresh: Spec v1 was deleted. Comment `/restore` to get it back, then `/refresh`.',
    );
    expect(explanations(issue)).toHaveLength(1);
  });

  it("deleting the explanation, a person's comment, an older version → nothing posted", async () => {
    const issue = await specWritten(t, 203);
    const [spec] = await rows('spec');
    await deleteBotComment(203, spec);
    const [explanation] = explanations(issue);

    const again = await deliver(
      t,
      issueCommentDeleted({
        number: 203,
        commentId: Number(explanation.id),
        author: BOT_LOGIN,
        body: explanation.body,
      }),
    );
    const human = await deliver(
      t,
      issueCommentDeleted({
        number: 203,
        commentId: 20301,
        body: 'looks good',
      }),
    );

    expect(again).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(human).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'comment-deleted',
    });
    expect(explanations(issue)).toHaveLength(1);
    expect(await actionRows(t)).toHaveLength(1);
  });

  it('a Spec v1 that a refresh replaced, deleted → nothing posted (only the waiting version counts)', async () => {
    const issue = await specWritten(t, 204);
    const [v1] = await rows('spec');
    t.repo.seedFile('main', 'src/d204.ts', 'export const a = 1;\n');
    t.models.replyJson({
      upToDate: false,
      changes: ['Names `a`.'],
      document: SPEC_TEXT.replace('Split', 'Split with `a`'),
    });
    await deliver(t, commentNow(204, 20401, '/refresh'));
    expect(await rows('spec')).toHaveLength(2);

    const event = await deleteBotComment(204, v1);

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(explanations(issue)).toEqual([]);
    t.repo.removeFile('main', 'src/d204.ts');
  });

  it('the approved Spec deleted while the Plan waits, or the go-signal deleted → nothing posted', async () => {
    const issue = await specWritten(t, 205);
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(205, 20501, '/approve'));
    const [spec] = await rows('spec');

    const approved = await deleteBotComment(205, spec);

    expect(approved).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(explanations(issue)).toEqual([]);

    const codeOnly = seedIssue(t, 206, { labels: ['workflow: code-only'] });
    await deliver(t, laneAdded(206, 'code-only'));
    const [goSignal] = await rows('go-signal');

    const event = await deleteBotComment(206, goSignal);

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(explanations(codeOnly)).toEqual([]);
  });

  it('deleted while the run is stopped (a failed `/refresh`) → the explanation says to continue the run first', async () => {
    const issue = await specWritten(t, 207);
    const [spec] = await rows('spec');
    t.repo.seedFile('main', 'src/d207.ts', 'export const a = 1;\n');
    t.models.reply({
      error: new LlmError(
        'Google blocked the answer',
        'permanent',
        'answer-blocked',
      ),
    });
    await deliver(t, commentNow(207, 20701, '/refresh'));
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'needs-human',
    });

    await deleteBotComment(207, spec);

    expect(explanations(issue)[0].body).toMatch(
      /\n\nRun 1 is stopped: continue it first \(see the stop comment\), then comment `\/restore`\.$/,
    );
    t.repo.removeFile('main', 'src/d207.ts');
  });
});

// Spec 7 "`/restore`" (SP9, SPW18; plan P12, P24, P34, P35): plan T22.

describe('/restore (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const rows = async (kind: string) =>
    (await documentRows(t)).filter((row) => row.kind === kind);
  const specComments = (issue: TaskRef) =>
    withMarker(t, issue, 'sdd-agent:spec:');
  const deleteBotComment = (
    number: number,
    doc: Pick<TaskDocument, 'commentId' | 'body'>,
    body = doc.body,
  ) => {
    t.issues.deleteComment(doc.commentId!);
    return deliver(
      t,
      issueCommentDeleted({
        number,
        commentId: Number(doc.commentId),
        author: BOT_LOGIN,
        body,
      }),
    );
  };

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('edited, deleted, `/restore` → ONE "**Spec v1** (restored for …)" comment with the edit, "Restored as it read when it was deleted."; `/approve` → the Plan; NO model call for the restore', async () => {
    const issue = await specWritten(t, 211);
    const [v1] = await rows('spec');
    const edited = v1.body.replace(
      'Split a bill evenly',
      'Split a bill evenly, in whole cents',
    );
    await deleteBotComment(211, v1, edited);
    const calls = t.models.calls.length;

    const event = await deliver(t, commentNow(211, 21101, '/restore'));

    expect(event).toMatchObject({ status: 'DONE' });
    expect(t.models.calls).toHaveLength(calls);
    const [, restored] = await rows('spec');
    expect(restored).toMatchObject({
      version: 1,
      origin: 'restored',
      basedOnId: v1.id,
      commit: v1.commit,
      logId: null,
      notes: v1.notes,
      triggerCommentId: '21101',
      postState: 'POSTED',
    });
    expect(restored.text).toContain('Split a bill evenly, in whole cents');
    expect(restored.body).toContain(
      `**Spec v1** (restored for [\`${HUMAN}\`'s \`/restore\`](https://github.com/test-owner/test-repo/issues/211#issuecomment-21101)) · ` +
        `run 1 (\`full-sdd\`) · read at \`main\` @ \`${v1.commit!.slice(0, 7)}\`\n\nRestored as it read when it was deleted.\n\n` +
        'To change it, edit this comment.',
    );
    expect(specComments(issue)).toHaveLength(1);
    expect(await actionRows(t)).toContainEqual(
      expect.objectContaining({
        action: 'restore',
        result: 'restored',
        documentId: restored.id,
        replyBody: null,
      }),
    );
    expect(logs).toContain(
      '#211 run 1 documents: /restore → spec v1 restored (as deleted)',
    );

    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(211, 21102, '/approve'));

    expect((await rows('spec'))[1]).toMatchObject({ approvedBy: HUMAN });
    expect((await rows('spec'))[1].approvedText).toContain('in whole cents');
    expect(await rows('plan')).toHaveLength(1);
  });

  it('`/restore` with the comment there → ONE reply with its link; the restored comment deleted again → a new explanation; a retried `/restore` → no second comment (P34)', async () => {
    const issue = await specWritten(t, 212);
    const [v1] = await rows('spec');
    await deleteBotComment(212, v1);
    const restore = await deliver(t, commentNow(212, 21201, '/restore'));
    const [, restored] = await rows('spec');

    const again = await deliver(t, commentNow(212, 21202, '/restore'));

    expect(again).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'restore-refused',
    });
    expect(withMarker(t, issue, restoreMarker('21202'))).toEqual([
      expect.objectContaining({
        body:
          `${restoreMarker('21202')}\n${yours('`/restore`', 212, 21202)} has nothing to restore: Spec v1 is still ` +
          `on the issue ([link](${restored.commentUrl})).`,
      }),
    ]);

    await runAgain(t, restore.id);

    expect(specComments(issue)).toHaveLength(1);
    expect(withMarker(t, issue, restoreMarker('21201'))).toEqual([]);

    await deleteBotComment(212, restored);

    expect(
      withMarker(t, issue, documentDeletedMarker(restored.commentId!)),
    ).toHaveLength(1);
  });

  it('a deletion the bot missed → `/restore` posts its last version with the lost-edits line; the deletion recorded', async () => {
    const issue = await specWritten(t, 213);
    const [v1] = await rows('spec');
    t.issues.deleteComment(v1.commentId!);

    await deliver(t, commentNow(213, 21301, '/restore'));

    const [missed, restored] = await rows('spec');
    expect(missed.deletedAt).not.toBeNull();
    expect(restored.text).toBe(v1.text);
    expect(restored.body).toContain(
      '\n\nThe bot missed the deletion, so this is its last version: edits made to the deleted comment are lost.\n\n',
    );
    expect(await actionRows(t)).toMatchObject([
      { action: 'restore', result: 'restored-last-version' },
    ]);
    expect(specComments(issue)).toHaveLength(1);
  });

  it('the Plan waits and the approved Spec\'s comment is gone → `/restore` → ONE "already approved" reply', async () => {
    const issue = await specWritten(t, 214);
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(214, 21401, '/approve'));
    const [spec] = await rows('spec');
    t.issues.deleteComment(spec.commentId!);

    await deliver(t, commentNow(214, 21402, '/restore'));

    expect(withMarker(t, issue, restoreMarker('21402'))[0].body).toContain(
      'has nothing to restore: Spec v1 is already approved; the bot keeps the approved text.',
    );
    expect(await actionRows(t)).toContainEqual(
      expect.objectContaining({ action: 'restore', result: 'approved' }),
    );
  });

  it.each([
    [
      'grilling',
      "has nothing to restore: run 1 is still at Grill Me, so there's no Spec.",
    ],
    ['draft', 'has nothing to restore yet: run 1 is just starting.'],
    ['executing', 'has nothing to restore: the bot keeps the approved texts.'],
    ['in-review', 'has nothing to restore: the bot keeps the approved texts.'],
    [
      'needs-human',
      'has nothing to restore now: run 1 is stopped. Continue it first (see the stop comment), then comment `/restore`.',
    ],
  ] as const)(
    '`/restore` in %s → ONE reply, `IGNORED` `restore-refused`',
    async (status, text) => {
      const number =
        220 +
        ['grilling', 'draft', 'executing', 'in-review', 'needs-human'].indexOf(
          status,
        );
      const issue = await specWritten(t, number);
      await t.prisma.task.updateMany({ data: { status, shownStatus: status } });
      const commentId = number * 100 + 1;

      const event = await deliver(t, commentNow(number, commentId, '/restore'));

      expect(event).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'restore-refused',
      });
      expect(
        withMarker(t, issue, refusedMarker('restore', String(commentId)))[0]
          .body,
      ).toBe(
        `${refusedMarker('restore', String(commentId))}\n${yours('`/restore`', number, commentId)} ${text}`,
      );
    },
  );

  it("`code-only` → ONE reply; no run → ONE reply; closed → spec 5's reply", async () => {
    const codeOnly = seedIssue(t, 230, { labels: ['workflow: code-only'] });
    await deliver(t, laneAdded(230, 'code-only'));
    await deliver(t, commentNow(230, 23001, '/restore'));
    expect(
      withMarker(t, codeOnly, refusedMarker('restore', '23001'))[0].body,
    ).toContain(
      'has nothing to restore: a `code-only` run has no Spec or Plan.',
    );

    const noRun = seedIssue(t, 231);
    const refused = await deliver(t, commentNow(231, 23101, '/restore'));
    expect(refused).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'restore-refused',
    });
    expect(
      withMarker(t, noRun, refusedMarker('restore', '23101'))[0].body,
    ).toContain(
      'has nothing to restore: this issue has no run. To start one, add a `workflow:` label.',
    );

    const closed = await specWritten(t, 232);
    t.issues.setOpen(closed, false);
    const onClosed = await deliver(t, commentNow(232, 23201, '/restore'));
    expect(
      withMarker(t, closed, issueClosedMarker(onClosed.deliveryId))[0].body,
    ).toContain('This issue is closed, so `/restore` did nothing.');
  });
});
