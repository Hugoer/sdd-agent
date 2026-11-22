// Spec 6 "Comments and reactions": every marker and text Grill Me posts, except the answers block. English; a
// login in backticks without `@` (spec 5, RL18). Model text (questions, guesses, gaps) is cleaned first (GMW3):
// every `@name` in backticks, so nobody is notified, and no hidden `sdd-agent` marker. Pure.
import type { Lane } from '../contracts/issue-provider.js';
import { laneLabel } from '../github/labels.js';
import { withNotes } from '../llm/prompt.js';
import type { RoundQuestion } from './grill.store.js';

const marker = (key: string): string => `<!-- sdd-agent:${key} -->`;

export const roundMarker = (roundId: string): string =>
  marker(`grill-round:${roundId}`);
export const clearMarker = (sessionId: string): string =>
  marker(`grill-clear:${sessionId}`);
export const skippedMarker = (sessionId: string): string =>
  marker(`grill-skipped:${sessionId}`);
export const stoppedMarker = (sessionId: string): string =>
  marker(`grill-stopped:${sessionId}`);
export const approveMarker = (commentId: string): string =>
  marker(`grill-approve:${commentId}`);

/** A hidden marker, also one cut off at the end of the text. */
const HIDDEN_MARKER = /<!--\s*sdd-agent:[\s\S]*?(?:-->|$)/gi;
/** A code span as CommonMark reads it: a backtick run, then the next run of the same length. */
export const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
/**
 * A GitHub mention: `@login` or `@org/team`, not inside a word (an e-mail address is left alone). Mentions written
 * together (`@a@b`) are one match, so the backticks around the first can't uncover the next.
 */
const NAME = String.raw`@[A-Za-z0-9][\w-]*(?:\/[A-Za-z0-9][\w.-]*)?`;
export const MENTION = new RegExp(String.raw`(?<!\w)${NAME}(?:${NAME})*`, 'g');
const SPAN_OR_MENTION = new RegExp(
  `${CODE_SPAN.source}|${MENTION.source}`,
  'g',
);

/**
 * GMW3: the model's text as the bot posts it. Hidden `sdd-agent` markers are removed (again until none is left,
 * so removing one can't join a new one), and every mention outside a code span goes in backticks. When the text
 * also has a backslash or a backtick outside any code span, which could escape or pair with the added backticks,
 * those characters are dropped first.
 */
export function cleanModelText(text: string): string {
  let cleaned = withoutMarkers(text);
  const outsideCode = cleaned.replace(CODE_SPAN, '');
  if (
    mentions(outsideCode) &&
    (outsideCode.includes('`') || outsideCode.includes('\\'))
  ) {
    cleaned = cleaned.replace(/[`\\]/g, '');
  }
  return cleaned.replace(SPAN_OR_MENTION, (match) =>
    match.startsWith('`') ? match : `\`${match}\``,
  );
}

/** Hidden `sdd-agent` markers removed, again until none is left, so removing one can't join a new one. */
export function withoutMarkers(text: string): string {
  let cleaned = text;
  for (let before = ''; before !== cleaned;) {
    before = cleaned;
    cleaned = cleaned.replace(HIDDEN_MARKER, '');
  }
  return cleaned;
}

function mentions(text: string): boolean {
  return text.search(MENTION) !== -1;
}

const q = (number: number): string => `Q${number}`;

export interface RoundCommentInput {
  roundId: string;
  /** 1, 2, … */
  round: number;
  /** `GRILL_MAX_ROUNDS`. */
  maxRounds: number;
  confidence: number;
  /** `GRILL_CONFIDENCE_THRESHOLD`. */
  threshold: number;
  /** The round's questions, numbered on from the run's last one (GM5). */
  questions: RoundQuestion[];
  /** Earlier question numbers still open. */
  stillOpen: number[];
  /** The model line and a line per cut text (`LlmResult.notes`). */
  notes: string[];
}

/** The question comment: its full text is stored with the round before it is posted (Tx1). */
export function roundComment(input: RoundCommentInput): string {
  const questions = input.questions.map(({ number, question, guess }) => ({
    number,
    question: cleanModelText(question),
    guess: cleanModelText(guess),
  }));
  const one = questions.length === 1;
  const first = q(questions[0].number);
  const intro =
    input.round === 1
      ? `${one ? 'One question' : 'A few questions'} before the bot writes the Spec:`
      : `${one ? 'One more question' : 'A few more questions'} before the bot writes the Spec.` +
        (input.stillOpen.length > 0
          ? ` Still open from before: ${input.stillOpen.map(q).join(', ')}.`
          : '');
  const answerWith = one
    ? `Answer with \`${first}: …\`. \`${first}: yes\` accepts the guess.`
    : `Answer with ${questions.map(({ number }) => `\`${q(number)}: …\``).join(', ')}, in one comment or ` +
      `several. \`${first}: yes\` accepts a guess.`;
  const body = [
    roundMarker(input.roundId),
    `**Grill Me, round ${input.round} of ${input.maxRounds}** · confidence ${input.confidence}% ` +
      `(the bot writes the Spec at ${input.threshold}%)`,
    intro,
    ...questions.map(
      ({ number, question, guess }) =>
        `\n**${q(number)}.** ${question}\n*Guess:* ${guess}`,
    ),
    '',
    `${answerWith} Edits to a comment aren't read: to change an answer, write a new comment. Anyone with ` +
      'Triage access or more can answer.',
  ].join('\n');
  return withNotes(body, input.notes);
}

/** Already clear: only when no question was asked in the run. */
export function clearComment(
  sessionId: string,
  input: { confidence: number; threshold: number; notes: string[] },
): string {
  return withNotes(
    `${clearMarker(sessionId)}\n**Grill Me: no questions needed.** The issue is clear enough (confidence ` +
      `${input.confidence}%; the bot writes the Spec at ${input.threshold}%): writing the Spec now.`,
    input.notes,
  );
}

/** A run that starts with `grill: skip` (GMW5: it names nobody). */
export function skippedComment(sessionId: string): string {
  return (
    `${skippedMarker(sessionId)}\nGrill Me skipped (\`grill: skip\` is on): writing the Spec from the issue ` +
    'description.'
  );
}

/** `grill: skip` while asking; `stoppedBy` is the label event's sender, null when no label event says (GM15). */
export function stoppedComment(
  sessionId: string,
  stoppedBy: string | null,
): string {
  const how = stoppedBy
    ? ` by \`${stoppedBy}\` (\`grill: skip\` added)`
    : ' (`grill: skip` is on)';
  return (
    `${stoppedMarker(sessionId)}\nGrill Me stopped${how}: writing the Spec from the issue and the answers so ` +
    'far.'
  );
}

/** `/approve` while asking (GM8): one reply per `/approve` comment, with the questions open now. */
export function approveReply(commentId: string, open: number[]): string {
  return (
    `${approveMarker(commentId)}\nThere's nothing to approve yet: the bot is still asking questions (still ` +
    `open: ${open.map(q).join(', ')}). It writes the Spec once it's sure enough, and you approve that. To stop ` +
    'the questions now, add `grill: skip`.'
  );
}

export interface LimitBodyInput {
  /** The question comments posted: `GRILL_MAX_ROUNDS`, or more when the setting was lowered. */
  rounds: number;
  confidence: number;
  threshold: number;
  run: { number: number; lane: Lane };
  /** The model's gaps (cleaned here). */
  gaps: string[];
  notes: string[];
}

/** GM9: the body of spec 5's stop comment at the round limit; spec 5 adds its marker. */
export function limitBody(input: LimitBodyInput): string {
  const gaps = input.gaps.map(cleanModelText);
  const used =
    input.rounds === 1
      ? 'used its only round'
      : `used all ${input.rounds} rounds`;
  const lines = [
    `⚠️ **Grill Me ${used} and is ${input.confidence}% sure** (it writes the Spec at ${input.threshold}%), ` +
      `so run ${input.run.number} stopped here.`,
    ...(gaps.length > 0
      ? ['', '**Still unclear:**', ...gaps.map((gap) => `- ${gap}`)]
      : []),
    '',
    '**To continue:**',
    `1. Remove the \`${laneLabel(input.run.lane)}\` label. The bot then posts your answers so far, ready to copy.`,
    `2. Add those answers ${gaps.length > 0 ? 'and the points above ' : ''}to the issue description.`,
    '3. Add the label again. The new run starts from the updated description.',
  ];
  return withNotes(lines.join('\n'), input.notes);
}
