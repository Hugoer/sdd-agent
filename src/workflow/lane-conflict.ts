// Spec 5 RL8, RL15: one lane-conflict reminder per conflict. Pure: the router applies the effect.

export type LaneConflictEffect =
  /** Post a reminder, set `laneConflictOpen`, count it. `during`: which wording (a run keeps its lane). */
  | { kind: 'post'; during: 'draft' | 'run' }
  /** At most one lane left: the conflict is over (a new one gets a new reminder). */
  | { kind: 'close' }
  | null;

/**
 * `laneCount`: lane labels on the issue now. `endsRun`: this event cancels or restarts the run, which closes the
 * open conflict first (RL15), so two or more lanes left get a fresh reminder. `runRemains`: a run is current
 * after this event (the reminder says the run keeps its lane).
 */
export function laneConflictEffect(
  laneCount: number,
  open: boolean,
  endsRun: boolean,
  runRemains: boolean,
): LaneConflictEffect {
  if (laneCount >= 2) {
    const stillOpen = open && !endsRun;
    return stillOpen
      ? null
      : { kind: 'post', during: runRemains ? 'run' : 'draft' };
  }
  return open ? { kind: 'close' } : null;
}
