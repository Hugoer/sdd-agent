import { describe, expect, it } from 'vitest';
import { externalRefOf } from './external-ref.js';

const repository = { full_name: 'Octo/Sandbox' };

describe('externalRefOf', () => {
  it('issue event → repo#issue number', () => {
    expect(
      externalRefOf({
        action: 'opened',
        repository,
        issue: { id: 1, number: 12 },
      }),
    ).toBe('Octo/Sandbox#12');
  });

  it('comment on an issue → the issue', () => {
    expect(
      externalRefOf({
        action: 'created',
        repository,
        issue: { number: 12 },
        comment: { id: 5 },
      }),
    ).toBe('Octo/Sandbox#12');
  });

  it('comment on a pull request → the PR (its issue object)', () => {
    expect(
      externalRefOf({
        action: 'created',
        repository,
        issue: { number: 15, pull_request: { url: 'x' } },
        comment: { id: 5 },
      }),
    ).toBe('Octo/Sandbox#15');
  });

  it('pull request event → repo#PR number', () => {
    expect(
      externalRefOf({
        action: 'opened',
        repository,
        number: 15,
        pull_request: { number: 15 },
      }),
    ).toBe('Octo/Sandbox#15');
  });

  it('the issue wins over a pull request object', () => {
    expect(
      externalRefOf({
        repository,
        issue: { number: 3 },
        pull_request: { number: 4 },
      }),
    ).toBe('Octo/Sandbox#3');
  });

  it.each([
    ['ping', { zen: 'x', repository }],
    ['no issue and no PR', { action: 'created', repository }],
    ['no repository', { issue: { number: 1 } }],
    [
      'full_name not a string',
      { repository: { full_name: 7 }, issue: { number: 1 } },
    ],
    [
      'empty full_name',
      { repository: { full_name: '' }, issue: { number: 1 } },
    ],
    ['repository not an object', { repository: 'x', issue: { number: 1 } }],
    ['number missing', { repository, issue: { id: 1 } }],
    ['number a string', { repository, issue: { number: '1' } }],
    ['number not an integer', { repository, issue: { number: 1.5 } }],
    ['number zero', { repository, issue: { number: 0 } }],
    ['number negative', { repository, issue: { number: -2 } }],
    [
      'issue with a bad number, PR with a good one',
      { repository, issue: { number: 'x' }, pull_request: { number: 4 } },
    ],
    ['issue is null', { repository, issue: null }],
    ['issue is an array', { repository, issue: [1] }],
  ])('%s → null', (_name, payload) => {
    expect(externalRefOf(payload)).toBeNull();
  });

  it.each([null, undefined, 'text', 42, [], true])(
    '%j → null, never throws',
    (payload) => {
      expect(externalRefOf(payload)).toBeNull();
    },
  );
});
