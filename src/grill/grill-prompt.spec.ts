import { describe, expect, it } from 'vitest';
import type { Block } from '../llm/llm-call.js';
import { grillFrame } from './grill-frame.js';
import { grillTurns, type GrillPromptInput } from './grill-prompt.js';

// The spec's frame ("Model, skill and prompt") with K 3, threshold 95, rounds 2, max 5.
const SPEC_FRAME = `You are Grill Me, the first step of a spec-driven workflow on a GitHub issue. Before a Spec is written for this
issue, you judge whether the issue says enough to write a Spec that its people would accept without changes, and
if it doesn't, you choose the next questions to ask them in a comment.

Each call gives you the issue, every question asked so far with its guess and the answers people wrote, and the
comments that are new since the last call. People may answer in one comment or several, answer only some
questions, refer to questions by number ("Q2: weekly"), accept a guess ("Q1: yes"), or talk among themselves. Use
what tells you something about the issue and ignore the rest.

Answer with:
- confidence: 0 to 100, how sure you are that you could write that Spec now.
- questions: the next questions, most important first, at most 3. Each has a guess at the answer with the
  reasoning behind it. Add a question only if you would ask it whatever the answers to the other questions are; a
  question whose need depends on another answer waits for a later round. Never ask what is already answered, and
  never ask an open question again: list it in open. Don't number the questions and don't @-mention anyone.
- open: the numbers of earlier questions that are still unanswered and that you still need. Leave out any that an
  answer made unnecessary.
- gaps: what is still unclear, a few words each, at most 10.

At 95 or more the bot writes the Spec and nothing more is asked. Below 95 you must either ask at
least one new question or list the open questions you are waiting for. Question comments posted so far: 2
of at most 5; after the last one the bot stops and a person completes the issue.`;

describe('grillFrame (spec 6)', () => {
  it('equals the spec’s text for K 3, threshold 95, rounds 2, max 5', () => {
    expect(grillFrame({ k: 3, threshold: 95, rounds: 2, max: 5 })).toBe(
      SPEC_FRAME,
    );
  });

  it('fills every placeholder', () => {
    const frame = grillFrame({ k: 7, threshold: 80, rounds: 0, max: 10 });

    expect(frame).toContain('most important first, at most 7.');
    expect(frame).toContain('At 80 or more the bot writes the Spec');
    expect(frame).toContain('Below 80 you must either ask');
    expect(frame).toContain(
      'Question comments posted so far: 0\nof at most 10;',
    );
    expect(frame).not.toMatch(/[{}]/);
  });
});

/** A block as one readable line: plain text as is, untrusted as `[key | label | url] text`. */
function view(blocks: Block[]): string[] {
  return blocks.map((block) =>
    block.kind === 'text'
      ? block.text
      : `[${[block.source.key, block.source.label, block.source.url].filter(Boolean).join(' | ')}] ${block.text}`,
  );
}

const ISSUE = {
  title: 'Split a bill',
  description: 'Let a group split a bill between its members.',
};
const FIRST: GrillPromptInput = {
  ...ISSUE,
  rounds: [],
  answers: [],
  newComments: [],
  firstEvaluation: true,
};
const URL = 'https://github.com/o/r/issues/12#issuecomment-';

describe('grillTurns (spec 6)', () => {
  it('the first evaluation with no comment: one user turn, the title and the description untrusted, then "None. This is the first evaluation."', () => {
    const turns = grillTurns(FIRST);

    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(view(turns[0].blocks)).toEqual([
      'Issue title:',
      '[title | the issue title] Split a bill',
      'Issue description:',
      '[description | the issue description] Let a group split a bill between its members.',
      'New comments since the last call: None. This is the first evaluation.',
    ]);
  });

  it('comments before the first questions come first, then each round with its questions, guesses and answers, then the new comments', () => {
    const [turn] = grillTurns({
      ...FIRST,
      firstEvaluation: false,
      rounds: [
        {
          number: 1,
          questions: [
            {
              number: 1,
              question: 'Who can split a bill?',
              guess: 'Only its creator.',
            },
            { number: 2, question: 'Can a paid bill be split?', guess: 'No.' },
          ],
        },
        {
          number: 2,
          questions: [
            {
              number: 3,
              question: 'Who approves a split over 100 €?',
              guess: 'The group admin.',
            },
          ],
        },
      ],
      answers: [
        {
          id: '11',
          author: 'carol',
          body: 'We only use euros.',
          url: `${URL}11`,
          afterRound: 0,
        },
        {
          id: '12',
          author: 'alice',
          body: 'Q1: yes. Q2: no.',
          url: null,
          afterRound: 1,
        },
        { id: '13', author: 'bob', body: 'Q3: the creator.', afterRound: 2 },
      ],
      newComments: [
        {
          id: '14',
          author: 'alice',
          body: 'Q3: the admin, after all.',
          url: `${URL}14`,
        },
      ],
    });

    expect(view(turn.blocks)).toEqual([
      'Issue title:',
      '[title | the issue title] Split a bill',
      'Issue description:',
      '[description | the issue description] Let a group split a bill between its members.',
      'Comments before the first questions:',
      `[comment-11 | the comment by carol | ${URL}11] We only use euros.`,
      'Round 1 (Q1–Q2):\nQ1. Who can split a bill?\nGuess: Only its creator.\nQ2. Can a paid bill be split?\nGuess: No.\nAnswers:',
      '[comment-12 | the comment by alice] Q1: yes. Q2: no.',
      'Round 2 (Q3):\nQ3. Who approves a split over 100 €?\nGuess: The group admin.\nAnswers:',
      '[comment-13 | the comment by bob] Q3: the creator.',
      'New comments since the last call:',
      `[comment-14 | the comment by alice | ${URL}14] Q3: the admin, after all.`,
    ]);
  });

  it('a round with no answer read yet says so; with no new comment after the first evaluation → "None."', () => {
    const [turn] = grillTurns({
      ...FIRST,
      firstEvaluation: false,
      rounds: [
        {
          number: 1,
          questions: [
            { number: 1, question: 'Who can split?', guess: 'Anyone.' },
          ],
        },
      ],
    });

    expect(view(turn.blocks).slice(4)).toEqual([
      'Round 1 (Q1):\nQ1. Who can split?\nGuess: Anyone.\nAnswers: none.',
      'New comments since the last call: None.',
    ]);
  });

  it('no comment, title or description text is ever in a plain block', () => {
    const [turn] = grillTurns({
      title: 'TITLE text',
      description: 'DESCRIPTION text',
      firstEvaluation: false,
      rounds: [
        {
          number: 1,
          questions: [{ number: 1, question: 'Who?', guess: 'Anyone.' }],
        },
      ],
      answers: [
        { id: '1', author: 'a', body: 'BEFORE text', afterRound: 0 },
        { id: '2', author: 'b', body: 'ANSWER text', afterRound: 1 },
      ],
      newComments: [{ id: '3', author: 'c', body: 'NEW text' }],
    });
    const plain = turn.blocks.flatMap((block) =>
      block.kind === 'text' ? [block.text] : [],
    );
    const untrusted = turn.blocks.flatMap((block) =>
      block.kind === 'untrusted' ? [block.text] : [],
    );

    expect(untrusted).toEqual([
      'TITLE text',
      'DESCRIPTION text',
      'BEFORE text',
      'ANSWER text',
      'NEW text',
    ]);
    for (const text of plain)
      expect(text).not.toMatch(/TITLE|DESCRIPTION|BEFORE|ANSWER|NEW/);
  });
});
