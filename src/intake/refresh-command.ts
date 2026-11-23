/**
 * Spec 7 "`/refresh`" (D29, SPW9): the whole comment, trimmed at both ends and compared in lower case, like `/approve`
 * and `/retry`. Anything else (a word after it, a quote) is a normal comment.
 */
export function isRefreshCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/refresh';
}
