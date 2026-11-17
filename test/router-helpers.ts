// Spec 5: shared steps of the router's integration suites (real PostgreSQL, the app's processor, fake ports).
import { expect } from 'vitest';
import type { WebhookEvent } from '../src/generated/prisma/client.js';
import type { TaskRef } from '../src/contracts/issue-provider.js';
import { WORKFLOW_CONFIG_PATH } from '../src/llm/workflow-config.js';
import { newDeliveryId, postWebhook, type TestApp } from './app.js';
import type { InMemoryRepoProvider } from './fakes/in-memory-repo-provider.js';
import type { Delivery } from './fixtures/github/payloads.js';

/** The issue id the payload fixtures give issue `number` (`issue.id`), so the fake and the row agree. */
export const fixtureIssueId = (number: number): string =>
  String(6335695000 + number);

/** Seeds issue `number` in the fake with the id the fixtures send. */
export function seedIssue(
  t: TestApp,
  number: number,
  options: { labels?: string[]; description?: string } = {},
): TaskRef {
  return t.issues.seedIssue({ number, id: fixtureIssueId(number), ...options });
}

/** Stores a signed delivery without processing it; returns its row. */
export async function store(
  t: TestApp,
  delivery: Delivery,
  deliveryId = newDeliveryId(),
): Promise<WebhookEvent> {
  const res = await postWebhook(t.baseUrl, JSON.stringify(delivery.payload), {
    'x-github-event': delivery.eventName,
    'x-github-delivery': deliveryId,
  });
  expect(res.status).toBe(202);
  return t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
}

/** Stores a delivery, drains the worker once, returns its row. */
export async function deliver(
  t: TestApp,
  delivery: Delivery,
): Promise<WebhookEvent> {
  const { id } = await store(t, delivery);
  await t.worker.drainOnce();
  return t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
}

/** Makes every waiting PENDING row due now (a worker retry or a WAIT without the real delay), then drains. */
export async function drainDueNow(t: TestApp): Promise<void> {
  await t.prisma.webhookEvent.updateMany({
    where: { status: 'PENDING' },
    data: { availableAt: new Date(0) },
  });
  await t.worker.drainOnce();
}

/** A sandbox-like `workflow.json` with a skill for every step, so the run-start check passes. */
export function seedWorkflow(repo: InMemoryRepoProvider, base = 'main'): void {
  const steps = ['grill', 'spec', 'plan', 'code', 'qualityGate'] as const;
  const skills = Object.fromEntries(
    steps.map((step) => [step, `.github-agent/skills/${step}`]),
  );
  repo.seedFile(
    base,
    WORKFLOW_CONFIG_PATH,
    JSON.stringify({
      skills,
      models: {
        standard: { default: 'gemini-4-hydrogen' },
        max: { default: 'gemini-4-carbon' },
      },
    }),
  );
  for (const step of steps)
    repo.seedFile(base, `${skills[step]}/SKILL.md`, `Placeholder ${step}.`);
}
