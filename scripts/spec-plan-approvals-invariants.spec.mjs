// Spec 7 plan P11: each invariant of scripts/spec-plan-approvals-invariants.mjs over a clean fixture (all pass) and a
// fixture that breaks it (FAIL naming the issue and the row). Created 2026-11-23 for plan Task 24.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  checkApprovals,
  checkCalls,
  checkCanary,
  checkOneAnswer,
  checkSizes,
  checkVersionComments,
  checkWarnings,
  checkWorkspace,
  documentTextOf,
  markerOf,
  runChecks,
} from './spec-plan-approvals-invariants.mjs';

const REF = 'o/r#12';
const T = (minute, second = 0) =>
  `2026-11-23T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
const SPEC_BODY =
  '<!-- sdd-agent:spec:s1 -->\n**Spec v1** · run 1\n\n<!-- sdd-agent:document -->\n# Spec\n<!-- sdd-agent:document-end -->';
const PLAN_BODY =
  '<!-- sdd-agent:plan:p1 -->\n**Plan v1** · run 1\n\n<!-- sdd-agent:document -->\n# Plan\n<!-- sdd-agent:document-end -->';

/** One full-sdd run: Spec v1 refreshed (up to date), approved; Plan v1 approved with a warning; the workspace stop. */
function clean() {
  const doc = (over) => ({
    run_id: 'r1',
    version: 1,
    origin: 'written',
    post_state: 'POSTED',
    superseded_at: null,
    deleted_at: null,
    stale_files: [],
    changed_complete: null,
    trigger_comment_id: null,
    external_ref: REF,
    ...over,
  });
  const comment = (id, body, minute, second = 0, bot = false) => ({
    number: 12,
    id,
    body,
    createdAt: T(minute, second),
    updatedAt: T(minute, second),
    bot,
  });
  return {
    canary: 'PINEAPPLE',
    runs: [
      {
        id: 'r1',
        number: 1,
        lane: 'full-sdd',
        stop_step: 'workspace',
        external_ref: REF,
      },
    ],
    documents: [
      doc({
        id: 's1',
        kind: 'spec',
        comment_id: '100',
        posted_at: T(0),
        approved_at: T(1, 5),
        approve_comment_id: '102',
        body: SPEC_BODY,
        log_id: 'L1',
      }),
      doc({
        id: 'p1',
        kind: 'plan',
        comment_id: '110',
        posted_at: T(5),
        approved_at: T(6, 5),
        approve_comment_id: '111',
        stale_files: ['src/index.ts'],
        changed_complete: true,
        body: PLAN_BODY,
        log_id: 'L2',
      }),
    ],
    actions: [
      {
        id: 'a1',
        action: 'refresh',
        result: 'up-to-date',
        document_id: 's1',
        source_comment_id: '101',
        log_ids: ['L3'],
        external_ref: REF,
      },
      {
        id: 'a2',
        action: 'approve-warning',
        result: 'stale',
        document_id: 'p1',
        source_comment_id: '111',
        log_ids: [],
        external_ref: REF,
      },
    ],
    logs: [
      {
        id: 'L1',
        call_id: 'c1',
        turn: 1,
        status: 'SUCCESS',
        step: 'spec',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
      {
        id: 'L2',
        call_id: 'c2',
        turn: 2,
        status: 'SUCCESS',
        step: 'plan',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
      {
        id: 'L2a',
        call_id: 'c2',
        turn: 1,
        status: 'SUCCESS',
        step: 'plan',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
      {
        id: 'L3',
        call_id: 'c3',
        turn: 1,
        status: 'SUCCESS',
        step: 'spec',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
      {
        id: 'L4',
        call_id: 'c4',
        turn: 3,
        status: 'ERROR',
        step: 'spec',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
      {
        id: 'G1',
        call_id: 'g1',
        turn: 1,
        status: 'SUCCESS',
        step: 'grill',
        run_id: 'r1',
        external_ref: REF,
        prompt: '[]',
      },
    ],
    comments: [
      comment('100', SPEC_BODY, 0, 0, true),
      comment('101', '/refresh', 0, 30),
      comment('120', '<!-- sdd-agent:refresh:101 -->\nup to date', 0, 40, true),
      comment('102', '/approve', 1),
      comment('110', PLAN_BODY, 5, 0, true),
      comment('111', ' /APPROVE ', 6),
      comment(
        '121',
        '<!-- sdd-agent:approve-warning:p1 -->\nApproved Plan v1 …',
        6,
        10,
        true,
      ),
      comment(
        '122',
        '<!-- sdd-agent:needs-human:r1:1 -->\nstopped',
        6,
        20,
        true,
      ),
    ],
  };
}

describe('the marker and the document text', () => {
  it('reads a marker, also one with a suffix; none without', () => {
    expect(markerOf(SPEC_BODY)).toEqual({ key: 'spec', id: 's1' });
    expect(markerOf('<!-- sdd-agent:needs-human:r1:1 -->\nx')).toEqual({
      key: 'needs-human',
      id: 'r1',
    });
    expect(markerOf('/approve')).toBeNull();
  });

  it('takes the text between the markers', () => {
    expect(documentTextOf(SPEC_BODY)).toBe('# Spec');
  });
});

describe('the clean fixture', () => {
  it('passes every invariant', () => {
    expect(runChecks(clean()).filter((r) => r.failures.length > 0)).toEqual([]);
  });
});

describe('each invariant fails on a fixture that breaks it, naming the issue and the row', () => {
  it('1: a version posted twice, or with no comment, or a comment with no row', () => {
    const twice = clean();
    twice.comments.push({ ...twice.comments[0], id: '199' });
    expect(checkVersionComments(twice)).toEqual([
      '#12 spec v1 (row s1): 2 comments',
    ]);

    const lost = clean();
    lost.documents[0].approved_at = null;
    lost.comments = lost.comments.filter((c) => c.id !== '100');
    expect(checkVersionComments(lost)).toEqual([
      '#12 spec v1 (row s1): no comment',
    ]);

    const orphan = clean();
    orphan.comments.push({
      ...orphan.comments[0],
      id: '198',
      body: '<!-- sdd-agent:plan:p9 -->\nx',
    });
    expect(checkVersionComments(orphan)).toEqual([
      'comment 198 on #12: plan:p9 has no POSTED row',
    ]);
  });

  it("1: an unedited comment that isn't its stored body; an edited one is matched by its marker only", () => {
    const changed = clean();
    changed.comments[0] = {
      ...changed.comments[0],
      body: `${SPEC_BODY}\nextra`,
    };
    expect(checkVersionComments(changed)).toEqual([
      "#12 spec v1 (row s1): comment 100 isn't its stored body",
    ]);
    changed.comments[0].updatedAt = T(9);
    expect(checkVersionComments(changed)).toEqual([]);
  });

  it('2: an /approve written before its version; two approved Specs still current', () => {
    const early = clean();
    early.comments.find((c) => c.id === '102').createdAt =
      '2026-11-23T09:59:00Z';
    expect(checkApprovals(early)).toEqual([
      '#12 spec v1 (row s1): /approve 102 was written before the version',
    ]);

    const two = clean();
    two.documents.push({
      ...two.documents[0],
      id: 's2',
      version: 2,
      comment_id: '130',
      approve_comment_id: '102',
    });
    expect(checkApprovals(two)).toEqual([
      '#12: 2 approved specs still current (rows s1, s2)',
    ]);
  });

  it('3: two answers to one /refresh; two explanations for one deletion', () => {
    const twice = clean();
    twice.comments.push({ ...twice.comments[2], id: '197' });
    expect(checkOneAnswer(twice)).toEqual([
      '#12 /refresh 101: 2 answers (refresh reply 120; refresh reply 197)',
    ]);

    const deleted = clean();
    const explanation = {
      ...deleted.comments[2],
      body: '<!-- sdd-agent:doc-deleted:100 -->\nx',
    };
    deleted.comments.push(
      { ...explanation, id: '196' },
      { ...explanation, id: '195' },
    );
    expect(checkOneAnswer(deleted)).toEqual([
      '#12 deleted comment 100: 2 explanations',
    ]);
  });

  it('4: a warning on a full-sdd Spec, or stale with no stale files, or a warning comment with no row', () => {
    const onSpec = clean();
    Object.assign(onSpec.actions[1], {
      document_id: 's1',
      source_comment_id: '102',
    });
    expect(checkWarnings(onSpec)).toContain(
      "#12 warning a2: spec v1 isn't the last document before code",
    );

    const notStale = clean();
    notStale.documents[1].stale_files = [];
    expect(checkWarnings(notStale)).toEqual([
      '#12 warning a2: stale, but no stale files',
    ]);

    const orphan = clean();
    orphan.actions = orphan.actions.filter(
      (a) => a.action !== 'approve-warning',
    );
    expect(checkWarnings(orphan)).toEqual([
      'comment 121 on #12: a warning with no approve-warning row',
    ]);
  });

  it('5: the canary in a comment or a prompt', () => {
    const leaked = clean();
    leaked.comments[0].body += '\nPINEAPPLE';
    leaked.logs[0].prompt = '[{"text":"PINEAPPLE"}]';
    expect(checkCanary(leaked)).toEqual([
      'comment 100 on #12',
      'execution_logs L1 (#12, spec)',
    ]);
  });

  it('6: a Spec comment over 65,536 characters; a document over 50,000', () => {
    const big = clean();
    big.comments[0].body = SPEC_BODY.replace('# Spec', 'x'.repeat(50_001));
    expect(checkSizes(big)).toEqual([
      '#12 spec comment 100: its document has 50001 characters',
    ]);
    big.comments[0].body = `${SPEC_BODY}${'y'.repeat(65_600)}`;
    expect(checkSizes(big)).toEqual([
      `#12 spec comment 100: ${SPEC_BODY.length + 65_600} characters`,
    ]);
  });

  it("7: a successful Plan call with no version or /refresh row (a failed call and a Grill call don't count)", () => {
    const orphan = clean();
    orphan.documents[1].log_id = null;
    expect(checkCalls(orphan)).toEqual([
      '#12 plan call c2 (row L2): no version or /refresh row',
    ]);
  });

  it('8: the workspace step with the Plan not approved', () => {
    const early = clean();
    early.documents[1].approved_at = null;
    expect(checkWorkspace(early)).toEqual([
      '#12 run 1 (full-sdd): the workspace step ran with no approved plan',
    ]);
  });
});

describe('the script only reads', () => {
  it('no INSERT, UPDATE or DELETE; gh only with `api` and no method flag', async () => {
    const source = await readFile(
      new globalThis.URL(
        './spec-plan-approvals-invariants.mjs',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(source).not.toMatch(/--method|-X\b|['"]-f['"]|['"]-F['"]/);
  });
});
