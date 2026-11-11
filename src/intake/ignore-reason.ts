/** Spec 2 "Ignore reasons": what `WebhookEvent.ignoreReason` holds for an event intake drops (IA12). */
export const IGNORE_REASONS = [
  'ping', // GitHub's webhook test
  'other-repo', // not TARGET_REPO
  'unsupported-event', // an event or action the bot doesn't use
  'invalid-payload', // a needed field is missing or malformed
  'own-event', // sent by the bot itself, and not a pull_request event
  'label-deleted', // a label event without a label
  'status-label', // a `status: *` label was added or removed
  'other-label', // a label the bot doesn't use
  'skip-removed', // `grill: skip` was removed
  'pr-comment', // a comment on a pull request
  'comment-edited', // a comment was edited
  'comment-deleted', // a comment was deleted
  'not-bot-pr', // a pull request the bot didn't open
  'unauthorized', // the sender's level is too low; nothing was done
  'label-reverted', // a lane or skip label added with no access was removed
  'approve-denied', // a Participant's /approve was answered
] as const;

export type IgnoreReason = (typeof IGNORE_REASONS)[number];
