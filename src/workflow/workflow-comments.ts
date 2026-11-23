// Spec 5 RLW12: every marker and text the router posts. Fixed text, validated logins, label names, run numbers,
// step names and spec 4's safe error messages only: never issue text, a stack trace or a bug's message. A login
// is in backticks without `@`: nobody is notified of their own action (RL18).
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';
import { laneLabel } from '../github/labels.js';

const marker = (key: string): string => `<!-- sdd-agent:${key} -->`;

export const needsHumanMarker = (runId: string, stops: number): string =>
  marker(`needs-human:${runId}:${stops}`);
export const runEndedMarker = (runId: string): string =>
  marker(`run-ended:${runId}`);
export const laneConflictMarker = (conflicts: number): string =>
  marker(`lane-conflict:${conflicts}`);
export const issueClosedMarker = (deliveryId: string): string =>
  marker(`issue-closed:${deliveryId}`);
export const retryRefusedMarker = (commentId: string): string =>
  marker(`retry-refused:${commentId}`);

/** The run a text names. */
export interface RunRef {
  id: string;
  number: number;
  lane: Lane;
}

/** The step a stop names (plan P3): a handler's name, or `run-start` before the first one. */
export const RUN_START = 'run-start';

export type StopText =
  /** Row 28: a failure; `/retry` may continue the run. */
  | { kind: 'failure'; step: string; message: string; cause: string }
  /** Rows 14, 22, 25, 26: the step's own body (plan P4); only a restart continues. */
  | { kind: 'work-result'; cause: string; body: string };

/** Spec 6 GM9: the round limit's body brings its own three steps, so its stop has no generic restart line. */
const OWN_STEPS_CAUSES = new Set(['grill-limit']);

/** Spec "Stop comment": the marker counts the run's stops, so a stop after `/retry` gets its own comment. */
export function stopComment(
  run: RunRef,
  stops: number,
  stop: StopText,
): string {
  const restart = `remove the \`${laneLabel(run.lane)}\` label and add it again.`;
  if (stop.kind === 'work-result') {
    return [
      needsHumanMarker(run.id, stops),
      stop.body,
      ...(OWN_STEPS_CAUSES.has(stop.cause)
        ? []
        : ['', `- To start again from scratch: ${restart}`]),
    ].join('\n');
  }
  const where =
    stop.step === RUN_START
      ? 'before its first step'
      : `at step \`${stop.step}\``;
  return [
    needsHumanMarker(run.id, stops),
    `⚠️ **Run ${run.number} stopped ${where}:** ${stop.message}. (\`${stop.cause}\`)`,
    '',
    `- Fix the cause, then comment \`/retry\` to continue run ${run.number} where it stopped.`,
    `- Or start again from scratch: ${restart}`,
  ].join('\n');
}

export type RunEnd =
  | { kind: 'cancelled' }
  | { kind: 'replaced'; by: { number: number; lane: Lane } };

/**
 * RL18: one comment whenever a run ends. `sender` is the login whose label change ended it; the cancel hooks'
 * blocks (spec 6: the answered rounds, D6) follow in the same comment.
 */
export function runEndedComment(
  run: RunRef,
  end: RunEnd,
  sender: string,
  blocks: string[] = [],
): string {
  const lines =
    end.kind === 'cancelled'
      ? [
          `Run ${run.number} (\`${run.lane}\`) was cancelled: \`${sender}\` removed \`${laneLabel(run.lane)}\`.`,
          'To start again, add one `workflow:` label.',
        ]
      : [
          `Run ${run.number} (\`${run.lane}\`) was replaced by run ${end.by.number} (\`${end.by.lane}\`): ` +
            `\`${sender}\` changed the workflow label.`,
        ];
  return [
    runEndedMarker(run.id),
    ...lines,
    ...blocks.map((block) => `\n${block}`),
  ].join('\n');
}

/** What a lane-conflict reminder says (plan Q3). */
export interface LaneConflictReminder {
  /** The lane labels on the issue now, as read. */
  lanes: Lane[];
  /** A reminder listing another set was open ("still has N"). */
  still: boolean;
  /** The run current after the event, if any: it keeps its lane. */
  run: { number: number; lane: Lane } | null;
}

/** RL8, plan Q3: one reminder per set of two or more lane labels, with the count and the list. */
export function laneConflictComment(
  conflicts: number,
  reminder: LaneConflictReminder,
): string {
  const { lanes, still, run } = reminder;
  const listed = lanes.map((lane) => `\`${laneLabel(lane)}\``).join(', ');
  const first = `This issue ${still ? 'still has' : 'has'} ${lanes.length} \`workflow:\` labels: ${listed}.`;
  const own = run && `\`${laneLabel(run.lane)}\``;
  const rest = run
    ? `Run ${run.number} keeps ${own}. To switch, remove ${own}; to stay, remove the others.`
    : 'Keep exactly one: the bot starts a run when one is left.';
  return `${laneConflictMarker(conflicts)}\n${first} ${rest}`;
}

export type ClosedCommand =
  | { kind: 'lane-added'; lane: Lane }
  | { kind: 'retry' }
  | { kind: 'approve' }
  | { kind: 'refresh' }
  | { kind: 'restore' };

/** RL19: a command on a closed issue gets one reply (marker per delivery). */
export function issueClosedComment(
  deliveryId: string,
  command: ClosedCommand,
): string {
  const text =
    command.kind === 'lane-added'
      ? `This issue is closed, so the bot did nothing with \`${laneLabel(command.lane)}\`. To start a run, ` +
        'reopen the issue, then remove the label and add it again.'
      : `This issue is closed, so \`/${command.kind}\` did nothing. Reopen the issue, then comment ` +
        `\`/${command.kind}\` again.`;
  return `${issueClosedMarker(deliveryId)}\n${text}`;
}

export type RetryRefusal =
  | { kind: 'no-run' }
  | { kind: 'not-stopped'; run: RunRef; status: TaskStatus }
  | { kind: 'before-stop'; run: RunRef }
  /** `reason`: `workResultReason()` of the stop's cause. */
  | { kind: 'work-result'; run: RunRef; reason: string };

/** RL20: every `/retry` that did nothing gets one reply (marker per `/retry` comment). */
export function retryRefusedComment(
  commentId: string,
  refusal: RetryRefusal,
): string {
  let text: string;
  switch (refusal.kind) {
    case 'no-run':
      text =
        'There is no run on this issue, so there is nothing to retry. To start one, add one `workflow:` label.';
      break;
    case 'not-stopped':
      text = `Run ${refusal.run.number} isn't stopped (status \`${refusal.status}\`), so there is nothing to retry.`;
      break;
    case 'before-stop':
      text =
        `This \`/retry\` was written before run ${refusal.run.number} stopped, so it didn't count. ` +
        `To continue run ${refusal.run.number}, comment \`/retry\` again.`;
      break;
    case 'work-result':
      text =
        '`/retry` only continues a run that stopped on a failure. ' +
        `Run ${refusal.run.number} stopped because ${refusal.reason}, so it needs a restart: ` +
        `remove the \`${laneLabel(refusal.run.lane)}\` label and add it again.`;
      break;
  }
  return `${retryRefusedMarker(commentId)}\n${text}`;
}
