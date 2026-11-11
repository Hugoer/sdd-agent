/** Every provider failure (overview §4, spec 3 G5). The worker retries `transient` and fails
 *  `permanent` at once; providers never retry a call themselves. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    message: string,
    readonly kind: 'transient' | 'permanent',
    readonly detail: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
  }
}
