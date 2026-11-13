import { describe, expect, it } from 'vitest';
import {
  BOT_LABELS,
  STEPS,
  laneOfLabel,
  modelLabel,
  stepOfModelLabel,
} from './labels.js';

describe('BOT_LABELS', () => {
  it('holds 16 labels with distinct names, the five model labels among them', () => {
    const names = BOT_LABELS.map((label) => label.name);

    expect(names).toHaveLength(16);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(16);
    expect(BOT_LABELS.filter((label) => label.color === 'fef2c0')).toEqual(
      STEPS.map((step) => ({
        name: modelLabel(step),
        color: 'fef2c0',
        description: expect.stringMatching(
          /^Approvers only: .* the most capable model\.$/,
        ) as string,
      })),
    );
  });
});

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

describe('model labels', () => {
  it.each([
    ['grill', 'model: max-grill'],
    ['spec', 'model: max-spec'],
    ['plan', 'model: max-plan'],
    ['code', 'model: max-code'],
    ['qualityGate', 'model: max-quality-gate'],
  ] as const)('%s ↔ %j', (step, label) => {
    expect(modelLabel(step)).toBe(label);
    expect(stepOfModelLabel(label)).toBe(step);
    expect(stepOfModelLabel(label.toUpperCase())).toBe(step);
  });

  it.each([
    'model: turbo',
    'model: max-qualityGate',
    'model: max-',
    'model:max-spec',
    'model: max-spec ',
    'workflow: full-sdd',
    'bug',
  ])('%j → no step', (name) => {
    expect(stepOfModelLabel(name)).toBeNull();
  });
});
