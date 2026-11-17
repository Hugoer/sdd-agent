import { describe, expect, it } from 'vitest';
import { ProviderError } from '../contracts/provider-error.js';
import {
  markError,
  routerMarkOf,
  type RouterMark,
} from './router-error-mark.js';

const mark: RouterMark = {
  taskId: 't-1',
  step: 'grill',
  retry: true,
  stale: false,
};

describe('the router mark on an error (plan P2)', () => {
  it('marks the same object: the worker still sees a ProviderError', () => {
    const error = new ProviderError('GitHub is down', 'permanent');

    const marked = markError(error, mark);

    expect(marked).toBe(error);
    expect(marked).toBeInstanceOf(ProviderError);
    expect(routerMarkOf(marked)).toEqual(mark);
  });

  it('keeps a copy: a later change of the job never reaches a thrown error', () => {
    const live = { ...mark };
    const marked = markError(new Error('x'), live);

    live.step = 'spec';

    expect(routerMarkOf(marked)?.step).toBe('grill');
  });

  it('a thrown non-object becomes an Error with the mark', () => {
    const marked = markError('boom', mark);

    expect(marked).toBeInstanceOf(Error);
    expect((marked as Error).message).toBe('boom');
    expect(routerMarkOf(marked)).toEqual(mark);
  });

  it('an unmarked error (intake) has no mark', () => {
    expect(routerMarkOf(new ProviderError('x', 'transient'))).toBeNull();
    expect(routerMarkOf('boom')).toBeNull();
    expect(routerMarkOf(undefined)).toBeNull();
  });
});
