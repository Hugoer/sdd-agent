import { describe, expect, it } from 'vitest';
import { isRetryCommand } from './retry-command.js';

describe('isRetryCommand (spec 5 "/retry")', () => {
  it.each([
    ['/retry', true],
    ['  /RETRY ', true],
    ['/Retry\n', true],
    ['\t/retry\r\n', true],
    ['please /retry', false],
    ['/retry now', false],
    ['/retry2', false],
    ['> /retry', false],
    ['/ retry', false],
    ['retry', false],
    ['', false],
    ['/approve', false],
  ])('%j → %s', (text, expected) => {
    expect(isRetryCommand(text)).toBe(expected);
  });
});
