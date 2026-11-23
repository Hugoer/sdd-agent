import { describe, expect, it } from 'vitest';
import {
  approveHintReply,
  approveNothingWaitsReply,
  approveRefusedReply,
  approveWarningReply,
  goSignalComment,
  lateCommentReply,
  planComment,
  planMarker,
  specComment,
  specMarker,
} from './document-comments.js';
import { documentText } from './document-text.js';

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

describe('approveNothingWaitsReply (spec "Replies where nothing waits")', () => {
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
      expect(approveNothingWaitsReply(answered('601'), situation, run)).toBe(
        `<!-- sdd-agent:approve-refused:601 -->\n[Your \`/approve\`](${LINK}601) ${text}`,
      );
    },
  );
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
