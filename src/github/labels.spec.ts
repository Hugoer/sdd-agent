import { describe, expect, it } from 'vitest';
import {
  BOT_LABELS,
  STEPS,
  isBotManagedLabel,
  isHumanControlLabel,
  laneOfLabel,
  modelLabel,
  stepOfModelLabel,
} from './labels.js';

describe('BOT_LABELS', () => {
  it('holds 18 labels with distinct names, the five model labels among them', () => {
    const names = BOT_LABELS.map((label) => label.name);

    expect(names).toHaveLength(18);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(18);
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

  it("holds the two labels of spec 13 (BFW9) and ready-for-dev with BF6's description", () => {
    expect(BOT_LABELS).toContainEqual({
      name: 'status: plan-review',
      color: 'bfd4f2',
      description: 'Bot-managed: Plan posted, waiting for /approve.',
    });
    expect(BOT_LABELS).toContainEqual({
      name: 'bot: working',
      color: 'd93f0b',
      description:
        'Bot-managed: the bot is working on this issue; removed when it ends.',
    });
    expect(BOT_LABELS).toContainEqual({
      name: 'status: ready-for-dev',
      color: '0e8a16',
      description:
        'Bot-managed: approved and ready for the Coder; in code-only, waiting for /approve to start it.',
    });
  });
});

describe('isBotManagedLabel (spec 13 BFW7)', () => {
  it.each([
    ['status: plan-review', true],
    ['Status: Ready-For-Dev', true],
    ['bot: working', true],
    ['Bot: Working', true],
    ['workflow: full-sdd', false],
    ['grill: skip', false],
    ['model: max-plan', false],
    ['bug', false],
  ])('%j → %j', (name, managed) => {
    expect(isBotManagedLabel(name)).toBe(managed);
  });

  it('bot: working is not a human-control label (removeLabel refuses it, spec 3 A4)', () => {
    expect(isHumanControlLabel('bot: working')).toBe(false);
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
