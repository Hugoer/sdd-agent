// Spec 7 "Refresh frame" (SP4, SP5, SPW17): the bot-owned frame of a refresh call, the same for both kinds, and its
// one user turn. The model gets the document as its text between the markers, never the header, notes or a diff
// block. Pure.
import { isHiddenPath } from '../llm/context-tools.js';
import type { Block, Turn } from '../llm/llm-call.js';
import { DOCUMENT_MAX_CHARS } from './document-text.js';
import { MAX_REFRESH_CHANGES } from './refresh-output.js';

export type RefreshKind = 'spec' | 'plan';

/** The files changed from the document's starting commit to the refresh's, or null when GitHub couldn't compare. */
export interface RefreshChanges {
  paths: string[];
  /** The ones the document's calls read: marked `*`. */
  read: string[];
  /** False when GitHub cut the list. */
  complete: boolean;
}

export interface RefreshFrameValues {
  kind: RefreshKind;
  /** The document's starting commit (its `checkedCommit` or `commit`). */
  from: string;
  /** The commit the refresh reads (B). */
  to: string;
  /** Null: the comparison failed (plan P32), the refresh still runs. */
  changes: RefreshChanges | null;
}

export function refreshFrame({
  kind,
  from,
  to,
  changes,
}: RefreshFrameValues): string {
  const name = kindName(kind);
  const max = DOCUMENT_MAX_CHARS.toLocaleString('en-US');
  const planOnly =
    kind === 'plan'
      ? "\nWhat to build still comes from the approved Spec below; don't add anything it doesn't ask for."
      : '';
  return `You are the ${name} step of a spec-driven workflow on a GitHub issue, asked to bring an existing ${name} up to
date with the repository. The ${name} below was written at commit ${from}; the repository is now at commit ${to}.
${changedLine(name, from, changes)}

Read what you need with read_file at ${to}. Then change only what the new code makes wrong or incomplete, and keep
everything else exactly as written, including the edits people made: the same sections, wording and order. If the
method below says how to update a ${name}, follow it.${planOnly}

Answer with:
- upToDate: true when nothing needs to change; then leave changes and document empty.
- changes: what you changed and why, one short line each, at most ${MAX_REFRESH_CHANGES}.
- document: the whole updated ${name}, at most ${max} characters, in its language. Write logins in backticks
  and add no HTML comments.`;
}

/**
 * The changed files, the ones the document read marked `*`. Plan P41: the paths the read tools hide (P10) are never
 * named. Plan P32: the comparison failed → read what you need.
 */
function changedLine(
  name: string,
  from: string,
  changes: RefreshChanges | null,
): string {
  if (!changes)
    return `The bot couldn't list the files changed since ${from}; read what you need.`;
  const shown = changes.paths.filter((path) => !isHiddenPath(path));
  const more = changes.complete ? '' : ', and possibly more';
  if (shown.length === 0)
    return `None of the files you can read changed since${changes.complete ? '' : ' (the list may be incomplete)'}.`;
  const paths = shown
    .map((path) => (changes.read.includes(path) ? `${path} *` : path))
    .join(', ');
  return `These files changed since, * marking the ones the ${name} read: ${paths}${more}.`;
}

export interface RefreshTurnsInput {
  /** `#12`. */
  issue: string;
  title: string;
  /** The document to bring up to date: its text between the markers (SPW17). */
  document: { kind: RefreshKind; id: string; version: number; text: string };
  /** A Plan's refresh only: the approved Spec it is written from. */
  approvedSpec?: {
    id: string;
    version: number;
    approvedBy: string;
    text: string;
  };
}

/**
 * The one user turn: the issue's title, the approved Spec (a Plan's refresh), then the document to update; all
 * untrusted, keyed by version (`spec-<versionId>`, `plan-<versionId>`) as the Plan's call keys the approved Spec.
 */
export function refreshTurns({
  issue,
  title,
  document,
  approvedSpec,
}: RefreshTurnsInput): Turn[] {
  const name = kindName(document.kind);
  const blocks: Block[] = [
    { kind: 'text', text: `Issue ${issue} title:` },
    {
      kind: 'untrusted',
      source: { key: 'title', label: 'the issue title' },
      text: title,
    },
  ];
  if (approvedSpec)
    blocks.push(
      {
        kind: 'text',
        text: `Approved Spec (v${approvedSpec.version}, approved by \`${approvedSpec.approvedBy}\`):`,
      },
      {
        kind: 'untrusted',
        source: { key: `spec-${approvedSpec.id}`, label: 'the approved Spec' },
        text: approvedSpec.text,
      },
    );
  blocks.push(
    { kind: 'text', text: `${name} v${document.version} to update:` },
    {
      kind: 'untrusted',
      source: {
        key: `${document.kind}-${document.id}`,
        label: `the ${name} to update`,
      },
      text: document.text,
    },
  );
  return [{ role: 'user', blocks }];
}

function kindName(kind: RefreshKind): string {
  return kind === 'plan' ? 'Plan' : 'Spec';
}
