import { Logger } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  HUMAN,
  TARGET_REPO,
  issueCommentCreated,
} from './fixtures/github/payloads.js';
import {
  askedRound1,
  botComments,
  commented,
  grillAnswer,
  grillRows,
} from './grill-helpers.js';
import { skillMd } from './fixtures/skills.js';
import { deliver, seedWorkflow, store } from './router-helpers.js';

// Spec 12 (bot-data-protection), plan DP20: the flows of T2 and T4–T7 on the booted app with the fakes.

// Every secret-shaped string is built at run time: none is written into the repo as a literal (plan DP22).
const GOOGLE_KEY = ['AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4-_o5p'].join(
  '',
);
const GITHUB_TOKEN = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join(
  '',
);

describe('Bot data protection (spec 12)', () => {
  let t: TestApp;
  let logs: string[];

  beforeAll(async () => {
    t = await startApp({ grill: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    logs = [];
    for (const level of ['log', 'warn'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logs.push(String(message));
        },
      );
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('payloads are stored redacted (BDW4)', () => {
    /** A comment delivery whose comment body and issue body each hold a secret. */
    function withSecrets() {
      const delivery = issueCommentCreated({
        number: 60,
        commentId: 6001,
        body: `here is ${GITHUB_TOKEN} oops`,
      });
      (delivery.payload.issue as Record<string, unknown>).body =
        `key ${GOOGLE_KEY}`;
      return delivery;
    }

    it('every string is redacted; externalRef, action and the other fields are unchanged; one log line', async () => {
      const deliveryId = newDeliveryId();
      const row = await store(t, withSecrets(), deliveryId);

      const text = JSON.stringify(row.payload);
      expect(text).not.toContain(GOOGLE_KEY);
      expect(text).not.toContain(GITHUB_TOKEN);
      expect(row.payload).toMatchObject({
        action: 'created',
        issue: { number: 60, body: 'key [REDACTED: google-api-key]' },
        comment: { id: 6001, body: 'here is [REDACTED: github-token] oops' },
      });
      expect(row).toMatchObject({
        externalRef: `${TARGET_REPO}#60`,
        action: 'created',
        eventName: 'issue_comment',
      });
      expect(logs).toContain(
        `secret-scan payload ${deliveryId}: redacted 2 (google-api-key, github-token)`,
      );
      expect(logs.join('\n')).not.toMatch(/AIza|ghp_/);
    });

    it('a payload without a secret is stored as it came, with no secret-scan line', async () => {
      const delivery = issueCommentCreated({ number: 61, body: 'plain' });
      const row = await store(t, delivery);

      expect(row.payload).toEqual(delivery.payload);
      expect(logs.some((line) => line.startsWith('secret-scan'))).toBe(false);
    });

    it('a redelivery of the same delivery is still a duplicate', async () => {
      const deliveryId = newDeliveryId();
      await store(t, withSecrets(), deliveryId);
      const body = JSON.stringify(withSecrets().payload);

      const res = await postWebhook(t.baseUrl, body, {
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
      });

      expect(res.status).toBe(202);
      expect(await t.prisma.webhookEvent.count()).toBe(1);
      expect(logs).toContain(
        `delivery=${deliveryId} event=issue_comment action=created duplicate`,
      );
    });
  });

  describe("Grill Me's answers are stored redacted (BDW4)", () => {
    it('an answer with a token reaches grill_answers.body as a placeholder', async () => {
      await askedRound1(t, 62);
      t.models.replyJson(grillAnswer({ confidence: 70, questions: 1 }));

      await deliver(t, commented(62, 6201, `Q1: use ${GITHUB_TOKEN}. Q2: no.`));

      const { answers } = await grillRows(t);
      expect(answers).toMatchObject([
        {
          commentId: '6201',
          body: 'Q1: use [REDACTED: github-token]. Q2: no.',
        },
      ]);
    });

    it('a payload stored unredacted (before the migration) is redacted when the answer is read', async () => {
      await askedRound1(t, 63);
      t.models.replyJson(grillAnswer({ confidence: 70, questions: 1 }));
      const delivery = commented(63, 6301, `Q1: ${GOOGLE_KEY}. Q2: yes.`);
      // Inserted with Prisma, as a row stored before spec 12 would be: the value is in the payload.
      await t.prisma.webhookEvent.create({
        data: {
          deliveryId: newDeliveryId(),
          eventName: delivery.eventName,
          action: 'created',
          payload: delivery.payload as Prisma.InputJsonValue,
          externalRef: `${TARGET_REPO}#63`,
        },
      });

      await t.worker.drainOnce();

      const { answers } = await grillRows(t);
      expect(answers).toMatchObject([
        {
          commentId: '6301',
          body: 'Q1: [REDACTED: google-api-key]. Q2: yes.',
        },
      ]);
      expect(logs).toContain(
        `secret-scan answer ${TARGET_REPO}#63 comment-6301: redacted 1 (google-api-key)`,
      );
    });
  });

  describe('repo files are redacted when read (BDW5)', () => {
    const SKILL = '.github-agent/skills/grill/SKILL.md';
    afterEach(() => {
      t.repo.removeFile('main', 'AGENTS.md');
    });

    it('a step SKILL.md and the root AGENTS.md holding keys → placeholders in the stored system message; no comment; catalog lines', async () => {
      t.repo.seedFile(
        'main',
        SKILL,
        skillMd('grill', `Ask well. ${GOOGLE_KEY}`, `Grill ${GOOGLE_KEY}.`),
      );
      t.repo.seedFile('main', 'AGENTS.md', `# Rules\nDeploy: ${GITHUB_TOKEN}`);

      const issue = await askedRound1(t, 64);

      const row = await t.prisma.executionLog.findFirstOrThrow();
      const prompt = JSON.stringify(row.prompt);
      expect(prompt).not.toContain(GOOGLE_KEY);
      expect(prompt).not.toContain(GITHUB_TOKEN);
      const system = (
        row.prompt as { type: string; data: { content: string } }[]
      )
        .filter(({ type }) => type === 'system')
        .map(({ data }) => data.content)
        .join('\n');
      expect(system).toContain('Ask well. [REDACTED: google-api-key]');
      expect(system).toContain('Deploy: [REDACTED: github-token]');
      // Only Grill Me's round: no notice for a repo file (BD3).
      expect(botComments(t, issue)).toHaveLength(1);
      expect(
        logs
          .filter((line) => line.startsWith('catalog @'))
          .map((line) => line.replace(/@\w{7}/, '@<sha>')),
      ).toEqual([
        'catalog @<sha>: AGENTS.md: redacted 1 (github-token)',
        `catalog @<sha>: ${SKILL}: redacted 2 (google-api-key)`,
      ]);
    });
  });
});
