import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../src/contracts/issue-provider.js';
import { LlmError } from '../src/contracts/llm-error.js';
import { CHAT_MODEL_FACTORY } from '../src/llm/chat-model.factory.js';
import { LlmService } from '../src/llm/llm.service.js';
import { withNotes } from '../src/llm/prompt.js';
import { StepConfigService } from '../src/llm/step-config.service.js';
import { WORKFLOW_CONFIG_PATH } from '../src/llm/workflow-config.js';
import { resetDatabase } from './db.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import { HUMAN, issuesOpened } from './fixtures/github/payloads.js';

// Spec 4 in the booted app: LlmModule is wired, CHAT_MODEL_FACTORY is the scripted fake (plan P8).

describe('LlmModule in the app', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Spec 5 plan P11: "an intake event" means intake alone, as when this suite was written.
    t = await startApp({ processor: 'intake-only' });
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

describe('LlmService.call() in the booted app (real PostgreSQL, fakes)', () => {
  let t: TestApp;
  const TOKEN = ['gh', 's_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
  const schema = z.object({ summary: z.string().min(1) });
  const SKILL_DIR = '.github-agent/skills/spec';

  beforeAll(async () => {
    t = await startApp();
    t.repo.seedFile(
      'main',
      WORKFLOW_CONFIG_PATH,
      JSON.stringify({
        skills: { spec: SKILL_DIR },
        models: {
          standard: { default: 'gemini-4-hydrogen' },
          max: { default: 'gemini-4-carbon' },
        },
      }),
    );
    t.repo.seedFile('main', `${SKILL_DIR}/SKILL.md`, 'Placeholder skill.');
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** prepare() for issue #N, then the call with one untrusted block (the description). */
  async function prepareAndCall(number: number, labels: string[] = []) {
    const ref = t.issues.seedIssue({
      number,
      description: 'Cents are rounded wrongly.',
      labels,
    });
    const task = await t.issues.getTaskDetails(ref);
    const setup = await t.app.get(StepConfigService).prepare('spec', task);
    const call = t.app.get(LlmService).call({
      context: { task: ref, step: 'spec', runId: 'it-run' },
      setup,
      frame: 'Summarize the issue. Answer with JSON only.',
      turns: [
        {
          role: 'user',
          blocks: [
            {
              kind: 'untrusted',
              source: { key: 'description', label: 'the issue description' },
              text: task.description,
            },
          ],
        },
      ],
      output: schema,
    });
    return { ref, setup, call };
  }

  it('prepare() then call() writes a real row and returns its id; the row matches the setup', async () => {
    t.models.replyJson({ summary: 'Rounding bug.' });

    const { setup, call } = await prepareAndCall(101, ['model: max-spec']);
    const result = await call;

    expect(result.output).toEqual({ summary: 'Rounding bug.' });
    expect(
      await t.prisma.executionLog.findUniqueOrThrow({
        where: { id: result.logId },
      }),
    ).toMatchObject({
      status: 'SUCCESS',
      attempt: 1,
      runId: 'it-run',
      step: 'spec',
      provider: 'scripted',
      model: 'gemini-4-carbon',
      modelLevel: 'max',
      skillCommit: setup.commit,
      externalRef: 'test-owner/test-repo#101',
    });
    expect(setup.skill.commit).toBe(setup.commit);
  });

  it('a mismatch then a valid answer → two rows; a provider error → one ERROR row and the LlmError', async () => {
    t.models.reply({ answer: 'not json' }).replyJson({ summary: 'ok' });
    await (
      await prepareAndCall(102)
    ).call;

    const error = new LlmError(
      'Google is down',
      'transient',
      'provider-unavailable',
    );
    t.models.reply({ error });
    await expect((await prepareAndCall(103)).call).rejects.toBe(error);

    const rows = await t.prisma.executionLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        externalRef: true,
        attempt: true,
        status: true,
        errorCode: true,
      },
    });
    expect(rows).toEqual([
      {
        externalRef: 'test-owner/test-repo#102',
        attempt: 1,
        status: 'ERROR',
        errorCode: 'invalid-answer',
      },
      {
        externalRef: 'test-owner/test-repo#102',
        attempt: 2,
        status: 'SUCCESS',
        errorCode: null,
      },
      {
        externalRef: 'test-owner/test-repo#103',
        attempt: 1,
        status: 'ERROR',
        errorCode: 'provider-unavailable',
      },
    ]);
  });

  it('a comment posted with withNotes() reaches the fake with the model line; a token in it arrives redacted', async () => {
    t.models.replyJson({ summary: 'Rounding bug.' });
    const { ref, call } = await prepareAndCall(104);
    const result = await call;

    await t.app
      .get<IssueProvider>(ISSUE_PROVIDER)
      .postComment(
        ref,
        withNotes(`${result.output.summary} ${TOKEN}`, result.notes),
      );

    expect(t.issues.commentsOf(ref).map((comment) => comment.body)).toEqual([
      'Rounding bug. [REDACTED: github-token]\n\n---\n<sub>Model: `gemini-4-hydrogen` (standard)</sub>',
    ]);
  });
});
