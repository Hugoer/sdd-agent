import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';
import { ChatGoogle } from '@langchain/google/node';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { LlmError } from '../../contracts/llm-error.js';
import type { ChatModelFactory } from '../chat-model.factory.js';

const UNAVAILABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const KEY_INVALID_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED']);
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);
// Google's status names, reasons and finish reasons are enum words; anything else is never echoed.
const ENUM_WORD = /^[A-Z][A-Z0-9_]{0,63}$/;

/** What `@langchain/google` throws on an HTTP error (its `RequestError`, not exported by the package). */
interface GoogleHttpError {
  statusCode: number;
  headers?: Record<string, string>;
  data?: unknown;
}

/** The Google implementation of the provider seam (spec 4, L2): Gemini through `ChatGoogle` (AI Studio key). */
@Injectable()
export class GoogleChatModelFactory implements ChatModelFactory {
  readonly provider = 'google';
  private readonly apiKey: string;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('GOOGLE_API_KEY', { infer: true });
  }

  /** LW6: no `temperature`, `topP` or `topK`. LangChain's own retries are off: the worker retries. */
  create(model: string): BaseChatModel {
    return new ChatGoogle({ model, apiKey: this.apiKey, maxRetries: 0 });
  }

  /** The spec's error table ("LlmService.call()" → Errors). */
  toLlmError(error: unknown, model: string): LlmError {
    if (error instanceof LlmError) return error;
    const name = error instanceof Error ? error.name : typeof error;

    const http = asGoogleHttpError(error);
    if (http) return fromHttpError(http, model);

    if (name === 'PromptBlockedError') {
      const reason = enumWord((error as { blockReason?: unknown }).blockReason);
      return new LlmError(
        `Google blocked the prompt to model \`${model}\`${reason ? ` (${reason})` : ''}`,
        'permanent',
        'answer-blocked',
      );
    }
    if (name === 'NoCandidatesError') {
      // "No answer at all": a mismatch that LlmService re-asks, like an empty answer.
      return new LlmError(
        `Google returned no answer from model \`${model}\``,
        'permanent',
        'invalid-answer',
      );
    }
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new LlmError(
        `Google gave no answer from model \`${model}\` in time`,
        'transient',
        'provider-unavailable',
      );
    }
    if (isNetworkFailure(error)) {
      return new LlmError(
        `Google could not be reached for model \`${model}\` (no response)`,
        'transient',
        'provider-unavailable',
      );
    }
    // Not in the table (e.g. a schema the package can't convert): only the error's class name is safe to show.
    return new LlmError(
      `The call to Google model \`${model}\` failed before an answer (${name})`,
      'permanent',
      'bad-request',
    );
  }

  /** Plan P3: Google's finish reasons on an answer that came back. */
  checkAnswer(answer: AIMessage, model: string): LlmError | null {
    const reason = enumWord(
      (answer.response_metadata as { finish_reason?: unknown } | undefined)
        ?.finish_reason,
    );
    if (reason === 'MAX_TOKENS') {
      return new LlmError(
        `The answer of model \`${model}\` was cut at its output limit (finish reason MAX_TOKENS)`,
        'permanent',
        'answer-cut',
      );
    }
    if (reason && BLOCKED_FINISH_REASONS.has(reason)) {
      return new LlmError(
        `Google blocked the answer of model \`${model}\` (finish reason ${reason})`,
        'permanent',
        'answer-blocked',
      );
    }
    return null;
  }
}

function fromHttpError(http: GoogleHttpError, model: string): LlmError {
  const status = http.statusCode;
  const { googleStatus, reasons, retryDelay } = readGoogleBody(http.data);
  const what = [`HTTP ${status}`, googleStatus, ...reasons]
    .filter(Boolean)
    .join(', ');

  if (
    status === 401 ||
    reasons.some((reason) => KEY_INVALID_REASONS.has(reason))
  ) {
    return new LlmError(
      `Google refused the API key (${what}): check GOOGLE_API_KEY`,
      'permanent',
      'bad-api-key',
    );
  }
  if (status === 429) {
    const retryAfterSeconds = retryAfterHeader(http.headers) ?? retryDelay;
    return new LlmError(
      `Google's rate limit was reached for model \`${model}\` (${what})`,
      'transient',
      'rate-limited',
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    );
  }
  if (UNAVAILABLE_STATUSES.has(status)) {
    return new LlmError(
      `Google is unavailable for model \`${model}\` (${what})`,
      'transient',
      'provider-unavailable',
    );
  }
  if (status === 403) {
    return new LlmError(
      `Google refused this key for this call (${what}): check the key's permissions and the project's billing`,
      'permanent',
      'access-denied',
    );
  }
  if (status === 402) {
    return new LlmError(
      `The Google account's credits are used up (${what})`,
      'permanent',
      'credits-exhausted',
    );
  }
  if (status === 404) {
    return new LlmError(
      `Google has no model \`${model}\` (${what}): check the models in .github-agent/workflow.json`,
      'permanent',
      'unknown-model',
    );
  }
  return new LlmError(
    `Google rejected the call to model \`${model}\` (${what})`,
    'permanent',
    'bad-request',
  );
}

function asGoogleHttpError(error: unknown): GoogleHttpError | null {
  if (!(error instanceof Error) || error.name !== 'RequestError') return null;
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === 'number'
    ? (error as unknown as GoogleHttpError)
    : null;
}

/** Google's error body: `{ error: { status, details: [{ '@type', reason?, retryDelay? }] } }`. */
function readGoogleBody(data: unknown): {
  googleStatus: string | undefined;
  reasons: string[];
  retryDelay: number | undefined;
} {
  const body = (data as { error?: { status?: unknown; details?: unknown } })
    ?.error;
  const details = Array.isArray(body?.details)
    ? (body.details as Record<string, unknown>[])
    : [];
  const reasons = details
    .map((detail) => enumWord(detail?.reason))
    .filter((reason): reason is string => reason !== undefined);
  const retryInfo = details.find((detail) =>
    String(detail?.['@type']).endsWith('google.rpc.RetryInfo'),
  );
  return {
    googleStatus: enumWord(body?.status),
    reasons,
    retryDelay: durationSeconds(retryInfo?.retryDelay),
  };
}

function retryAfterHeader(
  headers: Record<string, string> | undefined,
): number | undefined {
  const seconds = Number(headers?.['retry-after']);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : undefined;
}

/** A protobuf Duration in JSON, e.g. "13s" or "0.5s". */
function durationSeconds(value: unknown): number | undefined {
  const match =
    typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  const seconds = match ? Math.ceil(Number(match[1])) : 0;
  return seconds > 0 ? seconds : undefined;
}

/** Node's fetch reports every network failure (DNS, refused, reset) as `TypeError: fetch failed`. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}

function enumWord(value: unknown): string | undefined {
  return typeof value === 'string' && ENUM_WORD.test(value) ? value : undefined;
}
