// Spec 6 "Model, skill and prompt" → Turns: one user turn. Bot text goes in plain blocks; everything from GitHub
// (the title, the description, every comment) in untrusted blocks, which spec 4 guards, cuts and wraps. Pure.
import type { Block, Turn, UntrustedSource } from '../llm/llm-call.js';
import type { RoundQuestion } from './grill.store.js';

/** A comment as the prompt shows it. */
export interface PromptComment {
  id: string;
  author: string;
  body: string;
  url?: string | null;
}

export interface GrillPromptInput {
  title: string;
  description: string;
  /** The question comments posted so far, by number. */
  rounds: { number: number; questions: RoundQuestion[] }[];
  /** The comments earlier evaluations read, each with the round open when it was read (0 = before the first). */
  answers: (PromptComment & { afterRound: number })[];
  /** The comments this evaluation reads for the first time. */
  newComments: PromptComment[];
  /** No evaluation of this session has run yet. */
  firstEvaluation: boolean;
}

export function grillTurns(input: GrillPromptInput): Turn[] {
  const blocks: Block[] = [
    text('Issue title:'),
    untrusted({ key: 'title', label: 'the issue title' }, input.title),
    text('Issue description:'),
    untrusted(
      { key: 'description', label: 'the issue description' },
      input.description,
    ),
  ];
  const before = input.answers.filter(({ afterRound }) => afterRound === 0);
  if (before.length > 0) {
    blocks.push(
      text('Comments before the first questions:'),
      ...before.map(commentBlock),
    );
  }
  for (const round of input.rounds) {
    const answers = input.answers.filter(
      ({ afterRound }) => afterRound === round.number,
    );
    blocks.push(
      text(roundText(round, answers.length > 0)),
      ...answers.map(commentBlock),
    );
  }
  if (input.newComments.length > 0) {
    blocks.push(
      text('New comments since the last call:'),
      ...input.newComments.map(commentBlock),
    );
  } else {
    const none = input.firstEvaluation
      ? 'None. This is the first evaluation.'
      : 'None.';
    blocks.push(text(`New comments since the last call: ${none}`));
  }
  return [{ role: 'user', blocks }];
}

/** "Round 2 (Q4–Q5):", each question with its guess, then the answers' heading. */
function roundText(
  round: GrillPromptInput['rounds'][number],
  hasAnswers: boolean,
): string {
  const numbers = round.questions.map(({ number }) => number);
  const [first, last] = [Math.min(...numbers), Math.max(...numbers)];
  const range = first === last ? `Q${first}` : `Q${first}–Q${last}`;
  return [
    `Round ${round.number} (${range}):`,
    ...round.questions.map(
      ({ number, question, guess }) =>
        `Q${number}. ${question}\nGuess: ${guess}`,
    ),
    hasAnswers ? 'Answers:' : 'Answers: none.',
  ].join('\n');
}

function commentBlock({ id, author, body, url }: PromptComment): Block {
  return untrusted(
    {
      key: `comment-${id}`,
      label: `the comment by ${author}`,
      ...(url && { url }),
    },
    body,
  );
}

function text(value: string): Block {
  return { kind: 'text', text: value };
}

function untrusted(source: UntrustedSource, value: string): Block {
  return { kind: 'untrusted', source, text: value };
}
