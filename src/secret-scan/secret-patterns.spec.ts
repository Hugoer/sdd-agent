import { describe, expect, it } from 'vitest';
import { placeholderKinds } from './secret-patterns.js';

describe('placeholderKinds (spec 12 BDW2, plan DP15)', () => {
  it('each known kind once, in order of first appearance; an unknown kind is ignored', () => {
    expect(
      placeholderKinds(
        '[REDACTED: github-token] x [REDACTED: github-token] [REDACTED: foo]',
      ),
    ).toEqual(['github-token']);
  });

  it('every known kind, own-secret included', () => {
    expect(
      placeholderKinds(
        [
          'private-key',
          'own-secret',
          'slack-token',
          'aws-access-key',
          'google-api-key',
          'github-token',
        ]
          .map((kind) => `[REDACTED: ${kind}]`)
          .join(' '),
      ),
    ).toEqual([
      'private-key',
      'own-secret',
      'slack-token',
      'aws-access-key',
      'google-api-key',
      'github-token',
    ]);
  });

  it.each([
    ['no placeholder', 'plain text'],
    ['another shape', '[REDACTED:github-token] [redacted: github-token]'],
    ['an uppercase kind', '[REDACTED: GITHUB-TOKEN]'],
  ])('%s → none', (_name, text) => {
    expect(placeholderKinds(text)).toEqual([]);
  });

  it('is safe to call twice (the global regex keeps no state between calls)', () => {
    const text = 'a [REDACTED: google-api-key]';
    expect(placeholderKinds(text)).toEqual(['google-api-key']);
    expect(placeholderKinds(text)).toEqual(['google-api-key']);
  });
});
