// Spec 7 "The document comment", SPW5, SPW14 and SPW20 (plan P1, P17, P31): a document's text as the bot posts
// it, as it reads back from its comment, people's edits counted, and a refresh's diff block. Pure.
import { createTwoFilesPatch, diffLines, OMIT_HEADERS } from 'diff';
import { CODE_SPAN, MENTION, withoutMarkers } from '../grill/grill-comments.js';

/** SP7: the most a Spec or a Plan may have, so it fits one comment with the bot's header and notes. */
export const DOCUMENT_MAX_CHARS = 50_000;
/** GitHub's limit for one comment. */
export const COMMENT_MAX_CHARS = 65_536;
/** A refresh's comment longer than this leaves its diff block out (spec "The v2 comment"). */
export const DIFF_BLOCK_MAX_COMMENT_CHARS = 65_000;

/** SPW5: the document sits between these two in its comment, apart from the bot's header and notes. */
export const DOCUMENT_START = '<!-- sdd-agent:document -->';
export const DOCUMENT_END = '<!-- sdd-agent:document-end -->';

const START = /<!--\s*sdd-agent:document\s*-->/gi;
const END = /<!--\s*sdd-agent:document-end\s*-->/gi;
const SPAN_OR_MENTION = new RegExp(
  `${CODE_SPAN.source}|${MENTION.source}`,
  'g',
);
/** A fenced code block's opening line: a backtick fence's info string has no backtick (CommonMark). */
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * SPW20 with plan P31: the model's document as the bot posts it. Hidden `sdd-agent` markers are removed everywhere,
 * code included (spec 6's `withoutMarkers`). Fenced blocks (```` ``` ```` and `~~~`) and inline code are left as
 * written; every mention outside them goes in backticks, so nobody is notified. When the text outside code also has
 * a stray backtick or backslash, which could pair with or escape added backticks, each mention's `@` is dropped
 * instead, so the code stays as written (spec 6's `cleanModelText` would drop the backticks). Line ends become `\n`
 * and the text is trimmed, so it reads back from its comment as it was stored (`documentText`).
 */
export function cleanDocument(text: string): string {
  const parts = fencedParts(withoutMarkers(lf(text)));
  const outsideCode = parts
    .filter((part) => !part.code)
    .map((part) => part.text.replace(CODE_SPAN, ''))
    .join('\n');
  const stray = outsideCode.search(MENTION) !== -1 && /[`\\]/.test(outsideCode);
  return parts
    .map((part) =>
      part.code
        ? part.text
        : part.text.replace(SPAN_OR_MENTION, (match) =>
            match.startsWith('`')
              ? match
              : stray
                ? match.replaceAll('@', '')
                : `\`${match}\``,
          ),
    )
    .join('')
    .trim();
}

/**
 * SPW5: the document as its comment reads now: what sits between the first start marker and the last end marker
 * (a human who typed the markers inside changes nothing), else the whole comment; in both cases without hidden
 * `sdd-agent` markers, which nobody sees. `\r\n` becomes `\n` first (plan P17: GitHub's web editor saves edits with
 * `\r\n`), then the text is trimmed.
 */
export function documentText(body: string): string {
  const text = lf(body);
  const start = [...text.matchAll(START)].at(0);
  const end = [...text.matchAll(END)].at(-1);
  const from = start ? start.index + start[0].length : -1;
  const inner =
    start && end && end.index >= from ? text.slice(from, end.index) : text;
  return withoutMarkers(inner).trim();
}

/** SPW14: the lines people added and removed between the posted and the approved text (line ends ignored). */
export function lineCounts(
  posted: string,
  approved: string,
): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const change of diffLines(endLine(posted), endLine(approved))) {
    if (change.added) linesAdded += change.count;
    else if (change.removed) linesRemoved += change.count;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Plan P1: a refresh's diff as `git diff` shows its hunks: each `@@ -12,5 +12,5 @@` line and 2 unchanged lines
 * around each change, without the `---` / `+++` file lines, in a `diff` fence one backtick longer than any run
 * inside (spec 6's rule). Null when the texts are the same.
 */
export function diffBlock(before: string, after: string): string | null {
  const hunks = createTwoFilesPatch(
    '',
    '',
    endLine(before),
    endLine(after),
    undefined,
    undefined,
    { context: 2, headerOptions: OMIT_HEADERS },
  ).trimEnd();
  if (hunks === '') return null;
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(hunks) + 1));
  return `${fence}diff\n${hunks}\n${fence}`;
}

interface Part {
  code: boolean;
  text: string;
}

/** The text split into fenced code blocks (with their fence lines; one never closed runs to the end) and the rest. */
function fencedParts(text: string): Part[] {
  const parts: Part[] = [];
  let fence: string | null = null;
  let buffer = '';
  const flush = (code: boolean): void => {
    if (buffer !== '') parts.push({ code, text: buffer });
    buffer = '';
  };
  for (const line of text.split(/(?<=\n)/)) {
    const content = line.replace(/\n$/, '');
    if (fence === null) {
      const open = FENCE_OPEN.exec(content);
      if (open) {
        flush(false);
        fence = open[1] ?? open[2] ?? null;
      }
      buffer += line;
    } else {
      buffer += line;
      const close = FENCE_CLOSE.exec(content)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) {
        flush(true);
        fence = null;
      }
    }
  }
  flush(fence !== null);
  return parts;
}

function lf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** `\n` line ends, ending with one, so a missing last line end isn't counted as a change. */
function endLine(text: string): string {
  const normalized = lf(text);
  return normalized === '' || normalized.endsWith('\n')
    ? normalized
    : `${normalized}\n`;
}

function longestBacktickRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
}
