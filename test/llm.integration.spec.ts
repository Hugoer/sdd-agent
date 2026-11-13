import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_MODEL_FACTORY } from '../src/llm/chat-model.factory.js';
import { StepConfigService } from '../src/llm/step-config.service.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import { HUMAN, issuesOpened } from './fixtures/github/payloads.js';

// Spec 4 in the booted app: LlmModule is wired, CHAT_MODEL_FACTORY is the scripted fake (plan P8).

describe('LlmModule in the app', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('boots with the scripted factory behind the port and StepConfigService available', () => {
    expect(t.app.get(CHAT_MODEL_FACTORY)).toBe(t.models);
    expect(t.app.get(StepConfigService)).toBeInstanceOf(StepConfigService);
  });

  it('no model is created or called at boot or for an intake event', async () => {
    t.issues.setAccessLevel(HUMAN, 'approver');
    const delivery = issuesOpened({ number: 91 });
    const deliveryId = newDeliveryId();

    const res = await postWebhook(t.baseUrl, JSON.stringify(delivery.payload), {
      'x-github-event': delivery.eventName,
      'x-github-delivery': deliveryId,
    });
    expect(res.status).toBe(202);
    await t.worker.drainOnce();

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } }),
    ).toMatchObject({ status: 'DONE' });
    expect(t.models.created).toEqual([]);
    expect(t.models.calls).toEqual([]);
  });
});
