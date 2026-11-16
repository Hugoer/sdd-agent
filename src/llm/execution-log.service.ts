import { Injectable } from '@nestjs/common';
import type { UsageMetadata } from '@langchain/core/messages';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { LlmErrorCode } from '../contracts/llm-error.js';
import type { ResolvedModel, StepName } from '../contracts/step.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PromptSizes } from './prompt.js';

const MAX_ERROR_LENGTH = 2_000;

/** One model call attempt, as LlmService saw it (spec 4 "Owned table: ExecutionLog"). */
export interface ExecutionLogEntry {
  task: TaskRef;
  runId?: string;
  lane?: Lane;
  step: StepName;
  model: ResolvedModel;
  skillCommit: string;
  attempt: number;
  error?: { code: LlmErrorCode; message: string };
  /** The model call only. */
  durationMs: number;
  sizes: PromptSizes;
  answerChars?: number;
  injectionKinds: string[];
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

/** Writes ExecutionLog rows: insert only, one per attempt, success or failure (L11). */
@Injectable()
export class ExecutionLogService {
  constructor(private readonly prisma: PrismaService) {}

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
        answerChars: entry.answerChars ?? null,
        injectionKinds: entry.injectionKinds,
        cutSources: entry.cutSources,
        prompt: json(entry.prompt) ?? [],
        answer: json(entry.answer),
        providerUsage: json(usage),
        providerMeta: json(entry.providerMeta),
      },
      select: { id: true },
    });
    return id;
  }
}

/** A value as plain JSON for a jsonb column; undefined leaves the column empty. */
function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
