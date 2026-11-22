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
import { specMarker } from '../src/documents/document-comments.js';
import { DocumentsStore } from '../src/documents/documents.store.js';
import { skippedMarker } from '../src/grill/grill-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  SPEC_TEXT,
  documentRows,
  specWritten,
  withMarker,
} from './documents-helpers.js';
import { HUMAN, issueCommentCreated } from './fixtures/github/payloads.js';
import {
  botComments,
  captureLogs,
  grillAnswer,
  grillRows,
  laneAdded,
} from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
} from './router-helpers.js';

// Spec 7 "Writing the Spec", "The document comment" (plan T9): Grill Me ends → Spec v1.

// Built at run time: no token-shaped literal in the repo.
const TOKEN = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');

describe('Writing the Spec (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const task = () => t.prisma.task.findFirstOrThrow();
  const run = () => t.prisma.run.findFirstOrThrow();

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

  it('Grill Me clear → exactly one Spec v1 comment, `status: spec-review`, its row written and POSTED at the base branch’s commit', async () => {
    const issue = await specWritten(t, 12);
    const commit = await t.repo.resolveRef('main');

    const [row] = await documentRows(t);
    const specs = withMarker(t, issue, 'sdd-agent:spec:');
    expect(specs).toHaveLength(1);
    expect(specs[0].body).toBe(row.body);
    expect(row).toMatchObject({
      kind: 'spec',
      version: 1,
      origin: 'written',
      postState: 'POSTED',
      commit,
      commentId: specs[0].id,
      text: SPEC_TEXT.trim(),
      supersededAt: null,
      approvedAt: null,
    });
    expect(row.notes[0]).toBe('Model: `gemini-4-hydrogen` (standard)');
    expect(row.body.startsWith(specMarker(row.id))).toBe(true);
    expect(row.body).toContain(
      `**Spec v1** · run 1 (\`full-sdd\`) · read at \`main\` @ \`${commit.slice(0, 7)}\``,
    );
    expect(row.body).toContain('the bot writes the Plan from the text');
    const log = await t.prisma.executionLog.findUniqueOrThrow({
      where: { id: row.logId! },
    });
    expect(log).toMatchObject({ step: 'spec', runId: (await run()).id });
    expect(await task()).toMatchObject({
      status: 'spec-review',
      shownStatus: 'spec-review',
    });
    expect(t.issues.labelsOf(issue)).toContain('status: spec-review');
    expect(logs).toContain(
      `#12 run 1 spec: v1 written (${commit.slice(0, 7)}, ${SPEC_TEXT.trim().length} characters)`,
    );
  });

  it('the Spec call offers the four tools and a text maximum; its frame names the lane’s next step', async () => {
    await specWritten(t, 13, { lane: 'spec-code' });

    const call = t.models.calls[1];
    expect(call).toMatchObject({
      tools: ['load_skill', 'load_file', 'list_files', 'read_file'],
      schema: false,
    });
    expect(call.messages[0].text).toContain(
      'the code is then written from the approved text, with no Plan in between',
    );
    expect(call.messages[1].text).toContain(
      'Grill Me: no questions were needed',
    );
    const [row] = await documentRows(t);
    expect(row.body).toContain('**Spec v1** · run 1 (`spec-code`)');
    expect(row.body).toContain('the bot starts coding from the text');
  });

  it('`grill: skip` at run start → the skipped comment, then Spec v1; its prompt says skipped', async () => {
    const issue = seedIssue(t, 14, {
      labels: ['workflow: full-sdd', 'grill: skip'],
    });
    t.models.reply({ answer: SPEC_TEXT });

    await deliver(t, laneAdded(14));

    const { session } = await grillRows(t);
    const comments = botComments(t, issue);
    expect(comments.map(({ body }) => body.split('\n')[0])).toEqual([
      skippedMarker(session!.id),
      specMarker((await documentRows(t))[0].id),
    ]);
    expect(t.models.calls).toHaveLength(1);
    expect(t.models.calls[0].messages[1].text).toContain(
      'Grill Me: skipped (grill: skip)',
    );
    expect(t.models.calls[0].messages[1].text).not.toContain('Answers');
    expect(await task()).toMatchObject({ status: 'spec-review' });
  });

  it('the questions and the answers reach the Spec’s prompt, the answers each in its own untrusted block', async () => {
    const issue = seedIssue(t, 15, { labels: ['workflow: full-sdd'] });
    t.models.replyJson(grillAnswer({ confidence: 50, questions: 1 }));
    await deliver(t, laneAdded(15));
    t.models
      .replyJson(grillAnswer({ confidence: 97 }))
      .reply({ answer: SPEC_TEXT });

    await deliver(
      t,
      issueCommentCreated({ number: 15, commentId: 1501, body: 'Q1: evenly.' }),
    );

    const prompt = t.models.calls[2].messages[1].text;
    expect(prompt).toContain(
      'Grill Me: the questions:\nQ1. Question 1?  Guess: Guess 1.',
    );
    expect(prompt).toMatch(
      new RegExp(
        `Answers, in the order they were written:\n\n<untrusted-data-[0-9a-f]{16} source="the comment by ${HUMAN}">\nQ1: evenly.`,
      ),
    );
    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(1);
  });

  it('the model’s text is cleaned (no marker, @name in backticks) and redacted, in the comment and in `text`', async () => {
    const issue = await specWritten(t, 16, {
      spec: `# Spec <!-- sdd-agent:plan:x -->\n\nAsk @alice.\n\n\`\`\`ts\n@Injectable()\n\`\`\`\n\nKey: ${TOKEN}\n`,
    });

    const [row] = await documentRows(t);
    expect(row.text).toBe(
      '# Spec \n\nAsk `@alice`.\n\n```ts\n@Injectable()\n```\n\nKey: [REDACTED: github-token]',
    );
    const [comment] = withMarker(t, issue, 'sdd-agent:spec:');
    expect(comment.body).toContain(row.text);
    expect(comment.body).not.toContain(TOKEN);
    expect(comment.body).not.toContain('sdd-agent:plan:');
  });

  it('posting fails once after Tx1 → retried: one comment from the stored body, one Spec call, the recovery logged', async () => {
    const issue = seedIssue(t, 17, { labels: ['workflow: full-sdd'] });
    t.models
      .replyJson(grillAnswer({ confidence: 96 }))
      .reply({ answer: SPEC_TEXT });
    // The first post is Grill Me's "no questions needed"; the second is the Spec.
    const post = t.issues.postComment.bind(t.issues);
    let posts = 0;
    vi.spyOn(t.issues, 'postComment').mockImplementation((ref, body) =>
      ++posts === 2
        ? Promise.reject(
            new ProviderError('GitHub POST comment → 502', 'transient'),
          )
        : post(ref, body),
    );

    const first = await deliver(t, laneAdded(17));
    expect(first).toMatchObject({ status: 'PENDING' });
    expect(await documentRows(t)).toMatchObject([
      { postState: 'PENDING_POST' },
    ]);
    await drainDueNow(t);

    expect(await event(first.id)).toMatchObject({ status: 'DONE' });
    const [row] = await documentRows(t);
    expect(row).toMatchObject({ postState: 'POSTED' });
    expect(withMarker(t, issue, specMarker(row.id))).toEqual([
      expect.objectContaining({ body: row.body }),
    ]);
    expect(t.models.calls).toHaveLength(2);
    expect(await task()).toMatchObject({ status: 'spec-review' });
    expect(logs).toContain('#17 run 1 spec: v1 posted (recovered)');
  });

  it('a crash after posting (Tx2 fails once) → the retry finds the marker and posts nothing more', async () => {
    const issue = seedIssue(t, 18, { labels: ['workflow: full-sdd'] });
    t.models
      .replyJson(grillAnswer({ confidence: 96 }))
      .reply({ answer: SPEC_TEXT });
    vi.spyOn(t.app.get(DocumentsStore), 'markPosted').mockRejectedValueOnce(
      new Error('Tx2 broke'),
    );

    const first = await deliver(t, laneAdded(18));
    expect(first).toMatchObject({ status: 'PENDING' });
    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(1);
    await drainDueNow(t);

    expect(await event(first.id)).toMatchObject({ status: 'DONE' });
    const specs = withMarker(t, issue, 'sdd-agent:spec:');
    expect(specs).toHaveLength(1);
    expect(await documentRows(t)).toMatchObject([
      { postState: 'POSTED', commentId: specs[0].id },
    ]);
    expect(t.models.calls).toHaveLength(2);
  });

  it('60,000 characters three times → the stop at step `spec` with the message for people; `/retry` with a short answer → one Spec v1', async () => {
    const issue = seedIssue(t, 19, { labels: ['workflow: full-sdd'] });
    const long = 'x'.repeat(60_000);
    t.models
      .replyJson(grillAnswer({ confidence: 96 }))
      .reply({ answer: long }, { answer: long }, { answer: long });

    const first = await deliver(t, laneAdded(19));

    expect(first).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({
      stopStep: 'spec',
      stopCause: 'invalid-answer',
      stopRetryable: true,
    });
    const stop = botComments(t, issue).at(-1)!.body;
    expect(stop).toContain(
      '⚠️ **Run 1 stopped at step `spec`:** model `gemini-4-hydrogen` answered with 60,000 characters, more ' +
        'than the 50,000 a document may have, also after 2 requests to shorten it. Adding `model: max-spec` ' +
        'before `/retry` may help. (`invalid-answer`)',
    );
    expect(await documentRows(t)).toEqual([]);

    t.models.reply({ answer: SPEC_TEXT });
    await deliver(
      t,
      issueCommentCreated({ number: 19, commentId: 1901, body: '/retry' }),
    );

    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(1);
    expect(await documentRows(t)).toMatchObject([
      { version: 1, postState: 'POSTED' },
    ]);
    expect(await task()).toMatchObject({ status: 'spec-review' });
    expect(t.models.calls).toHaveLength(5);
  });
});
