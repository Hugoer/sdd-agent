import { describe, expect, it, vi } from 'vitest';
import {
  storedEvent,
  issuesOpened,
} from '../../test/fixtures/github/payloads.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { EventsWorker } from '../events/events.worker.js';
import { IntakeEventProcessor } from './intake-event.processor.js';
import type { IntakeResult, IntakeService } from './intake.service.js';

function setup(result: () => Promise<IntakeResult>) {
  const intake = { intake: vi.fn(result) };
  const worker = { registerProcessor: vi.fn() };
  const processor = new IntakeEventProcessor(
    intake as unknown as IntakeService,
    worker as unknown as EventsWorker,
  );
  return { intake, worker, processor };
}

describe('IntakeEventProcessor (placeholder until spec 5)', () => {
  it('registers itself with the worker on module init', () => {
    const { worker, processor } = setup(() =>
      Promise.resolve({ outcome: 'ignored', reason: 'ping' }),
    );
    processor.onModuleInit();
    expect(worker.registerProcessor).toHaveBeenCalledExactlyOnceWith(processor);
  });

  it('accepted → DONE', async () => {
    const event = storedEvent(issuesOpened());
    const { intake, processor } = setup(() =>
      Promise.resolve({
        outcome: 'accepted',
        input: {
          type: 'ISSUE_OPENED',
          deliveryId: event.deliveryId,
          receivedAt: event.receivedAt,
          sender: 'dev',
          task: { platform: 'GITHUB', id: '1', externalRef: 'a/b#1' },
        },
      }),
    );

    await expect(processor.process(event)).resolves.toEqual({ status: 'DONE' });
    expect(intake.intake).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('ignored → IGNORED with the reason', async () => {
    const { processor } = setup(() =>
      Promise.resolve({ outcome: 'ignored', reason: 'unauthorized' }),
    );
    await expect(
      processor.process(storedEvent(issuesOpened())),
    ).resolves.toEqual({
      status: 'IGNORED',
      reason: 'unauthorized',
    });
  });

  it('an error goes to the worker unchanged', async () => {
    const error = new ProviderError('down', 'transient');
    const { processor } = setup(() => Promise.reject(error));
    await expect(processor.process(storedEvent(issuesOpened()))).rejects.toBe(
      error,
    );
  });
});
