// Spec 5 "State and decide()": overview §3's transition table (rows 1–31) as one pure function (D3, RLW7). No
// Prisma, no port, no clock: the router passes the state it read and the times PostgreSQL gave (plan P7).
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import {
  laneConflictEffect,
  type LaneConflictEffect,
} from './lane-conflict.js';
import { WORK_RESULT_STOPS, workResultReason } from './stop-cause.js';
import type {
  ClosedCommand,
  RetryRefusal,
  RunRef,
} from './workflow-comments.js';

/** The step handlers (spec "Step-handler registry"); spec 5 only names them. Spec 7: `documents` (the replies). */
export type HandlerName =
  | 'grill'
  | 'spec'
  | 'plan'
  | 'go-signal'
  | 'documents'
  | 'workspace'
  | 'code'
  | 'qualityGate';

/** What a handler is asked to do (overview §3, the rows' actions). Spec 7: `refresh`, `reply`, `deleted`, `restore`. */
export type HandlerOp =
  | 'start'
  | 'skip'
  | 'round'
  | 'generate'
  | 'approve'
  | 'post'
  | 'refresh'
  | 'reply'
  | 'deleted'
  | 'restore'
  | 'claim'
  | 'review';

export interface HandlerCall {
  handler: HandlerName;
  op: HandlerOp;
}

/**
 * Overview §3 "Step outcomes". A result of the work that stops the run carries the step's comment body
 * (plan P4). A handler that only posts (a document, the go-signal) returns nothing instead. Spec 7:
 * `SPEC_REFRESHED` (a Spec v2 posted while the Plan waited → `spec-review`) and, plan P6, `IGNORED` (a step that
 * only replied, or found nothing to do: the event ends `IGNORED` with that reason).
 */
export type StepOutcome =
  | { type: 'IGNORED'; reason: RouterIgnoreReason }
  | { type: 'SPEC_REFRESHED' }
  | { type: 'ASKED' }
  | { type: 'CLEAR' }
  | { type: 'LIMIT'; body: string }
  | { type: 'WS_BUSY' }
  | { type: 'WS_DIRTY'; body: string }
  | { type: 'WS_CLAIMED' }
  | { type: 'GREEN' }
  | { type: 'RED'; body: string }
  | { type: 'INTERRUPTED'; prOpened: true }
  | { type: 'INTERRUPTED'; prOpened: false; body: string };

/** Row 28 (plan P16): a failure, with whether the failed event is a `/retry` (RL13) or stale (plan P2). */
export interface FailedInput {
  type: 'FAILED';
  cause: string;
  message: string;
  /** Plan P3: the handler's name, or `run-start`. */
  step: string;
  retry: boolean;
  stale: boolean;
}

/** Rows 9–11: the run passed its start check and the injection warning; its first step follows (RL3). */
export interface RunStartInput {
  type: 'RUN_START';
}

export type DecideInput =
  WorkflowInput | StepOutcome | FailedInput | RunStartInput;

type IssueEvent = Exclude<WorkflowInput, { type: 'PR_UPDATED' }>;

export interface CurrentRun extends RunRef {
  grillSkip: boolean;
  /** RL14, RLW9: `Run.startEventId` is the event being processed. */
  startedByThisEvent: boolean;
  /** Set while stopped (`needs-human`); `at` is `Run.stoppedAt` (PostgreSQL's clock). */
  stop: null | { retryable: boolean; at: Date; cause: string };
}

export interface RouterState {
  status: TaskStatus;
  /** Plan P6: the `status: *` label GitHub shows; null = none yet. */
  shownStatus: TaskStatus | null;
  /** Plan P6: runs so far (`Task.runCount`). */
  runCount: number;
  /** The current run, if any; plan P15: the rows are chosen by this, not by the status. */
  run: CurrentRun | null;
  /** From `readControls`, read now. */
  lanesOnIssue: Lane[];
  grillSkipOnIssue: boolean;
  /** `UnifiedTask.open`, read now (plan P5). */
  open: boolean;
  /** Plan Q3: the lanes the open lane-conflict reminder lists (`Task.laneConflictLanes`); empty = none open. */
  laneConflictLanes: Lane[];
  /**
   * R2: the gate's verdict (spec 7, plan P7, P26), asked only for `APPROVE` in `spec-review` or `ready-for-dev` with a
   * run (rows 17–20); null otherwise.
   */
  approval: ApprovalVerdict | null;
}

export type RouterIgnoreReason =
  | 'no-transition'
  | 'issue-closed'
  | 'lane-conflict'
  // Spec 7: a command or comment the `documents` handler answered with a reply (plan P6).
  | 'approve-refused'
  | 'approve-hint'
  | 'late-comment'
  | 'refresh-refused'
  | 'restore-refused';

/**
 * Spec 7 "`/approve`" (R2): the verdict on an `/approve` in `spec-review` or `ready-for-dev`, from the gate
 * DocumentsModule registers (plan P26: it lives here, so WorkflowModule imports nothing from `src/documents`).
 */
export type ApprovalVerdict =
  | 'valid'
  | 'done'
  | 'already-approved'
  | 'before-document'
  | 'deleted'
  | 'empty';

export type StopDecision =
  | {
      kind: 'failure';
      step: string;
      cause: string;
      message: string;
      retryable: true;
    }
  | {
      kind: 'work-result';
      step: HandlerName;
      cause: string;
      body: string;
      retryable: boolean;
    };

export type Action =
  /** Row 1: show `status: draft`. */
  | { kind: 'label-draft' }
  /** Rows 2, 4: a new run (RL3: create it, check, warning, then RUN_START). */
  | { kind: 'start-run'; lane: Lane; grillSkip: boolean }
  /** RL14: this event started the running run: its start again from the check (RLW9: stored lane and skip). */
  | { kind: 'continue-run' }
  /** Rows 6, 7, RL19: end the run; `start` = the restart's new run (row 6 with one lane left, row 7). */
  | { kind: 'cancel'; start: null | { lane: Lane; grillSkip: boolean } }
  /**
   * Call the handlers in order (plan P4). `statusFirst` is set before the calls (row 23); `statusAfter` when
   * every call returned nothing (rows 10, 11, 13, 17); an outcome goes back into decide().
   */
  | {
      kind: 'steps';
      calls: HandlerCall[];
      statusFirst: TaskStatus | null;
      statusAfter: TaskStatus | null;
    }
  /** Rows 12, 24, 26. */
  | { kind: 'set-status'; status: TaskStatus }
  /** Rows 14, 22, 25, 26, 28: `needs-human`. */
  | { kind: 'stop'; stop: StopDecision }
  /** Row 21 (spec 8). */
  | { kind: 'wait-workspace' }
  /** Row 30. */
  | { kind: 'accept-retry' }
  /** Row 31, RL20: one reply; the event ends `IGNORED` `retry-refused`. */
  | { kind: 'reply-retry'; refusal: RetryRefusal }
  /**
   * Spec 7 row 5 (plan P36, P7): a document command on an issue with no run; the gate posts the one reply and the
   * event ends `IGNORED` with the command's `-refused` reason.
   */
  | { kind: 'reply-without-run' }
  /** RL19: one reply; the event ends `IGNORED` `issue-closed`. */
  | { kind: 'reply-closed'; command: ClosedCommand }
  | { kind: 'ignore'; reason: RouterIgnoreReason }
  /** Row 28 without a running run, or for a `/retry` or a stale event: the event stays `FAILED`, silent. */
  | { kind: 'stay-failed' };

export interface Decision {
  action: Action;
  /** Checked after the rows for every issue event on an open issue (RL8). */
  laneConflict: LaneConflictEffect;
}

export function decide(state: RouterState, input: DecideInput): Decision {
  if (!isIssueEvent(input))
    return { action: otherInput(state, input), laneConflict: null };
  // Plan P5: the closed check is the first rule; nothing is reminded on a closed issue.
  if (!state.open)
    return { action: onClosedIssue(state, input), laneConflict: null };

  const action = issueEvent(state, input);
  const endsRun = action.kind === 'cancel';
  // A run started or restarted here has exactly one lane left, so no reminder names it.
  const runAfter = endsRun ? null : state.run;
  return {
    action,
    laneConflict: laneConflictEffect(
      state.lanesOnIssue,
      state.laneConflictLanes,
      endsRun,
      runAfter && { number: runAfter.number, lane: runAfter.lane },
    ),
  };
}

/** RL10: received before the event that started the issue's latest run; equal times are not stale. */
export function isStale(
  receivedAt: Date,
  latestRunStartReceivedAt: Date | null,
): boolean {
  return (
    latestRunStartReceivedAt !== null &&
    receivedAt.getTime() < latestRunStartReceivedAt.getTime()
  );
}

function isIssueEvent(input: DecideInput): input is IssueEvent {
  switch (input.type) {
    case 'ISSUE_OPENED':
    case 'SKIP_ADDED':
    case 'LANE_ADDED':
    case 'LANE_REMOVED':
    case 'COMMENT':
    case 'APPROVE':
    case 'RETRY':
    case 'REFRESH':
    case 'RESTORE':
    case 'BOT_COMMENT_DELETED':
      return true;
    default:
      return false;
  }
}

/** RL19 and plan P15. */
function onClosedIssue(state: RouterState, event: IssueEvent): Action {
  const run = state.run;
  if (run?.startedByThisEvent) return ignore('issue-closed');
  switch (event.type) {
    case 'LANE_REMOVED':
      return run && event.lane === run.lane
        ? { kind: 'cancel', start: null }
        : ignore('issue-closed');
    case 'LANE_ADDED':
      return {
        kind: 'reply-closed',
        command: { kind: 'lane-added', lane: event.lane },
      };
    case 'RETRY':
      return { kind: 'reply-closed', command: { kind: 'retry' } };
    case 'APPROVE':
      return { kind: 'reply-closed', command: { kind: 'approve' } };
    case 'REFRESH':
      return { kind: 'reply-closed', command: { kind: 'refresh' } };
    case 'RESTORE':
      return { kind: 'reply-closed', command: { kind: 'restore' } };
    default:
      return ignore('issue-closed');
  }
}

function issueEvent(state: RouterState, event: IssueEvent): Action {
  const run = state.run;
  if (!run) return withoutRun(state, event);
  // RL14: before rows 6–8.
  if (run.startedByThisEvent)
    return run.stop ? ignore('no-transition') : { kind: 'continue-run' };
  // RL12, RL15: the run's own lane.
  if (event.type === 'LANE_REMOVED' && event.lane === run.lane) {
    const left = state.lanesOnIssue;
    return {
      kind: 'cancel',
      start:
        left.length === 1
          ? { lane: left[0], grillSkip: state.grillSkipOnIssue }
          : null,
    };
  }
  if (event.type === 'LANE_ADDED' && event.lane === run.lane)
    return ignore('no-transition');
  return withRun(state, run, event);
}

/** Rows 1–5 (plan P15: no current run, so `draft`). */
function withoutRun(state: RouterState, event: IssueEvent): Action {
  const lanes = state.lanesOnIssue;
  switch (event.type) {
    case 'ISSUE_OPENED':
      // Row 1 (plan P6).
      return state.shownStatus === null && state.runCount === 0
        ? { kind: 'label-draft' }
        : ignore('no-transition');
    case 'LANE_ADDED':
    case 'LANE_REMOVED':
      // Rows 2 and 4: exactly one lane; row 3 (and a removal leaving two or more): a conflict; else row 5.
      if (lanes.length === 1)
        return {
          kind: 'start-run',
          lane: lanes[0],
          grillSkip: state.grillSkipOnIssue,
        };
      return ignore(lanes.length >= 2 ? 'lane-conflict' : 'no-transition');
    case 'RETRY':
      return { kind: 'reply-retry', refusal: { kind: 'no-run' } };
    case 'APPROVE':
    case 'REFRESH':
    case 'RESTORE':
      return { kind: 'reply-without-run' }; // row 5 (spec 7)
    default:
      return ignore('no-transition');
  }
}

/** Rows 7, 8 and the rows by status (15–20, 27, 30, 31) for an issue with a current run. */
function withRun(
  state: RouterState,
  run: CurrentRun,
  event: IssueEvent,
): Action {
  const lanes = state.lanesOnIssue;
  switch (event.type) {
    case 'LANE_ADDED':
      // Row 7: another lane, and it is the only one now (RL12).
      if (lanes.length === 1 && lanes[0] !== run.lane)
        return {
          kind: 'cancel',
          start: { lane: lanes[0], grillSkip: state.grillSkipOnIssue },
        };
      return ignore(lanes.length >= 2 ? 'lane-conflict' : 'no-transition');
    case 'LANE_REMOVED':
      // Row 8: another lane removed.
      return ignore(lanes.length >= 2 ? 'lane-conflict' : 'no-transition');
    case 'RETRY':
      return retry(state, run, event.receivedAt);
    default:
      return byStatus(state, run, event);
  }
}

function byStatus(
  state: RouterState,
  run: CurrentRun,
  event: IssueEvent,
): Action {
  switch (state.status) {
    case 'grilling':
      return whileGrilling(state, event);
    case 'spec-review':
      if (event.type === 'COMMENT') return documentsReply(); // row 20: a hint, a late comment, or nothing
      if (event.type === 'BOT_COMMENT_DELETED') return documentDeleted(); // row 33
      if (event.type === 'REFRESH')
        return steps([{ handler: 'spec', op: 'refresh' }], null); // row 32
      if (event.type === 'RESTORE') return documentRestore(); // row 34
      if (event.type !== 'APPROVE') return ignore('no-transition'); // row 20
      if (state.approval !== 'valid') return approvalAnswer(state.approval);
      return run.lane === 'full-sdd'
        ? steps(
            [
              { handler: 'spec', op: 'approve' },
              { handler: 'plan', op: 'generate' },
            ],
            'ready-for-dev',
          ) // row 17
        : steps(
            [
              { handler: 'spec', op: 'approve' },
              { handler: 'workspace', op: 'claim' },
            ],
            null,
          ); // row 18
    case 'ready-for-dev':
      if (event.type === 'COMMENT') return documentsReply(); // row 20: a hint, or nothing
      if (event.type === 'BOT_COMMENT_DELETED') return documentDeleted(); // row 33
      if (event.type === 'REFRESH')
        // Row 32: the Spec first, then the Plan (D3: two calls, no step calls another); `code-only`: row 35.
        return run.lane === 'full-sdd'
          ? steps(
              [
                { handler: 'spec', op: 'refresh' },
                { handler: 'plan', op: 'refresh' },
              ],
              null,
            )
          : documentsReply();
      if (event.type === 'RESTORE')
        // Row 34 (`full-sdd`: the Plan waits); `code-only`: row 35.
        return run.lane === 'full-sdd' ? documentRestore() : documentsReply();
      if (event.type !== 'APPROVE') return ignore('no-transition'); // row 20
      if (state.approval !== 'valid') return approvalAnswer(state.approval);
      // Row 19.
      return steps(
        [
          {
            handler: run.lane === 'full-sdd' ? 'plan' : 'go-signal',
            op: 'approve',
          },
          { handler: 'workspace', op: 'claim' },
        ],
        null,
      );
    default:
      // Row 27 (in-review, needs-human); also `draft` before the first step and `executing`: nothing to do, but
      // an `/approve` gets one reply why (spec 7 row 36), and a `/refresh` too (row 35). Row 33: a run stopped while a
      // document waited still records its deletion.
      if (
        event.type === 'APPROVE' ||
        event.type === 'REFRESH' ||
        event.type === 'RESTORE'
      )
        return documentsReply();
      return event.type === 'BOT_COMMENT_DELETED' &&
        state.status === 'needs-human'
        ? documentDeleted()
        : ignore('no-transition');
  }
}

/**
 * Spec 7 "`/approve`": `done` (this event already approved an earlier document of the run) → nothing, the event
 * ends DONE (plan P27); a refusal → one reply by the `documents` handler (row 20).
 */
function approvalAnswer(verdict: ApprovalVerdict | null): Action {
  if (verdict === null)
    throw new Error('decide: an APPROVE in review without the gate’s verdict');
  if (verdict === 'done') return steps([], null);
  return documentsReply();
}

/**
 * Row 33 (spec 7, D30): the `documents` handler checks whether the deleted bot comment is the waiting document's;
 * anything else ends `no-transition`.
 */
function documentDeleted(): Action {
  return steps([{ handler: 'documents', op: 'deleted' }], null);
}

/** Row 34 (spec 7, D30): `/restore` of the waiting document, by the `documents` handler (no model call). */
function documentRestore(): Action {
  return steps([{ handler: 'documents', op: 'restore' }], null);
}

/** Spec 7: the `documents` handler answers (or, for a comment that needs nothing, ends it `no-transition`). */
function documentsReply(): Action {
  return steps([{ handler: 'documents', op: 'reply' }], null);
}

/** Rows 30, 31 and RL20 (spec "`/retry`"). */
function retry(state: RouterState, run: CurrentRun, receivedAt: Date): Action {
  const ref: RunRef = { id: run.id, number: run.number, lane: run.lane };
  const stop = run.stop;
  if (!stop)
    return {
      kind: 'reply-retry',
      refusal: { kind: 'not-stopped', run: ref, status: state.status },
    };
  if (!stop.retryable)
    return {
      kind: 'reply-retry',
      refusal: {
        kind: 'work-result',
        run: ref,
        reason:
          workResultReason(stop.cause) ??
          `its step reported a result that needs a person (\`${stop.cause}\`)`,
      },
    };
  // RLW3: only a /retry received after the stop counts; the same instant counts as before.
  if (receivedAt.getTime() <= stop.at.getTime())
    return { kind: 'reply-retry', refusal: { kind: 'before-stop', run: ref } };
  return { kind: 'accept-retry' };
}

function otherInput(
  state: RouterState,
  input: Exclude<DecideInput, IssueEvent>,
): Action {
  const run = state.run;
  switch (input.type) {
    case 'RUN_START':
      return firstStep(run, state.grillSkipOnIssue);
    case 'FAILED':
      // Row 28: only a running run, never for a /retry (RL13) or a stale event (plan P2).
      return run && !run.stop && !input.retry && !input.stale
        ? {
            kind: 'stop',
            stop: {
              kind: 'failure',
              step: input.step,
              cause: input.cause,
              message: input.message,
              retryable: true,
            },
          }
        : { kind: 'stay-failed' };
    case 'PR_UPDATED':
      // Row 29 (spec 9 maps a bot PR to its issue; until then the router ends it `no-task`).
      return run
        ? steps([{ handler: 'qualityGate', op: 'review' }], null)
        : ignore('no-transition');
    case 'IGNORED':
      return ignore(input.reason); // spec 7, plan P6
    case 'SPEC_REFRESHED':
      return { kind: 'set-status', status: 'spec-review' }; // row 32
    case 'ASKED':
      return { kind: 'set-status', status: 'grilling' }; // row 12
    case 'CLEAR':
      return steps([{ handler: 'spec', op: 'generate' }], 'spec-review'); // row 13
    case 'LIMIT':
      return workResultStop('grill', 'LIMIT', input.body); // row 14
    case 'WS_BUSY':
      return { kind: 'wait-workspace' }; // row 21
    case 'WS_DIRTY':
      return workResultStop('workspace', 'WS_DIRTY', input.body); // row 22
    case 'WS_CLAIMED':
      // Row 23: the status shows `executing` while the Coder runs.
      return {
        kind: 'steps',
        calls: [{ handler: 'code', op: 'start' }],
        statusFirst: 'executing',
        statusAfter: null,
      };
    case 'GREEN':
      return { kind: 'set-status', status: 'in-review' }; // row 24
    case 'RED':
      return workResultStop('code', 'RED', input.body); // row 25
    case 'INTERRUPTED':
      // Row 26: a PR already opened finishes as GREEN.
      return input.prOpened
        ? { kind: 'set-status', status: 'in-review' }
        : workResultStop('code', 'INTERRUPTED', input.body);
  }
}

/**
 * Rows 9–11: the first step per lane and skip (RL3 step 4). Spec 6 GM15: `grill: skip` counts when the run
 * started with it or it is on the issue now (a retried run start after the label was added), amending RLW9.
 */
function firstStep(run: CurrentRun | null, grillSkipOnIssue: boolean): Action {
  if (!run) throw new Error('decide: RUN_START without a current run');
  if (run.lane === 'code-only')
    return steps([{ handler: 'go-signal', op: 'post' }], 'ready-for-dev'); // row 11
  if (run.grillSkip || grillSkipOnIssue) return grillSkipPath(); // row 10
  return steps([{ handler: 'grill', op: 'start' }], null); // row 9
}

/**
 * Rows 15 and 16 (spec 6 GM8, GM15): whenever the bot would ask while `grill: skip` is on, the skip path instead.
 * `APPROVE` → one reply. A `grill: skip` event that finds the label gone is read like a comment (plan P1).
 */
function whileGrilling(state: RouterState, event: IssueEvent): Action {
  switch (event.type) {
    case 'COMMENT':
    case 'SKIP_ADDED':
      return state.grillSkipOnIssue
        ? grillSkipPath()
        : steps([{ handler: 'grill', op: 'round' }], null);
    case 'APPROVE':
      return steps([{ handler: 'grill', op: 'approve' }], null);
    case 'REFRESH':
    case 'RESTORE':
      return documentsReply(); // row 35: no Spec yet
    default:
      return ignore('no-transition');
  }
}

/** Row 10, and row 16 for `grill: skip`: Grill Me skipped or stopped, then the Spec. */
function grillSkipPath(): Action {
  return steps(
    [
      { handler: 'grill', op: 'skip' },
      { handler: 'spec', op: 'generate' },
    ],
    'spec-review',
  );
}

/**
 * Plan P4: a result of the work stops the run with the step's body. Not retryable; spec 8 decides whether
 * `WS_DIRTY` is (the spec's "Agreed for later specs").
 */
function workResultStop(
  step: HandlerName,
  outcome: keyof typeof WORK_RESULT_STOPS,
  body: string,
): Action {
  return {
    kind: 'stop',
    stop: {
      kind: 'work-result',
      step,
      cause: WORK_RESULT_STOPS[outcome].cause,
      body,
      retryable: false,
    },
  };
}

function steps(calls: HandlerCall[], statusAfter: TaskStatus | null): Action {
  return { kind: 'steps', calls, statusFirst: null, statusAfter };
}

function ignore(reason: RouterIgnoreReason): Action {
  return { kind: 'ignore', reason };
}
