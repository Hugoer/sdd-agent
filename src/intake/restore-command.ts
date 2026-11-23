/**
 * Spec 7 "`/restore`" (D30, SPW9): the whole comment, trimmed at both ends and compared in lower case, like `/approve`
 * and `/refresh`. Anything else (a word after it, a quote) is a normal comment.
 */
export function isRestoreCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/restore';
}
