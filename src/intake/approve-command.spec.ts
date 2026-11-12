import { describe, expect, it } from 'vitest';
import { isApproveCommand } from './approve-command.js';

describe('isApproveCommand (spec 2 "What counts as /approve")', () => {
  it.each([
    ['/approve', true],
    ['  /APPROVE\n\n', true],
    ['\t/Approve \r\n', true],
    ['/approve thanks', false],
    ['LGTM, /approve', false],
    ['> /approve', false],
    ['/approve\n\n> On Tue, someone wrote:\n> please approve', false],
    ['/approved', false],
    ['/ approve', false],
    ['approve', false],
    ['', false],
    ['/approve /approve', false],
  ])('%j → %s', (text, expected) => {
    expect(isApproveCommand(text)).toBe(expected);
  });
});
