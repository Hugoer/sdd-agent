/**
 * Spec 2 "What counts as `/approve`" (IA6, overview D20): the whole comment, trimmed at both ends and
 * compared in lower case. Anything else (a quote, a word after it, an email reply) is a normal comment.
 */
export function isApproveCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/approve';
}

/**
 * Spec 7 (spec 2's agreement; SPW12): a near miss of `/approve`: trimmed and in lower case it starts with `/approve`
 * but isn't exactly that (`/approve please`, `/approved`). Such a comment gets the hint, once per waiting document.
 */
export function isApproveNearMiss(text: string): boolean {
  const command = text.trim().toLowerCase();
  return command.startsWith('/approve') && command !== '/approve';
}
