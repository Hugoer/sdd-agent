// Spec 7 "The document comment": every marker and comment text of the documents, each built next to its marker.
// English; a login in backticks without `@`. The document's own text arrives cleaned (`cleanDocument`). Pure.
import type { Lane } from '../contracts/issue-provider.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import { laneLabel } from '../github/labels.js';
import { withNotes } from '../llm/prompt.js';
import { namedFiles, type FlaggedFile, type Reader } from './commit-check.js';
import {
  DIFF_BLOCK_MAX_COMMENT_CHARS,
  DOCUMENT_END,
  DOCUMENT_START,
} from './document-text.js';
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
  /** How this version came to be; written when left out. */
  origin?: VersionOrigin;
  /** A refreshed Spec while a Plan waited (SPW8): that Plan's version, which no longer counts. */
  planNoLongerCounts?: number;
}

/** How a version came to be, as its comment's header says (spec "The v2 comment", the `/restore` table). */
export type VersionOrigin =
  | { kind: 'written' }
  | {
      kind: 'refreshed';
      /** The version it replaces, and the commit that version started from (`checkedCommit` or `commit`). */
      previous: { version: number; from: string };
      /** Null when GitHub couldn't compare (plan P32). */
      compareUrl: string | null;
      /** The `/refresh` and its author (plan P39: linked). */
      by: string;
      command: Pick<TaskComment, 'url'>;
      /** The model's change lines, cleaned and redacted. */
      changes: string[];
      /** `diffBlock(the replaced text, this text)`; null when they are the same. */
      diff: string | null;
    }
  | {
      kind: 'restored';
      by: string;
      command: Pick<TaskComment, 'url'>;
      /** The bot missed the deletion: it restores its own text, and the edits made to the comment are lost. */
      lost: boolean;
    };

/**
 * The Spec comment: its marker, the header (version, run, lane, the commit it read; a refresh or a restore says
 * so), how to change and approve it (what the approval starts depends on the lane), the document between its two
 * hidden markers (SPW5), a refresh's diff, the notes.
 */
export function specComment(input: SpecCommentInput): string {
  const origin = input.origin ?? WRITTEN;
  const next =
    input.run.lane === 'full-sdd'
      ? 'the bot writes the Plan from the text as it reads then'
      : 'the bot starts coding from the text as it reads then';
  const noLongerCounts =
    input.planNoLongerCounts === undefined || origin.kind !== 'refreshed'
      ? []
      : [
          '',
          `Plan v${input.planNoLongerCounts} was written from Spec v${origin.previous.version}, so it no longer ` +
            'counts: approve this Spec and the bot writes a new Plan.',
        ];
  return documentComment(input, origin, {
    marker: specMarker(input.versionId),
    header: versionHeader(
      `Spec v${input.version}`,
      `run ${input.run.number} (\`${input.run.lane}\`)`,
      [],
      input,
      origin,
    ),
    originLines: [...originLines(origin, null), ...noLongerCounts],
    approveLine:
      `To change it, edit this comment. When it's right, an Approver (Write access) comments \`/approve\` and ${next}. ` +
      `\`/refresh\` checks it against today's \`${input.base}\`.`,
  });
}

const WRITTEN: VersionOrigin = { kind: 'written' };

interface CommentParts {
  marker: string;
  header: string;
  /** Under the header: a refresh's "What changed" or a restore's line; none for a written version. */
  originLines: string[];
  /** Lines of the header after the origin's (the Plan's ⚠️ line). */
  warningLines?: string[];
  approveLine: string;
}

/**
 * The parts in their order, then the notes. A refresh's diff goes under the document, folded; the whole comment
 * would pass 65,000 characters → one line instead (spec "The v2 comment").
 */
function documentComment(
  input: { version: number; text: string; notes: string[] },
  origin: VersionOrigin,
  parts: CommentParts,
): string {
  const top = [
    parts.marker,
    parts.header,
    '',
    ...(parts.originLines.length > 0 ? [...parts.originLines, ''] : []),
    ...(parts.warningLines?.length ? [...parts.warningLines, ''] : []),
    parts.approveLine,
    '',
    DOCUMENT_START,
    input.text,
    DOCUMENT_END,
  ].join('\n');
  if (origin.kind !== 'refreshed' || origin.diff === null)
    return withNotes(top, input.notes);
  const v = `v${origin.previous.version}`;
  const withDiff = withNotes(
    `${top}\n\n<details><summary>Diff from ${v} (as it read at the refresh)</summary>\n\n${origin.diff}\n\n</details>`,
    input.notes,
  );
  if (withDiff.length <= DIFF_BLOCK_MAX_COMMENT_CHARS) return withDiff;
  return withNotes(
    `${top}\n\nThe diff is too long to show here; compare ${v} and v${input.version} above.`,
    input.notes,
  );
}

/**
 * "**Spec v2** · run 2 (`full-sdd`) · replaces v1 above · read at `main` @ `9e1d0c2` (v1: `4f2c1ab`, [compare](…))";
 * a restore: "**Spec v1** (restored for `alice`'s `/restore`) · run 2 (`full-sdd`) · read at …".
 */
function versionHeader(
  name: string,
  run: string,
  middle: string[],
  input: { base: string; commit: string },
  origin: VersionOrigin,
): string {
  const title =
    origin.kind === 'restored'
      ? `**${name}** (restored for ${linked(`\`${origin.by}\`'s \`/restore\``, origin.command.url)})`
      : `**${name}**`;
  const read = `read at ${at(input.base, input.commit)}`;
  if (origin.kind !== 'refreshed')
    return [title, run, ...middle, read].join(' · ');
  const { version, from } = origin.previous;
  const compare = origin.compareUrl ? `, [compare](${origin.compareUrl})` : '';
  return [
    title,
    run,
    ...middle,
    `replaces v${version} above`,
    `${read} (v${version}: \`${from.slice(0, 7)}\`${compare})`,
  ].join(' · ');
}

/** A refresh's "Refreshed for … What changed:" list; a restore's line. A refreshed Plan says the Spec still holds. */
function originLines(
  origin: VersionOrigin,
  specStillUpToDate: number | null,
): string[] {
  if (origin.kind === 'written') return [];
  if (origin.kind === 'restored')
    return [
      origin.lost
        ? 'The bot missed the deletion, so this is its last version: edits made to the deleted comment are lost.'
        : 'Restored as it read when it was deleted.',
    ];
  const by = linked(`\`${origin.by}\`'s \`/refresh\``, origin.command.url);
  const spec =
    specStillUpToDate === null
      ? ''
      : ` The approved Spec v${specStillUpToDate} is still up to date.`;
  return [
    `Refreshed for ${by}.${spec} What changed:`,
    ...origin.changes.map((change) => `- ${change}`),
  ];
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
  /** Null when the Spec's approval flagged nothing and compared (a refreshed or restored Plan: always null). */
  warning: SpecWarning | null;
  text: string;
  notes: string[];
  /** How this version came to be; written when left out. */
  origin?: VersionOrigin;
}

/**
 * The Plan comment (spec "The document comment"): its marker, the header naming the approved Spec it comes from,
 * a refresh's changes (the approved Spec still up to date) or a restore's line, the ⚠️ line when the Spec's approval
 * flagged files or couldn't compare, how to change and approve it, the document between its markers, a refresh's
 * diff, the notes.
 */
export function planComment(input: PlanCommentInput): string {
  const origin = input.origin ?? WRITTEN;
  return documentComment(input, origin, {
    marker: planMarker(input.versionId),
    header: versionHeader(
      `Plan v${input.version}`,
      `run ${input.run.number} (\`full-sdd\`)`,
      [`from the approved Spec v${input.specVersion}`],
      input,
      origin,
    ),
    originLines: originLines(origin, input.specVersion),
    warningLines: input.warning
      ? [specWarningLine(input.warning, input.base)]
      : [],
    approveLine:
      "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the bot " +
      `starts coding from the approved Spec and this Plan as it reads then. \`/refresh\` checks both against today's ` +
      `\`${input.base}\`.`,
  });
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
  refusedMarker('approve', commentId);

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

/** The commands about documents (spec 7's intake). */
export type DocumentCommand = 'approve' | 'refresh' | 'restore';

/** `<command>-refused:<commentId>`: the reply to a command where nothing waits (or, for `/approve`, any refusal). */
export const refusedMarker = (
  command: DocumentCommand,
  commentId: string,
): string => marker(`${command}-refused:${commentId}`);

/** Spec "Replies where nothing waits" (SPW16): why a command has nothing to work on, by the run's state. */
export type NothingWaits =
  | 'no-run'
  | 'starting'
  | 'grilling'
  | 'executing'
  | 'in-review'
  | 'stopped'
  | 'code-only';

/** The spec's table, a column per command; `/approve` while grilling is spec 6's reply, and its go-signal waits. */
function nothingWaitsTexts(
  command: DocumentCommand,
  run: number | null,
  lanes: readonly Lane[],
): Partial<Record<NothingWaits, string>> {
  const stopped = `run ${run} is stopped. Continue it first (see the stop comment), then comment \`/${command}\`.`;
  switch (command) {
    case 'approve':
      return {
        'no-run': `has nothing to approve: ${noRun(lanes)}`,
        starting: `has nothing to approve yet: run ${run} is just starting.`,
        executing: `has nothing to approve: run ${run} is writing the code.`,
        'in-review': `has nothing to approve here: run ${run}'s pull request is open; review it there.`,
        stopped: `has nothing to approve now: run ${run} is stopped. See the stop comment for how to continue.`,
      };
    case 'refresh':
      return {
        'no-run': `has nothing to refresh: ${noRun(lanes)}`,
        starting: `has nothing to refresh yet: run ${run} is just starting.`,
        grilling: `has nothing to refresh yet: run ${run} is still at Grill Me, so there's no Spec.`,
        executing: `comes too late: run ${run} is already writing the code from the approved texts.`,
        'in-review': `comes too late: run ${run}'s pull request is open.`,
        stopped: `has nothing to refresh now: ${stopped}`,
        'code-only':
          'has nothing to refresh: a `code-only` run has no Spec or Plan; the bot codes from the issue description ' +
          'as it reads at `/approve`.',
      };
    case 'restore':
      return {
        'no-run': `has nothing to restore: ${noRun(lanes)}`,
        starting: `has nothing to restore yet: run ${run} is just starting.`,
        grilling: `has nothing to restore: run ${run} is still at Grill Me, so there's no Spec.`,
        executing: 'has nothing to restore: the bot keeps the approved texts.',
        'in-review':
          'has nothing to restore: the bot keeps the approved texts.',
        stopped: `has nothing to restore now: ${stopped}`,
        'code-only':
          'has nothing to restore: a `code-only` run has no Spec or Plan.',
      };
  }
}

export function nothingWaitsReply(
  command: DocumentCommand,
  comment: AnsweredComment,
  situation: NothingWaits,
  run: number | null,
  /** `no-run` only: the `workflow:` labels on the issue (plan P40). */
  lanes: readonly Lane[] = [],
): string {
  const text = nothingWaitsTexts(command, run, lanes)[situation];
  if (text === undefined)
    throw new Error(`no /${command} reply where nothing waits: ${situation}`);
  return `${refusedMarker(command, comment.id)}\n${linked(`Your \`/${command}\``, comment.url)} ${text}`;
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

export const refreshMarker = (commentId: string): string =>
  marker(`refresh:${commentId}`);

const yourRefresh = (comment: Pick<TaskComment, 'url'>): string =>
  linked('Your `/refresh`', comment.url);

/** A version a refresh reply names: "Spec v1", "Plan v2". */
export interface NamedVersion {
  kind: 'spec' | 'plan';
  version: number;
}

export type RefreshRefusal = 'deleted' | 'empty' | 'already-approved';

/**
 * A `/refresh` that finds the waiting document deleted (SPW23: never from the stored text on its own), emptied
 * (plan P5) or already approved: one reply, no model call.
 */
export function refreshRefusedReply(
  comment: AnsweredComment,
  refusal: RefreshRefusal,
  document: NamedVersion,
): string {
  const name = versionName(document);
  const text = {
    deleted: `has nothing to refresh: ${name} was deleted. Comment \`/restore\` to get it back, then \`/refresh\`.`,
    empty:
      `has nothing to refresh: ${name}'s comment has no text left between its markers. Edit the comment to put the ` +
      `${kindName(document.kind)} back, then comment \`/refresh\`.`,
    'already-approved': `can't refresh ${name}: it's already approved.`,
  }[refusal];
  return `${refreshMarker(comment.id)}\n${yourRefresh(comment)} ${text}`;
}

export interface NothingChanged {
  /** The Spec alone (`spec-review`), or the Spec and the Plan (`ready-for-dev`). */
  documents: NamedVersion[];
  base: string;
  /** The commit they all started from, which `main` still is. */
  commit: string;
  /** A refresh moved a starting point there (SPW11): "last checked", not "written". */
  checked: boolean;
}

/** `main` hasn't moved since the documents' starting commit: no model call. */
export function refreshNothingChangedReply(
  comment: AnsweredComment,
  input: NothingChanged,
): string {
  const names = input.documents.map(versionName).join(' and ');
  const verb = input.documents.length === 1 ? 'was' : 'were';
  return (
    `${refreshMarker(comment.id)}\n${yourRefresh(comment)} has nothing to refresh: nothing changed on ` +
    `\`${input.base}\` since ${names} ${verb} ${input.checked ? 'last checked' : 'written'} ` +
    `(\`${input.commit.slice(0, 7)}\`).`
  );
}

/** What the files-changed sentence of an up-to-date reply says; null when GitHub couldn't compare (plan P32). */
export interface ChangedCount {
  files: number;
  complete: boolean;
  compareUrl: string;
}

export type UpToDate =
  /** `spec-review`: the Spec's call answered up to date. */
  | { kind: 'spec'; spec: number; from: string; changed: ChangedCount | null }
  /** The Plan waits: the Spec is up to date and the Plan was written at the refresh's commit (no Plan call). */
  | { kind: 'plan-at-commit'; spec: number; plan: number }
  /** The Plan waits: both calls answered up to date. */
  | { kind: 'both'; spec: number; plan: number };

/** The refresh changed nothing: one reply with the calls' notes (SPW11 moves the starting point). */
export function refreshUpToDateReply(
  comment: AnsweredComment,
  base: string,
  /** The refresh's commit (B). */
  to: string,
  upToDate: UpToDate,
  notes: string[],
): string {
  const against = `against \`${base}\` @ \`${to.slice(0, 7)}\``;
  let text: string;
  switch (upToDate.kind) {
    case 'spec':
      text =
        `checked Spec v${upToDate.spec} ${against}: still up to date. ` +
        `${changedSentence(upToDate.from, upToDate.changed)}; nothing in the Spec needs to change.`;
      break;
    case 'plan-at-commit':
      text =
        `checked Spec v${upToDate.spec} ${against}: still up to date, and Plan v${upToDate.plan} was already ` +
        'written at that commit.';
      break;
    case 'both':
      text = `checked Spec v${upToDate.spec} and Plan v${upToDate.plan} ${against}: both still up to date.`;
      break;
  }
  return withNotes(
    `${refreshMarker(comment.id)}\n${yourRefresh(comment)} ${text}`,
    notes,
  );
}

/** "3 files changed since `4f2c1ab` ([compare](…))", or the comparison failed. */
function changedSentence(from: string, changed: ChangedCount | null): string {
  const since = `since \`${from.slice(0, 7)}\``;
  if (!changed) return `The bot couldn't list the files changed ${since}`;
  const files = !changed.complete
    ? `${changed.files} or more files`
    : changed.files === 0
      ? 'No files'
      : changed.files === 1
        ? '1 file'
        : `${changed.files} files`;
  return `${files} changed ${since} ([compare](${changed.compareUrl}))`;
}

function versionName({ kind, version }: NamedVersion): string {
  return `${kindName(kind)} v${version}`;
}
