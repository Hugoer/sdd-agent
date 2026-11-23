import { describe, expect, it } from 'vitest';
import { chainReads, flaggedFiles, namedFiles } from './commit-check.js';

describe('chainReads (SP3, plan P4)', () => {
  const loads = [
    { logId: 'plan-2', path: 'src/split.ts' },
    { logId: 'plan-1', path: 'src/money.ts' },
    { logId: 'spec-1', path: 'src/index.ts' },
    { logId: 'other', path: 'README.md' },
  ];

  it('a Plan: its own versions’ reads are `own`, the approved Spec’s are `spec`; other calls are left out', () => {
    expect(
      chainReads(
        'plan',
        [
          { kind: 'plan', logId: 'plan-2' },
          { kind: 'plan', logId: 'plan-1' },
          { kind: 'spec', logId: 'spec-1' },
        ],
        loads,
      ),
    ).toEqual([
      { path: 'src/split.ts', reader: 'own' },
      { path: 'src/money.ts', reader: 'own' },
      { path: 'src/index.ts', reader: 'spec' },
    ]);
  });

  it('a restored version has no call: the chain reaches its first writer', () => {
    expect(
      chainReads(
        'spec',
        [
          { kind: 'spec', logId: null },
          { kind: 'spec', logId: 'spec-1' },
        ],
        loads,
      ),
    ).toEqual([{ path: 'src/index.ts', reader: 'own' }]);
  });
});

describe('flaggedFiles (SP3)', () => {
  it('the changed paths that were read, in the changed order, with every reader (own first)', () => {
    expect(
      flaggedFiles(
        ['README.md', 'src/index.ts', 'src/split.ts'],
        [
          { path: 'src/split.ts', reader: 'spec' },
          { path: 'src/index.ts', reader: 'spec' },
          { path: 'src/index.ts', reader: 'own' },
        ],
      ),
    ).toEqual([
      { path: 'src/index.ts', readers: ['own', 'spec'] },
      { path: 'src/split.ts', readers: ['spec'] },
    ]);
  });

  it('nothing read changed → none', () => {
    expect(
      flaggedFiles(['README.md'], [{ path: 'src/a.ts', reader: 'own' }]),
    ).toEqual([]);
  });
});

describe('namedFiles (the warning line’s list)', () => {
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `f${i + 1}`);

  it('one, two, five; more than five → the first five and "and N more"', () => {
    expect(namedFiles(['src/index.ts'], true)).toBe('`src/index.ts`');
    expect(namedFiles(paths(2), true)).toBe('`f1` and `f2`');
    expect(namedFiles(paths(5), true)).toBe('`f1`, `f2`, `f3`, `f4` and `f5`');
    expect(namedFiles(paths(8), true)).toBe(
      '`f1`, `f2`, `f3`, `f4`, `f5` and 3 more',
    );
  });

  it('a list the host cut → "… and possibly more"', () => {
    expect(namedFiles(paths(2), false)).toBe('`f1`, `f2` … and possibly more');
    expect(namedFiles(paths(6), false)).toBe(
      '`f1`, `f2`, `f3`, `f4`, `f5`, 1 more … and possibly more',
    );
  });
});
