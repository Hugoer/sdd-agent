/**
 * The issue or PR a stored event is about, as `owner/repo#number` (spec 2, IA14), or null.
 *
 * The number is `issue.number`, or `pull_request.number` when the payload has no issue object
 * (a comment on a PR carries an `issue`, so it gets the PR's number). Never throws.
 * The migration `webhook_event_external_ref` back-fills old rows with the same rule in SQL.
 */
export function externalRefOf(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const repository = payload['repository'];
  const fullName = isObject(repository) ? repository['full_name'] : undefined;
  if (typeof fullName !== 'string' || fullName === '') return null;

  const subject = isObject(payload['issue'])
    ? payload['issue']
    : isObject(payload['pull_request'])
      ? payload['pull_request']
      : null;
  const number = subject?.['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
    return null;
  return `${fullName}#${number}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
