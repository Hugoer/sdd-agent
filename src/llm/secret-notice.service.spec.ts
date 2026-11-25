import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  SecretNoticeService,
  noticeKinds,
  secretNoticeComment,
  secretNoticeMarker,
} from './secret-notice.service.js';

afterEach(() => vi.restoreAllMocks());

const REPO = 'test-owner/test-repo';
const DESCRIPTION = { key: 'description', label: 'the issue description' };
const COMMENT = {
  key: 'comment-4821',
  label: 'the comment by alice',
  url: `https://github.com/${REPO}/issues/14#issuecomment-4821`,
};

function setup() {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const issues = new InMemoryIssueProvider(REPO);
  const task = issues.seedIssue({ number: 14 });
  issues.calls.length = 0;
  return { issues, task, log, service: new SecretNoticeService(issues) };
}

describe('secretNoticeComment (spec 12 BDW3)', () => {
  it("the description's notice is BDW3's example", () => {
    expect(secretNoticeComment(DESCRIPTION, ['google-api-key'])).toBe(
      '<!-- sdd-agent:secret-removed:description -->\n' +
        '🔑 **A secret was removed from the issue description before the bot read it** (`google-api-key`).\n' +
        'The bot never sends it to the model and never stores it, but it is still on GitHub, and GitHub keeps the old ' +
        'text in the edit history: **rotate it** (revoke it and make a new one), then edit it out. The bot keeps ' +
        'working. This check is a pattern list: a secret of another format is not found.',
    );
  });

  it('a comment is named by a link; several kinds in backticks', () => {
    expect(
      secretNoticeComment(COMMENT, ['github-token', 'aws-access-key']),
    ).toContain(
      `🔑 **A secret was removed from [the comment by alice](${COMMENT.url}) before the bot read it** ` +
        '(`github-token`, `aws-access-key`).',
    );
  });

  it('the marker holds the source key', () => {
    expect(secretNoticeMarker('comment-4821')).toBe(
      '<!-- sdd-agent:secret-removed:comment-4821 -->',
    );
  });
});

describe('noticeKinds (plan DP7: BDW3, BDW16)', () => {
  it.each([['title'], ['description'], ['comment-4821']])(
    '%s: the kinds less own-secret',
    (key) => {
      expect(
        noticeKinds({ key }, ['own-secret', 'github-token', 'private-key']),
      ).toEqual(['github-token', 'private-key']);
    },
  );

  it('only own-secret → none (a notice would confirm a guessed value)', () => {
    expect(noticeKinds({ key: 'description' }, ['own-secret'])).toEqual([]);
  });

  it.each([['spec-1'], ['plan-2'], ['file-a']])(
    '%s (not written by people) → none',
    (key) => {
      expect(noticeKinds({ key }, ['github-token'])).toEqual([]);
    },
  );
});

describe('SecretNoticeService.notify', () => {
  it('posts once per source key; a second call finds the marker; another key gets its own; one log line each', async () => {
    const { issues, task, log, service } = setup();

    await expect(
      service.notify(task, DESCRIPTION, ['google-api-key']),
    ).resolves.toBe('posted');
    await expect(
      service.notify(task, DESCRIPTION, ['github-token']),
    ).resolves.toBe('already-there');
    await expect(service.notify(task, COMMENT, ['github-token'])).resolves.toBe(
      'posted',
    );

    expect(issues.commentsOf(task).map((c) => c.body.split('\n')[0])).toEqual([
      '<!-- sdd-agent:secret-removed:description -->',
      '<!-- sdd-agent:secret-removed:comment-4821 -->',
    ]);
    expect(log.mock.calls).toEqual([
      [`secret-notice ${REPO}#14 description: google-api-key; posted`],
      [`secret-notice ${REPO}#14 description: github-token; already-there`],
      [`secret-notice ${REPO}#14 comment-4821: github-token; posted`],
    ]);
  });

  it('a GitHub error passes through unchanged', async () => {
    const { issues, task, service } = setup();
    const down = new ProviderError('GitHub POST … → 502', 'transient', {
      status: 502,
    });
    vi.spyOn(issues, 'postComment').mockRejectedValue(down);

    await expect(
      service.notify(task, DESCRIPTION, ['google-api-key']),
    ).rejects.toBe(down);
  });
});
