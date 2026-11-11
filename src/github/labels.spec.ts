import { describe, expect, it } from 'vitest';
import { laneOfLabel } from './labels.js';

describe('laneOfLabel', () => {
  it.each([
    ['workflow: full-sdd', 'full-sdd'],
    ['workflow: spec-code', 'spec-code'],
    ['workflow: code-only', 'code-only'],
    ['Workflow: Code-Only', 'code-only'],
    ['workflow: other', null],
    ['workflow:full-sdd', null],
    ['workflow: full-sdd ', null],
    ['grill: skip', null],
    ['status: draft', null],
    ['bug', null],
  ])('%j → %j', (name, lane) => {
    expect(laneOfLabel(name)).toBe(lane);
  });
});
