// Spec 7 "Approving" step 2 (SP3; plan P4, P33): the changed files a document's calls read, and the pieces of the
// replies that name them. Spec 14 (UAW3–UAW6): an `/approve`'s starting point and whether it asks first. Pure.

/** Who read a file: the document's own versions, or (a Plan, plan P4) the approved Spec it is based on. */
export type Reader = 'own' | 'spec';

/** One version of a document's chain (itself, then each `basedOnId`, back to the first writer). */
export interface ChainVersion {
  kind: string;
  /** The call's last `execution_logs` row; null for a restore (no call of its own). */
  logId: string | null;
}

export interface FlaggedFile {
  path: string;
  readers: Reader[];
}

/** A file a document's chain read; `skill`: the step whose skill it belongs to (spec 14, plan UP5), else null. */
export interface Read {
  path: string;
  reader: Reader;
  skill: string | null;
}

/** A `context_loads` row of a call: its `kind` and `skill` say whether it is a file of the step's skill. */
export interface LoadedPath {
  logId: string;
  path: string;
  kind: string | null;
  skill: string | null;
}

/**
 * The files each version of the chain loaded (`loads`: the `context_loads` rows of their calls), with who read them:
 * a version of the document's own kind is `own`, an approved Spec under a Plan is `spec`.
 */
export function chainReads(
  kind: string,
  chain: ChainVersion[],
  loads: LoadedPath[],
): Read[] {
  const readerOf = new Map(
    chain
      .filter(({ logId }) => logId !== null)
      .map(({ kind: versionKind, logId }) => [
        logId!,
        versionKind === kind ? ('own' as const) : ('spec' as const),
      ]),
  );
  return loads
    .filter(({ logId }) => readerOf.has(logId))
    .map(({ logId, path, kind: loadKind, skill }) => ({
      path,
      reader: readerOf.get(logId)!,
      skill: loadKind === 'step-skill' ? skill : null,
    }));
}

/** SP3: the changed paths that were read, in the changed list's order, each with its readers (own first). */
export function flaggedFiles(
  changedPaths: string[],
  reads: Pick<Read, 'path' | 'reader'>[],
): FlaggedFile[] {
  return changedPaths.flatMap((path) => {
    const readers = (['own', 'spec'] as const).filter((reader) =>
      reads.some((read) => read.path === path && read.reader === reader),
    );
    return readers.length > 0 ? [{ path, readers }] : [];
  });
}

/** At most this many files are named in a line; the rest are counted (spec "The document comment"). */
export const MAX_NAMED_FILES = 5;

/**
 * "`a`", "`a` and `b`", "`a`, `b`, `c`, `d`, `e` and 3 more"; when the host cut the list (`complete` false, more
 * than 300 changed files): "`a`, `b` … and possibly more".
 */
export function namedFiles(paths: string[], complete: boolean): string {
  const named = paths.slice(0, MAX_NAMED_FILES).map((path) => `\`${path}\``);
  const rest = paths.length - named.length;
  const items = rest > 0 ? [...named, `${rest} more`] : named;
  if (!complete) return `${items.join(', ')} … and possibly more`;
  return items.length === 1
    ? items[0]
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Spec 14 (UAW3): where an `/approve` compares from, and how its question names it. */
export interface StartingPoint {
  commit: string;
  /** `asked`: the version's last question; `checked`: a refresh found it up to date; `written`: its own commit. */
  kind: 'asked' | 'checked' | 'written';
}

/** The last question's commit, else where a refresh found it up to date, else where it was written; null: no commit. */
export function startOf(doc: {
  askedCommit: string | null;
  checkedCommit: string | null;
  commit: string | null;
}): StartingPoint | null {
  if (doc.askedCommit) return { commit: doc.askedCommit, kind: 'asked' };
  if (doc.checkedCommit) return { commit: doc.checkedCommit, kind: 'checked' };
  return doc.commit ? { commit: doc.commit, kind: 'written' } : null;
}

/** Spec 14 "The question": why an `/approve` asks first. */
export type Question =
  | {
      result: 'stale';
      /** Every read file that changed, with its readers. */
      flagged: FlaggedFile[];
      /** The steps whose skill files are among them (UAW6), `spec` before `plan`. */
      skills: string[];
      /** False when GitHub cut the list. */
      complete: boolean;
      changedFiles: number;
    }
  | { result: 'not-compared' }
  | { result: 'large-change'; changedFiles: number; complete: boolean };

/**
 * UA1, UA3, UAW5: GitHub couldn't compare → `not-compared`; a file the chain read changed → `stale` (whatever the
 * count); else more than `threshold` paths (GitHub's cut list, 300, is always above it) → `large-change`; else none.
 */
export function questionFor({
  changed,
  reads,
  threshold,
}: {
  changed: { paths: string[]; complete: boolean } | 'not-compared';
  reads: Read[];
  threshold: number;
}): Question | null {
  if (changed === 'not-compared') return { result: 'not-compared' };
  const flagged = flaggedFiles(changed.paths, reads);
  if (flagged.length > 0) {
    const paths = new Set(flagged.map(({ path }) => path));
    const skills = new Set(
      reads.flatMap(({ path, skill }) =>
        skill !== null && paths.has(path) ? [skill] : [],
      ),
    );
    return {
      result: 'stale',
      flagged,
      skills: ['spec', 'plan'].filter((step) => skills.has(step)),
      complete: changed.complete,
      changedFiles: changed.paths.length,
    };
  }
  return changed.paths.length > threshold
    ? {
        result: 'large-change',
        changedFiles: changed.paths.length,
        complete: changed.complete,
      }
    : null;
}
