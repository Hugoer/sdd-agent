import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import type { TaskRef } from '../src/contracts/issue-provider.js';
import { LlmError } from '../src/contracts/llm-error.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { ContextLoaderService } from '../src/llm/context-loader.service.js';
import type { LoadRequest } from '../src/llm/context-tools.js';
import { StepConfigService } from '../src/llm/step-config.service.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  HUMAN,
  TARGET_REPO,
  issueCommentCreated,
  issuesUnlabeled,
} from './fixtures/github/payloads.js';
import {
  askedRound1,
  botComments,
  commented,
  grillAnswer,
  grillRows,
  laneAdded,
} from './grill-helpers.js';
import { skillMd } from './fixtures/skills.js';
import {
  deliver,
  fixtureIssueId,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

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

  describe('prompts are redacted and stored redacted (BDW1, BDW11, plan DP3)', () => {
    it('a key in the description: the model gets the placeholder; the stored prompt holds no value; secret_kinds', async () => {
      seedIssue(t, 65, {
        labels: ['workflow: full-sdd'],
        description: `Discount feature. Key: ${GOOGLE_KEY}`,
      });
      t.models.replyJson(grillAnswer({ confidence: 50, questions: 2 }));

      await deliver(t, laneAdded(65));

      const sent = t.models.calls[0].messages
        .map((message) => message.text)
        .join('\n');
      expect(sent).not.toContain(GOOGLE_KEY);
      expect(sent).toContain('Key: [REDACTED: google-api-key]');
      const row = await t.prisma.executionLog.findFirstOrThrow({
        where: { step: 'grill' },
      });
      expect(row.secretKinds).toEqual(['google-api-key']);
      expect(JSON.stringify(row.prompt)).not.toContain(GOOGLE_KEY);
      expect(JSON.stringify(row.prompt)).toContain(
        '[REDACTED: google-api-key]',
      );
      expect(logs).toContain(
        `secret-scan grill ${TARGET_REPO}#65 description: redacted 1 (google-api-key)`,
      );
    });

    it('a model answer quoting a key-shaped string: stored redacted in execution_logs, the step gets it as returned', async () => {
      const aws = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('');
      seedIssue(t, 66, { labels: ['workflow: full-sdd'] });
      t.models.replyJson(
        grillAnswer({
          confidence: 50,
          questions: [
            { question: `Is ${aws} the example key?`, guess: 'Yes.' },
          ],
        }),
      );

      await deliver(t, laneAdded(66));

      const row = await t.prisma.executionLog.findFirstOrThrow();
      expect(JSON.stringify(row.answer)).not.toContain(aws);
      expect(JSON.stringify(row.answer)).toContain(
        '[REDACTED: aws-access-key]',
      );
      const { rounds } = await grillRows(t);
      // Grill Me keeps the model's questions as written (plan DP3)…
      expect(JSON.stringify(rounds[0].questions)).toContain(aws);
      // …and the port redacts what is posted (spec 4).
      expect(JSON.stringify(t.issues.calls)).not.toContain(aws);
    });
  });

  describe('the 🔑 notice from model calls (BDW3)', () => {
    const notices = (issue: TaskRef) =>
      botComments(t, issue).filter(({ body }) =>
        body.startsWith('<!-- sdd-agent:secret-removed:'),
      );

    it('a Grill answer with a token: one notice before the call; none after a failed call, a /retry or the next round', async () => {
      const issue = await askedRound1(t, 67);
      t.models.reply({
        error: new LlmError('scripted failure', 'permanent', 'bad-request'),
      });

      const failed = await deliver(
        t,
        commented(67, 6701, `Q1: use ${GITHUB_TOKEN}. Q2: no.`),
      );

      expect(failed).toMatchObject({ status: 'FAILED' });
      expect(notices(issue).map(({ body }) => body.split('\n')[0])).toEqual([
        '<!-- sdd-agent:secret-removed:comment-6701 -->',
      ]);
      expect(notices(issue)[0].body).toContain(
        `[the comment by ${HUMAN}](https://github.com/${TARGET_REPO}/issues/67#issuecomment-6701)`,
      );

      t.models.replyJson(grillAnswer({ confidence: 70, questions: 1 }));
      await deliver(t, commented(67, 6702, '/retry'));
      t.models.replyJson(grillAnswer({ confidence: 75, questions: 1 }));
      await deliver(t, commented(67, 6703, 'Q3: monthly.'));

      expect(t.models.calls).toHaveLength(4);
      // The last call still read the first answer (its placeholder): the marker is found, nothing new.
      expect(
        t.models.calls[3].messages.map((m) => m.text).join('\n'),
      ).toContain('[REDACTED: github-token]');
      expect(notices(issue)).toHaveLength(1);
      expect(logs).toContain(
        `secret-notice ${TARGET_REPO}#67 comment-6701: github-token; already-there`,
      );
    });
  });

  describe('the 🔑 notice at run start (BDW3, plan DP11)', () => {
    const notices = (issue: TaskRef) =>
      botComments(t, issue)
        .filter(({ body }) => body.startsWith('<!-- sdd-agent:secret-removed:'))
        .map(({ body }) => body.split('\n')[0]);

    it("a key in the description: the notice before Grill Me's questions; a restarted run posts no second one", async () => {
      const issue = seedIssue(t, 68, {
        labels: ['workflow: full-sdd'],
        description: `Discount feature. Key: ${GOOGLE_KEY}`,
      });
      t.models.replyJson(grillAnswer({ confidence: 50, questions: 2 }));
      await deliver(t, laneAdded(68));

      expect(
        botComments(t, issue).map(({ body }) => body.split('\n')[0]),
      ).toEqual([
        '<!-- sdd-agent:secret-removed:description -->',
        expect.not.stringContaining('secret-removed') as string,
      ]);

      // Restart: the lane removed (run 1 cancelled), then added again (run 2).
      t.issues.setHumanLabels(issue, []);
      await deliver(
        t,
        issuesUnlabeled({ number: 68, label: 'workflow: full-sdd' }),
      );
      t.issues.setHumanLabels(issue, ['workflow: full-sdd']);
      t.models.replyJson(grillAnswer({ confidence: 50, questions: 2 }));
      await deliver(t, laneAdded(68));

      expect(await t.prisma.run.count()).toBe(2);
      expect(notices(issue)).toEqual([
        '<!-- sdd-agent:secret-removed:description -->',
      ]);
      expect(logs).toContain(
        `secret-notice ${TARGET_REPO}#68 description: google-api-key; already-there`,
      );
    });

    it("a key only in the title: no notice at run start; Grill Me's first call posts it", async () => {
      const issue = t.issues.seedIssue({
        number: 69,
        id: fixtureIssueId(69),
        title: `Use ${GITHUB_TOKEN}`,
        labels: ['workflow: full-sdd'],
      });
      t.models.replyJson(grillAnswer({ confidence: 50, questions: 2 }));

      await deliver(t, laneAdded(69));

      expect(notices(issue)).toEqual([
        '<!-- sdd-agent:secret-removed:title -->',
      ]);
      expect(
        logs.some((line) => line.startsWith('secret-scan run-start')),
      ).toBe(false);
      expect(logs).toContain(
        `secret-scan grill ${TARGET_REPO}#69 title: redacted 1 (github-token)`,
      );
    });
  });

  describe('.env files are hidden from the read tools (BD9, BDW7)', () => {
    afterEach(() => {
      for (const path of ['.env', '.devcontainer/.env', '.env.example'])
        t.repo.removeFile('main', path);
    });

    it('read_file .env → Not available, a not-found row and no loaded one; list_files shows .env.example only', async () => {
      t.repo.seedFile('main', '.env', `TOKEN=${GITHUB_TOKEN}\n`);
      t.repo.seedFile('main', '.devcontainer/.env', `TOKEN=${GITHUB_TOKEN}\n`);
      t.repo.seedFile('main', '.env.example', 'TOKEN=\n');
      const issue = seedIssue(t, 70);
      const setup = await t.app
        .get(StepConfigService)
        .prepare('spec', await t.issues.getTaskDetails(issue));
      const loader = t.app.get(ContextLoaderService);
      const budget = loader.budget(setup);
      const call = {
        task: issue,
        step: 'spec' as const,
        callId: randomUUID(),
        turn: 1,
        setup,
        repoFiles: { tag: 'untrusted-data-0123456789abcdef' },
      };
      const ask = (request: LoadRequest) => loader.load(call, request, budget);

      const listed = await ask({ tool: 'list_files', folder: '', reason: 'r' });
      const env = await ask({ tool: 'read_file', path: '.env', reason: 'r' });
      const nested = await ask({
        tool: 'read_file',
        path: '.devcontainer/.env',
        reason: 'r',
      });

      expect(listed.answer).toContain('.env.example');
      expect(listed.answer).not.toMatch(/\.env \(|\.env\n|devcontainer\/\.env/);
      expect(env).toEqual({
        outcome: 'not-found',
        answer: 'Not available: `.env`.',
      });
      expect(nested.outcome).toBe('not-found');
      const rows = await t.prisma.contextLoad.findMany({
        where: { callId: call.callId },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        rows.map(({ tool, requested, outcome }) => [tool, requested, outcome]),
      ).toEqual([
        ['list_files', '', 'loaded'],
        ['read_file', '.env', 'not-found'],
        ['read_file', '.devcontainer/.env', 'not-found'],
      ]);
      expect(
        t.repo.calls.some(
          (c) => c.method === 'readFile' && String(c.args[1]).endsWith('.env'),
        ),
      ).toBe(false);
    });
  });
});
