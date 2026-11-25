import { Injectable } from '@nestjs/common';
import type { UsageMetadata } from '@langchain/core/messages';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { LlmErrorCode } from '../contracts/llm-error.js';
import type { ResolvedModel, StepName } from '../contracts/step.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { PromptSizes } from './prompt.js';

const MAX_ERROR_LENGTH = 2_000;

/** One model request, as LlmService saw it (spec 4 "Owned table: ExecutionLog"; spec 11: one row per request). */
export interface ExecutionLogEntry {
  task: TaskRef;
  runId?: string;
  lane?: Lane;
  step: StepName;
  model: ResolvedModel;
  skillCommit: string;
  attempt: number;
  /** Spec 11: the `LlmService.call()` the request belongs to. */
  callId?: string;
  /** Spec 11 (SDW13): the request's number in its call, 1, 2, …; `attempt` when not given. */
  turn?: number;
  error?: { code: LlmErrorCode; message: string };
  /** The model call only. */
  durationMs: number;
  sizes: PromptSizes;
  answerChars?: number;
  injectionKinds: string[];
  /** Spec 12 (BDW11): the placeholder kinds of the request's untrusted blocks; empty = none. */
  secretKinds: string[];
  cutSources: string[];
  /** The messages as sent (LangChain StoredMessage[]). */
  prompt: unknown;
  /** The answer as received (a StoredMessage); absent when the call itself failed. */
  answer?: unknown;
  /** LangChain's usage_metadata; absent when the provider reported none. */
  usage?: UsageMetadata;
  /** LangChain's response_metadata, as received. */
  providerMeta?: unknown;
}

/**
 * Writes ExecutionLog rows: insert only, one per model request, success or failure (L11; spec 11). Spec 12 (plan
 * DP3): the stored prompt and answer pass `redactJson()`, so a key-shaped string the model wrote is not stored; the
 * step and the model get the messages as they were.
 */
@Injectable()
export class ExecutionLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: SecretScanner,
  ) {}

  /** Inserts the row and returns its id. Empty token columns mean "not reported", never zero. */
  async record(entry: ExecutionLogEntry): Promise<string> {
    const { usage } = entry;
    const { id } = await this.prisma.executionLog.create({
      data: {
        platform: entry.task.platform,
        taskId: entry.task.id,
        externalRef: entry.task.externalRef,
        runId: entry.runId ?? null,
        lane: entry.lane ?? null,
        step: entry.step,
        provider: entry.model.provider,
        model: entry.model.name,
        modelLevel: entry.model.level,
        skillCommit: entry.skillCommit,
        attempt: entry.attempt,
        callId: entry.callId ?? null,
        turn: entry.turn ?? entry.attempt,
        status: entry.error ? 'ERROR' : 'SUCCESS',
        errorCode: entry.error?.code ?? null,
        errorMessage: entry.error?.message.slice(0, MAX_ERROR_LENGTH) ?? null,
        durationMs: Math.round(entry.durationMs),
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cachedInputTokens: usage?.input_token_details?.cache_read ?? null,
        reasoningTokens: usage?.output_token_details?.reasoning ?? null,
        frameChars: entry.sizes.frame,
        skillChars: entry.sizes.skill,
        untrustedChars: entry.sizes.untrusted,
        otherChars: entry.sizes.other,
        agentsChars: entry.sizes.agents,
        listsChars: entry.sizes.lists,
        loadedChars: entry.sizes.loaded,
        answerChars: entry.answerChars ?? null,
        injectionKinds: entry.injectionKinds,
        secretKinds: entry.secretKinds,
        cutSources: entry.cutSources,
        prompt: json(this.redacted(entry.prompt)) ?? [],
        answer: json(this.redacted(entry.answer)),
        providerUsage: json(usage),
        providerMeta: json(entry.providerMeta),
      },
      select: { id: true },
    });
    return id;
  }

  /** A copy with every string redacted; undefined stays undefined (the column stays empty). */
  private redacted(value: unknown): unknown {
    return value === undefined
      ? undefined
      : this.scanner.redactJson(value).value;
  }
}

/** A value as plain JSON for a jsonb column; undefined leaves the column empty. */
function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
