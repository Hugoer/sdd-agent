import { describe, expect, it } from 'vitest';
import { approvalVerdict, type WaitingDocument } from './approval-check.js';
import { DOCUMENT_END, DOCUMENT_START } from './document-text.js';

const POSTED = new Date('2026-11-22T10:00:00Z');
const spec = (over: Partial<WaitingDocument> = {}): WaitingDocument => ({
  kind: 'spec',
  approvedAt: null,
  postedAt: POSTED,
  deletedAt: null,
  ...over,
});
const at = (seconds: number) => ({
  createdAt: new Date(POSTED.getTime() + seconds * 1000),
});
const body = (text: string) => ({
  body: `<!-- sdd-agent:spec:x -->\n**Spec v1**\n\n${DOCUMENT_START}\n${text}\n${DOCUMENT_END}\n\n---\n<sub>Model</sub>`,
});

describe('approvalVerdict (spec "`/approve`", the verdict table)', () => {
  it('valid: after the comment, not approved, the comment there with text', () => {
    expect(approvalVerdict(spec(), at(5), body('# Spec'), null)).toBe('valid');
  });

  it('the same second as the document counts (GitHub’s timestamps have one-second resolution)', () => {
    expect(approvalVerdict(spec(), at(0), body('# Spec'), null)).toBe('valid');
  });

  it('this event already approved the waiting document (a retry) → valid, whatever else holds', () => {
    expect(
      approvalVerdict(spec({ approvedAt: POSTED }), at(-5), null, 'waiting'),
    ).toBe('valid');
  });

  it('this event approved an earlier document of the run → done (P27)', () => {
    expect(approvalVerdict(spec(), at(5), body('x'), 'earlier')).toBe('done');
  });

  it('approved by another event → already-approved', () => {
    expect(
      approvalVerdict(spec({ approvedAt: POSTED }), at(5), body('x'), null),
    ).toBe('already-approved');
  });

  it('written before the comment was created, or before it was posted → before-document', () => {
    expect(approvalVerdict(spec(), at(-1), body('x'), null)).toBe(
      'before-document',
    );
    expect(
      approvalVerdict(spec({ postedAt: null }), at(5), body('x'), null),
    ).toBe('before-document');
  });

  it('the comment gone, or a deletion recorded → deleted', () => {
    expect(approvalVerdict(spec(), at(5), null, null)).toBe('deleted');
    expect(
      approvalVerdict(spec({ deletedAt: POSTED }), at(5), body('x'), null),
    ).toBe('deleted');
  });

  it('nothing between the markers, or an empty comment → empty', () => {
    expect(approvalVerdict(spec(), at(5), body('  \n '), null)).toBe('empty');
    expect(approvalVerdict(spec(), at(5), { body: '' }, null)).toBe('empty');
  });

  it('the go-signal: only the time and the approval count; deleted still counts', () => {
    const goSignal = spec({ kind: 'go-signal' });
    expect(approvalVerdict(goSignal, at(5), null, null)).toBe('valid');
    expect(approvalVerdict(goSignal, at(-1), null, null)).toBe(
      'before-document',
    );
    expect(
      approvalVerdict({ ...goSignal, approvedAt: POSTED }, at(5), null, null),
    ).toBe('already-approved');
  });
});
