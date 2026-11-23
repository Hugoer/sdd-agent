import { describe, expect, it } from 'vitest';
import {
  approveHintReply,
  approveRefusedReply,
  approveWarningReply,
  documentDeletedComment,
  goSignalComment,
  lateCommentReply,
  nothingWaitsReply,
  refreshNothingChangedReply,
  refreshRefusedReply,
  refreshUpToDateReply,
  restoreRefusedReply,
  runEndedLine,
  planComment,
  planMarker,
  specComment,
  specMarker,
} from './document-comments.js';
import { diffBlock, documentText } from './document-text.js';

const COMMIT = '4f2c1ab'.padEnd(40, 'e');
const NOTES = [
  'Model: `gemini-4-carbon` (standard)',
  'Read: skill `money-rules` (`SKILL.md`), `src/index.ts`',
];

describe('specComment (spec "The document comment")', () => {
  it('full-sdd: marker, header, the Plan line, the document between its markers, the notes', () => {
    expect(
      specComment({
        versionId: 'v-1',
        version: 1,
        run: { number: 2, lane: 'full-sdd' },
        base: 'main',
        commit: COMMIT,
        text: '# Spec\n\nSplit evenly.',
        notes: NOTES,
      }),
    ).toBe(
      [
        '<!-- sdd-agent:spec:v-1 -->',
        '**Spec v1** · run 2 (`full-sdd`) · read at `main` @ `4f2c1ab`',
        '',
        "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the " +
          "bot writes the Plan from the text as it reads then. `/refresh` checks it against today's `main`.",
        '',
        '<!-- sdd-agent:document -->',
        '# Spec',
        '',
        'Split evenly.',
        '<!-- sdd-agent:document-end -->',
        '',
        '---',
        '<sub>Model: `gemini-4-carbon` (standard)</sub>',
        '<sub>Read: skill `money-rules` (`SKILL.md`), `src/index.ts`</sub>',
      ].join('\n'),
    );
  });

  it('spec-code: the approval starts the code; another base branch is named', () => {
    const body = specComment({
      versionId: 'v-2',
      version: 1,
      run: { number: 1, lane: 'spec-code' },
      base: 'develop',
      commit: COMMIT,
      text: 'x',
      notes: [],
    });

    expect(body).toContain(
      '**Spec v1** · run 1 (`spec-code`) · read at `develop` @ `4f2c1ab`',
    );
    expect(body).toContain(
      'comments `/approve` and the bot starts coding from the text as it reads then. `/refresh` checks it against ' +
        "today's `develop`.",
    );
    expect(body).not.toContain('---');
  });

  it('starts with its marker, and the document reads back as stored', () => {
    const body = specComment({
      versionId: 'v-3',
      version: 1,
      run: { number: 1, lane: 'full-sdd' },
      base: 'main',
      commit: COMMIT,
      text: '# Spec\n\nAsk `@alice`.',
      notes: NOTES,
    });

    expect(body.startsWith(specMarker('v-3'))).toBe(true);
    expect(documentText(body)).toBe('# Spec\n\nAsk `@alice`.');
  });
});

/** The answered comment's own link (plan P39). */
const LINK = 'https://github.com/o/r/issues/12#issuecomment-';
const answered = (id: string) => ({ id, url: `${LINK}${id}` });

describe('approveRefusedReply (spec "`/approve`", the verdict table)', () => {
  const SPEC_V1 = {
    kind: 'spec' as const,
    version: 1,
    url: 'https://github.com/o/r/issues/12#issuecomment-9',
    approvedBy: 'bob',
  };

  it('already-approved names who approved it', () => {
    expect(
      approveRefusedReply(
        answered('501'),
        'already-approved',
        SPEC_V1,
        'full-sdd',
      ),
    ).toBe(
      '<!-- sdd-agent:approve-refused:501 -->\n' +
        `[Your \`/approve\`](${LINK}501) changes nothing: Spec v1 is already approved (by \`bob\`).`,
    );
  });

  it('before-document links the waiting version', () => {
    expect(
      approveRefusedReply(
        answered('502'),
        'before-document',
        { ...SPEC_V1, version: 2, approvedBy: null },
        'full-sdd',
      ).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}502) was written before Spec v2 was posted, so it didn't count. Read ` +
        '[Spec v2](https://github.com/o/r/issues/12#issuecomment-9), then comment `/approve` again.',
    );
  });

  it('deleted points to /restore and to the lane label', () => {
    expect(
      approveRefusedReply(
        answered('503'),
        'deleted',
        SPEC_V1,
        'spec-code',
      ).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}503) has nothing to approve: Spec v1 was deleted. Comment \`/restore\` to get it ` +
        'back, or remove the ' +
        '`workflow: spec-code` label and add it again to start over.',
    );
  });

  it('empty asks to put the document back', () => {
    expect(
      approveRefusedReply(
        answered('504'),
        'empty',
        { ...SPEC_V1, kind: 'plan' },
        'full-sdd',
      ).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}504) has nothing to approve: Plan v1's comment has no text left between its ` +
        'markers. Edit the comment to put the Plan back, then comment `/approve`.',
    );
  });

  it('the go-signal is named by its comment', () => {
    expect(
      approveRefusedReply(
        answered('505'),
        'already-approved',
        { kind: 'go-signal', version: 1, url: null, approvedBy: 'bob' },
        'code-only',
      ).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}505) changes nothing: the **Ready to code** comment is already approved (by \`bob\`).`,
    );
  });

  it('P39: an event with no link (spec 2\'s signed test requests) → "Your `/approve`" as plain text', () => {
    expect(
      approveRefusedReply(
        { id: '506' },
        'already-approved',
        SPEC_V1,
        'full-sdd',
      ).split('\n')[1],
    ).toBe(
      'Your `/approve` changes nothing: Spec v1 is already approved (by `bob`).',
    );
  });
});

describe('nothingWaitsReply for `/approve` (spec "Replies where nothing waits")', () => {
  it.each([
    [
      'no-run',
      null,
      'has nothing to approve: this issue has no run. To start one, add a `workflow:` label.',
    ],
    ['starting', 2, 'has nothing to approve yet: run 2 is just starting.'],
    ['executing', 2, 'has nothing to approve: run 2 is writing the code.'],
    [
      'in-review',
      2,
      "has nothing to approve here: run 2's pull request is open; review it there.",
    ],
    [
      'stopped',
      2,
      'has nothing to approve now: run 2 is stopped. See the stop comment for how to continue.',
    ],
  ] as const)(
    '%s → its text, after the linked `/approve`',
    (situation, run, text) => {
      expect(
        nothingWaitsReply('approve', answered('601'), situation, run),
      ).toBe(
        `<!-- sdd-agent:approve-refused:601 -->\n[Your \`/approve\`](${LINK}601) ${text}`,
      );
    },
  );

  it('P40: no run, but a `workflow:` label is on → names it and how to start a run', () => {
    expect(
      nothingWaitsReply('approve', answered('602'), 'no-run', null, [
        'full-sdd',
      ]).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}602) has nothing to approve: \`workflow: full-sdd\` is on, but the bot has no ` +
        'run for it yet. If none starts within a few minutes, remove the label and add it again.',
    );
    expect(
      nothingWaitsReply('approve', answered('603'), 'no-run', null, [
        'full-sdd',
        'code-only',
      ]).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}603) has nothing to approve: \`workflow: full-sdd\` and \`workflow: code-only\` ` +
        'are on, but the bot has no run for them yet. If none starts within a few minutes, keep one `workflow:` ' +
        'label, then remove it and add it again.',
    );
  });
});

describe('approveHintReply and lateCommentReply (P39: the answered comment linked)', () => {
  it('the hint links the near miss', () => {
    expect(approveHintReply('s-1', answered('701'))).toBe(
      '<!-- sdd-agent:approve-hint:s-1 -->\n' +
        `[Your comment](${LINK}701) isn't an approval: to approve, comment exactly \`/approve\`, with nothing else.`,
    );
  });

  it('the late comment names its author and links the comment', () => {
    expect(lateCommentReply(answered('702'), 'alice')).toBe(
      '<!-- sdd-agent:late-comment:702 -->\n' +
        `\`alice\`, [your comment](${LINK}702) was written while the bot was writing the Spec, so the Spec doesn't ` +
        'include it. If it changes the Spec, someone with Write access can edit the Spec comment before `/approve`.',
    );
  });

  it('no link on the event → plain text', () => {
    expect(lateCommentReply({ id: '703' }, 'alice').split('\n')[1]).toMatch(
      /^`alice`, your comment was written while/,
    );
  });
});

describe('planComment (spec "The document comment")', () => {
  const PLAN_COMMIT = '9e1d0c2'.padEnd(40, 'f');
  const input = {
    versionId: 'p-1',
    version: 1,
    run: { number: 2 },
    base: 'main',
    commit: PLAN_COMMIT,
    specVersion: 1,
    warning: null,
    text: '# Plan',
    notes: ['Model: `gemini-4-carbon` (standard)'],
  };
  const URL = `https://github.com/o/r/compare/${COMMIT}...${PLAN_COMMIT}`;

  it('no warning: marker, header from the approved Spec, the coding line, the document, the notes', () => {
    expect(planComment(input)).toBe(
      [
        '<!-- sdd-agent:plan:p-1 -->',
        '**Plan v1** · run 2 (`full-sdd`) · from the approved Spec v1 · read at `main` @ `9e1d0c2`',
        '',
        "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the " +
          "bot starts coding from the approved Spec and this Plan as it reads then. `/refresh` checks both against today's `main`.",
        '',
        '<!-- sdd-agent:document -->',
        '# Plan',
        '<!-- sdd-agent:document-end -->',
        '',
        '---',
        '<sub>Model: `gemini-4-carbon` (standard)</sub>',
      ].join('\n'),
    );
    expect(planComment(input).startsWith(planMarker('p-1'))).toBe(true);
  });

  it('flagged files → the ⚠️ line with the compare link, before the coding line', () => {
    const lines = planComment({
      ...input,
      warning: {
        kind: 'stale',
        from: COMMIT,
        files: ['src/index.ts'],
        complete: true,
        compareUrl: URL,
      },
    }).split('\n');

    expect(lines[3]).toBe(
      `⚠️ Since the Spec was written (\`4f2c1ab\`), \`main\` changed \`src/index.ts\`, which it read ([compare](${URL})). ` +
        'This Plan reads the current code. If the change affects the Spec, comment `/refresh`.',
    );
    expect(lines[5].startsWith('To change it')).toBe(true);
  });

  it('more than five files → the first five and "and N more"; a cut list → "possibly more"', () => {
    const files = Array.from({ length: 7 }, (_, i) => `f${i}.ts`);
    const warning = {
      kind: 'stale' as const,
      from: COMMIT,
      files,
      complete: true,
      compareUrl: URL,
    };

    expect(planComment({ ...input, warning })).toContain(
      'changed `f0.ts`, `f1.ts`, `f2.ts`, `f3.ts`, `f4.ts` and 2 more, which it read',
    );
    expect(
      planComment({
        ...input,
        warning: { ...warning, files: ['a.ts'], complete: false },
      }),
    ).toContain('changed `a.ts` … and possibly more, which it read');
  });

  it('the comparison failed → the not-compared line', () => {
    expect(
      planComment({
        ...input,
        warning: { kind: 'not-compared', from: COMMIT },
      }).split('\n')[3],
    ).toBe(
      "⚠️ The bot couldn't compare `4f2c1ab` with `main`, so it can't tell whether the Spec is out of date.",
    );
  });
});

describe('approveWarningReply (SPW13, plan P4)', () => {
  const FROM = '9e1d0c2'.padEnd(40, '1');
  const URL = 'https://github.com/o/r/compare/a...b';
  const plan = {
    versionId: 'p-1',
    approve: { url: `${LINK}801` },
    document: { kind: 'plan' as const, version: 1 },
    lane: 'full-sdd' as const,
    base: 'main',
  };
  const stale = (flagged: { path: string; readers: ('own' | 'spec')[] }[]) =>
    approveWarningReply({
      ...plan,
      warning: {
        kind: 'stale',
        from: FROM,
        flagged,
        complete: true,
        compareUrl: URL,
      },
    });

  it('a file the Plan read: the spec’s text, with the compare link and the restart', () => {
    expect(stale([{ path: 'src/index.ts', readers: ['own'] }])).toBe(
      '<!-- sdd-agent:approve-warning:p-1 -->\n' +
        `[Your \`/approve\`](${LINK}801) approved Plan v1. Since it was written (\`9e1d0c2\`), \`main\` changed ` +
        '`src/index.ts`, which it read ' +
        `([compare](${URL})). The code is written from today's \`main\`, and the Coder is told which files ` +
        'changed. To write the Plan again instead, remove the `workflow: full-sdd` label and add it again.',
    );
  });

  it('P4: who read each file is named', () => {
    expect(stale([{ path: 'src/index.ts', readers: ['spec'] }])).toContain(
      'changed `src/index.ts`, which the approved Spec read ([compare]',
    );
    expect(
      stale([{ path: 'src/index.ts', readers: ['own', 'spec'] }]),
    ).toContain('changed `src/index.ts`, which it and the approved Spec read');
    expect(
      stale([
        { path: 'a.ts', readers: ['own'] },
        { path: 'b.ts', readers: ['spec'] },
        { path: 'c.ts', readers: ['own'] },
      ]),
    ).toContain(
      'changed `a.ts` and `c.ts`, which it read, and `b.ts`, which the approved Spec read ([compare]',
    );
  });

  it('spec-code: the Spec and its lane label', () => {
    expect(
      approveWarningReply({
        ...plan,
        document: { kind: 'spec', version: 2 },
        lane: 'spec-code',
        warning: {
          kind: 'stale',
          from: FROM,
          flagged: [{ path: 'src/index.ts', readers: ['own'] }],
          complete: true,
          compareUrl: URL,
        },
      }),
    ).toContain('approved Spec v2. Since it was written (`9e1d0c2`)');
  });

  it('the comparison failed → the not-compared reply', () => {
    expect(
      approveWarningReply({
        ...plan,
        warning: { kind: 'not-compared', from: FROM },
      }).split('\n')[1],
    ).toBe(
      `[Your \`/approve\`](${LINK}801) approved Plan v1. The bot couldn't compare \`9e1d0c2\` with \`main\`, so it ` +
        "can't tell whether files it read have changed.",
    );
  });
});

describe('goSignalComment (spec "The go-signal")', () => {
  it('its marker names the run; the coding line', () => {
    expect(goSignalComment({ id: 'run-1', number: 1 })).toBe(
      [
        '<!-- sdd-agent:go-signal:run-1 -->',
        '**Ready to code** · run 1 (`code-only`)',
        '',
        'The bot codes from the issue description, with no Spec or Plan. An Approver (Write access) comments ' +
          '`/approve` to start; the bot reads the title and description as they read then.',
      ].join('\n'),
    );
  });
});

describe('the refreshed and restored comments (spec "The v2 comment", the `/restore` table)', () => {
  const B = '9e1d0c2'.padEnd(40, 'b');
  const COMPARE = 'https://github.com/o/r/compare/a...b';
  const APPROVE_LINE =
    "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the bot " +
    "writes the Plan from the text as it reads then. `/refresh` checks it against today's `main`.";
  const refreshed = (
    diff: string | null = diffBlock('a\nb\nc\n', 'a\nB\nc\n'),
  ) => ({
    kind: 'refreshed' as const,
    previous: { version: 1, from: COMMIT },
    compareUrl: COMPARE,
    by: 'bob',
    command: { url: `${LINK}900` },
    changes: [
      '`split()` is now `splitEvenly()`; the Spec names the new function.',
    ],
    diff,
  });
  const specV2 = (
    origin: Parameters<typeof specComment>[0]['origin'],
    extra: Partial<Parameters<typeof specComment>[0]> = {},
  ) =>
    specComment({
      versionId: 's-2',
      version: 2,
      run: { number: 2, lane: 'full-sdd' },
      base: 'main',
      commit: B,
      text: 'a\nB\nc',
      notes: NOTES,
      origin,
      ...extra,
    });

  it('Spec v2: the header with both commits, "Refreshed for" linked, the changes, the document, the folded diff', () => {
    expect(specV2(refreshed())).toBe(
      [
        '<!-- sdd-agent:spec:s-2 -->',
        `**Spec v2** · run 2 (\`full-sdd\`) · replaces v1 above · read at \`main\` @ \`9e1d0c2\` (v1: \`4f2c1ab\`, [compare](${COMPARE}))`,
        '',
        `Refreshed for [\`bob\`'s \`/refresh\`](${LINK}900). What changed:`,
        '- `split()` is now `splitEvenly()`; the Spec names the new function.',
        '',
        APPROVE_LINE,
        '',
        '<!-- sdd-agent:document -->',
        'a',
        'B',
        'c',
        '<!-- sdd-agent:document-end -->',
        '',
        '<details><summary>Diff from v1 (as it read at the refresh)</summary>',
        '',
        '```diff',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '```',
        '',
        '</details>',
        '',
        '---',
        '<sub>Model: `gemini-4-carbon` (standard)</sub>',
        '<sub>Read: skill `money-rules` (`SKILL.md`), `src/index.ts`</sub>',
      ].join('\n'),
    );
  });

  it("while a Plan waited: the no-longer-counts line; GitHub couldn't compare (P32): no compare link", () => {
    const body = specV2(
      { ...refreshed(), compareUrl: null },
      { planNoLongerCounts: 1 },
    );
    expect(body).toContain(
      '- `split()` is now `splitEvenly()`; the Spec names the new function.\n\n' +
        'Plan v1 was written from Spec v1, so it no longer counts: approve this Spec and the bot writes a new Plan.\n\n' +
        'To change it',
    );
    expect(body).toContain('read at `main` @ `9e1d0c2` (v1: `4f2c1ab`)\n');
    expect(documentText(body)).toBe('a\nB\nc');
  });

  it('the comment would pass 65,000 characters → the diff is left out with its line', () => {
    const long = 'x'.repeat(40_000);
    const body = specV2(refreshed(diffBlock(`${long}\n`, `${long}y\n`)), {
      text: `${long}y`,
    });
    expect(body).not.toContain('<details>');
    expect(body).toContain(
      '<!-- sdd-agent:document-end -->\n\nThe diff is too long to show here; compare v1 and v2 above.\n\n---',
    );
  });

  it('Plan v2: from the approved Spec, replaces v1, "The approved Spec v1 is still up to date."', () => {
    const body = planComment({
      versionId: 'p-2',
      version: 2,
      run: { number: 2 },
      base: 'main',
      commit: B,
      specVersion: 1,
      warning: null,
      text: 'a\nB\nc',
      notes: [],
      origin: refreshed(),
    });
    expect(body.split('\n').slice(0, 5)).toEqual([
      '<!-- sdd-agent:plan:p-2 -->',
      `**Plan v2** · run 2 (\`full-sdd\`) · from the approved Spec v1 · replaces v1 above · read at \`main\` @ \`9e1d0c2\` (v1: \`4f2c1ab\`, [compare](${COMPARE}))`,
      '',
      `Refreshed for [\`bob\`'s \`/refresh\`](${LINK}900). The approved Spec v1 is still up to date. What changed:`,
      '- `split()` is now `splitEvenly()`; the Spec names the new function.',
    ]);
  });

  it('restored: the header names who asked (linked), then the restored or the lost-edits line; no diff', () => {
    const restored = (lost: boolean) =>
      specComment({
        versionId: 's-1b',
        version: 1,
        run: { number: 2, lane: 'full-sdd' },
        base: 'main',
        commit: COMMIT,
        text: '# Spec',
        notes: NOTES,
        origin: {
          kind: 'restored',
          by: 'alice',
          command: { url: `${LINK}901` },
          lost,
        },
      });
    expect(restored(false).split('\n').slice(1, 5)).toEqual([
      `**Spec v1** (restored for [\`alice\`'s \`/restore\`](${LINK}901)) · run 2 (\`full-sdd\`) · read at \`main\` @ \`4f2c1ab\``,
      '',
      'Restored as it read when it was deleted.',
      '',
    ]);
    expect(restored(true)).toContain(
      '\nThe bot missed the deletion, so this is its last version: edits made to the deleted comment are lost.\n',
    );
    expect(restored(true)).not.toContain('<details>');
  });
});

describe('the refresh replies (spec "`/refresh`")', () => {
  const B = '9e1d0c2'.padEnd(40, 'b');
  const YOURS = `[Your \`/refresh\`](${LINK}910)`;
  const reply = (body: string) => body.split('\n').slice(1).join('\n');

  it.each([
    [
      'deleted',
      { kind: 'spec', version: 1 },
      'has nothing to refresh: Spec v1 was deleted. Comment `/restore` to get it back, then `/refresh`.',
    ],
    [
      'empty',
      { kind: 'plan', version: 2 },
      "has nothing to refresh: Plan v2's comment has no text left between its markers. Edit the comment to put the " +
        'Plan back, then comment `/refresh`.',
    ],
    [
      'already-approved',
      { kind: 'spec', version: 1 },
      "can't refresh Spec v1: it's already approved.",
    ],
  ] as const)(
    '%s → one reply, marker refresh:<comment>',
    (refusal, document, text) => {
      const body = refreshRefusedReply(answered('910'), refusal, document);
      expect(body.split('\n')[0]).toBe('<!-- sdd-agent:refresh:910 -->');
      expect(reply(body)).toBe(`${YOURS} ${text}`);
    },
  );

  it('nothing changed: written, last checked, both documents', () => {
    const text = (
      documents: { kind: 'spec' | 'plan'; version: number }[],
      checked: boolean,
    ) =>
      reply(
        refreshNothingChangedReply(answered('910'), {
          documents,
          base: 'main',
          commit: COMMIT,
          checked,
        }),
      );
    expect(text([{ kind: 'spec', version: 1 }], false)).toBe(
      `${YOURS} has nothing to refresh: nothing changed on \`main\` since Spec v1 was written (\`4f2c1ab\`).`,
    );
    expect(
      text(
        [
          { kind: 'spec', version: 1 },
          { kind: 'plan', version: 1 },
        ],
        true,
      ),
    ).toBe(
      `${YOURS} has nothing to refresh: nothing changed on \`main\` since Spec v1 and Plan v1 were last checked ` +
        '(`4f2c1ab`).',
    );
  });

  it('up to date: the Spec with its files and compare link, then the notes', () => {
    expect(
      refreshUpToDateReply(
        answered('910'),
        'main',
        B,
        {
          kind: 'spec',
          spec: 1,
          from: COMMIT,
          changed: { files: 3, complete: true, compareUrl: 'https://c' },
        },
        NOTES,
      ),
    ).toBe(
      '<!-- sdd-agent:refresh:910 -->\n' +
        `${YOURS} checked Spec v1 against \`main\` @ \`9e1d0c2\`: still up to date. 3 files changed since \`4f2c1ab\` ` +
        '([compare](https://c)); nothing in the Spec needs to change.\n\n---\n' +
        '<sub>Model: `gemini-4-carbon` (standard)</sub>\n<sub>Read: skill `money-rules` (`SKILL.md`), `src/index.ts`</sub>',
    );
  });

  it('up to date: 1 file, a cut list, not compared (P32), the Plan at that commit, both', () => {
    const text = (upToDate: Parameters<typeof refreshUpToDateReply>[3]) =>
      reply(refreshUpToDateReply(answered('910'), 'main', B, upToDate, []));
    const spec = (
      changed: { files: number; complete: boolean; compareUrl: string } | null,
    ) => text({ kind: 'spec', spec: 1, from: COMMIT, changed });
    expect(spec({ files: 1, complete: true, compareUrl: 'u' })).toContain(
      'still up to date. 1 file changed since',
    );
    expect(spec({ files: 300, complete: false, compareUrl: 'u' })).toContain(
      '300 or more files changed since',
    );
    expect(spec(null)).toContain(
      "still up to date. The bot couldn't list the files changed since `4f2c1ab`; nothing in the Spec needs to change.",
    );
    expect(text({ kind: 'plan-at-commit', spec: 1, plan: 1 })).toBe(
      `${YOURS} checked Spec v1 against \`main\` @ \`9e1d0c2\`: still up to date, and Plan v1 was already written at ` +
        'that commit.',
    );
    expect(text({ kind: 'both', spec: 1, plan: 2 })).toBe(
      `${YOURS} checked Spec v1 and Plan v2 against \`main\` @ \`9e1d0c2\`: both still up to date.`,
    );
  });
});

describe('nothingWaitsReply for `/refresh` and `/restore` (spec "Replies where nothing waits")', () => {
  it.each([
    [
      'refresh',
      'no-run',
      'has nothing to refresh: this issue has no run. To start one, add a `workflow:` label.',
    ],
    [
      'refresh',
      'starting',
      'has nothing to refresh yet: run 2 is just starting.',
    ],
    [
      'refresh',
      'grilling',
      "has nothing to refresh yet: run 2 is still at Grill Me, so there's no Spec.",
    ],
    [
      'refresh',
      'executing',
      'comes too late: run 2 is already writing the code from the approved texts.',
    ],
    ['refresh', 'in-review', "comes too late: run 2's pull request is open."],
    [
      'refresh',
      'stopped',
      'has nothing to refresh now: run 2 is stopped. Continue it first (see the stop comment), then comment `/refresh`.',
    ],
    [
      'refresh',
      'code-only',
      'has nothing to refresh: a `code-only` run has no Spec or Plan; the bot codes from the issue description as it ' +
        'reads at `/approve`.',
    ],
    [
      'restore',
      'no-run',
      'has nothing to restore: this issue has no run. To start one, add a `workflow:` label.',
    ],
    [
      'restore',
      'starting',
      'has nothing to restore yet: run 2 is just starting.',
    ],
    [
      'restore',
      'grilling',
      "has nothing to restore: run 2 is still at Grill Me, so there's no Spec.",
    ],
    [
      'restore',
      'executing',
      'has nothing to restore: the bot keeps the approved texts.',
    ],
    [
      'restore',
      'in-review',
      'has nothing to restore: the bot keeps the approved texts.',
    ],
    [
      'restore',
      'stopped',
      'has nothing to restore now: run 2 is stopped. Continue it first (see the stop comment), then comment `/restore`.',
    ],
    [
      'restore',
      'code-only',
      'has nothing to restore: a `code-only` run has no Spec or Plan.',
    ],
  ] as const)('/%s, %s → its text', (command, situation, text) => {
    expect(
      nothingWaitsReply(
        command,
        answered('920'),
        situation,
        situation === 'no-run' ? null : 2,
      ),
    ).toBe(
      `<!-- sdd-agent:${command}-refused:920 -->\n[Your \`/${command}\`](${LINK}920) ${text}`,
    );
  });

  it('P40: a workflow label on with no run → named, for /refresh too', () => {
    expect(
      nothingWaitsReply('refresh', answered('921'), 'no-run', null, [
        'spec-code',
      ]),
    ).toContain(
      'has nothing to refresh: `workflow: spec-code` is on, but the bot has no run for it yet.',
    );
  });

  it('/approve has no grilling or code-only text (spec 6 answers it; the go-signal waits)', () => {
    expect(() =>
      nothingWaitsReply('approve', answered('922'), 'grilling', 2),
    ).toThrow('no /approve reply where nothing waits: grilling');
  });
});

describe('no text of spec 7 notifies anyone: every login in backticks', () => {
  it('no `@` outside backticks in the refresh and restore texts', () => {
    const texts = [
      refreshRefusedReply(answered('1'), 'deleted', {
        kind: 'spec',
        version: 1,
      }),
      refreshNothingChangedReply(answered('1'), {
        documents: [{ kind: 'spec', version: 1 }],
        base: 'main',
        commit: COMMIT,
        checked: false,
      }),
      ...(['refresh', 'restore'] as const).flatMap((command) =>
        (
          [
            'no-run',
            'starting',
            'grilling',
            'executing',
            'in-review',
            'stopped',
            'code-only',
          ] as const
        ).map((situation) =>
          nothingWaitsReply(command, { id: '1' }, situation, 2, ['full-sdd']),
        ),
      ),
    ];
    for (const text of texts)
      expect(text.replace(/`[^`]*`/g, '')).not.toContain('@');
  });
});

describe('documentDeletedComment (SP9)', () => {
  it('who deleted it, /restore, or start over with the lane label', () => {
    expect(
      documentDeletedComment('77', {
        kind: 'spec',
        version: 1,
        by: 'bob',
        lane: 'full-sdd',
        stoppedRun: null,
      }),
    ).toBe(
      '<!-- sdd-agent:doc-deleted:77 -->\n' +
        "The Spec comment (v1) was deleted by `bob`, so there's nothing to approve. To get it back, comment " +
        '`/restore`: the bot posts it again as it read when it was deleted. To start over instead, remove the ' +
        '`workflow: full-sdd` label and add it again.',
    );
  });

  it('a stopped run: continue it first', () => {
    expect(
      documentDeletedComment('78', {
        kind: 'plan',
        version: 2,
        by: 'bob',
        lane: 'full-sdd',
        stoppedRun: 2,
      }),
    ).toContain('The Plan comment (v2) was deleted by `bob`');
    expect(
      documentDeletedComment('78', {
        kind: 'plan',
        version: 2,
        by: 'bob',
        lane: 'full-sdd',
        stoppedRun: 2,
      }).endsWith(
        '\n\nRun 2 is stopped: continue it first (see the stop comment), then comment `/restore`.',
      ),
    ).toBe(true);
  });
});

describe("restoreRefusedReply (the spec's `/restore` table)", () => {
  it('still there → its link; approved → the bot keeps the approved text', () => {
    expect(
      restoreRefusedReply(answered('930'), 'nothing-deleted', {
        kind: 'spec',
        version: 1,
        url: 'https://c/1',
      }),
    ).toBe(
      '<!-- sdd-agent:restore:930 -->\n' +
        `[Your \`/restore\`](${LINK}930) has nothing to restore: Spec v1 is still on the issue ([link](https://c/1)).`,
    );
    expect(
      restoreRefusedReply(answered('931'), 'approved', {
        kind: 'spec',
        version: 2,
        url: null,
      }).split('\n')[1],
    ).toBe(
      `[Your \`/restore\`](${LINK}931) has nothing to restore: Spec v2 is already approved; the bot keeps the approved text.`,
    );
  });
});

describe('runEndedLine (SPW10)', () => {
  const SPEC = { kind: 'spec' as const, version: 1, url: 'https://c/s1' };
  const PLAN = { kind: 'plan' as const, version: 1, url: 'https://c/p1' };

  it('a replacement: both linked, the new run named', () => {
    expect(
      runEndedLine({
        run: 1,
        end: { kind: 'replaced', by: { number: 2, lane: 'spec-code' } },
        documents: [SPEC, PLAN],
      }),
    ).toBe(
      "[Spec v1](https://c/s1) and [Plan v1](https://c/p1) belonged to run 1 and no longer count. Run 2 doesn't " +
        'use them: it works from the issue description and its own Grill Me answers. To keep anything from them, ' +
        'copy it into the description.',
    );
  });

  it('a cancel with one document: "A new run", the singular', () => {
    expect(
      runEndedLine({ run: 3, end: { kind: 'cancelled' }, documents: [SPEC] }),
    ).toBe(
      "[Spec v1](https://c/s1) belonged to run 3 and no longer counts. A new run doesn't use it: it works from the " +
        'issue description and its own Grill Me answers. To keep anything from it, copy it into the description.',
    );
  });

  it('no document → null', () => {
    expect(
      runEndedLine({ run: 1, end: { kind: 'cancelled' }, documents: [] }),
    ).toBeNull();
  });
});
