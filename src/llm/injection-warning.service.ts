import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type TaskRef,
} from '../contracts/issue-provider.js';
import {
  findInjectionKinds,
  type InjectionKind,
} from './injection-patterns.js';
import type { UntrustedSource } from './llm-call.js';

export type WarningState = 'posted' | 'already-there' | 'none';

/**
 * Spec 4 "Warning comment": a text that looks like instructions aimed at the bot gets one warning comment per
 * source and issue, posted before any model call. Called by LlmService.call() for every matched block and by
 * spec 5 with the description at run start. Never quotes the matched text.
 */
@Injectable()
export class InjectionWarningService {
  private readonly logger = new Logger(InjectionWarningService.name);

  constructor(@Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider) {}

  /** The kinds of the text; for a match, the warning (marker first, posted once). A ProviderError passes through. */
  async check(
    task: TaskRef,
    source: UntrustedSource,
    text: string,
  ): Promise<{ kinds: InjectionKind[]; warning: WarningState }> {
    const kinds = findInjectionKinds(text);
    if (kinds.length === 0) return { kinds, warning: 'none' };
    return { kinds, warning: await this.warn(task, source, kinds) };
  }

  /** Posts the warning for these kinds unless its marker is already on the issue. */
  async warn(
    task: TaskRef,
    source: UntrustedSource,
    kinds: InjectionKind[],
  ): Promise<Exclude<WarningState, 'none'>> {
    const marker = injectionWarningMarker(source.key);
    let warning: Exclude<WarningState, 'none'> = 'already-there';
    if (!(await this.issues.findCommentByMarker(task, marker))) {
      await this.issues.postComment(
        task,
        injectionWarningComment(source, kinds),
      );
      warning = 'posted';
    }
    this.logger.log(
      `injection-warning ${task.externalRef} ${source.key}: ${kinds.join(', ')}; ${warning}`,
    );
    return warning;
  }
}

export function injectionWarningMarker(sourceKey: string): string {
  return `<!-- sdd-agent:injection-warning:${sourceKey} -->`;
}

/** Fixed text; the kinds are fixed identifiers; with a url the source label is a link. */
export function injectionWarningComment(
  source: UntrustedSource,
  kinds: InjectionKind[],
): string {
  const label = source.url ? `[${source.label}](${source.url})` : source.label;
  return (
    `${injectionWarningMarker(source.key)}\n` +
    `⚠️ **Read ${label} carefully before you \`/approve\` anything on this issue.** Part of it looks like ` +
    `instructions aimed at the bot (${kinds.map((kind) => `\`${kind}\``).join(', ')}). The bot treats that ` +
    'text as data, never as instructions, and keeps working. This check is a simple pattern list: it can be ' +
    'wrong, and a text without this warning is not proven safe.'
  );
}
