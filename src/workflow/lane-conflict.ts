// Spec 5 RL8, RL15 and plan Q3 (decided at Checkpoint 2): one lane-conflict reminder per set of lane labels. Pure:
// the router applies the effect.
import type { Lane } from '../contracts/issue-provider.js';
import type { LaneConflictReminder } from './workflow-comments.js';

export type LaneConflictEffect =
  /** Post a reminder listing `lanes`, store them as the listed set, count it. */
  | ({ kind: 'post' } & LaneConflictReminder)
  /** At most one lane left: the conflict is over (a new one gets a new reminder). */
  | { kind: 'close' }
  | null;

/**
 * `lanes`: the lane labels on the issue now. `listed`: the lanes the open reminder lists (`Task.laneConflictLanes`),
 * empty when none is open. `endsRun`: this event cancels or restarts the run, which closes the open conflict
 * first (RL15). `run`: the run current after this event, if any (the reminder says it keeps its lane).
 */
export function laneConflictEffect(
  lanes: Lane[],
  listed: Lane[],
  endsRun: boolean,
  run: { number: number; lane: Lane } | null,
): LaneConflictEffect {
  const open = endsRun ? [] : listed;
  if (lanes.length >= 2)
    return sameLanes(lanes, open)
      ? null
      : { kind: 'post', lanes, still: open.length > 0, run };
  return open.length > 0 ? { kind: 'close' } : null;
}

/** The same set of lanes, in any order. */
function sameLanes(a: Lane[], b: Lane[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((lane, index) => lane === sorted[index]);
}
