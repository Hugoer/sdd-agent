import { describe, expect, it } from 'vitest';
import { LlmError } from '../contracts/llm-error.js';
import { stopCauseOf } from './stop-cause.js';
import {
  RUN_START,
  issueClosedComment,
  laneConflictComment,
  retryRefusedComment,
  runEndedComment,
  stopComment,
  type RunRef,
} from './workflow-comments.js';
import { StepNotBuiltError } from './workflow-errors.js';

const RUN_ID = '3f2c9a4e-0000-4000-8000-000000000002';
const run2: RunRef = { id: RUN_ID, number: 2, lane: 'full-sdd' };

describe('stopComment (spec "Stop comment")', () => {
  it('a failure at a step: the spec example, marker first', () => {
    const text = stopComment(run2, 1, {
      kind: 'failure',
      step: 'spec',
      message:
        "Google refused this key for this call: check the key's permissions and the project's billing",
      cause: 'access-denied',
    });

    expect(text).toBe(
      [
        `<!-- sdd-agent:needs-human:${RUN_ID}:1 -->`,
        "⚠️ **Run 2 stopped at step `spec`:** Google refused this key for this call: check the key's permissions and the project's billing. (`access-denied`)",
        '',
        '- Fix the cause, then comment `/retry` to continue run 2 where it stopped.',
        '- Or start again from scratch: remove the `workflow: full-sdd` label and add it again.',
      ].join('\n'),
    );
  });

  it('before the first step', () => {
    const text = stopComment(run2, 1, {
      kind: 'failure',
      step: RUN_START,
      message: 'missing skills: plan, code',
      cause: 'step-config',
    });

    expect(text.split('\n')[1]).toBe(
      '⚠️ **Run 2 stopped before its first step:** missing skills: plan, code. (`step-config`)',
    );
  });

  it('step-not-built, with the same two lines', () => {
    const run1: RunRef = { id: RUN_ID, number: 1, lane: 'code-only' };
    const { cause, message } = stopCauseOf(
      new StepNotBuiltError('grill'),
      'd-1',
    );
    const lines = stopComment(run1, 1, {
      kind: 'failure',
      step: 'grill',
      message,
      cause,
    }).split('\n');

    expect(lines[1]).toBe(
      '⚠️ **Run 1 stopped at step `grill`:** this version of the bot has no `grill` step yet. (`step-not-built`)',
    );
    expect(lines.slice(3)).toEqual([
      '- Fix the cause, then comment `/retry` to continue run 1 where it stopped.',
      '- Or start again from scratch: remove the `workflow: code-only` label and add it again.',
    ]);
  });

  it('the marker counts stops: a second stop gets its own marker', () => {
    const second = stopComment(run2, 2, {
      kind: 'failure',
      step: 'spec',
      message: 'x',
      cause: 'step-config',
    });

    expect(second.split('\n')[0]).toBe(
      `<!-- sdd-agent:needs-human:${RUN_ID}:2 -->`,
    );
  });

  it('a result of the work: the step body, then only the restart line (plan P4)', () => {
    const text = stopComment(run2, 1, {
      kind: 'work-result',
      body: 'The Grill reached its round limit.',
    });

    expect(text).toBe(
      [
        `<!-- sdd-agent:needs-human:${RUN_ID}:1 -->`,
        'The Grill reached its round limit.',
        '',
        '- To start again from scratch: remove the `workflow: full-sdd` label and add it again.',
      ].join('\n'),
    );
    expect(text).not.toContain('/retry');
  });
});

describe('runEndedComment (RL18)', () => {
  it('cancelled: the spec example', () => {
    expect(runEndedComment(run2, { kind: 'cancelled' }, 'octocat')).toBe(
      [
        `<!-- sdd-agent:run-ended:${RUN_ID} -->`,
        'Run 2 (`full-sdd`) was cancelled: `octocat` removed `workflow: full-sdd`.',
        'To start again, add one `workflow:` label.',
      ].join('\n'),
    );
  });

  it('replaced: the spec example', () => {
    expect(
      runEndedComment(
        run2,
        { kind: 'replaced', by: { number: 3, lane: 'spec-code' } },
        'octocat',
      ),
    ).toBe(
      [
        `<!-- sdd-agent:run-ended:${RUN_ID} -->`,
        'Run 2 (`full-sdd`) was replaced by run 3 (`spec-code`): `octocat` changed the workflow label.',
      ].join('\n'),
    );
  });

  it('the cancel hooks’ blocks follow in the same comment, each after a blank line', () => {
    const text = runEndedComment(run2, { kind: 'cancelled' }, 'octocat', [
      'Answered rounds: 2 of 5.',
    ]);

    expect(text.endsWith('\n\nAnswered rounds: 2 of 5.')).toBe(true);
  });

  it('never mentions with @', () => {
    expect(
      runEndedComment(run2, { kind: 'cancelled' }, 'octocat'),
    ).not.toContain('@');
  });
});

describe('laneConflictComment (RL8)', () => {
  it('in draft: the spec example', () => {
    expect(laneConflictComment(1, ['full-sdd', 'code-only'], null)).toBe(
      '<!-- sdd-agent:lane-conflict:1 -->\n' +
        'This issue has more than one `workflow:` label (`workflow: full-sdd`, `workflow: code-only`). ' +
        'Keep exactly one: the bot starts a run when one is left.',
    );
  });

  it('during a run: the spec example', () => {
    expect(
      laneConflictComment(2, ['full-sdd', 'code-only'], {
        number: 2,
        lane: 'full-sdd',
      }),
    ).toBe(
      '<!-- sdd-agent:lane-conflict:2 -->\n' +
        'This issue has more than one `workflow:` label (`workflow: full-sdd`, `workflow: code-only`). ' +
        'Run 2 keeps `workflow: full-sdd`. To switch, remove `workflow: full-sdd`; to stay, remove the others.',
    );
  });
});

describe('issueClosedComment (RL19)', () => {
  it('a lane label added: the spec example', () => {
    expect(
      issueClosedComment('d-7', { kind: 'lane-added', lane: 'full-sdd' }),
    ).toBe(
      '<!-- sdd-agent:issue-closed:d-7 -->\n' +
        'This issue is closed, so the bot did nothing with `workflow: full-sdd`. To start a run, reopen the ' +
        'issue, then remove the label and add it again.',
    );
  });

  it('/retry: the spec example; /approve the same way', () => {
    expect(issueClosedComment('d-8', { kind: 'retry' })).toBe(
      '<!-- sdd-agent:issue-closed:d-8 -->\n' +
        'This issue is closed, so `/retry` did nothing. Reopen the issue, then comment `/retry` again.',
    );
    expect(issueClosedComment('d-9', { kind: 'approve' })).toBe(
      '<!-- sdd-agent:issue-closed:d-9 -->\n' +
        'This issue is closed, so `/approve` did nothing. Reopen the issue, then comment `/approve` again.',
    );
  });
});

describe('retryRefusedComment (RL20)', () => {
  const head = '<!-- sdd-agent:retry-refused:555 -->\n';

  it('a result of the work: the spec example', () => {
    expect(
      retryRefusedComment('555', {
        kind: 'work-result',
        run: run2,
        reason: 'the Grill round limit was reached',
      }),
    ).toBe(
      head +
        '`/retry` only continues a run that stopped on a failure. Run 2 stopped because the Grill round limit ' +
        'was reached, so it needs a restart: remove the `workflow: full-sdd` label and add it again.',
    );
  });

  it('no run, not stopped, before the stop: the spec texts', () => {
    expect(retryRefusedComment('555', { kind: 'no-run' })).toBe(
      head +
        'There is no run on this issue, so there is nothing to retry. To start one, add one `workflow:` label.',
    );
    expect(
      retryRefusedComment('555', {
        kind: 'not-stopped',
        run: run2,
        status: 'grilling',
      }),
    ).toBe(
      head +
        "Run 2 isn't stopped (status `grilling`), so there is nothing to retry.",
    );
    expect(retryRefusedComment('555', { kind: 'before-stop', run: run2 })).toBe(
      head +
        "This `/retry` was written before run 2 stopped, so it didn't count. To continue run 2, comment " +
        '`/retry` again.',
    );
  });
});

describe('every text (RLW12)', () => {
  const bug = new Error(
    'TypeError: x is undefined\n    at decide (decide.ts:1:1)',
  );
  const internal = stopCauseOf(bug, 'delivery-1');
  const texts = [
    stopComment(run2, 1, { kind: 'failure', step: 'spec', ...internal }),
    stopComment(run2, 1, {
      kind: 'failure',
      step: 'spec',
      ...stopCauseOf(
        new LlmError('Google refused this key', 'permanent', 'access-denied'),
        'd',
      ),
    }),
    stopComment(run2, 1, { kind: 'work-result', body: 'body' }),
    runEndedComment(run2, { kind: 'cancelled' }, 'octocat'),
    runEndedComment(
      run2,
      { kind: 'replaced', by: { number: 3, lane: 'code-only' } },
      'octocat',
    ),
    laneConflictComment(1, ['full-sdd', 'spec-code'], null),
    laneConflictComment(1, ['full-sdd', 'spec-code'], run2),
    issueClosedComment('d', { kind: 'lane-added', lane: 'code-only' }),
    issueClosedComment('d', { kind: 'retry' }),
    issueClosedComment('d', { kind: 'approve' }),
    retryRefusedComment('1', { kind: 'no-run' }),
    retryRefusedComment('1', {
      kind: 'not-stopped',
      run: run2,
      status: 'executing',
    }),
    retryRefusedComment('1', { kind: 'before-stop', run: run2 }),
    retryRefusedComment('1', {
      kind: 'work-result',
      run: run2,
      reason: 'the Grill round limit was reached',
    }),
  ];

  it.each(texts.map((text, i) => [i, text]))(
    'text %i starts with its marker and holds no error name or stack trace',
    (_, text) => {
      expect(text).toMatch(/^<!-- sdd-agent:[a-z-]+:[^\n]+ -->\n/);
      expect(text).not.toMatch(/Error:/);
      expect(text).not.toMatch(/\n\s+at /);
      expect(text).not.toContain('@');
    },
  );
});
