import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import type { Env } from '../config/env.schema.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { EventProcessor, helloCommentBody } from './event-processor.js';

/** As typed in .env; GitHub names the repo with its own case. */
const TARGET_REPO = 'octo/sdd-agent-sandbox';
const GITHUB_NAME = 'Octo/SDD-Agent-Sandbox';

function issuesOpened(fullName = GITHUB_NAME) {
  return {
    action: 'opened',
    installation: { id: 42 },
    repository: { full_name: fullName },
    issue: { id: 3456789012, number: 7 },
  };
}

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'id-1',
    deliveryId: 'delivery-1',
    eventName: 'issues',
    action: 'opened',
    payload: issuesOpened(),
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

function setup() {
  const issues = new InMemoryIssueProvider(GITHUB_NAME);
  issues.seedIssue({ number: 7 });
  const config = new ConfigService<Env, true>({ TARGET_REPO });
  return { issues, processor: new EventProcessor(issues, config) };
}

describe('EventProcessor', () => {
  it('issues.opened on the target repo → one hello on that issue, DONE', async () => {
    const { issues, processor } = setup();

    await expect(processor.process(event())).resolves.toEqual({
      status: 'DONE',
    });

    expect(issues.calls).toEqual([
      {
        method: 'postComment',
        args: [
          {
            platform: 'GITHUB',
            id: '3456789012',
            externalRef: `${GITHUB_NAME}#7`,
          },
          helloCommentBody('delivery-1'),
        ],
      },
    ]);
  });

  it('issues.opened on another repo → IGNORED other-repo, no provider call', async () => {
    const { issues, processor } = setup();
    const payload = issuesOpened('someone/other-repo');

    await expect(processor.process(event({ payload }))).resolves.toEqual({
      status: 'IGNORED',
      reason: 'other-repo',
    });
    expect(issues.calls).toEqual([]);
  });

  it('ping → IGNORED ping', async () => {
    const { issues, processor } = setup();

    await expect(
      processor.process(
        event({ eventName: 'ping', action: null, payload: { zen: 'x' } }),
      ),
    ).resolves.toEqual({ status: 'IGNORED', reason: 'ping' });
    expect(issues.calls).toEqual([]);
  });

  it.each([
    ['issues', 'labeled'],
    ['issues', 'edited'],
    ['issue_comment', 'created'],
    ['pull_request', 'opened'],
  ])('%s.%s → IGNORED not-handled', async (eventName, action) => {
    const { issues, processor } = setup();

    await expect(
      processor.process(event({ eventName, action })),
    ).resolves.toEqual({ status: 'IGNORED', reason: 'not-handled' });
    expect(issues.calls).toEqual([]);
  });

  it('propagates a provider error so the worker decides', async () => {
    const { issues, processor } = setup();
    const unavailable = new ProviderError('503: Unavailable', 'transient', {
      status: 503,
    });
    issues.failNext(unavailable);

    await expect(processor.process(event())).rejects.toBe(unavailable);
  });
});

describe('helloCommentBody', () => {
  it('is the fixed text naming the delivery', () => {
    expect(helloCommentBody('abc-123')).toBe(
      '👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery `abc-123`.',
    );
  });
});
