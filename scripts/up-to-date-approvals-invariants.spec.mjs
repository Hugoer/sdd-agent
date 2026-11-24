// Spec 14 (UAW11): each invariant of scripts/up-to-date-approvals-invariants.mjs over a clean fixture (all pass) and
// a fixture that breaks it (FAIL naming the issue and the row). Created 2026-11-24 for plan Task 8.
import { describe, expect, it } from 'vitest';
import {
  checkBeforeQuestion,
  checkNoWarnings,
  checkQuestions,
  checkStaleApprovals,
  markerOf,
  runChecks,
} from './up-to-date-approvals-invariants.mjs';

const REF = 'o/r#12';
const T = (minute, second = 0) =>
  `2026-11-24T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
const PLAN_BODY =
  '<!-- sdd-agent:plan:p1 -->\n**Plan v1** · run 1\n\nTo change it, edit this comment.\n\n<!-- sdd-agent:document -->\n# Plan ⚠️ in the text is fine\n<!-- sdd-agent:document-end -->';

/**
 * Issue #12: Spec v1 (s1), a read file changed. /approve 501 (10:01) → the question (10:02); /approve 502 (10:01:30,
 * before the question) → before-question (10:03); /approve 503 (10:04) counts, `stale_files` set. Plan v1 waits.
 */
function clean() {
  const comment = (id, body, minute, second = 0, bot = false) => ({
    number: 12,
    id,
    body,
    createdAt: T(minute, second),
    bot,
  });
  const action = (over) => ({
    external_ref: REF,
    document_id: 's1',
    reply_post_state: 'POSTED',
    ...over,
  });
  const documents = [
    {
      id: 's1',
      kind: 'spec',
      version: 1,
      external_ref: REF,
      approved_at: T(4, 1),
      approve_comment_id: '503',
      approved_commit: 'b1',
      approved_from_commit: 'a0',
      stale_files: ['src/index.ts'],
      changed_files: 1,
      changed_complete: true,
      body: '<!-- sdd-agent:spec:s1 -->',
    },
    {
      id: 'p1',
      kind: 'plan',
      version: 1,
      external_ref: REF,
      approved_at: null,
      body: PLAN_BODY,
    },
  ];
  const actions = [
    action({
      id: 'q1',
      action: 'approve-asked',
      result: 'stale',
      source_comment_id: '501',
      reply_posted_at: T(2),
      created_at: T(2),
    }),
    action({
      id: 'r1',
      action: 'approve-refused',
      result: 'before-question',
      source_comment_id: '502',
      reply_posted_at: T(3),
      created_at: T(3),
    }),
  ];
  return {
    allDocuments: documents,
    documents,
    allActions: actions,
    actions,
    threshold: 15,
    comments: [
      comment('501', '/approve', 1),
      comment('502', '/approve', 1, 30),
      comment('503', '/approve', 4),
      comment(
        '901',
        '<!-- sdd-agent:approve-asked:501 -->\nquestion',
        2,
        0,
        true,
      ),
      comment(
        '902',
        '<!-- sdd-agent:approve-refused:502 -->\nwritten before',
        3,
        0,
        true,
      ),
      comment('903', PLAN_BODY, 5, 0, true),
    ],
  };
}

describe('up-to-date-approvals invariants (spec 14)', () => {
  it('a clean run passes all four', () => {
    expect(runChecks(clean())).toHaveLength(4);
    for (const { failures } of runChecks(clean())) expect(failures).toEqual([]);
  });

  it('runChecks: invariants 1 and 4 read every row, so an issue left out of the list fails them', () => {
    const data = clean();
    // The issue left out: its rows stay in `allActions`, its rows and comments leave the scoped lists.
    data.actions = [];
    data.documents = [];
    data.comments = [];
    const failed = runChecks(data).filter(({ failures }) => failures.length);
    expect(failed.map(({ name }) => name[0])).toEqual(['1', '4']);
  });

  it('markerOf reads the key and the comment id', () => {
    expect(markerOf('<!-- sdd-agent:approve-asked:501 -->\nx')).toEqual({
      key: 'approve-asked',
      id: '501',
    });
    expect(markerOf('/approve')).toBeNull();
  });

  describe('1. every question answers an /approve that approved nothing, with no other reply, posted once', () => {
    it('the /approve also approved a document → FAIL', () => {
      const data = clean();
      data.allDocuments[0].approve_comment_id = '501';
      expect(checkQuestions({ ...data, documents: data.allDocuments })).toEqual(
        ['#12 question q1 (/approve 501): that /approve approved a document'],
      );
    });

    it('another reply to the same /approve (a row, a comment) → FAIL', () => {
      const data = clean();
      data.allActions.push({
        id: 'h1',
        action: 'approve-refused',
        result: 'already-approved',
        source_comment_id: '501',
        external_ref: REF,
      });
      data.comments.push({
        number: 12,
        id: '904',
        body: '<!-- sdd-agent:approve-refused:501 -->\nno',
        createdAt: T(6),
        bot: true,
      });
      expect(checkQuestions({ ...data, documents: data.allDocuments })).toEqual(
        [
          '#12 question q1 (/approve 501): also answered by approve-refused h1',
          '#12 question q1 (/approve 501): another reply, approve-refused comment 904',
        ],
      );
    });

    it('not posted, or posted twice, or not on the issues given (a wrong list) → FAIL', () => {
      const unposted = clean();
      unposted.allActions[0].reply_post_state = 'PENDING_POST';
      unposted.comments = unposted.comments.filter(({ id }) => id !== '901');
      expect(
        checkQuestions({ ...unposted, documents: unposted.allDocuments }),
      ).toEqual([
        '#12 question q1 (/approve 501): reply PENDING_POST',
        '#12 question q1 (/approve 501): 0 question comments',
      ]);
      const twice = clean();
      twice.comments.push({ ...twice.comments[3], id: '905' });
      expect(
        checkQuestions({ ...twice, documents: twice.allDocuments }),
      ).toEqual(['#12 question q1 (/approve 501): 2 question comments']);
      const wrongList = clean();
      wrongList.comments = [];
      expect(
        checkQuestions({ ...wrongList, documents: wrongList.allDocuments }),
      ).toEqual(['#12 question q1 (/approve 501): 0 question comments']);
    });
  });

  describe('2. every stale approval had a question posted before its /approve', () => {
    it('no question for the version → FAIL; the question posted after the /approve → FAIL', () => {
      const none = clean();
      none.actions = none.actions.filter(({ id }) => id !== 'q1');
      expect(checkStaleApprovals(none)).toEqual([
        '#12 spec v1 (row s1, stale_files src/index.ts): approved by /approve 503 with no question posted before it',
      ]);
      const late = clean();
      late.actions[0].reply_posted_at = T(4, 1);
      expect(checkStaleApprovals(late)).toHaveLength(1);
    });

    it('the same second counts', () => {
      const data = clean();
      data.actions[0].reply_posted_at = T(4);
      expect(checkStaleApprovals(data)).toEqual([]);
    });

    it('each reason: above the threshold, a cut list, not compared; at the threshold or the same commit → no question needed', () => {
      const approved = (over) => {
        const data = clean();
        data.actions = [];
        Object.assign(data.documents[0], { stale_files: [], ...over });
        return checkStaleApprovals(data);
      };
      expect(approved({ changed_files: 16 })[0]).toContain('16 changed files');
      expect(approved({ changed_complete: false })[0]).toContain('a cut list');
      expect(
        approved({ changed_complete: null, changed_files: null })[0],
      ).toContain('not compared');
      expect(approved({ changed_files: 15 })).toEqual([]);
      expect(
        approved({
          changed_complete: null,
          changed_files: null,
          approved_commit: 'a0',
        }),
      ).toEqual([]);
    });

    it('the approving /approve not on the issues given → FAIL', () => {
      const data = clean();
      data.comments = data.comments.filter(({ id }) => id !== '503');
      expect(checkStaleApprovals(data)).toEqual([
        "#12 spec v1 (row s1, stale_files src/index.ts): its /approve 503 isn't on the issues given",
      ]);
    });
  });

  describe('3. no approve-warning row, no ⚠️ line in a Plan header', () => {
    it('an approve-warning row, a ⚠️ header in a comment or a stored body → FAIL', () => {
      const data = clean();
      data.actions.push({
        id: 'w1',
        action: 'approve-warning',
        external_ref: REF,
      });
      const warned = PLAN_BODY.replace(
        'To change it',
        '⚠️ Since the Spec was written …\n\nTo change it',
      );
      data.comments[5].body = warned;
      data.documents[1].body = warned;
      expect(checkNoWarnings(data)).toEqual([
        '#12: approve-warning row w1',
        '#12: Plan comment 903 has a ⚠️ line',
        '#12 plan v1 (row p1): a ⚠️ line in its body',
      ]);
    });
  });

  describe('4. every before-question reply answers an /approve written before a question', () => {
    it('the /approve written after the question, or the question posted after the reply → FAIL', () => {
      const after = clean();
      after.comments[1].createdAt = T(2, 30);
      expect(
        checkBeforeQuestion({ ...after, actions: after.allActions }),
      ).toEqual([
        '#12 before-question r1 (/approve 502): no question of its version posted after the /approve and before the reply',
      ]);
      const late = clean();
      late.allActions[0].reply_posted_at = T(3, 30);
      expect(
        checkBeforeQuestion({ ...late, actions: late.allActions }),
      ).toHaveLength(1);
    });

    it('the /approve written in the same second as the question → FAIL (it counts as after)', () => {
      const data = clean();
      data.comments[1].createdAt = T(2);
      expect(
        checkBeforeQuestion({ ...data, actions: data.allActions }),
      ).toHaveLength(1);
    });

    it('a question of another version → FAIL', () => {
      const data = clean();
      data.allActions[0].document_id = 'p1';
      expect(
        checkBeforeQuestion({ ...data, actions: data.allActions }),
      ).toHaveLength(1);
    });
  });
});
