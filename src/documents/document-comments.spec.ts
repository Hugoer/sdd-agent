import { describe, expect, it } from 'vitest';
import {
  approveAskedMarker,
  approveAskedReply,
  approveHintReply,
  approveRefusedReply,
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

describe('approveAskedReply (spec 14 "The question")', () => {
  const A = '4f2c1ab'.padEnd(40, 'a');
  const P = '9e1d0c2'.padEnd(40, 'b');
  const Q = 'b71e4d8'.padEnd(40, 'c');
  const C = 'c3d9a10'.padEnd(40, 'd');
  const CMP =
    'https://github.com/Hugoer/sdd-agent-sandbox/compare/4f2c1ab...b71e4d8';
  const QUESTION = `${LINK}700`;
  const spec = {
    approve: answered('501'),
    document: { kind: 'spec' as const, version: 1 },
    base: 'main',
    start: { commit: A, kind: 'written' as const },
    questionUrl: null,
    compareUrl: CMP,
  };
  const plan = {
    ...spec,
    document: { kind: 'plan' as const, version: 1 },
    specVersion: 1,
    start: { commit: P, kind: 'written' as const },
    compareUrl: '…',
  };
  const stale = (
    flagged: { path: string; readers: ('own' | 'spec')[] }[],
    data: { skills?: string[]; complete?: boolean } = {},
  ) => ({
    result: 'stale' as const,
    flagged,
    skills: [],
    complete: true,
    changedFiles: flagged.length,
    ...data,
  });
  const yours = `[Your \`/approve\`](${LINK}501)`;
  const text = (body: string) => body.split('\n').slice(1).join('\n');

  it('Spec, files changed: the marker, the file "which it read", the compare link, the two ways on', () => {
    const body = approveAskedReply({
      ...spec,
      question: stale([{ path: 'src/index.ts', readers: ['own'] }]),
    });
    expect(body.split('\n')[0]).toBe(approveAskedMarker('501'));
    expect(approveAskedMarker('501')).toBe(
      '<!-- sdd-agent:approve-asked:501 -->',
    );
    expect(text(body)).toBe(
      `${yours} didn't count yet: since Spec v1 was written (\`4f2c1ab\`), \`main\` changed \`src/index.ts\`, which ` +
        `it read ([compare](${CMP})). Comment \`/refresh\` to bring it up to date with \`main\`, or \`/approve\` ` +
        'again to approve it as it is.',
    );
  });

  it('Plan (plan P4’s grouping): its own reads and the approved Spec’s; both documents named', () => {
    expect(
      text(
        approveAskedReply({
          ...plan,
          question: stale([
            { path: 'src/index.ts', readers: ['own'] },
            { path: 'README.md', readers: ['spec'] },
          ]),
        }),
      ),
    ).toBe(
      `${yours} didn't count yet: since Plan v1 was written (\`9e1d0c2\`), \`main\` changed \`src/index.ts\`, which ` +
        'it read, and `README.md`, which the approved Spec read ([compare](…)). Comment `/refresh` to bring Spec v1 ' +
        'and Plan v1 up to date with `main`, or `/approve` again to approve Plan v1 as it is.',
    );
    expect(
      approveAskedReply({
        ...plan,
        question: stale([{ path: 'AGENTS.md', readers: ['own', 'spec'] }]),
      }),
    ).toContain('changed `AGENTS.md`, which it and the approved Spec read (');
  });

  it('a step skill’s file (UAW6, plan UP4): its skill named; a Plan names each changed skill', () => {
    expect(
      text(
        approveAskedReply({
          ...spec,
          question: stale(
            [{ path: '.github-agent/skills/spec/SKILL.md', readers: ['own'] }],
            { skills: ['spec'] },
          ),
        }),
      ),
    ).toBe(
      `${yours} didn't count yet: since Spec v1 was written (\`4f2c1ab\`), \`main\` changed ` +
        `\`.github-agent/skills/spec/SKILL.md\`, which it read ([compare](${CMP})). Comment \`/refresh\` to bring ` +
        'it up to date with `main` and its `spec` skill, or `/approve` again to approve it as it is.',
    );
    const planWith = (skills: string[]) =>
      approveAskedReply({
        ...plan,
        question: stale([{ path: 'x', readers: ['own'] }], { skills }),
      });
    expect(planWith(['plan'])).toContain(
      'bring Spec v1 and Plan v1 up to date with `main` and the `plan` skill, or',
    );
    expect(planWith(['spec'])).toContain(
      'up to date with `main` and the `spec` skill, or',
    );
    expect(planWith(['spec', 'plan'])).toContain(
      'up to date with `main` and the `spec` and `plan` skills, or',
    );
  });

  it('the starting point: "since the bot asked" (the document named), "since … was last checked"', () => {
    expect(
      approveAskedReply({
        ...spec,
        start: { commit: Q, kind: 'asked' },
        questionUrl: QUESTION,
        question: stale([{ path: 'src/index.test.ts', readers: ['own'] }]),
      }),
    ).toContain(
      `didn't count yet: since [the bot asked](${QUESTION}) (\`b71e4d8\`), \`main\` changed \`src/index.test.ts\`, ` +
        `which Spec v1 read ([compare](${CMP})).`,
    );
    expect(
      approveAskedReply({
        ...plan,
        start: { commit: Q, kind: 'asked' },
        questionUrl: QUESTION,
        question: stale([{ path: 'a', readers: ['own', 'spec'] }]),
      }),
    ).toContain('`a`, which Plan v1 and the approved Spec read (');
    expect(
      approveAskedReply({
        ...spec,
        start: { commit: C, kind: 'checked' },
        question: stale([{ path: 'src/index.ts', readers: ['own'] }]),
      }),
    ).toContain(
      "didn't count yet: since Spec v1 was last checked (`c3d9a10`), `main` changed `src/index.ts`, which it read",
    );
  });

  it('more than 5 files → the first 5 and "and N more"; a cut list → "… and possibly more"; hidden paths named', () => {
    const flagged = Array.from({ length: 7 }, (_, i) => ({
      path: `f${i}.ts`,
      readers: ['own' as const],
    }));
    expect(approveAskedReply({ ...spec, question: stale(flagged) })).toContain(
      'changed `f0.ts`, `f1.ts`, `f2.ts`, `f3.ts`, `f4.ts` and 2 more, which it read (',
    );
    expect(
      approveAskedReply({
        ...spec,
        question: stale(
          [{ path: '.github-agent/workflow.json', readers: ['own'] }],
          { complete: false },
        ),
      }),
    ).toContain(
      'changed `.github-agent/workflow.json` … and possibly more, which it read (',
    );
  });

  it('not-compared: no compare link; each starting point names itself', () => {
    const notCompared = { result: 'not-compared' as const };
    expect(text(approveAskedReply({ ...spec, question: notCompared }))).toBe(
      `${yours} didn't count yet: the bot couldn't compare \`4f2c1ab\`, where Spec v1 was written, with \`main\` ` +
        "(that commit is no longer on GitHub, e.g. after a force-push), so it can't tell whether files it read " +
        "changed. Comment `/refresh` to check it against today's `main`, or `/approve` again to approve it as it is.",
    );
    expect(approveAskedReply({ ...spec, question: notCompared })).not.toContain(
      'compare](',
    );
    expect(
      approveAskedReply({
        ...spec,
        start: { commit: Q, kind: 'asked' },
        questionUrl: QUESTION,
        question: notCompared,
      }),
    ).toContain(
      `couldn't compare \`b71e4d8\`, the commit of [the bot's question](${QUESTION}), with \`main\``,
    );
    expect(
      approveAskedReply({
        ...spec,
        start: { commit: C, kind: 'checked' },
        question: notCompared,
      }),
    ).toContain(
      "couldn't compare `c3d9a10`, where Spec v1 was last checked, with `main`",
    );
  });

  it('Plan not-compared (plan UP3): both readers, both documents', () => {
    expect(
      text(
        approveAskedReply({ ...plan, question: { result: 'not-compared' } }),
      ),
    ).toBe(
      `${yours} didn't count yet: the bot couldn't compare \`9e1d0c2\`, where Plan v1 was written, with \`main\` ` +
        "(that commit is no longer on GitHub, e.g. after a force-push), so it can't tell whether files it or the " +
        "approved Spec read changed. Comment `/refresh` to check Spec v1 and Plan v1 against today's `main`, or " +
        '`/approve` again to approve Plan v1 as it is.',
    );
  });

  it('large-change (UAW5): the count, none read; a cut list → "more than 300"; the Plan’s form (plan UP3)', () => {
    const large = {
      result: 'large-change' as const,
      changedFiles: 42,
      complete: true,
    };
    expect(
      text(approveAskedReply({ ...spec, compareUrl: '…', question: large })),
    ).toBe(
      `${yours} didn't count yet: since Spec v1 was written (\`4f2c1ab\`), 42 files changed on \`main\` ` +
        '([compare](…)), none of them one it read. A change this size may still affect it. Comment `/refresh` to ' +
        "check it against today's `main`, or `/approve` again to approve it as it is.",
    );
    expect(
      approveAskedReply({
        ...spec,
        compareUrl: '…',
        question: { ...large, changedFiles: 300, complete: false },
      }),
    ).toContain(
      'more than 300 files changed on `main` ([compare](…)); none of the 300 GitHub lists is one it read.',
    );
    expect(text(approveAskedReply({ ...plan, question: large }))).toBe(
      `${yours} didn't count yet: since Plan v1 was written (\`9e1d0c2\`), 42 files changed on \`main\` ` +
        '([compare](…)), none of them one it or the approved Spec read. A change this size may still affect them. ' +
        "Comment `/refresh` to check Spec v1 and Plan v1 against today's `main`, or `/approve` again to approve " +
        'Plan v1 as it is.',
    );
    expect(
      approveAskedReply({
        ...spec,
        start: { commit: Q, kind: 'asked' },
        questionUrl: QUESTION,
        question: large,
      }),
    ).toContain(`since [the bot asked](${QUESTION}) (\`b71e4d8\`), 42 files`);
  });

  it('no `@` outside backticks in any form', () => {
    const bodies = [
      approveAskedReply({
        ...spec,
        question: stale([{ path: 'a', readers: ['own'] }]),
      }),
      approveAskedReply({ ...plan, question: { result: 'not-compared' } }),
      approveAskedReply({
        ...plan,
        question: { result: 'large-change', changedFiles: 16, complete: true },
      }),
    ];
    for (const body of bodies)
      expect(body.replace(/`[^`]*`/g, '')).not.toContain('@');
  });
});

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

  it('before-question (spec 14, UA5) links the bot’s question', () => {
    expect(
      approveRefusedReply(
        answered('503'),
        'before-question',
        SPEC_V1,
        'full-sdd',
        `${LINK}700`,
      ),
    ).toBe(
      '<!-- sdd-agent:approve-refused:503 -->\n' +
        `[Your \`/approve\`](${LINK}503) was written before [the bot's question](${LINK}700), so it didn't count: ` +
        'read it, then comment `/refresh`, or `/approve` again.',
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
    text: '# Plan',
    notes: ['Model: `gemini-4-carbon` (standard)'],
  };
  it('no ⚠️ line, ever (spec 14, UA4): marker, header from the approved Spec, the coding line, the document, the notes', () => {
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
    // Spec 13 (plan FP1): `ready-for-dev` after every approval.
    [
      'refresh',
      'approved',
      'comes too late: every approval of run 2 is in, and the bot codes from the approved texts.',
    ],
    [
      'restore',
      'approved',
      'has nothing to restore: every approval of run 2 is in, and the bot keeps the approved texts.',
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

  it('/approve has no approved text either (the gate judges it, plan FP19)', () => {
    expect(() =>
      nothingWaitsReply('approve', answered('923'), 'approved', 2),
    ).toThrow('no /approve reply where nothing waits: approved');
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
            'approved',
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
