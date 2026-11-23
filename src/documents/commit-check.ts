// Spec 7 "Approving" step 2 (SP3; plan P4, P33): the changed files a document's calls read, and the pieces of the
// warning line and reply that name them. Pure.

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

/**
 * The files each version of the chain loaded (`loads`: the `context_loads` rows of their calls), with who read them:
 * a version of the document's own kind is `own`, an approved Spec under a Plan is `spec`.
 */
export function chainReads(
  kind: string,
  chain: ChainVersion[],
  loads: { logId: string; path: string }[],
): { path: string; reader: Reader }[] {
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
    .map(({ logId, path }) => ({ path, reader: readerOf.get(logId)! }));
}

/** SP3: the changed paths that were read, in the changed list's order, each with its readers (own first). */
export function flaggedFiles(
  changedPaths: string[],
  reads: { path: string; reader: Reader }[],
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
