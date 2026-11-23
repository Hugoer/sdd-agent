import { describe, expect, it } from 'vitest';
import { isRestoreCommand } from './restore-command.js';

describe('isRestoreCommand (spec 7 "`/restore`")', () => {
  it.each([
    ['/restore', true],
    ['  /RESTORE ', true],
    ['/Restore\n', true],
    ['please /restore', false],
    ['/restore it', false],
    ['/restored', false],
    ['> /restore', false],
    ['restore', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(isRestoreCommand(text)).toBe(expected);
  });
});
