import { describe, expect, it } from 'vitest';
import { methodChange, refreshFrame, refreshTurns } from './refresh-frame.js';

const FROM = '4f2c1ab'.padEnd(40, '0');
const TO = '9e1d0c2'.padEnd(40, '0');

describe('refreshFrame (spec "Refresh frame")', () => {
  it('the Spec: both commits, the changed files (its reads marked *), the rules, the answer', () => {
    expect(
      refreshFrame({
        kind: 'spec',
        from: FROM,
        to: TO,
        changes: {
          paths: ['README.md', 'src/index.ts'],
          read: ['src/index.ts'],
          complete: true,
        },
      }),
    ).toBe(
      `You are the Spec step of a spec-driven workflow on a GitHub issue, asked to bring an existing Spec up to
date with the repository. The Spec below was written at commit ${FROM}; the repository is now at commit ${TO}.
These files changed since, * marking the ones the Spec read: README.md, src/index.ts *.

Read what you need with read_file at ${TO}. Then change only what the new code makes wrong or incomplete, and keep
everything else exactly as written, including the edits people made: the same sections, wording and order. If the
method below says how to update a Spec, follow it.

Answer with:
- upToDate: true when nothing needs to change; then leave changes and document empty.
- changes: what you changed and why, one short line each, at most 10.
- document: the whole updated Spec, at most 50,000 characters, in its language. Write logins in backticks
  and add no HTML comments.`,
    );
  });

  it('the Plan: what to build still comes from the approved Spec', () => {
    const frame = refreshFrame({
      kind: 'plan',
      from: FROM,
      to: TO,
      changes: { paths: ['a.ts'], read: [], complete: false },
    });
    expect(frame).toContain('asked to bring an existing Plan up to\ndate');
    expect(frame).toContain('the ones the Plan read: a.ts, and possibly more.');
    expect(frame).toContain(
      "If the\nmethod below says how to update a Plan, follow it.\nWhat to build still comes from the approved Spec below; don't add anything it doesn't ask for.\n",
    );
  });

  it("P32: GitHub couldn't compare → read what you need", () => {
    expect(
      refreshFrame({ kind: 'spec', from: FROM, to: TO, changes: null }),
    ).toContain(
      `the repository is now at commit ${TO}.\nThe bot couldn't list the files changed since ${FROM}; read what you need.\n`,
    );
  });

  it('P41: the paths the read tools hide are never named; only those → none you can read', () => {
    const frame = (paths: string[]) =>
      refreshFrame({
        kind: 'spec',
        from: FROM,
        to: TO,
        changes: { paths, read: [], complete: true },
      });
    expect(
      frame(['.github-agent/workflow.json', 'CLAUDE.md', 'src/index.ts']),
    ).toContain('the ones the Spec read: src/index.ts.');
    expect(
      frame(['.github-agent/workflow.json', 'CLAUDE.md', 'src/index.ts']),
    ).not.toMatch(/github-agent|CLAUDE/);
    expect(frame(['.github-agent/skills/spec/SKILL.md'])).toContain(
      'None of the files you can read changed since.',
    );
  });
});

describe('refreshTurns', () => {
  it('a Spec: the title, then the Spec to update, both untrusted, keyed by version', () => {
    const [turn] = refreshTurns({
      issue: '#12',
      title: 'Split bills',
      document: { kind: 'spec', id: 's-1', version: 1, text: '# Spec' },
    });
    expect(turn.blocks).toEqual([
      { kind: 'text', text: 'Issue #12 title:' },
      {
        kind: 'untrusted',
        source: { key: 'title', label: 'the issue title' },
        text: 'Split bills',
      },
      { kind: 'text', text: 'Spec v1 to update:' },
      {
        kind: 'untrusted',
        source: { key: 'spec-s-1', label: 'the Spec to update' },
        text: '# Spec',
      },
    ]);
  });

  it('a Plan: the approved Spec before the Plan to update', () => {
    const [turn] = refreshTurns({
      issue: '#12',
      title: 'Split bills',
      document: { kind: 'plan', id: 'p-1', version: 1, text: '# Plan' },
      approvedSpec: {
        id: 's-1',
        version: 1,
        approvedBy: 'bob',
        text: '# Spec',
      },
    });
    expect(turn.blocks.slice(2)).toEqual([
      { kind: 'text', text: 'Approved Spec (v1, approved by `bob`):' },
      {
        kind: 'untrusted',
        source: { key: 'spec-s-1', label: 'the approved Spec' },
        text: '# Spec',
      },
      { kind: 'text', text: 'Plan v1 to update:' },
      {
        kind: 'untrusted',
        source: { key: 'plan-p-1', label: 'the Plan to update' },
        text: '# Plan',
      },
    ]);
  });
});

describe('the method sentence (spec 14, UAW7)', () => {
  const SENTENCE =
    'If the\nmethod below says how to update a Spec, follow it. The method below changed since the Spec was ' +
    'written. Where the Spec no longer follows it, change that too, even when that adds, renames or removes a ' +
    'section; keep everything else as written.\n';
  const frame = (paths: string[], method?: 'changed' | 'may-have-changed') =>
    refreshFrame({
      kind: 'spec',
      from: FROM,
      to: TO,
      changes: { paths, read: [], complete: true },
      method,
    });

  it('changed → the sentence right after "follow it."; absent → none', () => {
    expect(frame(['src/index.ts'], 'changed')).toContain(SENTENCE);
    expect(frame(['src/index.ts'])).not.toContain('The method below');
  });

  it('may-have-changed → the same sentence with "may have changed"; a Plan’s line follows it', () => {
    expect(frame(['src/index.ts'], 'may-have-changed')).toContain(
      'The method below may have changed since the Spec was written.',
    );
    expect(
      refreshFrame({
        kind: 'plan',
        from: FROM,
        to: TO,
        changes: null,
        method: 'changed',
      }),
    ).toContain(
      'keep everything else as written.\nWhat to build still comes from the approved Spec below;',
    );
  });

  it('only the skill’s hidden paths changed → "None of the files you can read changed since." and the sentence; no `.github-agent/` path', () => {
    const text = frame(['.github-agent/skills/spec/SKILL.md'], 'changed');
    expect(text).toContain('None of the files you can read changed since.');
    expect(text).toContain('The method below changed since the Spec');
    expect(text).not.toMatch(/github-agent/i);
  });
});

describe('methodChange (spec 14, UAW7)', () => {
  const FOLDER = '.github-agent/skills/spec';

  it('a path under the step skill’s folder → changed, even in a cut list', () => {
    expect(
      methodChange(
        { paths: ['src/a.ts', `${FOLDER}/SKILL.md`], complete: true },
        FOLDER,
      ),
    ).toBe('changed');
    expect(
      methodChange({ paths: [`${FOLDER}/refs/x.md`], complete: false }, FOLDER),
    ).toBe('changed');
  });

  it('none of its files: complete → nothing; cut → may-have-changed; not compared → may-have-changed', () => {
    const others = ['src/a.ts', '.github-agent/skills/specs-other/SKILL.md'];
    expect(methodChange({ paths: others, complete: true }, FOLDER)).toBe(
      undefined,
    );
    expect(methodChange({ paths: others, complete: false }, FOLDER)).toBe(
      'may-have-changed',
    );
    expect(methodChange(null, FOLDER)).toBe('may-have-changed');
  });
});
