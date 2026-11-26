// Spec 12 (BDW15, plan DP23): each invariant of scripts/bot-data-protection-invariants.mjs over a clean fixture
// (all pass) and fixtures that break it (FAIL naming where, never the value); invariant 4 is the two-notices case.
// The copied patterns and hidden-path rule are compared with the code they copy. Created 2026-11-26 for plan Task 11.
import { describe, expect, it } from 'vitest';
import { isHiddenPath as botIsHiddenPath } from '../src/llm/context-tools.ts';
import { SECRET_PATTERNS as BOT_PATTERNS } from '../src/secret-scan/secret-patterns.ts';
import {
  SECRET_PATTERNS,
  checkHiddenLoads,
  checkNoStoredSecrets,
  checkNotices,
  isHiddenPath,
  runChecks,
  storedTexts,
} from './bot-data-protection-invariants.mjs';

// Built at run time: no key-shaped literal in the repo (plan DP22).
const TOKEN = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
const GOOGLE = ['AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4-_o5p'].join('');
const REF = 'o/r#80';

const notice = (id, key, over = {}) => ({
  number: 80,
  id,
  body: `<!-- sdd-agent:secret-removed:${key} -->\n🔑 **A secret was removed …**`,
  login: 'sdd-agent-app[bot]',
  bot: true,
  ...over,
});

/** Issue #80: one notice for the description and one for comment 7, every stored text redacted. */
function clean() {
  return {
    texts: storedTexts({
      events: [
        {
          delivery_id: 'd1',
          external_ref: REF,
          payload: { issue: { body: 'key [REDACTED: google-api-key]' } },
        },
      ],
      logs: [
        {
          id: 'l1',
          external_ref: REF,
          prompt: [{ data: { content: '[REDACTED: github-token]' } }],
          answer: null,
        },
      ],
      answers: [
        {
          comment_id: '7',
          external_ref: REF,
          body: 'Q1: [REDACTED: github-token]',
        },
      ],
      documents: [
        {
          id: 's1',
          external_ref: REF,
          text: '# Spec',
          body: '<!-- sdd-agent:spec:s1 -->',
          deleted_text: null,
          approved_text: '# Spec',
        },
      ],
    }),
    comments: [
      notice('1', 'description'),
      notice('2', 'comment-7'),
      {
        number: 80,
        id: '3',
        body: 'Grill Me, round 1',
        login: 'x[bot]',
        bot: true,
      },
    ],
    loads: [
      {
        id: 'c1',
        external_ref: REF,
        tool: 'read_file',
        path: '.env.example',
        outcome: 'loaded',
      },
      {
        id: 'c2',
        external_ref: REF,
        tool: 'read_file',
        path: '.env',
        outcome: 'not-found',
      },
      {
        id: 'c3',
        external_ref: REF,
        tool: 'list_files',
        path: '',
        outcome: 'loaded',
      },
      // The step skill under .github-agent/, given at start and with load_file: by design (spec 11).
      {
        id: 'c4',
        external_ref: REF,
        trigger: 'start',
        tool: null,
        path: '.github-agent/skills/grill/SKILL.md',
        outcome: 'loaded',
      },
      {
        id: 'c5',
        external_ref: REF,
        trigger: 'tool',
        tool: 'load_file',
        path: '.github-agent/skills/grill/references/q.md',
        outcome: 'loaded',
      },
    ],
  };
}

describe('bot-data-protection invariants', () => {
  it('a clean run passes every invariant', () => {
    expect(runChecks(clean())).toEqual([
      { name: expect.stringMatching(/^1 /), failures: [] },
      { name: expect.stringMatching(/^2 /), failures: [] },
      { name: expect.stringMatching(/^3 /), failures: [] },
    ]);
  });

  it('1: a stored value fails, naming where and the kind, never the value', () => {
    const failures = checkNoStoredSecrets({
      texts: storedTexts({
        events: [
          {
            delivery_id: 'd9',
            external_ref: REF,
            payload: { body: `x ${GOOGLE}` },
          },
        ],
        logs: [
          {
            id: 'l9',
            external_ref: REF,
            prompt: [],
            answer: { content: TOKEN },
          },
        ],
        answers: [{ comment_id: '9', external_ref: REF, body: TOKEN }],
        documents: [
          {
            id: 'p9',
            external_ref: REF,
            text: '',
            body: '',
            deleted_text: null,
            approved_text: `${GOOGLE} and ${TOKEN}`,
          },
        ],
      }),
    });

    expect(failures).toEqual([
      `webhook_events d9 ${REF}: holds google-api-key`,
      `execution_logs l9 ${REF} answer: holds github-token`,
      `grill_answers comment 9 ${REF}: holds github-token`,
      `task_documents p9 ${REF} approved_text: holds github-token, google-api-key`,
    ]);
    expect(failures.join('\n')).not.toMatch(/AIza|ghp_/);
  });

  it('4 (2): an issue with two notices for one key fails; a notice not by the App fails', () => {
    expect(
      checkNotices({
        comments: [
          notice('1', 'description'),
          notice('5', 'description'),
          notice('6', 'title', { login: 'Hugoer', bot: false }),
        ],
      }),
    ).toEqual([
      '#80 description: a second notice, comment 5 (first 1)',
      '#80 title: comment 6 is not by the App (Hugoer)',
    ]);
  });

  it('the same key on two issues is two texts: passes', () => {
    expect(
      checkNotices({
        comments: [
          notice('1', 'description'),
          notice('2', 'description', { number: 81 }),
        ],
      }),
    ).toEqual([]);
  });

  it('3: a loaded .env row fails', () => {
    expect(
      checkHiddenLoads({
        loads: [
          {
            id: 'c9',
            external_ref: REF,
            tool: 'read_file',
            path: '.devcontainer/.env',
            outcome: 'loaded',
          },
        ],
      }),
    ).toEqual([
      '#80 context_loads row c9: read_file .devcontainer/.env loaded',
    ]);
  });

  it("the copied patterns equal the bot's (spec 4's five)", () => {
    expect(
      SECRET_PATTERNS.map(({ kind, pattern }) => [
        kind,
        pattern.source,
        pattern.flags,
      ]),
    ).toEqual(
      BOT_PATTERNS.map(({ kind, pattern }) => [
        kind,
        pattern.source,
        pattern.flags,
      ]),
    );
  });

  it.each([
    'CLAUDE.md',
    'docs/claude.md',
    'GEMINI.md',
    '.cursorrules',
    'a/.windsurfrules',
    '.github/copilot-instructions.md',
    '.cursor/rules/a.mdc',
    'vendor/.cursor/x',
    '.github-agent/workflow.json',
    '.GITHUB-AGENT/x',
    'vendor/.github-agent/workflow.json',
    '.env',
    '.ENV',
    'a/.env.local',
    '.devcontainer/.env',
    '.env.example',
    'a/.ENV.EXAMPLE',
    '.env.example.bak',
    '.envrc',
    'env.ts',
    'src/index.ts',
    'docs/CLAUDE.md.bak',
    '.github/workflows/ci.yml',
  ])("the copied hidden-path rule agrees with the bot's on %s", (path) => {
    expect(isHiddenPath(path)).toBe(botIsHiddenPath(path));
  });
});
