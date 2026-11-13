import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../src/contracts/issue-provider.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../src/contracts/repo-provider.js';
import {
  approveDeniedComment,
  labelRevertComment,
} from '../src/intake/intake.service.js';
import { resetDatabase } from './db.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import {
  issueCommentCreated,
  issuesLabeled,
  type Delivery,
} from './fixtures/github/payloads.js';
import { testEnv } from './test-env.js';

// Spec 4 "At the ports" (LW4, plan P4): in the booted app both port tokens are the scanning wrappers.

// Built at run time: no token-shaped literal in the repo.
const TOKEN = ['gh', 's_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');

describe('secret scanning at the ports (booted app)', () => {
  let t: TestApp;

  async function deliver(delivery: Delivery) {
    const deliveryId = newDeliveryId();
    const res = await postWebhook(t.baseUrl, JSON.stringify(delivery.payload), {
      'x-github-event': delivery.eventName,
      'x-github-delivery': deliveryId,
    });
    expect(res.status).toBe(202);
    await t.worker.drainOnce();
    return t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
  }

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('a comment with a token-shaped string, posted through ISSUE_PROVIDER, arrives redacted at the fake', async () => {
    const task = t.issues.seedIssue({ number: 81 });

    await t.app
      .get<IssueProvider>(ISSUE_PROVIDER)
      .postComment(
        task,
        `<!-- sdd-agent:test -->\nleaked ${TOKEN} and ${testEnv.GITHUB_WEBHOOK_SECRET}`,
      );

    expect(t.issues.commentsOf(task).map((comment) => comment.body)).toEqual([
      '<!-- sdd-agent:test -->\nleaked [REDACTED: github-token] and [REDACTED: own-secret]',
    ]);
  });

  it('a pull request title and body through REPO_PROVIDER arrive redacted', async () => {
    await t.app
      .get<RepoProvider>(REPO_PROVIDER)
      .openPullRequest(
        'agent/issue-81',
        'main',
        `Fix ${TOKEN}`,
        `Body ${TOKEN}`,
      );

    expect(
      t.repo.pullRequests.map(({ branch, title, body }) => ({
        branch,
        title,
        body,
      })),
    ).toEqual([
      {
        branch: 'agent/issue-81',
        title: 'Fix [REDACTED: github-token]',
        body: 'Body [REDACTED: github-token]',
      },
    ]);
  });

  it("spec 2's revert comment arrives byte for byte unchanged", async () => {
    const task = t.issues.seedIssue({
      number: 82,
      labels: ['workflow: code-only'],
    });

    const row = await deliver(
      issuesLabeled({
        number: 82,
        label: 'workflow: code-only',
        sender: 'octocat',
      }),
    );

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'label-reverted',
    });
    expect(t.issues.commentsOf(task).map((comment) => comment.body)).toEqual([
      labelRevertComment(
        { label: 'workflow: code-only', key: 'code-only' },
        'octocat',
      ),
    ]);
  });

  it("spec 2's /approve reply arrives byte for byte unchanged", async () => {
    t.issues.setAccessLevel('a-triager', 'participant');
    const task = t.issues.seedIssue({ number: 83 });

    const row = await deliver(
      issueCommentCreated({
        number: 83,
        body: '/approve',
        sender: 'a-triager',
        commentId: 9083,
      }),
    );

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-denied',
    });
    expect(t.issues.commentsOf(task).map((comment) => comment.body)).toEqual([
      approveDeniedComment('9083', 'a-triager'),
    ]);
  });
});
