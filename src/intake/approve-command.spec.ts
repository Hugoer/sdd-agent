import { describe, expect, it } from 'vitest';
import { isApproveCommand, isApproveNearMiss } from './approve-command.js';

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

describe('isApproveNearMiss (spec 7, SPW12)', () => {
  it.each([
    ['/approve please', true],
    ['  /APPROVED\n', true],
    ['/approve /approve', true],
    ['/approve', false],
    [' /Approve ', false],
    ['please /approve', false],
    ['> /approve', false],
    ['approve', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(isApproveNearMiss(text)).toBe(expected);
  });
});
