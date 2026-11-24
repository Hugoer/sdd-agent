import { describe, expect, it } from 'vitest';
import {
  chainReads,
  flaggedFiles,
  namedFiles,
  questionFor,
  startOf,
  type Read,
} from './commit-check.js';

describe('chainReads (SP3, plan P4)', () => {
  const file = { kind: 'file', skill: null };
  const loads = [
    { logId: 'plan-2', path: 'src/split.ts', ...file },
    { logId: 'plan-1', path: 'src/money.ts', ...file },
    { logId: 'spec-1', path: 'src/index.ts', ...file },
    { logId: 'other', path: 'README.md', ...file },
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
      { path: 'src/split.ts', reader: 'own', skill: null },
      { path: 'src/money.ts', reader: 'own', skill: null },
      { path: 'src/index.ts', reader: 'spec', skill: null },
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
    ).toEqual([{ path: 'src/index.ts', reader: 'own', skill: null }]);
  });

  it('a step skill’s file carries its step (spec 14, plan UP5); a repo skill’s does not', () => {
    expect(
      chainReads(
        'spec',
        [{ kind: 'spec', logId: 'spec-1' }],
        [
          {
            logId: 'spec-1',
            path: '.github-agent/skills/spec/SKILL.md',
            kind: 'step-skill',
            skill: 'spec',
          },
          {
            logId: 'spec-1',
            path: 'skills/money/SKILL.md',
            kind: 'repo-skill',
            skill: 'money',
          },
        ],
      ),
    ).toEqual([
      {
        path: '.github-agent/skills/spec/SKILL.md',
        reader: 'own',
        skill: 'spec',
      },
      { path: 'skills/money/SKILL.md', reader: 'own', skill: null },
    ]);
  });
});

describe('startOf (spec 14, UAW3)', () => {
  const doc = { askedCommit: 'q', checkedCommit: 'c', commit: 'w' };

  it('the last question’s commit over where a refresh checked it over where it was written', () => {
    expect(startOf(doc)).toEqual({ commit: 'q', kind: 'asked' });
    expect(startOf({ ...doc, askedCommit: null })).toEqual({
      commit: 'c',
      kind: 'checked',
    });
    expect(startOf({ ...doc, askedCommit: null, checkedCommit: null })).toEqual(
      { commit: 'w', kind: 'written' },
    );
    expect(
      startOf({ askedCommit: null, checkedCommit: null, commit: null }),
    ).toBeNull();
  });
});

describe('questionFor (spec 14, UA1, UA3, UAW5)', () => {
  const read = (path: string, data: Partial<Read> = {}): Read => ({
    path,
    reader: 'own',
    skill: null,
    ...data,
  });
  const paths = (count: number) =>
    Array.from({ length: count }, (_, i) => `bulk/f${i}.txt`);
  const ask = (
    changed: { paths: string[]; complete: boolean } | 'not-compared',
    reads: Read[] = [read('src/index.ts')],
  ) => questionFor({ changed, reads, threshold: 15 });

  it('a read file changed → stale, even with more than the threshold changed', () => {
    expect(
      ask({ paths: [...paths(20), 'src/index.ts'], complete: true }),
    ).toEqual({
      result: 'stale',
      flagged: [{ path: 'src/index.ts', readers: ['own'] }],
      skills: [],
      complete: true,
      changedFiles: 21,
    });
  });

  it('none read: threshold + 1 → large-change, threshold → none', () => {
    expect(ask({ paths: paths(16), complete: true })).toEqual({
      result: 'large-change',
      changedFiles: 16,
      complete: true,
    });
    expect(ask({ paths: paths(15), complete: true })).toBeNull();
    expect(ask({ paths: [], complete: true })).toBeNull();
  });

  it('a cut list: with a read file → stale, incomplete; without → large-change', () => {
    expect(
      ask({ paths: [...paths(299), 'src/index.ts'], complete: false }),
    ).toMatchObject({ result: 'stale', complete: false, changedFiles: 300 });
    expect(ask({ paths: paths(300), complete: false })).toEqual({
      result: 'large-change',
      changedFiles: 300,
      complete: false,
    });
  });

  it('not compared → not-compared', () => {
    expect(ask('not-compared')).toEqual({ result: 'not-compared' });
  });

  it('the step skills of the flagged files, spec before plan; a skill file that didn’t change is not named', () => {
    const reads = [
      read('.github-agent/skills/plan/SKILL.md', { skill: 'plan' }),
      read('.github-agent/skills/spec/SKILL.md', {
        reader: 'spec',
        skill: 'spec',
      }),
      read('.github-agent/skills/spec/extra.md', { skill: 'spec' }),
    ];
    expect(
      ask(
        {
          paths: [
            '.github-agent/skills/plan/SKILL.md',
            '.github-agent/skills/spec/SKILL.md',
          ],
          complete: true,
        },
        reads,
      ),
    ).toMatchObject({ skills: ['spec', 'plan'] });
    expect(
      ask(
        { paths: ['.github-agent/skills/plan/SKILL.md'], complete: true },
        reads,
      ),
    ).toMatchObject({ skills: ['plan'] });
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
