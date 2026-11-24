import { describe, expect, it } from 'vitest';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import {
  decide,
  isStale,
  type Action,
  type CurrentRun,
  type DecideInput,
  type RouterState,
} from './decide.js';

// Spec 5 RLW7: one named test per row of overview §3 (1–31), then the checks before the rows.

const T0 = new Date('2026-11-16T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const task: TaskRef = {
  platform: 'GITHUB',
  id: '1012',
  externalRef: 'o/r#12',
};
const base = { deliveryId: 'd-1', receivedAt: T0, sender: 'octocat' };
const comment = (body: string) => ({ id: '555', body, createdAt: T0 });

const ev = {
  opened: (): WorkflowInput => ({ ...base, type: 'ISSUE_OPENED', task }),
  added: (lane: Lane): WorkflowInput => ({
    ...base,
    type: 'LANE_ADDED',
    task,
    lane,
  }),
  removed: (lane: Lane): WorkflowInput => ({
    ...base,
    type: 'LANE_REMOVED',
    task,
    lane,
  }),
  skip: (): WorkflowInput => ({ ...base, type: 'SKIP_ADDED', task }),
  comment: (): WorkflowInput => ({
    ...base,
    type: 'COMMENT',
    task,
    comment: comment('looks fine'),
  }),
  approve: (): WorkflowInput => ({
    ...base,
    type: 'APPROVE',
    task,
    comment: comment('/approve'),
  }),
  retry: (receivedAt = later(60_000)): WorkflowInput => ({
    ...base,
    receivedAt,
    type: 'RETRY',
    task,
    comment: comment('/retry'),
  }),
  refresh: (): WorkflowInput => ({
    ...base,
    type: 'REFRESH',
    task,
    comment: comment('/refresh'),
  }),
  restore: (): WorkflowInput => ({
    ...base,
    type: 'RESTORE',
    task,
    comment: comment('/restore'),
  }),
  deleted: (): WorkflowInput => ({
    ...base,
    type: 'BOT_COMMENT_DELETED',
    task,
    comment: comment('<!-- sdd-agent:spec:x -->'),
  }),
  pr: (): WorkflowInput => ({
    ...base,
    type: 'PR_UPDATED',
    pr: { platform: 'GITHUB', repo: 'o/r', number: 40, url: 'u' },
    headSha: 'abc',
  }),
};

function runOf(over: Partial<CurrentRun> = {}): CurrentRun {
  return {
    id: 'run-2',
    number: 2,
    lane: 'full-sdd',
    grillSkip: false,
    startedByThisEvent: false,
    stop: null,
    ...over,
  };
}

function state(over: Partial<RouterState> = {}): RouterState {
  return {
    status: 'draft',
    shownStatus: null,
    runCount: 0,
    run: null,
    lanesOnIssue: [],
    grillSkipOnIssue: false,
    open: true,
    laneConflictLanes: [],
    approval: null,
    ...over,
  };
}

/** A state with a current run, in a run status. */
const running = (over: Partial<RouterState> = {}, run = runOf()) =>
  state({
    status: 'grilling',
    shownStatus: 'grilling',
    runCount: 2,
    lanesOnIssue: [run.lane],
    run,
    ...over,
  });

const stoppedAt = later(30_000);
const stopped = (retryable = true, cause = 'credits-exhausted') =>
  running(
    { status: 'needs-human', shownStatus: 'needs-human' },
    runOf({ stop: { retryable, at: stoppedAt, cause } }),
  );

const act = (s: RouterState, input: DecideInput): Action =>
  decide(s, input).action;
const ignored = (reason: string) => ({ kind: 'ignore', reason });

describe('decide(): overview §3 rows 1–31', () => {
  it('row 1: ISSUE_OPENED in draft, no label shown, no run so far → show status: draft (plan P6)', () => {
    expect(act(state(), ev.opened())).toEqual({ kind: 'label-draft' });
    // A row a lane-conflict event created first: still row 1.
    expect(
      act(state({ lanesOnIssue: ['full-sdd', 'code-only'] }), ev.opened()),
    ).toEqual({ kind: 'label-draft' });
  });

  it('row 2: draft, LANE_ADDED, exactly one lane label → start a run with it', () => {
    expect(
      act(state({ lanesOnIssue: ['spec-code'] }), ev.added('spec-code')),
    ).toEqual({ kind: 'start-run', lane: 'spec-code', grillSkip: false });
    expect(
      act(
        state({ lanesOnIssue: ['full-sdd'], grillSkipOnIssue: true }),
        ev.added('full-sdd'),
      ),
    ).toEqual({ kind: 'start-run', lane: 'full-sdd', grillSkip: true });
  });

  it('row 3: draft, LANE_ADDED, two or more lanes → lane-conflict, the reminder (draft wording)', () => {
    const decision = decide(
      state({ lanesOnIssue: ['full-sdd', 'code-only'] }),
      ev.added('code-only'),
    );

    expect(decision).toEqual({
      action: ignored('lane-conflict'),
      laneConflict: {
        kind: 'post',
        lanes: ['full-sdd', 'code-only'],
        still: false,
        run: null,
      },
    });
  });

  it('row 4: draft, LANE_REMOVED, exactly one lane left → start a run with it', () => {
    expect(
      act(state({ lanesOnIssue: ['full-sdd'] }), ev.removed('code-only')),
    ).toEqual({ kind: 'start-run', lane: 'full-sdd', grillSkip: false });
  });

  it('row 5: draft, anything else → ignored; an APPROVE → the gate’s reply without a run (spec 7, P36)', () => {
    const draft = state({ shownStatus: 'draft', runCount: 1 });
    for (const input of [
      ev.opened(), // a label already shown, or a run before (plan P6)
      ev.skip(),
      ev.comment(),
      ev.added('full-sdd'), // the label is gone again
      ev.removed('full-sdd'),
    ])
      expect(act(draft, input)).toEqual(ignored('no-transition'));
    expect(act(draft, ev.approve())).toEqual({ kind: 'reply-without-run' });
  });

  it('row 6: run state, LANE_REMOVED of the run lane → cancel; one lane left → restart with it', () => {
    expect(act(running({ lanesOnIssue: [] }), ev.removed('full-sdd'))).toEqual({
      kind: 'cancel',
      start: null,
    });
    expect(
      act(running({ lanesOnIssue: ['code-only'] }), ev.removed('full-sdd')),
    ).toEqual({
      kind: 'cancel',
      start: { lane: 'code-only', grillSkip: false },
    });
  });

  it('row 7: run state, LANE_ADDED of another lane, exactly one lane now → restart with it', () => {
    expect(
      act(running({ lanesOnIssue: ['spec-code'] }), ev.added('spec-code')),
    ).toEqual({
      kind: 'cancel',
      start: { lane: 'spec-code', grillSkip: false },
    });
  });

  it('row 8: run state, any other lane change → ignored, the run continues; two or more lanes → reminder (run wording)', () => {
    const twoLanes = decide(
      running({ lanesOnIssue: ['full-sdd', 'code-only'] }),
      ev.added('code-only'),
    );
    expect(twoLanes).toEqual({
      action: ignored('lane-conflict'),
      laneConflict: {
        kind: 'post',
        lanes: ['full-sdd', 'code-only'],
        still: false,
        run: { number: 2, lane: 'full-sdd' },
      },
    });
    expect(
      act(running({ lanesOnIssue: ['full-sdd'] }), ev.removed('code-only')),
    ).toEqual(ignored('no-transition'));
  });

  it('row 9: run start, full-sdd or spec-code, no grill: skip → grill start (its outcome decides)', () => {
    for (const lane of ['full-sdd', 'spec-code'] as const)
      expect(
        act(running({ status: 'draft' }, runOf({ lane })), {
          type: 'RUN_START',
        }),
      ).toEqual({
        kind: 'steps',
        calls: [{ handler: 'grill', op: 'start' }],
        statusFirst: null,
        statusAfter: null,
      });
  });

  it('row 10 (spec 6 GM15): run start with the label on the issue now, not stored on the run → the skip path', () => {
    for (const lane of ['full-sdd', 'spec-code'] as const)
      expect(
        act(
          running({ status: 'draft', grillSkipOnIssue: true }, runOf({ lane })),
          { type: 'RUN_START' },
        ),
      ).toEqual({
        kind: 'steps',
        calls: [
          { handler: 'grill', op: 'skip' },
          { handler: 'spec', op: 'generate' },
        ],
        statusFirst: null,
        statusAfter: 'spec-review',
      });
  });

  it('row 11 (spec 6): code-only ignores grill: skip on the issue too', () => {
    expect(
      act(
        running(
          { status: 'draft', grillSkipOnIssue: true },
          runOf({ lane: 'code-only' }),
        ),
        { type: 'RUN_START' },
      ),
    ).toMatchObject({ calls: [{ handler: 'go-signal', op: 'post' }] });
  });

  it('row 10: run start with grill: skip → grill skip, then the Spec → spec-review', () => {
    expect(
      act(
        running(
          { status: 'draft' },
          runOf({ lane: 'spec-code', grillSkip: true }),
        ),
        { type: 'RUN_START' },
      ),
    ).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'grill', op: 'skip' },
        { handler: 'spec', op: 'generate' },
      ],
      statusFirst: null,
      statusAfter: 'spec-review',
    });
  });

  it('row 11: run start, code-only → go-signal → ready-for-dev (skip ignored)', () => {
    expect(
      act(
        running(
          { status: 'draft' },
          runOf({ lane: 'code-only', grillSkip: true }),
        ),
        { type: 'RUN_START' },
      ),
    ).toEqual({
      kind: 'steps',
      calls: [{ handler: 'go-signal', op: 'post' }],
      statusFirst: null,
      statusAfter: 'ready-for-dev',
    });
  });

  it('row 12: Grill ASKED → grilling', () => {
    expect(act(running({ status: 'draft' }), { type: 'ASKED' })).toEqual({
      kind: 'set-status',
      status: 'grilling',
    });
  });

  it('row 13: Grill CLEAR → generate the Spec → spec-review', () => {
    expect(act(running(), { type: 'CLEAR' })).toEqual({
      kind: 'steps',
      calls: [{ handler: 'spec', op: 'generate' }],
      statusFirst: null,
      statusAfter: 'spec-review',
    });
  });

  it('row 14: Grill LIMIT → needs-human, not retryable, with the step body (plan P4)', () => {
    expect(act(running(), { type: 'LIMIT', body: 'Summary.' })).toEqual({
      kind: 'stop',
      stop: {
        kind: 'work-result',
        step: 'grill',
        cause: 'grill-limit',
        body: 'Summary.',
        retryable: false,
      },
    });
  });

  it('row 15: grilling, COMMENT → a Grill round', () => {
    expect(act(running(), ev.comment())).toEqual({
      kind: 'steps',
      calls: [{ handler: 'grill', op: 'round' }],
      statusFirst: null,
      statusAfter: null,
    });
  });

  it('row 15 (spec 6 GM15): grilling, COMMENT with grill: skip on the issue → grill skip, then the Spec', () => {
    expect(act(running({ grillSkipOnIssue: true }), ev.comment())).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'grill', op: 'skip' },
        { handler: 'spec', op: 'generate' },
      ],
      statusFirst: null,
      statusAfter: 'spec-review',
    });
  });

  it('row 16 (spec 6 GM8): grilling, APPROVE → the grill approve reply', () => {
    expect(act(running(), ev.approve())).toEqual({
      kind: 'steps',
      calls: [{ handler: 'grill', op: 'approve' }],
      statusFirst: null,
      statusAfter: null,
    });
    // An Approver's /approve while asking is answered by Grill Me; spec 7's gate isn't asked (approval null).
    expect(act(running({ approval: null }), ev.approve())).toMatchObject({
      calls: [{ handler: 'grill', op: 'approve' }],
    });
  });

  it('row 16 (spec 6 GM8, GM15): grilling, SKIP_ADDED with the label still on → grill skip, then the Spec', () => {
    expect(act(running({ grillSkipOnIssue: true }), ev.skip())).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'grill', op: 'skip' },
        { handler: 'spec', op: 'generate' },
      ],
      statusFirst: null,
      statusAfter: 'spec-review',
    });
  });

  it('row 16 (spec 6 plan P1): grilling, SKIP_ADDED with the label gone → read like a comment (grill round)', () => {
    expect(act(running(), ev.skip())).toEqual({
      kind: 'steps',
      calls: [{ handler: 'grill', op: 'round' }],
      statusFirst: null,
      statusAfter: null,
    });
  });

  it('row 17: spec-review (full-sdd), valid APPROVE → snapshot the Spec, generate the Plan → ready-for-dev', () => {
    expect(
      act(running({ status: 'spec-review', approval: 'valid' }), ev.approve()),
    ).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'spec', op: 'approve' },
        { handler: 'plan', op: 'generate' },
      ],
      statusFirst: null,
      statusAfter: 'ready-for-dev',
    });
  });

  it('row 18: spec-review (spec-code), valid APPROVE → snapshot the Spec, claim the workspace', () => {
    expect(
      act(
        running(
          { status: 'spec-review', approval: 'valid' },
          runOf({ lane: 'spec-code' }),
        ),
        ev.approve(),
      ),
    ).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'spec', op: 'approve' },
        { handler: 'workspace', op: 'claim' },
      ],
      statusFirst: null,
      statusAfter: null,
    });
  });

  it('row 19: ready-for-dev, valid APPROVE → full-sdd: the Plan, code-only: the go-signal; then claim', () => {
    expect(
      act(
        running({ status: 'ready-for-dev', approval: 'valid' }),
        ev.approve(),
      ),
    ).toEqual({
      kind: 'steps',
      calls: [
        { handler: 'plan', op: 'approve' },
        { handler: 'workspace', op: 'claim' },
      ],
      statusFirst: null,
      statusAfter: null,
    });
    expect(
      act(
        running(
          { status: 'ready-for-dev', approval: 'valid' },
          runOf({ lane: 'code-only' }),
        ),
        ev.approve(),
      ),
    ).toMatchObject({
      calls: [
        { handler: 'go-signal', op: 'approve' },
        { handler: 'workspace', op: 'claim' },
      ],
    });
  });

  it('row 20: spec-review, ready-for-dev: SKIP_ADDED → ignored; a COMMENT and an invalid APPROVE → the documents reply (spec 7)', () => {
    for (const status of ['spec-review', 'ready-for-dev'] as const) {
      expect(act(running({ status }), ev.comment())).toEqual({
        kind: 'steps',
        calls: [{ handler: 'documents', op: 'reply' }],
        statusFirst: null,
        statusAfter: null,
      });
      expect(act(running({ status }), ev.skip())).toEqual(
        ignored('no-transition'),
      );
      expect(
        act(running({ status, approval: 'before-document' }), ev.approve()),
      ).toEqual({
        kind: 'steps',
        calls: [{ handler: 'documents', op: 'reply' }],
        statusFirst: null,
        statusAfter: null,
      });
    }
  });

  describe('spec 7: the gate’s verdict on an APPROVE (R2, plan P27)', () => {
    for (const verdict of [
      'already-approved',
      'before-document',
      'deleted',
      'empty',
      'before-question',
    ] as const) {
      it(`${verdict} → one reply by the documents handler, no status change`, () => {
        for (const status of ['spec-review', 'ready-for-dev'] as const)
          expect(
            act(running({ status, approval: verdict }), ev.approve()),
          ).toEqual({
            kind: 'steps',
            calls: [{ handler: 'documents', op: 'reply' }],
            statusFirst: null,
            statusAfter: null,
          });
      });
    }

    it('done → steps with no calls: the event ends DONE, nothing posted (P27)', () => {
      for (const status of ['spec-review', 'ready-for-dev'] as const)
        expect(
          act(running({ status, approval: 'done' }), ev.approve()),
        ).toEqual({
          kind: 'steps',
          calls: [],
          statusFirst: null,
          statusAfter: null,
        });
    });

    it('an APPROVE in review with no verdict is a wiring error', () => {
      expect(() =>
        act(running({ status: 'spec-review' }), ev.approve()),
      ).toThrow('without the gate’s verdict');
    });
  });

  it('row 21: workspace WS_BUSY → wait for the workspace (spec 8)', () => {
    expect(
      act(running({ status: 'spec-review' }), { type: 'WS_BUSY' }),
    ).toEqual({ kind: 'wait-workspace' });
  });

  it('row 22: workspace WS_DIRTY → needs-human with the step body (spec 8 decides retryable)', () => {
    expect(
      act(running({ status: 'ready-for-dev' }), {
        type: 'WS_DIRTY',
        body: 'Dirty.',
      }),
    ).toEqual({
      kind: 'stop',
      stop: {
        kind: 'work-result',
        step: 'workspace',
        cause: 'workspace-dirty',
        body: 'Dirty.',
        retryable: false,
      },
    });
  });

  it('row 23: workspace WS_CLAIMED → executing, then the Coder job', () => {
    expect(
      act(running({ status: 'ready-for-dev' }), { type: 'WS_CLAIMED' }),
    ).toEqual({
      kind: 'steps',
      calls: [{ handler: 'code', op: 'start' }],
      statusFirst: 'executing',
      statusAfter: null,
    });
  });

  it('row 24: executing, GREEN → in-review', () => {
    expect(act(running({ status: 'executing' }), { type: 'GREEN' })).toEqual({
      kind: 'set-status',
      status: 'in-review',
    });
  });

  it('row 25: executing, RED → needs-human, not retryable, with the step body', () => {
    expect(
      act(running({ status: 'executing' }), { type: 'RED', body: 'Red.' }),
    ).toEqual({
      kind: 'stop',
      stop: {
        kind: 'work-result',
        step: 'code',
        cause: 'coder-red',
        body: 'Red.',
        retryable: false,
      },
    });
  });

  it('row 26: executing, INTERRUPTED → PR opened: in-review; otherwise needs-human with the body', () => {
    const executing = running({ status: 'executing' });
    expect(act(executing, { type: 'INTERRUPTED', prOpened: true })).toEqual({
      kind: 'set-status',
      status: 'in-review',
    });
    expect(
      act(executing, { type: 'INTERRUPTED', prOpened: false, body: 'Cut.' }),
    ).toEqual({
      kind: 'stop',
      stop: {
        kind: 'work-result',
        step: 'code',
        cause: 'coder-interrupted',
        body: 'Cut.',
        retryable: false,
      },
    });
  });

  it('row 27: in-review, needs-human: COMMENT, SKIP_ADDED → ignored; APPROVE → the documents reply (row 36; also executing, draft with a run)', () => {
    for (const s of [
      running({ status: 'in-review' }),
      stopped(),
      running({ status: 'executing' }),
      running({ status: 'draft', shownStatus: 'draft' }),
    ]) {
      for (const input of [ev.comment(), ev.skip()])
        expect(act(s, input)).toEqual(ignored('no-transition'));
      expect(act(s, ev.approve())).toEqual({
        kind: 'steps',
        calls: [{ handler: 'documents', op: 'reply' }],
        statusFirst: null,
        statusAfter: null,
      });
    }
  });

  it('row 28: FAILED with a running run → needs-human, retryable, the step and cause', () => {
    expect(
      act(running({ status: 'spec-review' }), {
        type: 'FAILED',
        cause: 'credits-exhausted',
        message: 'Google says the credits are used up',
        step: 'plan',
        retry: false,
        stale: false,
      }),
    ).toEqual({
      kind: 'stop',
      stop: {
        kind: 'failure',
        step: 'plan',
        cause: 'credits-exhausted',
        message: 'Google says the credits are used up',
        retryable: true,
      },
    });
  });

  it('row 28: never without a running run, for a /retry (RL13) or a stale event (plan P2): stays FAILED', () => {
    const failed = (retry: boolean, stale: boolean): DecideInput => ({
      type: 'FAILED',
      cause: 'provider-error',
      message: 'm',
      step: 'grill',
      retry,
      stale,
    });
    for (const [s, input] of [
      [state(), failed(false, false)],
      [stopped(), failed(false, false)],
      [running(), failed(true, false)],
      [running(), failed(false, true)],
    ] as const)
      expect(act(s, input)).toEqual({ kind: 'stay-failed' });
  });

  it('row 29: PR_UPDATED with a run → Quality Gate, status unchanged', () => {
    expect(act(running({ status: 'in-review' }), ev.pr())).toEqual({
      kind: 'steps',
      calls: [{ handler: 'qualityGate', op: 'review' }],
      statusFirst: null,
      statusAfter: null,
    });
    expect(decide(running(), ev.pr()).laneConflict).toBeNull();
  });

  it('row 30: needs-human after a failure, RETRY received after the stop → accept', () => {
    expect(act(stopped(), ev.retry(later(30_001)))).toEqual({
      kind: 'accept-retry',
    });
  });

  it('row 31: needs-human as a result of the work, RETRY → the restart reply', () => {
    expect(act(stopped(false, 'grill-limit'), ev.retry())).toEqual({
      kind: 'reply-retry',
      refusal: {
        kind: 'work-result',
        run: { id: 'run-2', number: 2, lane: 'full-sdd' },
        reason: 'the Grill round limit was reached',
      },
    });
  });
});

describe('decide(): spec 7 seam (plan T7)', () => {
  it('a step outcome IGNORED → the event ends IGNORED with that reason (plan P6)', () => {
    for (const reason of [
      'approve-refused',
      'approve-asked',
      'approve-hint',
      'late-comment',
      'refresh-refused',
      'restore-refused',
      'no-transition',
    ] as const) {
      expect(
        act(running({ status: 'spec-review' }), { type: 'IGNORED', reason }),
      ).toEqual(ignored(reason));
    }
  });

  it('SPEC_REFRESHED → set-status spec-review (row 32)', () => {
    expect(
      act(running({ status: 'ready-for-dev' }), { type: 'SPEC_REFRESHED' }),
    ).toEqual({ kind: 'set-status', status: 'spec-review' });
  });

  it('a deleted bot comment on a closed issue → ignored issue-closed (plan P21)', () => {
    expect(
      act(running({ status: 'spec-review', open: false }), ev.deleted()),
    ).toEqual(ignored('issue-closed'));
  });
});

describe('decide(): a deleted bot comment (spec 7 row 33, D30)', () => {
  const deleted = {
    kind: 'steps',
    calls: [{ handler: 'documents', op: 'deleted' }],
    statusFirst: null,
    statusAfter: null,
  };

  it('spec-review, ready-for-dev, needs-human → the documents handler checks it', () => {
    for (const status of [
      'spec-review',
      'ready-for-dev',
      'needs-human',
    ] as const)
      expect(act(running({ status }), ev.deleted())).toEqual(deleted);
  });

  it('grilling, executing, in-review, draft, no run → no-transition; a closed issue → issue-closed (plan P21)', () => {
    for (const status of [
      'grilling',
      'executing',
      'in-review',
      'draft',
    ] as const)
      expect(act(running({ status }), ev.deleted())).toEqual(
        ignored('no-transition'),
      );
    expect(act(state(), ev.deleted())).toEqual(ignored('no-transition'));
    expect(
      act(running({ status: 'spec-review', open: false }), ev.deleted()),
    ).toEqual(ignored('issue-closed'));
  });
});

describe('decide(): /restore (spec 7 rows 5, 34, 35; RL19)', () => {
  const calls = (handler: string, op: string) => ({
    kind: 'steps',
    calls: [{ handler, op }],
    statusFirst: null,
    statusAfter: null,
  });

  it('row 34: spec-review (any lane), ready-for-dev full-sdd → the documents handler restores', () => {
    expect(act(running({ status: 'spec-review' }), ev.restore())).toEqual(
      calls('documents', 'restore'),
    );
    expect(act(running({ status: 'ready-for-dev' }), ev.restore())).toEqual(
      calls('documents', 'restore'),
    );
  });

  it('row 35: grilling, code-only ready-for-dev, executing, in-review, needs-human, draft with a run → one reply', () => {
    for (const status of [
      'grilling',
      'executing',
      'in-review',
      'needs-human',
      'draft',
    ] as const)
      expect(act(running({ status }), ev.restore())).toEqual(
        calls('documents', 'reply'),
      );
    expect(
      act(
        running({ status: 'ready-for-dev' }, runOf({ lane: 'code-only' })),
        ev.restore(),
      ),
    ).toEqual(calls('documents', 'reply'));
  });

  it("row 5: no run → the gate; a closed issue → spec 5's reply", () => {
    expect(act(state(), ev.restore())).toEqual({ kind: 'reply-without-run' });
    expect(
      act(running({ status: 'spec-review', open: false }), ev.restore()),
    ).toEqual({ kind: 'reply-closed', command: { kind: 'restore' } });
  });
});

describe('decide(): /refresh (spec 7 rows 5, 32, 35; RL19)', () => {
  const calls = (...list: { handler: string; op: string }[]) => ({
    kind: 'steps',
    calls: list,
    statusFirst: null,
    statusAfter: null,
  });
  const reply = calls({ handler: 'documents', op: 'reply' });

  it('row 32: spec-review → the Spec step refreshes; ready-for-dev full-sdd → the Spec, then the Plan', () => {
    expect(act(running({ status: 'spec-review' }), ev.refresh())).toEqual(
      calls({ handler: 'spec', op: 'refresh' }),
    );
    expect(
      act(
        running({ status: 'spec-review' }, runOf({ lane: 'spec-code' })),
        ev.refresh(),
      ),
    ).toEqual(calls({ handler: 'spec', op: 'refresh' }));
    expect(act(running({ status: 'ready-for-dev' }), ev.refresh())).toEqual(
      calls(
        { handler: 'spec', op: 'refresh' },
        { handler: 'plan', op: 'refresh' },
      ),
    );
  });

  it('row 35: grilling, code-only ready-for-dev, executing, in-review, needs-human, draft with a run → one reply', () => {
    for (const status of [
      'grilling',
      'executing',
      'in-review',
      'needs-human',
      'draft',
    ] as const)
      expect(act(running({ status }), ev.refresh())).toEqual(reply);
    expect(
      act(
        running({ status: 'ready-for-dev' }, runOf({ lane: 'code-only' })),
        ev.refresh(),
      ),
    ).toEqual(reply);
  });

  it("row 5: no run → the gate answers; a closed issue → spec 5's reply (RL19)", () => {
    expect(act(state(), ev.refresh())).toEqual({ kind: 'reply-without-run' });
    expect(
      act(running({ status: 'spec-review', open: false }), ev.refresh()),
    ).toEqual({ kind: 'reply-closed', command: { kind: 'refresh' } });
  });
});

describe('decide(): /retry (spec "`/retry`", RL20)', () => {
  const ref = { id: 'run-2', number: 2, lane: 'full-sdd' };

  it('received at the same instant as the stop counts as before; earlier too', () => {
    for (const at of [stoppedAt, later(1)])
      expect(act(stopped(), ev.retry(at))).toEqual({
        kind: 'reply-retry',
        refusal: { kind: 'before-stop', run: ref },
      });
  });

  it('a run that is not stopped → its status', () => {
    expect(act(running({ status: 'spec-review' }), ev.retry())).toEqual({
      kind: 'reply-retry',
      refusal: { kind: 'not-stopped', run: ref, status: 'spec-review' },
    });
  });

  it('draft with no run → how to start one', () => {
    expect(act(state(), ev.retry())).toEqual({
      kind: 'reply-retry',
      refusal: { kind: 'no-run' },
    });
  });

  it('a stop not retryable, even if written before it → the restart reply (it says how to go on)', () => {
    expect(act(stopped(false, 'coder-red'), ev.retry(later(1)))).toMatchObject({
      refusal: { kind: 'work-result' },
    });
  });

  it('a stop with an unknown work-result cause still gets a reason', () => {
    expect(act(stopped(false, 'something-new'), ev.retry())).toMatchObject({
      refusal: {
        reason:
          'its step reported a result that needs a person (`something-new`)',
      },
    });
  });

  it('a closed issue → RL19 reply', () => {
    expect(act({ ...stopped(), open: false }, ev.retry())).toEqual({
      kind: 'reply-closed',
      command: { kind: 'retry' },
    });
  });
});

describe('decide(): the checks before the rows', () => {
  it('RL14: this event started the running run → continue it; a stopped one → no-transition', () => {
    const own = runOf({ startedByThisEvent: true });
    expect(
      act(running({ status: 'draft' }, own), ev.added('full-sdd')),
    ).toEqual({ kind: 'continue-run' });
    expect(
      act(
        running(
          { status: 'needs-human' },
          runOf({
            startedByThisEvent: true,
            stop: { retryable: true, at: stoppedAt, cause: 'x' },
          }),
        ),
        ev.added('full-sdd'),
      ),
    ).toEqual(ignored('no-transition'));
  });

  it('RLW9: the start event continues with its stored lane, whatever the labels say now', () => {
    expect(
      act(
        running(
          { status: 'draft', lanesOnIssue: ['code-only'] },
          runOf({ startedByThisEvent: true }),
        ),
        ev.added('full-sdd'),
      ),
    ).toEqual({ kind: 'continue-run' });
  });

  it('RL12: LANE_ADDED of the run own lane → no-transition', () => {
    expect(act(running(), ev.added('full-sdd'))).toEqual(
      ignored('no-transition'),
    );
  });

  it('RL15: removing the run own lane with two or more left → cancel (row 6 wins), then a fresh draft reminder', () => {
    const decision = decide(
      running({
        lanesOnIssue: ['spec-code', 'code-only'],
        laneConflictLanes: ['full-sdd', 'spec-code', 'code-only'],
      }),
      ev.removed('full-sdd'),
    );

    // The cancel closed the open reminder: "has 2", not "still has 2".
    expect(decision).toEqual({
      action: { kind: 'cancel', start: null },
      laneConflict: {
        kind: 'post',
        lanes: ['spec-code', 'code-only'],
        still: false,
        run: null,
      },
    });
  });

  it('a stopped run is a run state: removing its lane cancels it', () => {
    expect(
      act({ ...stopped(), lanesOnIssue: [] }, ev.removed('full-sdd')),
    ).toEqual({
      kind: 'cancel',
      start: null,
    });
  });

  it('the run own lane removed and added again before the bot handles it → restart with the same lane (RL12)', () => {
    expect(act(stopped(), ev.removed('full-sdd'))).toEqual({
      kind: 'cancel',
      start: { lane: 'full-sdd', grillSkip: false },
    });
  });

  it('a swap in either order, both events seeing the final labels → exactly one start (RL12)', () => {
    const finalLabels = { lanesOnIssue: ['code-only'] as Lane[] };
    // Removal first: restart; then the added event finds code-only as the new run's own lane.
    expect(act(running(finalLabels), ev.removed('full-sdd'))).toMatchObject({
      kind: 'cancel',
      start: { lane: 'code-only' },
    });
    expect(
      act(
        running(finalLabels, runOf({ number: 3, lane: 'code-only' })),
        ev.added('code-only'),
      ),
    ).toEqual(ignored('no-transition'));
    // Added first: restart; then the removal is of another lane (no longer the run's).
    expect(act(running(finalLabels), ev.added('code-only'))).toMatchObject({
      kind: 'cancel',
      start: { lane: 'code-only' },
    });
    expect(
      act(
        running(finalLabels, runOf({ number: 3, lane: 'code-only' })),
        ev.removed('full-sdd'),
      ),
    ).toEqual(ignored('no-transition'));
  });
});

describe('decide(): plan P15, rows keyed on the current run', () => {
  const draftWithRun = (run: CurrentRun, lanes: Lane[]) =>
    state({
      status: 'draft',
      shownStatus: 'draft',
      runCount: 1,
      run,
      lanesOnIssue: lanes,
    });

  it('draft with a running run: a lane added follows rows 7–8, never row 2', () => {
    const run = runOf({ number: 1 });
    expect(
      act(draftWithRun(run, ['full-sdd', 'code-only']), ev.added('code-only')),
    ).toEqual(ignored('lane-conflict'));
    expect(
      act(draftWithRun(run, ['code-only']), ev.added('code-only')),
    ).toMatchObject({ kind: 'cancel', start: { lane: 'code-only' } });
  });

  it('draft with a stopped run (after /retry of a first-step stop): a lane removed follows rows 6 and 8, never row 4', () => {
    const run = runOf({
      number: 1,
      stop: { retryable: true, at: stoppedAt, cause: 'step-not-built' },
    });
    expect(
      act(draftWithRun(run, ['full-sdd']), ev.removed('code-only')),
    ).toEqual(ignored('no-transition'));
    expect(
      act(draftWithRun(run, ['code-only']), ev.removed('full-sdd')),
    ).toMatchObject({ kind: 'cancel', start: { lane: 'code-only' } });
  });

  it('draft with a run: ISSUE_OPENED is not row 1', () => {
    expect(
      act(
        { ...draftWithRun(runOf(), ['full-sdd']), shownStatus: null },
        ev.opened(),
      ),
    ).toEqual(ignored('no-transition'));
  });

  it('a closed issue: the current run own start event processed again → issue-closed, no reply', () => {
    expect(
      act(
        {
          ...draftWithRun(runOf({ startedByThisEvent: true }), ['full-sdd']),
          open: false,
        },
        ev.added('full-sdd'),
      ),
    ).toEqual(ignored('issue-closed'));
  });
});

describe('decide(): closed issues (RL19, plan P5)', () => {
  const closed = (over: Partial<RouterState> = {}) =>
    running({ open: false, ...over });

  it('the run own lane removed → cancel, no new run even with one lane left; no reminder', () => {
    expect(
      decide(closed({ lanesOnIssue: ['code-only'] }), ev.removed('full-sdd')),
    ).toEqual({ action: { kind: 'cancel', start: null }, laneConflict: null });
  });

  it('a lane label added (any lane) → one reply', () => {
    for (const lane of ['full-sdd', 'code-only'] as const)
      expect(act(closed(), ev.added(lane))).toEqual({
        kind: 'reply-closed',
        command: { kind: 'lane-added', lane },
      });
    expect(act(state({ open: false }), ev.added('spec-code'))).toEqual({
      kind: 'reply-closed',
      command: { kind: 'lane-added', lane: 'spec-code' },
    });
  });

  it('/retry and /approve → one reply', () => {
    expect(act(closed(), ev.retry())).toEqual({
      kind: 'reply-closed',
      command: { kind: 'retry' },
    });
    expect(act(closed(), ev.approve())).toEqual({
      kind: 'reply-closed',
      command: { kind: 'approve' },
    });
  });

  it('a comment, grill: skip, another lane removed, issues.opened → issue-closed, silent', () => {
    for (const input of [
      ev.comment(),
      ev.skip(),
      ev.removed('code-only'),
      ev.opened(),
    ])
      expect(act(closed(), input)).toEqual(ignored('issue-closed'));
  });

  it('two or more lanes on a closed issue → no reminder', () => {
    expect(
      decide(closed({ lanesOnIssue: ['full-sdd', 'code-only'] }), ev.comment())
        .laneConflict,
    ).toBeNull();
  });
});

describe('decide(): the lane-conflict check after the rows (RL8, plan Q3)', () => {
  it('any issue event with two or more lanes and no reminder open posts one; the listed set, in any order → nothing', () => {
    const twoLanes = ['full-sdd', 'code-only'] as Lane[];
    expect(
      decide(running({ lanesOnIssue: twoLanes }), ev.comment()).laneConflict,
    ).toEqual({
      kind: 'post',
      lanes: twoLanes,
      still: false,
      run: { number: 2, lane: 'full-sdd' },
    });
    expect(
      decide(
        running({
          lanesOnIssue: twoLanes,
          laneConflictLanes: ['code-only', 'full-sdd'],
        }),
        ev.comment(),
      ).laneConflict,
    ).toBeNull();
  });

  it('another set of two or more while a reminder is open → a fresh "still has" reminder', () => {
    const threeLanes = ['full-sdd', 'code-only', 'spec-code'] as Lane[];
    expect(
      decide(
        running({
          lanesOnIssue: threeLanes,
          laneConflictLanes: ['full-sdd', 'code-only'],
        }),
        ev.added('spec-code'),
      ).laneConflict,
    ).toEqual({
      kind: 'post',
      lanes: threeLanes,
      still: true,
      run: { number: 2, lane: 'full-sdd' },
    });
  });

  it('at most one lane closes an open conflict', () => {
    expect(
      decide(
        running({
          lanesOnIssue: ['full-sdd'],
          laneConflictLanes: ['full-sdd', 'code-only'],
        }),
        ev.removed('code-only'),
      ).laneConflict,
    ).toEqual({ kind: 'close' });
  });

  it('outcomes and failures never touch the conflict', () => {
    expect(
      decide(running({ lanesOnIssue: ['full-sdd', 'code-only'] }), {
        type: 'ASKED',
      }).laneConflict,
    ).toBeNull();
  });
});

describe('isStale (RL10)', () => {
  it('before the latest run start event → stale; equal or after → not; no run ever → not', () => {
    expect(isStale(T0, later(1))).toBe(true);
    expect(isStale(T0, T0)).toBe(false);
    expect(isStale(later(1), T0)).toBe(false);
    expect(isStale(T0, null)).toBe(false);
  });
});

describe('decide() is pure', () => {
  it('RUN_START without a run is a bug in the caller', () => {
    expect(() => decide(state(), { type: 'RUN_START' })).toThrow(
      'RUN_START without a current run',
    );
  });
});
