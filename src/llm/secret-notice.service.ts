// Spec 12 "The secret notice on GitHub" (BD3, BDW2, BDW3, BDW16; plan DP7, DP24): a text people wrote that held a
// secret gets one comment per source and issue, posted before the model call. Never names the value.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type TaskRef,
} from '../contracts/issue-provider.js';
import type { SecretKind } from '../secret-scan/secret-patterns.js';
import type { UntrustedSource } from './llm-call.js';

export type NoticeState = 'posted' | 'already-there';

/**
 * Posts the 🔑 notice unless its marker is already on the issue (found by marker and App author, like spec 4's
 * warning). Called by LlmService.call() for every block `noticeKinds` keeps and by spec 5's run start for the
 * description. A ProviderError passes through.
 */
@Injectable()
export class SecretNoticeService {
  private readonly logger = new Logger(SecretNoticeService.name);

  constructor(@Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider) {}

  async notify(
    task: TaskRef,
    source: UntrustedSource,
    kinds: SecretKind[],
  ): Promise<NoticeState> {
    let notice: NoticeState = 'already-there';
    if (
      !(await this.issues.findCommentByMarker(
        task,
        secretNoticeMarker(source.key),
      ))
    ) {
      await this.issues.postComment(task, secretNoticeComment(source, kinds));
      notice = 'posted';
    }
    this.logger.log(
      `secret-notice ${task.externalRef} ${source.key}: ${kinds.join(', ')}; ${notice}`,
    );
    return notice;
  }
}

/**
 * The kinds a block's notice names (plan DP7): none unless people wrote the text (the title, the description, a
 * comment: BDW16), and never `own-secret` (BDW3: a notice would confirm a guessed value of the bot's secrets).
 * Empty: no notice.
 */
export function noticeKinds(
  source: Pick<UntrustedSource, 'key'>,
  kinds: SecretKind[],
): SecretKind[] {
  const written =
    source.key === 'title' ||
    source.key === 'description' ||
    source.key.startsWith('comment-');
  return written ? kinds.filter((kind) => kind !== 'own-secret') : [];
}

export function secretNoticeMarker(sourceKey: string): string {
  return `<!-- sdd-agent:secret-removed:${sourceKey} -->`;
}

/** BDW3's fixed text; the kinds are fixed identifiers; with a url the source label is a link. */
export function secretNoticeComment(
  source: UntrustedSource,
  kinds: SecretKind[],
): string {
  const label = source.url ? `[${source.label}](${source.url})` : source.label;
  return (
    `${secretNoticeMarker(source.key)}\n` +
    `🔑 **A secret was removed from ${label} before the bot read it** ` +
    `(${kinds.map((kind) => `\`${kind}\``).join(', ')}).\n` +
    'The bot never sends it to the model and never stores it, but it is still on GitHub, and GitHub keeps the old ' +
    'text in the edit history: **rotate it** (revoke it and make a new one), then edit it out. The bot keeps ' +
    'working. This check is a pattern list: a secret of another format is not found.'
  );
}
