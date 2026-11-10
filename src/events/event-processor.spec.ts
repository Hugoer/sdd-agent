import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { EventProcessor } from './event-processor.js';
import type { HelloCommentService } from './hello/hello-comment.service.js';

const issuesOpened = {
  action: 'opened',
  installation: { id: 42 },
  repository: { name: 'sdd-agent-sandbox', owner: { login: 'octo' } },
  issue: { number: 7 },
};

function event(overrides: Partial<WebhookEvent>): WebhookEvent {
  return {
    id: 'id-1',
    deliveryId: 'delivery-1',
    eventName: 'issues',
    action: 'opened',
    payload: issuesOpened,
    status: 'PROCESSING',
    ignoreReason: null,
    attempts: 1,
    availableAt: new Date(),
    lastError: null,
    receivedAt: new Date(),
    processedAt: null,
    ...overrides,
  };
}

describe('EventProcessor', () => {
  const postHello = vi.fn<HelloCommentService['postHello']>();
  const processor = new EventProcessor({
    postHello,
  } as unknown as HelloCommentService);

  beforeEach(() => {
    postHello.mockReset();
  });

  it('issues.opened → posts one hello on that issue and is DONE', async () => {
    await expect(processor.process(event({}))).resolves.toEqual({
      status: 'DONE',
    });
    expect(postHello).toHaveBeenCalledExactlyOnceWith({
      installationId: 42,
      owner: 'octo',
      repo: 'sdd-agent-sandbox',
      issueNumber: 7,
      deliveryId: 'delivery-1',
    });
  });

  it('ping → IGNORED ping', async () => {
    await expect(
      processor.process(
        event({ eventName: 'ping', action: null, payload: { zen: 'x' } }),
      ),
    ).resolves.toEqual({ status: 'IGNORED', reason: 'ping' });
    expect(postHello).not.toHaveBeenCalled();
  });

  it('issues.opened without an installation → IGNORED no-installation', async () => {
    const payload = { ...issuesOpened, installation: undefined };
    await expect(processor.process(event({ payload }))).resolves.toEqual({
      status: 'IGNORED',
      reason: 'no-installation',
    });
    expect(postHello).not.toHaveBeenCalled();
  });

  it.each([
    ['issues', 'labeled'],
    ['issues', 'edited'],
    ['issue_comment', 'created'],
    ['pull_request', 'opened'],
  ])('%s.%s → IGNORED not-handled', async (eventName, action) => {
    await expect(
      processor.process(event({ eventName, action })),
    ).resolves.toEqual({ status: 'IGNORED', reason: 'not-handled' });
    expect(postHello).not.toHaveBeenCalled();
  });

  it('propagates a GitHub error so the worker retries', async () => {
    postHello.mockRejectedValueOnce(new Error('Bad credentials'));
    await expect(processor.process(event({}))).rejects.toThrow(
      'Bad credentials',
    );
  });
});
