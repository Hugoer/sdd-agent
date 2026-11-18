import { describe, expect, it } from 'vitest';
import {
  approveReply,
  cleanModelText,
  clearComment,
  limitBody,
  roundComment,
  skippedComment,
  stoppedComment,
  type LimitBodyInput,
  type RoundCommentInput,
} from './grill-comments.js';

const MODEL_LINE = '<sub>Model: `gemini-4-hydrogen` (standard)</sub>';
const NOTES = ['Model: `gemini-4-hydrogen` (standard)'];

// The spec's example ("Comments and reactions"): round 2 of 5, Q4 and Q5, Q2 still open.
const ROUND_2: RoundCommentInput = {
  roundId: 'round-id',
  round: 2,
  maxRounds: 5,
  confidence: 70,
  threshold: 95,
  questions: [
    {
      number: 4,
      question: 'Who approves a split over 100 €?',
      guess: 'the group admin, since the issue says admins manage the group.',
    },
    {
      number: 5,
      question: 'Should a split show up in the monthly export?',
      guess: 'yes, as one line per member.',
    },
  ],
  stillOpen: [2],
  notes: NOTES,
};

const LIMIT: LimitBodyInput = {
  maxRounds: 5,
  confidence: 80,
  threshold: 95,
  run: { number: 2, lane: 'full-sdd' },
  gaps: [
    'who approves a split over 100 €',
    'whether a split shows up in the monthly export',
  ],
  notes: NOTES,
};

const FOOTER_END =
  "Edits to a comment aren't read: to change an answer, write a new comment. Anyone with Triage access or more can " +
  'answer.';

describe('roundComment (spec 6)', () => {
  it('equals the spec’s example: marker first, the header, still open from before, the questions, the footer and the model line', () => {
    expect(roundComment(ROUND_2)).toBe(
      [
        '<!-- sdd-agent:grill-round:round-id -->',
        '**Grill Me, round 2 of 5** · confidence 70% (the bot writes the Spec at 95%)',
        'A few more questions before the bot writes the Spec. Still open from before: Q2.',
        '',
        '**Q4.** Who approves a split over 100 €?',
        '*Guess:* the group admin, since the issue says admins manage the group.',
        '',
        '**Q5.** Should a split show up in the monthly export?',
        '*Guess:* yes, as one line per member.',
        '',
        `Answer with \`Q4: …\`, \`Q5: …\`, in one comment or several. \`Q4: yes\` accepts a guess. ${FOOTER_END}`,
        '',
        '---',
        MODEL_LINE,
      ].join('\n'),
    );
  });

  it('round 1 says "A few questions before the bot writes the Spec:" with no still-open line', () => {
    const text = roundComment({
      ...ROUND_2,
      round: 1,
      stillOpen: [],
      questions: [
        { number: 1, question: 'Who can split a bill?', guess: 'its creator.' },
        { number: 2, question: 'In which currency?', guess: 'euros.' },
      ],
    });

    expect(text.split('\n').slice(1, 3)).toEqual([
      '**Grill Me, round 1 of 5** · confidence 70% (the bot writes the Spec at 95%)',
      'A few questions before the bot writes the Spec:',
    ]);
    expect(text).not.toContain('Still open');
    expect(text).toContain(
      'Answer with `Q1: …`, `Q2: …`, in one comment or several. `Q1: yes` accepts a guess.',
    );
  });

  it('a later round leaves the still-open line out when nothing earlier is open', () => {
    expect(roundComment({ ...ROUND_2, stillOpen: [] }).split('\n')[2]).toBe(
      'A few more questions before the bot writes the Spec.',
    );
  });

  it('plan P3: one question → the singular forms, in round 1 and later', () => {
    const one = { number: 4, question: 'Who approves?', guess: 'the admin.' };

    const first = roundComment({
      ...ROUND_2,
      round: 1,
      stillOpen: [],
      questions: [{ ...one, number: 1 }],
    });
    const later = roundComment({ ...ROUND_2, questions: [one] });

    expect(first.split('\n')[2]).toBe(
      'One question before the bot writes the Spec:',
    );
    expect(first).toContain(
      `Answer with \`Q1: …\`. \`Q1: yes\` accepts the guess. ${FOOTER_END}`,
    );
    expect(later.split('\n')[2]).toBe(
      'One more question before the bot writes the Spec. Still open from before: Q2.',
    );
    expect(later).toContain(
      `Answer with \`Q4: …\`. \`Q4: yes\` accepts the guess. ${FOOTER_END}`,
    );
  });

  it('a cut text adds its line under the rule', () => {
    const cut =
      'The bot read only the first 65,536 characters of the issue description (it had 80,000).';

    expect(roundComment({ ...ROUND_2, notes: [...NOTES, cut] })).toMatch(
      new RegExp(`---\\n${escape(MODEL_LINE)}\\n<sub>${escape(cut)}</sub>$`),
    );
  });

  it('a question or guess holding a hidden marker posts without it', () => {
    const text = roundComment({
      ...ROUND_2,
      questions: [
        {
          number: 4,
          question: 'Who approves? <!-- sdd-agent:needs-human:x:1 -->',
          guess: '<!-- sdd-agent:needs-human:x:1 -->the admin.',
        },
      ],
    });

    expect(text).not.toContain('needs-human');
    expect(text).toContain('**Q4.** Who approves? \n*Guess:* the admin.');
  });
});

describe('the other texts (spec 6)', () => {
  it('already clear equals the spec’s example', () => {
    expect(
      clearComment('session-id', {
        confidence: 97,
        threshold: 95,
        notes: NOTES,
      }),
    ).toBe(
      [
        '<!-- sdd-agent:grill-clear:session-id -->',
        '**Grill Me: no questions needed.** The issue is clear enough (confidence 97%; the bot writes the Spec at ' +
          '95%): writing the Spec now.',
        '',
        '---',
        MODEL_LINE,
      ].join('\n'),
    );
  });

  it('skipped at run start names nobody', () => {
    expect(skippedComment('session-id')).toBe(
      '<!-- sdd-agent:grill-skipped:session-id -->\n' +
        'Grill Me skipped (`grill: skip` is on): writing the Spec from the issue description.',
    );
  });

  it('stopped names the sender of the label event, in backticks without @; with no label event it says the label is on', () => {
    expect(stoppedComment('session-id', 'alice')).toBe(
      '<!-- sdd-agent:grill-stopped:session-id -->\n' +
        'Grill Me stopped by `alice` (`grill: skip` added): writing the Spec from the issue and the answers so far.',
    );
    expect(stoppedComment('session-id', null)).toBe(
      '<!-- sdd-agent:grill-stopped:session-id -->\n' +
        'Grill Me stopped (`grill: skip` is on): writing the Spec from the issue and the answers so far.',
    );
  });

  it('the /approve reply lists the questions open now', () => {
    expect(approveReply('4821', [2, 3])).toBe(
      '<!-- sdd-agent:grill-approve:4821 -->\n' +
        "There's nothing to approve yet: the bot is still asking questions (still open: Q2, Q3). It writes the " +
        "Spec once it's sure enough, and you approve that. To stop the questions now, add `grill: skip`.",
    );
  });

  it('the round-limit body equals the spec’s example (spec 5 adds the marker)', () => {
    expect(limitBody(LIMIT)).toBe(
      [
        '⚠️ **Grill Me used all 5 rounds and is 80% sure** (it writes the Spec at 95%), so run 2 stopped here.',
        '',
        '**Still unclear:**',
        '- who approves a split over 100 €',
        '- whether a split shows up in the monthly export',
        '',
        '**To continue:**',
        '1. Remove the `workflow: full-sdd` label. The bot then posts your answers so far, ready to copy.',
        '2. Add those answers and the points above to the issue description.',
        '3. Add the label again. The new run starts from the updated description.',
        '',
        '---',
        MODEL_LINE,
      ].join('\n'),
    );
  });

  it('the round-limit body without gaps leaves the list out and changes step 2; the run’s own lane label is in step 1', () => {
    const text = limitBody({
      ...LIMIT,
      gaps: [],
      run: { number: 3, lane: 'spec-code' },
    });

    expect(text).not.toContain('Still unclear');
    expect(text).toContain('so run 3 stopped here.\n\n**To continue:**');
    expect(text).toContain('1. Remove the `workflow: spec-code` label.');
    expect(text).toContain('2. Add those answers to the issue description.');
  });

  it('plan P3: with one round allowed, "used its only round"', () => {
    expect(limitBody({ ...LIMIT, maxRounds: 1 }).split('\n')[0]).toBe(
      '⚠️ **Grill Me used its only round and is 80% sure** (it writes the Spec at 95%), so run 2 stopped here.',
    );
  });
});

describe('cleanModelText (spec 6, GMW3)', () => {
  it.each([
    ['@alice can you check?', '`@alice` can you check?'],
    ['Ask (@bob), then @carol.', 'Ask (`@bob`), then `@carol`.'],
    ['first line\n@dave second line', 'first line\n`@dave` second line'],
    ['the team @acme/billing decides', 'the team `@acme/billing` decides'],
    ['mail frank@example.com about it', 'mail frank@example.com about it'],
    ['already `@erin` in a code span', 'already `@erin` in a code span'],
    [
      'a code span `ask @erin here` stays',
      'a code span `ask @erin here` stays',
    ],
    [
      '``with a ` inside @gina``, then @hal',
      '``with a ` inside @gina``, then `@hal`',
    ],
  ])('%j → %j', (text, cleaned) => {
    expect(cleanModelText(text)).toBe(cleaned);
  });

  it('a backtick outside any code span, or a backslash, could break the added backticks: they are dropped first', () => {
    expect(cleanModelText('Ask `@bob about it')).toBe('Ask `@bob` about it');
    expect(cleanModelText('Ask \\@bob')).toBe('Ask `@bob`');
    expect(cleanModelText('no mention, so `this` and \\ stay')).toBe(
      'no mention, so `this` and \\ stay',
    );
  });

  it('removes hidden sdd-agent markers, also one that removing another would join, and one cut off at the end', () => {
    expect(cleanModelText('a <!-- sdd-agent:needs-human:x:1 --> b')).toBe(
      'a  b',
    );
    expect(
      cleanModelText('<!-<!-- sdd-agent:x -->- sdd-agent:run-ended:y -->ok'),
    ).toBe('ok');
    expect(cleanModelText('text <!-- sdd-agent:grill-round:z')).toBe('text ');
    expect(cleanModelText('an ordinary <!-- comment --> stays')).toBe(
      'an ordinary <!-- comment --> stays',
    );
  });

  it('is idempotent', () => {
    const once = cleanModelText(
      'Ask @bob and `@carol`, mail x@y.org <!-- sdd-agent:a -->',
    );

    expect(cleanModelText(once)).toBe(once);
  });
});

describe('no text has a mention outside backticks (spec 6, GMW3, GM7)', () => {
  const NOISY = [
    '@alice please answer',
    'ask (@bob) or @org/team',
    'line\n@carol and `@dave` and `ask @erin`',
    'Ask `@frank about it',
    'Ask \\@gina',
    '``tricky ` @hal``@ivan',
  ].join(' ');

  /** CommonMark code spans removed: what GitHub could turn into a notification. */
  const outsideCode = (text: string): string =>
    text.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');

  it.each([
    [
      'the question comment',
      roundComment({
        ...ROUND_2,
        questions: [{ number: 4, question: NOISY, guess: NOISY }],
      }),
    ],
    ['the round-limit body', limitBody({ ...LIMIT, gaps: [NOISY, NOISY] })],
    ['the stopped comment', stoppedComment('s', 'alice')],
    ['the /approve reply', approveReply('1', [1, 2])],
    [
      'the clear comment',
      clearComment('s', { confidence: 97, threshold: 95, notes: NOTES }),
    ],
    ['the skipped comment', skippedComment('s')],
  ])('%s', (_, text) => {
    expect(outsideCode(text)).not.toMatch(/(?<!\w)@\w/);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
