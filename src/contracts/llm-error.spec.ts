import { describe, expect, it } from 'vitest';
import { LlmError, StepConfigError } from './llm-error.js';

describe('LlmError', () => {
  it('carries its kind, code and retry delay, and names itself', () => {
    const error = new LlmError('rate limited', 'transient', 'rate-limited', {
      retryAfterSeconds: 12,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LlmError');
    expect(error.message).toBe('rate limited');
    expect(error.kind).toBe('transient');
    expect(error.code).toBe('rate-limited');
    expect(error.detail.retryAfterSeconds).toBe(12);
    expect(String(error)).toBe('LlmError: rate limited');
  });

  it('defaults to an empty detail', () => {
    const error = new LlmError('no model', 'permanent', 'unknown-model');
    expect(error.detail).toEqual({});
  });
});

describe('StepConfigError', () => {
  it('names itself', () => {
    const error = new StepConfigError('missing skills: plan');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StepConfigError');
    expect(String(error)).toBe('StepConfigError: missing skills: plan');
  });
});
