// Spec 4 "Secret scanner" (L9): the kinds of secret the bot never posts, as a fixed list of patterns. A list,
// not a proof: a secret split over two lines, encoded or of an unknown format is not found (spec "Edge cases").
// No entropy rule: commit SHAs, delivery IDs and comment IDs are in many bot texts.

export type SecretKind =
  | 'github-token'
  | 'google-api-key'
  | 'aws-access-key'
  | 'slack-token'
  | 'private-key'
  | 'own-secret';

/** In this order: when two findings start at the same place, the first kind here names it. */
export const SECRET_PATTERNS: readonly {
  kind: Exclude<SecretKind, 'own-secret'>;
  pattern: RegExp;
}[] = [
  {
    kind: 'private-key',
    // To its END line, or to the end of the text when the END line is missing.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    kind: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
  },
  { kind: 'google-api-key', pattern: /AIza[A-Za-z0-9_-]{35}/g },
  { kind: 'aws-access-key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { kind: 'slack-token', pattern: /xox[bpars]-[A-Za-z0-9-]{10,}/g },
];

/** `own-secret` covers only values this long or longer: a shorter one would match ordinary words. */
export const MIN_OWN_SECRET_LENGTH = 8;

/** The placeholder a redaction writes (spec 12 "Contracts"); group 1 is the kind as written. */
export const REDACTED_PLACEHOLDER = /\[REDACTED: ([a-z-]+)\]/g;

const SECRET_KINDS: ReadonlySet<string> = new Set<SecretKind>([
  ...SECRET_PATTERNS.map(({ kind }) => kind),
  'own-secret',
]);

/**
 * The kinds of the `[REDACTED: <kind>]` placeholders in the text, each once, in order of first appearance (spec 12
 * BDW2). A placeholder naming no known kind is ignored (plan DP15).
 */
export function placeholderKinds(text: string): SecretKind[] {
  const kinds = new Set<SecretKind>();
  for (const match of text.matchAll(REDACTED_PLACEHOLDER)) {
    if (SECRET_KINDS.has(match[1])) kinds.add(match[1] as SecretKind);
  }
  return [...kinds];
}
