import { describe, expect, it } from 'vitest';
import { LlmError, StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  WORK_RESULT_STOPS,
  stopCauseOf,
  workResultReason,
} from './stop-cause.js';
import { LeaseLostError, StepNotBuiltError } from './workflow-errors.js';

describe('stopCauseOf (spec "Cause and message")', () => {
  it('StepNotBuiltError → step-not-built, before the StepConfigError rule (plan P1)', () => {
    const error = new StepNotBuiltError('grill');

    expect(error).toBeInstanceOf(StepConfigError);
    expect(stopCauseOf(error, 'd')).toEqual({
      cause: 'step-not-built',
      message: 'this version of the bot has no `grill` step yet',
    });
  });

  it('StepConfigError → step-config with its message', () => {
    expect(
      stopCauseOf(new StepConfigError('missing skills: plan, code'), 'd'),
    ).toEqual({ cause: 'step-config', message: 'missing skills: plan, code' });
  });

  it('LlmError → its code and message', () => {
    expect(
      stopCauseOf(
        new LlmError(
          'Google says the credits are used up',
          'permanent',
          'credits-exhausted',
        ),
        'd',
      ),
    ).toEqual({
      cause: 'credits-exhausted',
      message: 'Google says the credits are used up',
    });
  });

  it('ProviderError → provider-error; "after 3 attempts" only when transient', () => {
    expect(
      stopCauseOf(
        new ProviderError('GitHub GET … → 404: Not Found', 'permanent'),
        'd',
      ),
    ).toEqual({
      cause: 'provider-error',
      message: 'GitHub GET … → 404: Not Found',
    });
    expect(
      stopCauseOf(
        new ProviderError('GitHub GET … → 503: Unavailable', 'transient'),
        'd',
      ),
    ).toEqual({
      cause: 'provider-error',
      message: 'GitHub GET … → 503: Unavailable, after 3 attempts',
    });
  });

  it.each([
    new Error('secret token abc123 leaked in a bug'),
    new LeaseLostError('task-1', 'event-1'),
    'a thrown string',
    undefined,
  ])(
    'anything else → internal-error naming the delivery, never its message (%#)',
    (error) => {
      const result = stopCauseOf(error, 'delivery-42');

      expect(result).toEqual({
        cause: 'internal-error',
        message:
          'an unexpected error; the app log has the details (delivery `delivery-42`)',
      });
    },
  );
});

describe('work-result stops (plan P4)', () => {
  it('each outcome has its own cause, and the reason is found by cause', () => {
    const causes = Object.values(WORK_RESULT_STOPS).map((stop) => stop.cause);

    expect(new Set(causes).size).toBe(causes.length);
    expect(workResultReason('grill-limit')).toBe(
      'the Grill round limit was reached',
    );
    expect(workResultReason('provider-error')).toBeNull();
  });
});
