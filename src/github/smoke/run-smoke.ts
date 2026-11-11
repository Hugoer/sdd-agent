// The checks of `npm run github:smoke` (spec 3 "Smoke script", plan P6). They use the provider ports only, so
// they are unit-tested against the in-memory fakes before they write to the sandbox.
import type {
  AccessLevel,
  CommentRef,
  IssueProvider,
  TaskRef,
  UnifiedTask,
} from '../../contracts/issue-provider.js';
import { ProviderError } from '../../contracts/provider-error.js';
import type {
  PullRequestRef,
  RepoFile,
  RepoProvider,
} from '../../contracts/repo-provider.js';
import { isStatusLabel, sameLabel } from '../labels.js';

export interface SmokePorts {
  issues: IssueProvider;
  repo: RepoProvider;
  /** Plain fetch for the comment attempt with the push token (spec: no Octokit there). */
  fetch: typeof fetch;
}

export interface SmokeOptions {
  targetRepo: string;
  issue: number;
  /** Makes the comment marker, the invented login and the missing names unique to this run. */
  runId: string;
  /** Branch the repo checks read (`--base`). */
  base: string;
  /** Directory listed by the repo checks (`--dir`). */
  dir: string;
  /** Both or neither (`--branch`, `--sha`): the PR checks run only with both. */
  branch?: string;
  sha?: string;
}

type Print = (line: string) => void;
/** A check returns what it saw, or throws. */
type Check = [name: string, run: () => Promise<string>];

/** Prints one PASS / FAIL line per check; returns true only if every check passed. Groups are independent. */
export async function runSmoke(
  ports: SmokePorts,
  options: SmokeOptions,
  print: Print,
): Promise<boolean> {
  const results = [
    await runGroup(issueChecks(ports.issues, options), print),
    await runGroup(repoChecks(ports.repo, options), print),
    await runGroup(
      credentialChecks(ports.repo, ports.issues, ports.fetch, options),
      print,
    ),
  ];
  if (options.branch && options.sha) {
    results.push(
      await runGroup(
        pullRequestChecks(ports.repo, options, options.branch, options.sha),
        print,
      ),
    );
  }
  return results.every(Boolean);
}

/** Checks of one group run in order and depend on each other, so the group stops at its first FAIL. */
async function runGroup(checks: Check[], print: Print): Promise<boolean> {
  for (const [name, run] of checks) {
    try {
      print(`PASS ${name}: ${await run()}`);
    } catch (error) {
      print(
        `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  return true;
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function issueChecks(
  issues: IssueProvider,
  { targetRepo, issue, runId }: SmokeOptions,
): Check[] {
  // `id` is the DB identity and isn't sent to GitHub; the details give the real one.
  const ref: TaskRef = {
    platform: 'GITHUB',
    id: 'smoke',
    externalRef: `${targetRepo}#${issue}`,
  };
  const marker = `<!-- sdd-agent:smoke:${runId} -->`;
  const body = `${marker}\n🧪 sdd-agent smoke check (spec 3), run \`${runId}\`. The bot never deletes comments: remove it by hand if you like.`;
  let task!: UnifiedTask;
  let comment!: CommentRef;

  const accessLevel = async (login: string, expected: AccessLevel) => {
    const level = await issues.getAccessLevel(task, login);
    assert(level === expected, `${login} → ${level}, expected ${expected}`);
    return `${login} → ${level}`;
  };

  return [
    [
      'getTaskDetails',
      async () => {
        task = await issues.getTaskDetails(ref);
        return `#${issue} "${task.title}" by ${task.author}, labels [${task.labels.join(', ')}]`;
      },
    ],
    [
      'readControls',
      () => {
        const { lanes, grillSkip } = issues.readControls(task);
        return Promise.resolve(
          `lanes [${lanes.join(', ')}], grillSkip ${grillSkip}`,
        );
      },
    ],
    [
      'postComment',
      async () => {
        comment = await issues.postComment(task, body);
        return `comment ${comment.id} ${comment.url}`;
      },
    ],
    [
      'findCommentByMarker',
      async () => {
        const found = await issues.findCommentByMarker(task, marker);
        assert(
          found?.id === comment.id,
          `expected comment ${comment.id}, got ${found?.id ?? 'null'}`,
        );
        return `comment ${found.id}`;
      },
    ],
    [
      'getComment',
      async () => {
        const found = await issues.getComment(task, comment.id);
        assert(found?.body === body, 'the body differs from the posted one');
        return `same body, created ${found.createdAt.toISOString()}`;
      },
    ],
    [
      'findCommentByMarker (unused marker)',
      async () => {
        const unused = `<!-- sdd-agent:smoke:unused-${runId} -->`;
        const found = await issues.findCommentByMarker(task, unused);
        assert(found === null, `expected null, got comment ${found?.id}`);
        return 'null';
      },
    ],
    [
      'setStatusLabel grilling → spec-review',
      async () => {
        await issues.setStatusLabel(task, 'grilling');
        await issues.setStatusLabel(task, 'spec-review');
        const { labels } = await issues.getTaskDetails(task);
        const status = labels.filter(isStatusLabel);
        assert(
          status.length === 1 && sameLabel(status[0], 'status: spec-review'),
          `status labels [${status.join(', ')}]`,
        );
        return `status labels [${status.join(', ')}]`;
      },
    ],
    [
      'removeLabel grill: skip (twice)',
      async () => {
        await issues.removeLabel(task, 'grill: skip');
        await issues.removeLabel(task, 'grill: skip');
        const { labels } = await issues.getTaskDetails(task);
        assert(
          !labels.some((label) => sameLabel(label, 'grill: skip')),
          `still there: labels [${labels.join(', ')}]`,
        );
        return `labels [${labels.join(', ')}]`;
      },
    ],
    [
      'removeLabel bug (refused)',
      async () => {
        try {
          await issues.removeLabel(task, 'bug');
        } catch (error) {
          if (error instanceof ProviderError && error.kind === 'permanent')
            return `refused: ${error.message}`;
          throw error;
        }
        throw new Error('it was not refused');
      },
    ],
    [
      'getAccessLevel (issue author)',
      () => accessLevel(task.author, 'approver'),
    ],
    ['getAccessLevel octocat', () => accessLevel('octocat', 'none')],
    [
      'getAccessLevel (invented login)',
      () => accessLevel(`no-such-user-${runId}`, 'none'),
    ],
    [
      'isSelf (issue author)',
      () => Promise.resolve(isSelf(issues, task.author, false)),
    ],
  ];
}

function isSelf(
  issues: IssueProvider,
  login: string,
  expected: boolean,
): string {
  const self = issues.isSelf(login);
  assert(self === expected, `${login} → ${self}, expected ${expected}`);
  return `${login} → ${self}`;
}

function repoChecks(
  repo: RepoProvider,
  { base, dir, runId }: SmokeOptions,
): Check[] {
  const workflow = '.github-agent/workflow.json';
  const missingFile = `.github-agent/no-such-file-${runId}.md`;
  const missingRef = `no-such-ref-${runId}`;
  const missingDir = `no-such-dir-${runId}`;

  return [
    [
      `readFile ${base}:${workflow}`,
      async () => {
        const content = await repo.readFile(base, workflow);
        assert(content !== null, 'expected the file, got null');
        return `${Buffer.byteLength(content)} B: ${content.replaceAll('\n', '\\n')}`;
      },
    ],
    [
      'readFile (missing file)',
      async () => {
        const content = await repo.readFile(base, missingFile);
        assert(content === null, 'expected null, got a file');
        return `${base}:${missingFile} → null`;
      },
    ],
    [
      'readFile (unknown ref)',
      async () => {
        try {
          await repo.readFile(missingRef, workflow);
        } catch (error) {
          if (error instanceof ProviderError && error.kind === 'permanent')
            return `${missingRef}:${workflow} → error: ${error.message}`;
          throw error;
        }
        throw new Error('expected a permanent error, got a result');
      },
    ],
    [
      `listFiles ${base}:${dir}`,
      async () => {
        const files = await repo.listFiles(base, dir);
        assert(files !== null, 'expected a directory, got null');
        return `${files.length} file${files.length === 1 ? '' : 's'}: ${files.map(describeFile).join(', ')}`;
      },
    ],
    [
      'listFiles (missing directory)',
      async () => {
        const files = await repo.listFiles(base, missingDir);
        assert(files === null, `expected null, got ${files?.length} files`);
        return `${base}:${missingDir} → null`;
      },
    ],
  ];
}

function describeFile(file: RepoFile): string {
  return `${file.path} (${file.size} B${file.executable ? ', executable' : ''})`;
}

/** G8: the push token is new on every call and can't write anything but contents. Tokens print as lengths only. */
function credentialChecks(
  repo: RepoProvider,
  issues: IssueProvider,
  fetchFn: typeof fetch,
  { targetRepo, issue }: SmokeOptions,
): Check[] {
  let token = '';
  let botLogin = '';
  return [
    [
      'getPushCredentials (twice)',
      async () => {
        const first = await repo.getPushCredentials();
        const second = await repo.getPushCredentials();
        assert(first.token !== second.token, 'the same token twice');
        token = second.token;
        botLogin = second.authorName;
        const minutes = Math.round(
          (second.expiresAt.getTime() - Date.now()) / 60_000,
        );
        return `${second.authorName} <${second.authorEmail}>, ${second.remoteUrl}, expires in ${minutes} min, two different tokens (${first.token.length} and ${second.token.length} chars)`;
      },
    ],
    [
      'isSelf (bot login)',
      () => Promise.resolve(isSelf(issues, botLogin, true)),
    ],
    [
      'push token cannot comment (403)',
      async () => {
        const response = await fetchFn(
          `https://api.github.com/repos/${targetRepo}/issues/${issue}/comments`,
          {
            method: 'POST',
            headers: {
              authorization: `token ${token}`,
              accept: 'application/vnd.github+json',
              'content-type': 'application/json',
              'user-agent': 'sdd-agent-smoke',
              'x-github-api-version': '2022-11-28',
            },
            body: JSON.stringify({
              body: 'sdd-agent smoke: this comment uses the push token and must be refused.',
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        await response.body?.cancel();
        assert(response.status === 403, `GitHub answered ${response.status}`);
        return `GitHub answered ${response.status}`;
      },
    ],
  ];
}

/** Safe to run again: the second run finds the PR instead of opening another, and updates the same check run. */
function pullRequestChecks(
  repo: RepoProvider,
  { base, runId }: SmokeOptions,
  branch: string,
  sha: string,
): Check[] {
  let pr: PullRequestRef | null = null;
  const current = (): PullRequestRef => {
    if (!pr) throw new Error('no pull request');
    return pr;
  };

  return [
    [
      `findPullRequest ${branch}`,
      async () => {
        pr = await repo.findPullRequest(branch);
        return pr ? `#${pr.number} ${pr.url}` : 'none yet';
      },
    ],
    [
      'openPullRequest (if missing)',
      async () => {
        if (pr) return `not needed: #${pr.number} exists`;
        pr = await repo.openPullRequest(
          branch,
          base,
          'sdd-agent smoke (spec 3)',
          'Opened by `npm run github:smoke` (spec 3). The bot never closes pull requests: close it by hand.',
        );
        return `opened #${pr.number} ${pr.url}`;
      },
    ],
    [
      'findPullRequest (again)',
      async () => {
        const expected = current().number;
        const found = await repo.findPullRequest(branch);
        assert(
          found?.number === expected,
          `expected #${expected}, got ${found ? `#${found.number}` : 'null'}`,
        );
        return `#${found.number}`;
      },
    ],
    [
      'postPullRequestComment',
      async () => {
        const comment = await repo.postPullRequestComment(
          current(),
          `<!-- sdd-agent:smoke:${runId} -->\n🧪 sdd-agent smoke check (spec 3), run \`${runId}\`.`,
        );
        return `comment ${comment.id} ${comment.url}`;
      },
    ],
    [
      `setQualityResult ${sha.slice(0, 7)}`,
      async () => {
        await repo.setQualityResult(
          current(),
          sha,
          'neutral',
          `Smoke run ${runId}: neutral first.`,
        );
        await repo.setQualityResult(
          current(),
          sha,
          'success',
          `Smoke run ${runId}: then success.`,
        );
        return 'neutral, then success (the Checks tab must show one Quality Gate run)';
      },
    ],
  ];
}
