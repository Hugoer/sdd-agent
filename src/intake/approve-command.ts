/**
 * Spec 2 "What counts as `/approve`" (IA6, overview D20): the whole comment, trimmed at both ends and
 * compared in lower case. Anything else (a quote, a word after it, an email reply) is a normal comment.
 */
export function isApproveCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/approve';
}
