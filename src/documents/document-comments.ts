// Spec 7 "The document comment": every marker and comment text of the documents, each built next to its marker.
// English; a login in backticks without `@`. The document's own text arrives cleaned (`cleanDocument`). Pure.
import type { Lane } from '../contracts/issue-provider.js';
import { withNotes } from '../llm/prompt.js';
import { DOCUMENT_END, DOCUMENT_START } from './document-text.js';

const marker = (key: string): string => `<!-- sdd-agent:${key} -->`;

export const specMarker = (versionId: string): string =>
  marker(`spec:${versionId}`);

export interface SpecCommentInput {
  /** The version's row id: its marker names it. */
  versionId: string;
  version: number;
  run: { number: number; lane: Exclude<Lane, 'code-only'> };
  /** `TARGET_BASE_BRANCH`. */
  base: string;
  /** The commit its model read. */
  commit: string;
  /** The document, cleaned and redacted. */
  text: string;
  /** The lines under the rule (`LlmResult.notes`). */
  notes: string[];
}

/**
 * The Spec comment: its marker, the header (version, run, lane, the commit it read), how to change and approve it
 * (what the approval starts depends on the lane), the document between its two hidden markers (SPW5), the notes.
 */
export function specComment(input: SpecCommentInput): string {
  const next =
    input.run.lane === 'full-sdd'
      ? 'the bot writes the Plan from the text as it reads then'
      : 'the bot starts coding from the text as it reads then';
  const body = [
    specMarker(input.versionId),
    `**Spec v${input.version}** · run ${input.run.number} (\`${input.run.lane}\`) · read at ${at(input.base, input.commit)}`,
    '',
    `To change it, edit this comment. When it's right, an Approver (Write access) comments \`/approve\` and ${next}. ` +
      `\`/refresh\` checks it against today's \`${input.base}\`.`,
    '',
    DOCUMENT_START,
    input.text,
    DOCUMENT_END,
  ].join('\n');
  return withNotes(body, input.notes);
}

/** "`main` @ `4f2c1ab`": the base branch and the commit's first 7 characters. */
function at(base: string, commit: string): string {
  return `\`${base}\` @ \`${commit.slice(0, 7)}\``;
}
