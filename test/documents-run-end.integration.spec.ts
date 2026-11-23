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
import { DocumentsHandler } from '../src/documents/documents.handler.js';
import type { CancelContext } from '../src/workflow/step-handler.registry.js';
import { runEndedMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  commentNow,
  documentRows,
  specWritten,
} from './documents-helpers.js';
import { HUMAN, issuesUnlabeled } from './fixtures/github/payloads.js';
import {
  botComments,
  captureLogs,
  grillAnswer,
  laneAdded,
} from './grill-helpers.js';
import { deliver, seedIssue, seedWorkflow } from './router-helpers.js';

// Spec 7 "When the run ends" (SPW10; plan P3): the line in spec 5's run-ended comment (plan T23).

describe('When the run ends (spec 7)', () => {
  let t: TestApp;

  const firstRun = () =>
    t.prisma.run.findFirstOrThrow({ orderBy: { number: 'asc' } });
  const ended = async (issue: TaskRef) => {
    const { id } = await firstRun();
    return botComments(t, issue)
      .map(({ body }) => body)
      .filter((body) => body.startsWith(runEndedMarker(id)));
  };
  const url = async (kind: string) =>
    (await documentRows(t)).find((row) => row.kind === kind)!.commentUrl!;

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

  it('Spec v1 waiting, the lane removed → the run-ended comment ends with the line, singular, "A new run"', async () => {
    const issue = await specWritten(t, 241);
    t.issues.setHumanLabels(issue, []);

    await deliver(
      t,
      issuesUnlabeled({ number: 241, label: 'workflow: full-sdd' }),
    );

    const [comment] = await ended(issue);
    expect(
      comment.endsWith(
        `[Spec v1](${await url('spec')}) belonged to run 1 and no longer counts. A new run doesn't use it: it ` +
          'works from the issue description and its own Grill Me answers. To keep anything from it, copy it into ' +
          'the description.',
      ),
    ).toBe(true);
  });

  it('a Plan waiting, the lane switched to spec-code → both linked, run 2 named', async () => {
    const issue = await specWritten(t, 242);
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(242, 24201, '/approve'));
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    t.models.replyJson(grillAnswer({ confidence: 50, questions: 1 }));

    await deliver(t, laneAdded(242, 'spec-code'));

    const [comment] = await ended(issue);
    expect(comment).toContain(
      `[Spec v1](${await url('spec')}) and [Plan v1](${await url('plan')}) belonged to run 1 and no longer ` +
        "count. Run 2 doesn't use them:",
    );
  });

  it('ended during Grill Me → no line', async () => {
    const issue = seedIssue(t, 243, { labels: ['workflow: full-sdd'] });
    t.models.replyJson(grillAnswer({ confidence: 50, questions: 1 }));
    await deliver(t, laneAdded(243));
    t.issues.setHumanLabels(issue, []);

    await deliver(
      t,
      issuesUnlabeled({ number: 243, label: 'workflow: full-sdd' }),
    );

    const [comment] = await ended(issue);
    expect(comment).toBeDefined();
    expect(comment).not.toContain('belonged to run');
  });

  it('the hook called twice → the same line; nothing written, no comment edited', async () => {
    const issue = await specWritten(t, 244);
    const run = await firstRun();
    const before = botComments(t, issue).map(({ body }) => body);
    const rows = await documentRows(t);
    const handler = t.app.get(DocumentsHandler);
    const context = {
      run: { id: run.id, number: run.number, lane: run.lane },
      end: { kind: 'cancelled' },
    } as unknown as CancelContext;

    const first = await handler.onCancel(context);
    const second = await handler.onCancel(context);

    expect(first).toContain('belonged to run 1');
    expect(second).toBe(first);
    expect(botComments(t, issue).map(({ body }) => body)).toEqual(before);
    expect(await documentRows(t)).toEqual(rows);
  });
});
