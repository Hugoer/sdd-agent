import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_CHARS,
  BLOCK_MAX_CHARS,
  answersBlock,
  type AnswersBlockInput,
  type BlockAnswer,
} from './answers-block.js';

// Spec 6 "Answers block" (GM10, GM16, GM17), plan T18.

/** The spec's example: run 2, two answered rounds. */
const EXAMPLE: AnswersBlockInput = {
  run: 2,
  end: { kind: 'cancelled' },
  rounds: [
    {
      number: 1,
      questions: [
        {
          number: 1,
          question:
            'Who can split a bill: only its creator, or any group member?',
          guess: 'only the creator, since the issue says "my bills".',
        },
        {
          number: 2,
          question: "Can a bill be split after it's paid?",
          guess: 'no; the issue only talks about open bills.',
        },
      ],
    },
    {
      number: 2,
      questions: [
        {
          number: 3,
          question: 'Who approves a split over 100 €?',
          guess: 'the group admin.',
        },
      ],
    },
  ],
  answers: [
    {
      author: 'alice',
      body: 'Q1: yes. Q2: no, but admins can.',
      afterRound: 1,
    },
    {
      author: 'bob',
      body: "Q3: the bill's creator, not the admin.",
      afterRound: 2,
    },
  ],
};

const CANCEL_HEADER =
  "**Your Grill Me answers from run 2.** The next run starts from the issue description and won't see them. " +
  'Add them to the description before a new run starts, paste them into your first reply to its questions, or ' +
  'edit them into its Spec before `/approve`.';

/** The lines between the fences. */
function inside(block: string): string[] {
  const lines = block.split('\n');
  return lines.slice(2, -1);
}

const answer = (body: string, extra: Partial<BlockAnswer> = {}) => ({
  ...EXAMPLE,
  answers: [{ author: 'alice', body, afterRound: 1, ...extra }],
});

describe('answersBlock (spec 6 "Answers block")', () => {
  it('the spec’s example, word for word (the header is one line in the comment)', () => {
    expect(answersBlock(EXAMPLE)).toBe(
      [
        CANCEL_HEADER,
        '```text',
        'Q1. Who can split a bill: only its creator, or any group member?',
        '    Guess: only the creator, since the issue says "my bills".',
        "Q2. Can a bill be split after it's paid?",
        '    Guess: no; the issue only talks about open bills.',
        'alice: Q1: yes. Q2: no, but admins can.',
        '',
        'Q3. Who approves a split over 100 €?',
        '    Guess: the group admin.',
        "bob: Q3: the bill's creator, not the admin.",
        '```',
      ].join('\n'),
    );
  });

  it('GM17: after a label swap, the header names the run that has started', () => {
    const block = answersBlock({
      ...EXAMPLE,
      end: { kind: 'replaced', by: { number: 3, lane: 'spec-code' } },
    });

    expect(block?.split('\n')[0]).toBe(
      "**Your Grill Me answers from run 2.** Run 3 started from the issue description and won't see them: paste " +
        'them into your first reply to its questions, or edit them into its Spec before `/approve`.',
    );
  });

  it('nobody answered → null', () => {
    expect(answersBlock({ ...EXAMPLE, answers: [] })).toBeNull();
  });

  it('a round with no answer is left out', () => {
    const block = answersBlock({
      ...EXAMPLE,
      answers: [EXAMPLE.answers[1]],
    });

    expect(inside(block!)).toEqual([
      'Q3. Who approves a split over 100 €?',
      '    Guess: the group admin.',
      "bob: Q3: the bill's creator, not the admin.",
    ]);
  });

  it('answers read before the first question come first, with no questions; each round keeps its order', () => {
    const block = answersBlock({
      ...EXAMPLE,
      answers: [
        { author: 'carol', body: 'Before anything was asked.', afterRound: 0 },
        ...EXAMPLE.answers,
        { author: 'dave', body: 'Q2: also never.', afterRound: 1 },
      ],
    });

    expect(inside(block!)).toEqual([
      'carol: Before anything was asked.',
      '',
      'Q1. Who can split a bill: only its creator, or any group member?',
      '    Guess: only the creator, since the issue says "my bills".',
      "Q2. Can a bill be split after it's paid?",
      '    Guess: no; the issue only talks about open bills.',
      'alice: Q1: yes. Q2: no, but admins can.',
      'dave: Q2: also never.',
      '',
      'Q3. Who approves a split over 100 €?',
      '    Guess: the group admin.',
      "bob: Q3: the bill's creator, not the admin.",
    ]);
  });

  it('an answer with a ``` code block → a four-backtick fence, the answer unchanged; a run of five → six', () => {
    const body = 'Like this:\n```ts\nsplit(100, 3)\n```';
    const block = answersBlock(answer(body))!;

    expect(block.split('\n')[1]).toBe('````text');
    expect(block.split('\n').at(-1)).toBe('````');
    expect(block).toContain(`alice: ${body}\n`);
    const five = answersBlock(answer('a ````` run'))!;
    expect(five.split('\n')[1]).toBe('``````text');
  });

  it('hidden `sdd-agent` markers are removed from answers and questions', () => {
    const block = answersBlock({
      ...answer('Q1: yes <!-- sdd-agent:test --> really'),
      rounds: [
        {
          number: 1,
          questions: [
            {
              number: 1,
              question: 'Who? <!-- sdd-agent:grill-round:x -->',
              guess: 'me',
            },
          ],
        },
      ],
    })!;

    expect(block).not.toContain('sdd-agent');
    expect(block).toContain('alice: Q1: yes  really');
    expect(block).toContain('Q1. Who? \n');
  });

  it('an answer over 2,000 characters keeps its first 2,000, then a link to the full comment, or a note without a url', () => {
    const long = 'a'.repeat(2_500);
    const url = 'https://github.com/o/r/issues/1#issuecomment-9';

    expect(inside(answersBlock(answer(long, { url }))!).at(-1)).toBe(
      `alice: ${'a'.repeat(ANSWER_MAX_CHARS)}… (cut; full comment: ${url})`,
    );
    expect(inside(answersBlock(answer(long))!).at(-1)).toBe(
      `alice: ${'a'.repeat(ANSWER_MAX_CHARS)}… (cut; the full comment is on the issue)`,
    );
    expect(inside(answersBlock(answer('b'.repeat(2_000)))!).at(-1)).toBe(
      `alice: ${'b'.repeat(2_000)}`,
    );
  });

  it('past 60,000 characters the oldest answers are left out, and a first line says how many', () => {
    const many = (count: number): AnswersBlockInput => ({
      ...EXAMPLE,
      answers: Array.from({ length: count }, (_, i) => ({
        author: 'alice',
        body: `${i}:`.padEnd(ANSWER_MAX_CHARS, 'x'),
        afterRound: 0,
      })),
    });

    const two = answersBlock(many(31))!;
    expect(two.length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
    expect(inside(two)[0]).toBe(
      "(The 2 oldest answers are left out, to keep this comment under GitHub's size limit.)",
    );
    expect(two).not.toContain('alice: 1:');
    expect(two).toContain('alice: 2:');
    expect(two).toContain('alice: 30:');
    const one = answersBlock(many(30))!;
    expect(one.length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
    expect(inside(one)[0]).toBe(
      "(The oldest answer is left out, to keep this comment under GitHub's size limit.)",
    );
    expect(answersBlock(many(29))).not.toContain('left out');
  });
});
