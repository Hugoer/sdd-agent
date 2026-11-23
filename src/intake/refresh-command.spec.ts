import { describe, expect, it } from 'vitest';
import { isRefreshCommand } from './refresh-command.js';

describe('isRefreshCommand (spec 7 "`/refresh`")', () => {
  it.each([
    ['/refresh', true],
    ['  /REFRESH ', true],
    ['/Refresh\n', true],
    ['\t/refresh\r\n', true],
    ['please /refresh', false],
    ['/refresh now', false],
    ['/refreshed', false],
    ['> /refresh', false],
    ['/ refresh', false],
    ['refresh', false],
    ['', false],
    ['/approve', false],
  ])('%j → %s', (text, expected) => {
    expect(isRefreshCommand(text)).toBe(expected);
  });
});
