import { describe, expect, it } from 'vitest';
import { laneConflictEffect } from './lane-conflict.js';

describe('laneConflictEffect (RL8, RL15)', () => {
  it('two or more lanes, no conflict open → post (draft or run wording)', () => {
    expect(laneConflictEffect(2, false, false, false)).toEqual({
      kind: 'post',
      during: 'draft',
    });
    expect(laneConflictEffect(3, false, false, true)).toEqual({
      kind: 'post',
      during: 'run',
    });
  });

  it('two or more lanes, conflict already open → nothing', () => {
    expect(laneConflictEffect(2, true, false, true)).toBeNull();
  });

  it('at most one lane → the conflict is over (close if open, else nothing)', () => {
    expect(laneConflictEffect(1, true, false, true)).toEqual({ kind: 'close' });
    expect(laneConflictEffect(0, true, false, false)).toEqual({
      kind: 'close',
    });
    expect(laneConflictEffect(1, false, false, false)).toBeNull();
  });

  it('a cancel closes the open conflict first: two or more lanes left → a fresh draft reminder (RL15)', () => {
    expect(laneConflictEffect(2, true, true, false)).toEqual({
      kind: 'post',
      during: 'draft',
    });
  });

  it('a cancel with at most one lane left closes it', () => {
    expect(laneConflictEffect(1, true, true, true)).toEqual({ kind: 'close' });
  });
});
