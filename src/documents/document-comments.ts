// Spec 7 "The document comment": every marker and comment text of the documents, each built next to its marker.
// English; a login in backticks without `@`. The document's own text arrives cleaned (`cleanDocument`). Pure.
import type { Lane } from '../contracts/issue-provider.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import { laneLabel } from '../github/labels.js';
import { withNotes } from '../llm/prompt.js';
import { namedFiles, type FlaggedFile, type Reader } from './commit-check.js';
import { DOCUMENT_END, DOCUMENT_START } from './document-text.js';
import type { DocumentKind } from './documents.store.js';

const marker = (key: string): string => `<!-- sdd-agent:${key} -->`;

/** A person's comment a reply answers: its id names the reply's marker, its link is the reply's subject (plan P39). */
export type AnsweredComment = Pick<TaskComment, 'id' | 'url'>;

/** Plan P39: the answered comment as a link; plain text when the event has no link (spec 2's signed test requests). */
function linked(text: string, url: string | undefined): string {
  return url ? `[${text}](${url})` : text;
}

const yourApprove = (comment: Pick<TaskComment, 'url'>): string =>
  linked('Your `/approve`', comment.url);

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

export const planMarker = (versionId: string): string =>
  marker(`plan:${versionId}`);

/** The Spec's approval, as the Plan's header warns about it (SP3). */
export type SpecWarning =
  | {
      kind: 'stale';
      /** The commit the approval compared from. */
      from: string;
      files: string[];
      complete: boolean;
      compareUrl: string;
    }
  | { kind: 'not-compared'; from: string };

export interface PlanCommentInput {
  versionId: string;
  version: number;
  run: { number: number };
  base: string;
  commit: string;
  /** The approved Spec version it is written from. */
  specVersion: number;
  /** Null when the Spec's approval flagged nothing and compared. */
  warning: SpecWarning | null;
  text: string;
  notes: string[];
}

/**
 * The Plan comment (spec "The document comment"): its marker, the header naming the approved Spec it comes from,
 * the ⚠️ line when the Spec's approval flagged files or couldn't compare, how to change and approve it, the document
 * between its markers, the notes.
 */
export function planComment(input: PlanCommentInput): string {
  const body = [
    planMarker(input.versionId),
    `**Plan v${input.version}** · run ${input.run.number} (\`full-sdd\`) · from the approved Spec v${input.specVersion} · ` +
      `read at ${at(input.base, input.commit)}`,
    '',
    ...(input.warning ? [specWarningLine(input.warning, input.base), ''] : []),
    "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the bot " +
      `starts coding from the approved Spec and this Plan as it reads then. \`/refresh\` checks both against today's ` +
      `\`${input.base}\`.`,
    '',
    DOCUMENT_START,
    input.text,
    DOCUMENT_END,
  ].join('\n');
  return withNotes(body, input.notes);
}

/** SP3: the Plan header's warning about the approved Spec (5 files at most, "possibly more", or not compared). */
function specWarningLine(warning: SpecWarning, base: string): string {
  const from = `\`${warning.from.slice(0, 7)}\``;
  if (warning.kind === 'not-compared')
    return `⚠️ The bot couldn't compare ${from} with \`${base}\`, so it can't tell whether the Spec is out of date.`;
  return (
    `⚠️ Since the Spec was written (${from}), \`${base}\` changed ${namedFiles(warning.files, warning.complete)}, ` +
    `which it read ([compare](${warning.compareUrl})). This Plan reads the current code. If the change affects the ` +
    'Spec, comment `/refresh`.'
  );
}

/** "`main` @ `4f2c1ab`": the base branch and the commit's first 7 characters. */
function at(base: string, commit: string): string {
  return `\`${base}\` @ \`${commit.slice(0, 7)}\``;
}

export const approveRefusedMarker = (commentId: string): string =>
  marker(`approve-refused:${commentId}`);

/** The document an `/approve` was judged against, as its replies name it. */
export interface RepliedDocument {
  kind: DocumentKind;
  version: number;
  /** Its comment's link; null while it waits to be posted. */
  url: string | null;
  approvedBy: string | null;
}

export type ApproveRefusal =
  'already-approved' | 'before-document' | 'deleted' | 'empty';

/** Spec "`/approve`", the verdict table: one reply per refused `/approve` comment, naming the waiting document. */
export function approveRefusedReply(
  comment: AnsweredComment,
  refusal: ApproveRefusal,
  document: RepliedDocument,
  lane: Lane,
): string {
  const name = documentName(document);
  const yours = yourApprove(comment);
  const text = {
    'already-approved': `${yours} changes nothing: ${name} is already approved (by \`${document.approvedBy ?? 'someone'}\`).`,
    'before-document':
      `${yours} was written before ${name} was posted, so it didn't count. Read ` +
      `${document.url ? `[${name}](${document.url})` : name}, then comment \`/approve\` again.`,
    deleted:
      `${yours} has nothing to approve: ${name} was deleted. Comment \`/restore\` to get it back, or remove ` +
      `the \`${laneLabel(lane)}\` label and add it again to start over.`,
    empty:
      `${yours} has nothing to approve: ${name}'s comment has no text left between its markers. Edit the ` +
      `comment to put the ${kindName(document.kind)} back, then comment \`/approve\`.`,
  }[refusal];
  return `${approveRefusedMarker(comment.id)}\n${text}`;
}

/** "Spec v1", "Plan v2", "the **Ready to code** comment" (the go-signal has no version a person sees). */
function documentName({ kind, version }: RepliedDocument): string {
  return kind === 'go-signal'
    ? 'the **Ready to code** comment'
    : `${kindName(kind)} v${version}`;
}

function kindName(kind: DocumentKind): string {
  return kind === 'plan' ? 'Plan' : 'Spec';
}

export const approveWarningMarker = (versionId: string): string =>
  marker(`approve-warning:${versionId}`);

export type ApproveWarning =
  | {
      kind: 'stale';
      /** The commit the approval compared from (the document's `checkedCommit` or `commit`). */
      from: string;
      flagged: FlaggedFile[];
      complete: boolean;
      compareUrl: string;
    }
  | { kind: 'not-compared'; from: string };

export interface ApproveWarningInput {
  versionId: string;
  /** The `/approve` comment the reply answers (plan P39). */
  approve: Pick<TaskComment, 'url'>;
  /** The last document before code: `spec-code`'s Spec or `full-sdd`'s Plan. */
  document: { kind: 'spec' | 'plan'; version: number };
  lane: Lane;
  base: string;
  warning: ApproveWarning;
}

/**
 * SPW13 with plan P4: the one reply to the last approval before code when files it (or, for a Plan, the approved
 * Spec) read changed since it was written, or the comparison failed. It never blocks: the approval is stored.
 */
export function approveWarningReply(input: ApproveWarningInput): string {
  const { document, warning, base } = input;
  const name = `${kindName(document.kind)} v${document.version}`;
  const from = `\`${warning.from.slice(0, 7)}\``;
  const approved = `${yourApprove(input.approve)} approved ${name}.`;
  const text =
    warning.kind === 'not-compared'
      ? `${approved} The bot couldn't compare ${from} with \`${base}\`, so it can't tell whether files it read ` +
        'have changed.'
      : `${approved} Since it was written (${from}), \`${base}\` changed ${readFiles(warning.flagged, warning.complete)} ` +
        `([compare](${warning.compareUrl})). The code is written from today's \`${base}\`, and the Coder is told ` +
        `which files changed. To write the ${kindName(document.kind)} again instead, remove the ` +
        `\`${laneLabel(input.lane)}\` label and add it again.`;
  return `${approveWarningMarker(input.versionId)}\n${text}`;
}

/** Plan P4: the files grouped by who read them: "`a`, which it read, and `b`, which the approved Spec read". */
function readFiles(flagged: FlaggedFile[], complete: boolean): string {
  const groups = new Map<string, string[]>();
  for (const { path, readers } of flagged) {
    const who = readerText(readers);
    groups.set(who, [...(groups.get(who) ?? []), path]);
  }
  const entries = [...groups];
  return entries
    .map(
      ([who, paths], index) =>
        `${namedFiles(paths, complete || index < entries.length - 1)}, which ${who}`,
    )
    .join(', and ');
}

function readerText(readers: Reader[]): string {
  if (readers.includes('own') && readers.includes('spec'))
    return 'it and the approved Spec read';
  return readers.includes('own') ? 'it read' : 'the approved Spec read';
}

export const goSignalMarker = (runId: string): string =>
  marker(`go-signal:${runId}`);

/** Spec "The go-signal" (SPW6): a `code-only` run's one comment before the code; it has no document. */
export function goSignalComment(run: { id: string; number: number }): string {
  return [
    goSignalMarker(run.id),
    `**Ready to code** · run ${run.number} (\`code-only\`)`,
    '',
    'The bot codes from the issue description, with no Spec or Plan. An Approver (Write access) comments `/approve` ' +
      'to start; the bot reads the title and description as they read then.',
  ].join('\n');
}

export const approveHintMarker = (versionId: string): string =>
  marker(`approve-hint:${versionId}`);

/** Spec "`/approve please`": once per waiting document. */
export function approveHintReply(
  versionId: string,
  comment: Pick<TaskComment, 'url'>,
): string {
  return (
    `${approveHintMarker(versionId)}\n${linked('Your comment', comment.url)} isn't an approval: to approve, comment ` +
    'exactly `/approve`, with nothing else.'
  );
}

export const lateCommentMarker = (commentId: string): string =>
  marker(`late-comment:${commentId}`);

/** SP12: a comment written while the bot wrote the Spec, which Grill Me never read; names its author (no `@`). */
export function lateCommentReply(
  comment: AnsweredComment,
  author: string,
): string {
  return (
    `${lateCommentMarker(comment.id)}\n\`${author}\`, ${linked('your comment', comment.url)} was written while the ` +
    "bot was writing the Spec, so the Spec doesn't include it. If it changes the Spec, someone with Write access can " +
    'edit the Spec comment before `/approve`.'
  );
}

/** Spec "Replies where nothing waits" (SPW16): why an `/approve` has nothing to approve, by the run's state. */
export type NothingWaits =
  'no-run' | 'starting' | 'executing' | 'in-review' | 'stopped';

export function approveNothingWaitsReply(
  comment: AnsweredComment,
  situation: NothingWaits,
  run: number | null,
  /** `no-run` only: the `workflow:` labels on the issue (plan P40). */
  lanes: readonly Lane[] = [],
): string {
  const text = {
    'no-run': `has nothing to approve: ${noRun(lanes)}`,
    starting: `has nothing to approve yet: run ${run} is just starting.`,
    executing: `has nothing to approve: run ${run} is writing the code.`,
    'in-review': `has nothing to approve here: run ${run}'s pull request is open; review it there.`,
    stopped: `has nothing to approve now: run ${run} is stopped. See the stop comment for how to continue.`,
  }[situation];
  return `${approveRefusedMarker(comment.id)}\n${yourApprove(comment)} ${text}`;
}

/**
 * Plan P40: no run, yet a `workflow:` label is on: the event that added it is late (GitHub doesn't keep the order of
 * its deliveries) or was missed (the bot wasn't running), so the reply names the label and says to wait first,
 * instead of asking to add one.
 */
function noRun(lanes: readonly Lane[]): string {
  if (lanes.length === 0)
    return 'this issue has no run. To start one, add a `workflow:` label.';
  const labels = lanes.map((lane) => `\`${laneLabel(lane)}\``);
  return lanes.length === 1
    ? `${labels[0]} is on, but the bot has no run for it yet. If none starts within a few minutes, remove the ` +
        'label and add it again.'
    : `${labels.join(' and ')} are on, but the bot has no run for them yet. If none starts within a few minutes, ` +
        'keep one `workflow:` label, then remove it and add it again.';
}
