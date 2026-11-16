/**
 * Spec 5 (RL6, overview D25): `/retry` is the whole comment, trimmed at both ends and compared in lower case,
 * like `/approve`. Anything else (a word after it, a quote) is a normal comment.
 */
export function isRetryCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/retry';
}
