import { describe, expect, it } from 'vitest';
import type { Lane } from '../contracts/issue-provider.js';
import { laneConflictEffect } from './lane-conflict.js';

const two: Lane[] = ['full-sdd', 'code-only'];
const three: Lane[] = ['full-sdd', 'code-only', 'spec-code'];
const run2 = { number: 2, lane: 'full-sdd' as const };

describe('laneConflictEffect (RL8, RL15, plan Q3)', () => {
  it('two or more lanes, no reminder open → post "has N" (draft or run wording)', () => {
    expect(laneConflictEffect(two, [], false, null)).toEqual({
      kind: 'post',
      lanes: two,
      still: false,
      run: null,
    });
    expect(laneConflictEffect(three, [], false, run2)).toEqual({
      kind: 'post',
      lanes: three,
      still: false,
      run: run2,
    });
  });

  it('the set the open reminder lists, in any order → nothing', () => {
    expect(
      laneConflictEffect(two, ['code-only', 'full-sdd'], false, run2),
    ).toBeNull();
  });

  it('another set of two or more → a fresh "still has N" reminder (one removed of three, or a third added)', () => {
    expect(laneConflictEffect(two, three, false, null)).toEqual({
      kind: 'post',
      lanes: two,
      still: true,
      run: null,
    });
    expect(laneConflictEffect(three, two, false, run2)).toEqual({
      kind: 'post',
      lanes: three,
      still: true,
      run: run2,
    });
  });

  it('at most one lane → the conflict is over (close if open, else nothing)', () => {
    expect(laneConflictEffect(['full-sdd'], two, false, run2)).toEqual({
      kind: 'close',
    });
    expect(laneConflictEffect([], two, false, null)).toEqual({
      kind: 'close',
    });
    expect(laneConflictEffect(['full-sdd'], [], false, null)).toBeNull();
  });

  it('a cancel closes the open reminder first: the same set left → a fresh "has N" in the draft wording (RL15)', () => {
    expect(laneConflictEffect(two, two, true, null)).toEqual({
      kind: 'post',
      lanes: two,
      still: false,
      run: null,
    });
  });

  it('a cancel or restart with at most one lane left: the end closed it already → nothing', () => {
    expect(laneConflictEffect(['code-only'], two, true, null)).toBeNull();
  });
});
