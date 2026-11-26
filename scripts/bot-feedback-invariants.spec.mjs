// Spec 13 (BFW14): each invariant of scripts/bot-feedback-invariants.mjs over a clean fixture (all pass) and a
// fixture that breaks it (FAIL naming the issue). Created 2026-11-27 for plan Task 12.
import { describe, expect, it } from 'vitest';
import {
  checkNoWorkingSign,
  checkReadyMeansApproved,
  checkRocketOrEyes,
  checkRockets,
  runChecks,
} from './bot-feedback-invariants.mjs';

const REF = 'o/r#12';
const T = (minute, second = 0) =>
  `2026-11-27T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
const rocket = { content: 'rocket', bot: true };
const eyes = { content: 'eyes', bot: true };

/**
 * Issue #12 (`full-sdd`), Plan approved, idle. Comment 501 (a Grill answer) worked 10:01–10:03 with a model row at
 * 10:02 → 🚀; comment 502 answered later (👀 only); `/retry` 503 accepted → 🚀; a person's own 🚀 on 504.
 */
function clean() {
  const comment = (id, body, reactions) => ({
    number: 12,
    id,
    body,
    bot: false,
    reactions,
  });
  const event = (over) => ({
    external_ref: REF,
    status: 'DONE',
    ignore_reason: null,
    working_started_at: null,
    working_ended_at: null,
    ...over,
  });
  return {
    issues: [
      { number: 12, labels: ['workflow: full-sdd', 'status: ready-for-dev'] },
    ],
    tasks: [
      {
        external_ref: REF,
        working_event_id: null,
        status: 'ready-for-dev',
        lane: 'full-sdd',
        plan_approved: true,
      },
    ],
    comments: [
      comment('501', 'Q1: yes.', [rocket]),
      comment('502', 'Q2 later.', [eyes]),
      comment('503', '/retry', [rocket]),
      comment('504', 'Nice', [{ content: 'rocket', bot: false }]),
    ],
    events: [
      event({
        id: 'e1',
        comment_id: '501',
        working_started_at: T(1),
        working_ended_at: T(3),
      }),
      event({ id: 'e2', comment_id: '502' }),
      event({ id: 'e3', comment_id: '503' }),
      event({ id: 'e4', comment_id: '504' }),
    ],
    logs: [{ external_ref: REF, created_at: T(2) }],
  };
}

describe('bot-feedback invariants (spec 13)', () => {
  it('the clean fixture passes every invariant', () => {
    expect(
      runChecks(clean()).filter((result) => result.failures.length > 0),
    ).toEqual([]);
  });

  it('1: a bot: working label on a given issue; a task with a mark', () => {
    const data = clean();
    data.issues[0].labels.push('bot: working');
    data.tasks[0].working_event_id = 'e1';

    expect(checkNoWorkingSign(data)).toEqual([
      '#12: still labelled `bot: working`',
      '#12: tasks.working_event_id = e1',
    ]);
  });

  it("2: a comment with the bot's 🚀 and 👀", () => {
    const data = clean();
    data.comments[1].reactions.push(rocket);

    expect(checkRocketOrEyes(data)).toEqual([
      "#12: comment 502 has the bot's 🚀 and 👀",
    ]);
  });

  it('3: a 🚀 on a comment whose event has no model row in its own working window', () => {
    const data = clean();
    data.logs = [{ external_ref: REF, created_at: T(5) }];

    expect(checkRockets(data)).toEqual([
      '#12: 🚀 on comment 501: its event has no execution_logs row in its own working window',
    ]);
  });

  it("3 (FP24, the review's overlap): a second answer whose arrival and end span the first's model rows, but which never started working → its 🚀 fails", () => {
    const data = clean();
    data.comments.push({
      number: 12,
      id: '505',
      body: 'Q3: twice.',
      bot: false,
      reactions: [rocket],
    });
    // Received 10:00:30 (before the first answer's model row) and processed at 10:04: a received … processed
    // window would pass it, its own working window (never set) does not.
    data.events.push({
      id: 'e5',
      external_ref: REF,
      comment_id: '505',
      status: 'DONE',
      ignore_reason: null,
      received_at: T(0, 30),
      processed_at: T(4),
      working_started_at: null,
      working_ended_at: null,
    });

    expect(checkRockets(data)).toEqual([
      '#12: 🚀 on comment 505: its event has no execution_logs row in its own working window',
    ]);
  });

  it('3: an accepted /retry passes; a refused /retry fails; a 🚀 with no stored event fails', () => {
    const data = clean();
    data.events.find((e) => e.id === 'e3').status = 'IGNORED';
    data.events.find((e) => e.id === 'e3').ignore_reason = 'retry-refused';
    data.comments.push({
      number: 12,
      id: '506',
      body: 'hello',
      bot: false,
      reactions: [rocket],
    });

    expect(checkRockets(data)).toEqual([
      '#12: 🚀 on comment 503: a refused /retry',
      '#12: 🚀 on comment 506: no stored event for it',
    ]);
    expect(checkRockets(clean())).toEqual([]);
  });

  it('4: a full-sdd issue labelled ready-for-dev with an unapproved current Plan; code-only and spec-code pass', () => {
    const data = clean();
    data.tasks[0].plan_approved = false;

    expect(checkReadyMeansApproved(data)).toEqual([
      '#12: `status: ready-for-dev` while its current Plan waits for /approve',
    ]);
    for (const lane of ['code-only', 'spec-code']) {
      const other = clean();
      other.tasks[0].lane = lane;
      other.tasks[0].plan_approved = null;
      expect(checkReadyMeansApproved(other)).toEqual([]);
    }
  });
});
