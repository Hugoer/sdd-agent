import { describe, expect, it } from 'vitest';
import { refreshOutputSchema } from './refresh-output.js';

const issues = (value: unknown) => {
  const result = refreshOutputSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ message }) => message);
};

describe('refreshOutputSchema (spec "Refresh frame")', () => {
  it('up to date with nothing else, or changed with its lines and the whole document → valid', () => {
    expect(issues({ upToDate: true, changes: [], document: '' })).toEqual([]);
    expect(
      issues({
        upToDate: false,
        changes: ['Names `splitEvenly()`.'],
        document: '# Spec',
      }),
    ).toEqual([]);
  });

  it('upToDate with changes or a document → refused', () => {
    const message =
      'upToDate is true, so leave changes and document empty; if something must change, set upToDate to false';
    expect(issues({ upToDate: true, changes: ['x'], document: '' })).toEqual([
      message,
    ]);
    expect(issues({ upToDate: true, changes: [], document: '# Spec' })).toEqual(
      [message],
    );
  });

  it('changed with a blank document or no change line → refused', () => {
    expect(
      issues({ upToDate: false, changes: ['x'], document: '  \n' }),
    ).toEqual([
      'upToDate is false, so document must be the whole updated text',
    ]);
    expect(
      issues({ upToDate: false, changes: [], document: '# Spec' }),
    ).toEqual([
      'upToDate is false, so changes must say what you changed and why, one short line each',
    ]);
  });

  it('11 change lines → refused', () => {
    expect(
      refreshOutputSchema.safeParse({
        upToDate: false,
        changes: Array.from({ length: 11 }, (_, i) => `change ${i}`),
        document: '# Spec',
      }).success,
    ).toBe(false);
  });

  it('a 60,000-character document → refused with P2\'s message, as spec 4 reports it ("document: …")', () => {
    const result = refreshOutputSchema.safeParse({
      upToDate: false,
      changes: ['x'],
      document: 'x'.repeat(60_000),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['document'],
        message: '60,000 characters, at most 50,000 fit',
      }),
    ]);
  });
});
