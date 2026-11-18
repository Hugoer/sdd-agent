// Spec 6 "Answers block" (GM10, GM16, GM17): the questions and answers of an ended run, word for word, for spec 5's
// run-ended comment. In a code block: GitHub's copy button, and a mention or `#12` inside doesn't notify or link
// again. No model call (GM10). Pure.
import type { RunEnd } from '../workflow/workflow-comments.js';
import { withoutMarkers } from './grill-comments.js';
import type { RoundQuestion } from './grill.store.js';

/** An answer longer than this is cut, with a link to the full comment. */
export const ANSWER_MAX_CHARS = 2_000;
/** Past this the oldest answers are left out: the run-ended comment must stay under GitHub's 65,536. */
export const BLOCK_MAX_CHARS = 60_000;

export interface BlockRound {
  number: number;
  questions: RoundQuestion[];
}

export interface BlockAnswer {
  author: string;
  /** As written. */
  body: string;
  url?: string | null;
  /** Question comments posted when it was read (0 = before the first). */
  afterRound: number;
}

export interface AnswersBlockInput {
  /** The run the answers belong to. */
  run: number;
  /** `cancelled`, or `replaced` by the run that has already started (GM17). */
  end: RunEnd;
  rounds: BlockRound[];
  /** In creation order. */
  answers: BlockAnswer[];
}

/**
 * The block, or null when nobody answered. Each round with at least one answer: its questions with their guesses,
 * then each answer as `<login>: <text as written>`; answers read before the first question come first.
 */
export function answersBlock(input: AnswersBlockInput): string | null {
  const { answers } = input;
  if (answers.length === 0) return null;
  for (let leftOut = 0; ; leftOut++) {
    const block = render(input, leftOut);
    if (block.length <= BLOCK_MAX_CHARS || leftOut === answers.length - 1) {
      return block;
    }
  }
}

function render(input: AnswersBlockInput, leftOut: number): string {
  const kept = input.answers.slice(leftOut);
  const byRound = new Map<number, BlockAnswer[]>();
  for (const answer of kept) {
    byRound.set(answer.afterRound, [
      ...(byRound.get(answer.afterRound) ?? []),
      answer,
    ]);
  }
  const sections = [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((number) => [
      ...(input.rounds
        .find((round) => round.number === number)
        ?.questions.flatMap(questionLines) ?? []),
      ...(byRound.get(number) ?? []).map(answerLine),
    ]);
  const content = [
    ...(leftOut > 0 ? [leftOutLine(leftOut), ''] : []),
    ...sections.flatMap((lines, index) =>
      index === 0 ? lines : ['', ...lines],
    ),
  ].join('\n');
  // One backtick longer than the longest run inside, so an answer with a code block can't end it.
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return [header(input.run, input.end), `${fence}text`, content, fence].join(
    '\n',
  );
}

function header(run: number, end: RunEnd): string {
  const first = `**Your Grill Me answers from run ${run}.**`;
  return end.kind === 'replaced'
    ? `${first} Run ${end.by.number} started from the issue description and won't see them: paste them into your ` +
        'first reply to its questions, or edit them into its Spec before `/approve`.'
    : `${first} The next run starts from the issue description and won't see them. Add them to the description ` +
        'before a new run starts, paste them into your first reply to its questions, or edit them into its Spec ' +
        'before `/approve`.';
}

function questionLines({ number, question, guess }: RoundQuestion): string[] {
  return [
    `Q${number}. ${withoutMarkers(question)}`,
    `    Guess: ${withoutMarkers(guess)}`,
  ];
}

function answerLine({ author, body, url }: BlockAnswer): string {
  const chars = [...withoutMarkers(body)];
  const text =
    chars.length <= ANSWER_MAX_CHARS
      ? chars.join('')
      : chars.slice(0, ANSWER_MAX_CHARS).join('') +
        (url
          ? `… (cut; full comment: ${url})`
          : '… (cut; the full comment is on the issue)');
  return `${author}: ${text}`;
}

function leftOutLine(count: number): string {
  return count === 1
    ? "(The oldest answer is left out, to keep this comment under GitHub's size limit.)"
    : `(The ${count} oldest answers are left out, to keep this comment under GitHub's size limit.)`;
}

function longestBacktickRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
}
