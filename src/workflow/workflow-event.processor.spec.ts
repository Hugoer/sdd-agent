import { describe, expect, it, vi } from 'vitest';
import {
  issuesOpened,
  storedEvent,
} from '../../test/fixtures/github/payloads.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { EventsWorker } from '../events/events.worker.js';
import type { IntakeResult, IntakeService } from '../intake/intake.service.js';
import type { RouterService } from './router.service.js';
import { WorkflowEventProcessor } from './workflow-event.processor.js';

function setup(result: () => Promise<IntakeResult>) {
  const intake = { intake: vi.fn(result) };
  const router = {
    route: vi.fn(() => Promise.resolve({ status: 'DONE' as const })),
  };
  const worker = { registerProcessor: vi.fn() };
  const processor = new WorkflowEventProcessor(
    intake as unknown as IntakeService,
    router as unknown as RouterService,
    worker as unknown as EventsWorker,
  );
  return { intake, router, worker, processor };
}

describe('WorkflowEventProcessor (spec 5: intake, then the router)', () => {
  it('registers itself with the worker on module init', () => {
    const { worker, processor } = setup(() =>
      Promise.resolve({ outcome: 'ignored', reason: 'ping' }),
    );

    processor.onModuleInit();

    expect(worker.registerProcessor).toHaveBeenCalledExactlyOnceWith(processor);
  });

  it('ignored by intake → IGNORED with its reason; the router is not called', async () => {
    const { router, processor } = setup(() =>
      Promise.resolve({ outcome: 'ignored', reason: 'unauthorized' }),
    );

    await expect(
      processor.process(storedEvent(issuesOpened())),
    ).resolves.toEqual({ status: 'IGNORED', reason: 'unauthorized' });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("accepted → the router's result for that input", async () => {
    const event = storedEvent(issuesOpened());
    const input = {
      type: 'ISSUE_OPENED' as const,
      deliveryId: event.deliveryId,
      receivedAt: event.receivedAt,
      sender: 'dev',
      task: { platform: 'GITHUB' as const, id: '1', externalRef: 'a/b#1' },
    };
    const { router, processor } = setup(() =>
      Promise.resolve({ outcome: 'accepted', input }),
    );

    await expect(processor.process(event)).resolves.toEqual({ status: 'DONE' });
    expect(router.route).toHaveBeenCalledExactlyOnceWith(event, input);
  });

  it("an intake error passes through as it is (the worker's rule applies)", async () => {
    const error = new ProviderError('GitHub is down', 'transient');
    const { processor } = setup(() => Promise.reject(error));

    await expect(processor.process(storedEvent(issuesOpened()))).rejects.toBe(
      error,
    );
  });
});
