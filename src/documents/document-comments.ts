// Spec 7 "The document comment": every marker and comment text of the documents, each built next to its marker.
// English; a login in backticks without `@`. The document's own text arrives cleaned (`cleanDocument`). Pure.
import type { Lane } from '../contracts/issue-provider.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import { laneLabel } from '../github/labels.js';
import { withNotes } from '../llm/prompt.js';
import type { RunEnd } from '../workflow/workflow-comments.js';
import {
  namedFiles,
  type FlaggedFile,
  type Question,
  type Reader,
  type StartingPoint,
} from './commit-check.js';
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

export interface PlanCommentInput {
  versionId: string;
  version: number;
  run: { number: number };
  base: string;
  commit: string;
  /** The approved Spec version it is written from. */
  specVersion: number;
  text: string;
  notes: string[];
  /** How this version came to be; written when left out. */
  origin?: VersionOrigin;
}

/**
 * The Plan comment (spec "The document comment"): its marker, the header naming the approved Spec it comes from,
 * a refresh's changes (the approved Spec still up to date) or a restore's line, how to change and approve it, the
 * document between its markers, a refresh's diff, the notes. Spec 14 (UA4): no ⚠️ line; an approval asks first.
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
    approveLine:
      "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the bot " +
      `starts coding from the approved Spec and this Plan as it reads then. \`/refresh\` checks both against today's ` +
      `\`${input.base}\`.`,
  });
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
  | 'already-approved'
  | 'before-document'
  | 'deleted'
  | 'empty'
  | 'before-question';

/**
 * Spec "`/approve`", the verdict table: one reply per refused `/approve` comment, naming the waiting document.
 * `questionUrl`: the bot's last question, which a `before-question` refusal links (spec 14, UA5; plan UP2).
 */
export function approveRefusedReply(
  comment: AnsweredComment,
  refusal: ApproveRefusal,
  document: RepliedDocument,
  lane: Lane,
  questionUrl: string | null = null,
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
    'before-question':
      `${yours} was written before ${linked("the bot's question", questionUrl ?? undefined)}, so it didn't count: ` +
      'read it, then comment `/refresh`, or `/approve` again.',
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

/**
 * Plan P4: the files grouped by who read them: "`a`, which it read, and `b`, which the approved Spec read"; `own`
 * names the document's own reader ("it", or "Spec v1" where "it" would be unclear).
 */
function readFiles(
  flagged: FlaggedFile[],
  complete: boolean,
  own = 'it',
): string {
  const groups = new Map<string, string[]>();
  for (const { path, readers } of flagged) {
    const who = readerText(readers, own);
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

function readerText(readers: Reader[], own: string): string {
  if (readers.includes('own') && readers.includes('spec'))
    return `${own} and the approved Spec read`;
  return readers.includes('own') ? `${own} read` : 'the approved Spec read';
}

export const approveAskedMarker = (commentId: string): string =>
  marker(`approve-asked:${commentId}`);

export interface ApproveAskedInput {
  /** The `/approve` the question answers (its id names the marker, plan P39). */
  approve: AnsweredComment;
  document: { kind: 'spec' | 'plan'; version: number };
  /** A Plan: the approved Spec version it comes from. */
  specVersion?: number;
  base: string;
  start: StartingPoint;
  /** The bot's last question (UP2), which a starting point `asked` links. */
  questionUrl: string | null;
  question: Question;
  /** GitHub's compare page from the starting point to now; unused for `not-compared`. */
  compareUrl: string;
}

/**
 * Spec 14 "The question" (UA1–UA3, UAW5, UAW6; plan UP3, UP4): the `/approve` didn't count yet, why (the read files
 * that changed, GitHub couldn't compare, or a large change), and the two ways on: `/refresh`, or `/approve` again.
 */
export function approveAskedReply(input: ApproveAskedInput): string {
  const { document, start, question, base } = input;
  const name = `${kindName(document.kind)} v${document.version}`;
  const plan = document.kind === 'plan';
  const both = plan ? `Spec v${input.specVersion ?? 1} and ${name}` : 'it';
  const asked = linked('the bot asked', input.questionUrl ?? undefined);
  const commit = `\`${start.commit.slice(0, 7)}\``;
  // After "since the bot asked", "it" would read as the bot: the document is named instead.
  const own = start.kind === 'asked' ? name : 'it';
  const since = {
    asked: `since ${asked} (${commit})`,
    checked: `since ${name} was last checked (${commit})`,
    written: `since ${name} was written (${commit})`,
  }[start.kind];
  const approveAgain = `\`/approve\` again to approve ${plan ? name : 'it'} as it is.`;
  const head = `${yourApprove(input.approve)} didn't count yet:`;
  const compare = `[compare](${input.compareUrl})`;
  let text: string;
  if (question.result === 'stale') {
    const skills = question.skills;
    const skill =
      skills.length === 0
        ? ''
        : plan
          ? ` and the ${skills.map((step) => `\`${step}\``).join(' and ')} skill${skills.length > 1 ? 's' : ''}`
          : ` and its \`${skills[0]}\` skill`;
    text =
      `${head} ${since}, \`${base}\` changed ${readFiles(question.flagged, question.complete, own)} (${compare}). ` +
      `Comment \`/refresh\` to bring ${both} up to date with \`${base}\`${skill}, or ${approveAgain}`;
  } else {
    const readers = plan ? `${own} or the approved Spec` : own;
    const check = `Comment \`/refresh\` to check ${both} against today's \`${base}\`, or ${approveAgain}`;
    if (question.result === 'not-compared') {
      const where = {
        asked: `the commit of ${linked("the bot's question", input.questionUrl ?? undefined)}`,
        checked: `where ${name} was last checked`,
        written: `where ${name} was written`,
      }[start.kind];
      const whose = plan ? `${own} or the approved Spec` : own;
      text =
        `${head} the bot couldn't compare ${commit}, ${where}, with \`${base}\` (that commit is no longer on ` +
        `GitHub, e.g. after a force-push), so it can't tell whether files ${whose} read changed. ${check}`;
    } else {
      const count = question.complete
        ? `${question.changedFiles} files changed on \`${base}\` (${compare}), none of them one ${readers} read.`
        : `more than ${question.changedFiles} files changed on \`${base}\` (${compare}); none of the ` +
          `${question.changedFiles} GitHub lists is one ${readers} read.`;
      text = `${head} ${since}, ${count} A change this size may still affect ${plan ? 'them' : 'it'}. ${check}`;
    }
  }
  return `${approveAskedMarker(input.approve.id)}\n${text}`;
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
  | 'code-only'
  // Spec 13 (plan FP1, FP19): `ready-for-dev` after every approval; `/refresh` and `/restore` only.
  | 'approved';

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
        approved: `comes too late: every approval of run ${run} is in, and the bot codes from the approved texts.`,
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
        approved: `has nothing to restore: every approval of run ${run} is in, and the bot keeps the approved texts.`,
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

export const documentDeletedMarker = (commentId: string): string =>
  marker(`doc-deleted:${commentId}`);

export interface DeletedDocument {
  kind: 'spec' | 'plan';
  version: number;
  /** Who deleted it (the event's sender), in backticks. */
  by: string;
  lane: Lane;
  /** The run stopped while the document waited (`needs-human`): its number, so the line says to continue it. */
  stoppedRun: number | null;
}

/**
 * SP9: the waiting document's comment was deleted: who did it, `/restore` to post it again as it read when deleted,
 * or start over; a stopped run is continued first (2026-11-21, review).
 */
export function documentDeletedComment(
  commentId: string,
  doc: DeletedDocument,
): string {
  const text =
    `The ${kindName(doc.kind)} comment (v${doc.version}) was deleted by \`${doc.by}\`, so there's nothing to approve. ` +
    'To get it back, comment `/restore`: the bot posts it again as it read when it was deleted. To start over ' +
    `instead, remove the \`${laneLabel(doc.lane)}\` label and add it again.`;
  const stopped =
    doc.stoppedRun === null
      ? ''
      : `\n\nRun ${doc.stoppedRun} is stopped: continue it first (see the stop comment), then comment \`/restore\`.`;
  return `${documentDeletedMarker(commentId)}\n${text}${stopped}`;
}

export const restoreMarker = (commentId: string): string =>
  marker(`restore:${commentId}`);

/** The spec's `/restore` table: the waiting document is still on the issue (with its link), or already approved. */
export function restoreRefusedReply(
  comment: AnsweredComment,
  refusal: 'nothing-deleted' | 'approved',
  document: NamedVersion & { url: string | null },
): string {
  const name = versionName(document);
  const text =
    refusal === 'approved'
      ? `has nothing to restore: ${name} is already approved; the bot keeps the approved text.`
      : `has nothing to restore: ${name} is still on the issue${document.url ? ` ([link](${document.url}))` : ''}.`;
  return `${restoreMarker(comment.id)}\n${linked('Your `/restore`', comment.url)} ${text}`;
}

export interface EndedRunDocuments {
  run: number;
  end: RunEnd;
  /** The run's current Spec and Plan (not superseded, not deleted, approved or not), in that order. */
  documents: (NamedVersion & { url: string | null })[];
}

/**
 * SPW10: the line spec 7 adds to spec 5's run-ended comment, after spec 6's answers block: the ended run's documents,
 * linked, no longer count, and how to keep something from them. None (ended during Grill Me, or `code-only`) → null.
 */
export function runEndedLine({
  run,
  end,
  documents,
}: EndedRunDocuments): string | null {
  if (documents.length === 0) return null;
  const one = documents.length === 1;
  const links = documents
    .map((doc) =>
      doc.url ? `[${versionName(doc)}](${doc.url})` : versionName(doc),
    )
    .join(' and ');
  const them = one ? 'it' : 'them';
  const next = end.kind === 'replaced' ? `Run ${end.by.number}` : 'A new run';
  return (
    `${links} belonged to run ${run} and no longer ${one ? 'counts' : 'count'}. ${next} doesn't use ${them}: it ` +
    `works from the issue description and its own Grill Me answers. To keep anything from ${them}, copy it into the ` +
    'description.'
  );
}
