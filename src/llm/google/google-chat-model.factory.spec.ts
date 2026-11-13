import { AIMessage } from '@langchain/core/messages';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.schema.js';
import { LlmError } from '../../contracts/llm-error.js';
import { GoogleChatModelFactory } from './google-chat-model.factory.js';

// Built at run time and not key-shaped: no real key is ever written into the repo.
const KEY = ['test', 'google', 'key', 'value'].join('-');
const MODEL = 'gemini-test-model';
const PROMPT = 'the prompt text that must never leak';
const ANSWER = 'the answer text that must never leak';
const HEADER_VALUE = 'header-value-that-must-never-leak';

const factory = new GoogleChatModelFactory(
  new ConfigService<Env, true>({ GOOGLE_API_KEY: KEY }),
);

type FetchStub = (request: Request) => Promise<Response>;
let fetchStub: ReturnType<typeof vi.fn<FetchStub>>;

beforeEach(() => {
  fetchStub = vi.fn<FetchStub>();
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => vi.unstubAllGlobals());

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Google's error body; the message repeats what was sent, as Google's messages sometimes do. */
function googleError(
  code: number,
  status: string,
  details: Record<string, unknown>[] = [],
): unknown {
  return {
    error: {
      code,
      message: `rejected: ${PROMPT} ${KEY}`,
      status,
      details,
    },
  };
}

function answer(finishReason: string, text = ANSWER): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 },
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      totalTokenCount: 7,
    },
    modelVersion: MODEL,
  };
}

async function invoke(options?: { timeout?: number }): Promise<AIMessage> {
  return factory.create(MODEL).invoke(PROMPT, options);
}

/** Calls the real ChatGoogle against the stubbed fetch and maps what it throws. */
async function mappedError(options?: { timeout?: number }): Promise<LlmError> {
  try {
    await invoke(options);
  } catch (error) {
    return factory.toLlmError(error, MODEL);
  }
  throw new Error('expected the call to fail');
}

function expectSafe(error: LlmError): void {
  for (const value of [KEY, PROMPT, ANSWER, HEADER_VALUE]) {
    expect(error.message).not.toContain(value);
  }
}

describe('GoogleChatModelFactory.create', () => {
  it('sends the model name and the key, and no sampling option', async () => {
    fetchStub.mockResolvedValue(json(200, answer('STOP')));

    const message = await invoke();

    expect(message.content).toBe(ANSWER);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const request = fetchStub.mock.calls[0][0];
    expect(request.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    );
    expect(request.headers.get('x-goog-api-key')).toBe(KEY);
    const body = (await request.json()) as {
      generationConfig?: Record<string, unknown>;
    };
    for (const option of ['temperature', 'topP', 'topK']) {
      expect(body.generationConfig ?? {}).not.toHaveProperty(option);
    }
  });

  it('makes no retry of its own (maxRetries 0)', async () => {
    fetchStub.mockResolvedValue(json(503, googleError(503, 'UNAVAILABLE')));

    const error = await mappedError();

    expect(error.code).toBe('provider-unavailable');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('names its provider', () => {
    expect(factory.provider).toBe('google');
  });
});

describe('GoogleChatModelFactory.toLlmError', () => {
  it.each([
    [401, 'UNAUTHENTICATED', 'bad-api-key', 'permanent'],
    [403, 'PERMISSION_DENIED', 'access-denied', 'permanent'],
    [402, 'FAILED_PRECONDITION', 'credits-exhausted', 'permanent'],
    [404, 'NOT_FOUND', 'unknown-model', 'permanent'],
    [408, 'DEADLINE_EXCEEDED', 'provider-unavailable', 'transient'],
    [500, 'INTERNAL', 'provider-unavailable', 'transient'],
    [502, 'UNAVAILABLE', 'provider-unavailable', 'transient'],
    [503, 'UNAVAILABLE', 'provider-unavailable', 'transient'],
    [504, 'DEADLINE_EXCEEDED', 'provider-unavailable', 'transient'],
    [400, 'INVALID_ARGUMENT', 'bad-request', 'permanent'],
    [413, 'INVALID_ARGUMENT', 'bad-request', 'permanent'],
    [422, 'INVALID_ARGUMENT', 'bad-request', 'permanent'],
  ])('HTTP %i (%s) → %s, %s', async (status, googleStatus, code, kind) => {
    fetchStub.mockResolvedValue(
      json(status, googleError(status, googleStatus), {
        'x-secret-header': HEADER_VALUE,
      }),
    );

    const error = await mappedError();

    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe(code);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(`HTTP ${status}`);
    expectSafe(error);
  });

  it('a key-invalid reason on a 400 → bad-api-key, pointing at GOOGLE_API_KEY', async () => {
    fetchStub.mockResolvedValue(
      json(
        400,
        googleError(400, 'INVALID_ARGUMENT', [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
          },
        ]),
      ),
    );

    const error = await mappedError();

    expect(error.code).toBe('bad-api-key');
    expect(error.kind).toBe('permanent');
    expect(error.message).toContain('check GOOGLE_API_KEY');
    expect(error.message).toContain('API_KEY_INVALID');
    expectSafe(error);
  });

  it('a 404 names the model', async () => {
    fetchStub.mockResolvedValue(json(404, googleError(404, 'NOT_FOUND')));

    expect((await mappedError()).message).toContain(`\`${MODEL}\``);
  });

  describe('429', () => {
    const retryInfo = (retryDelay: string) => ({
      '@type': 'type.googleapis.com/google.rpc.RetryInfo',
      retryDelay,
    });

    it('takes the delay from the retry-after header', async () => {
      fetchStub.mockResolvedValue(
        json(429, googleError(429, 'RESOURCE_EXHAUSTED', [retryInfo('50s')]), {
          'retry-after': '7',
        }),
      );

      const error = await mappedError();

      expect(error.code).toBe('rate-limited');
      expect(error.kind).toBe('transient');
      expect(error.detail.retryAfterSeconds).toBe(7);
    });

    it.each([
      ['13s', 13],
      ['0.4s', 1],
      ['2.5s', 3],
    ])('takes the delay from RetryInfo (%s → %i s)', async (delay, seconds) => {
      fetchStub.mockResolvedValue(
        json(429, googleError(429, 'RESOURCE_EXHAUSTED', [retryInfo(delay)])),
      );

      expect((await mappedError()).detail.retryAfterSeconds).toBe(seconds);
    });

    it('has no delay when Google gives none', async () => {
      fetchStub.mockResolvedValue(
        json(429, googleError(429, 'RESOURCE_EXHAUSTED')),
      );

      const error = await mappedError();

      expect(error.code).toBe('rate-limited');
      expect(error.detail).toEqual({});
    });
  });

  it('a blocked prompt → answer-blocked with the block reason', async () => {
    fetchStub.mockResolvedValue(
      json(200, { promptFeedback: { blockReason: 'SAFETY' } }),
    );

    const error = await mappedError();

    expect(error.code).toBe('answer-blocked');
    expect(error.kind).toBe('permanent');
    expect(error.message).toContain('SAFETY');
  });

  it('no answer at all → invalid-answer (a mismatch LlmService re-asks)', async () => {
    fetchStub.mockResolvedValue(json(200, { candidates: [] }));

    const error = await mappedError();

    expect(error.code).toBe('invalid-answer');
    expect(error.kind).toBe('permanent');
  });

  it('no response → provider-unavailable', async () => {
    fetchStub.mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    );

    const error = await mappedError();

    expect(error.code).toBe('provider-unavailable');
    expect(error.kind).toBe('transient');
  });

  it('the call timeout → provider-unavailable', async () => {
    fetchStub.mockImplementation(
      (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(request.signal.reason as Error),
          ),
        ),
    );

    const error = await mappedError({ timeout: 20 });

    expect(error.code).toBe('provider-unavailable');
    expect(error.kind).toBe('transient');
  });

  it('an error outside the table → permanent bad-request naming only its class', () => {
    const error = factory.toLlmError(
      new RangeError(`bad schema near ${PROMPT}`),
      MODEL,
    );

    expect(error.code).toBe('bad-request');
    expect(error.kind).toBe('permanent');
    expect(error.message).toContain('RangeError');
    expectSafe(error);
  });

  it('never echoes a Google status or reason that is not an enum word', () => {
    const http = Object.assign(new Error('x'), {
      name: 'RequestError',
      statusCode: 400,
      data: {
        error: { status: `<${PROMPT}>`, details: [{ reason: ANSWER }] },
      },
    });

    const error = factory.toLlmError(http, MODEL);

    expect(error.message).toBe(
      `Google rejected the call to model \`${MODEL}\` (HTTP 400)`,
    );
  });

  it('passes an LlmError through', () => {
    const original = new LlmError('x', 'transient', 'rate-limited');
    expect(factory.toLlmError(original, MODEL)).toBe(original);
  });
});

describe('GoogleChatModelFactory.checkAnswer', () => {
  async function checked(finishReason: string): Promise<LlmError | null> {
    fetchStub.mockResolvedValue(json(200, answer(finishReason)));
    return factory.checkAnswer(await invoke(), MODEL);
  }

  it.each(['STOP', 'OTHER'])('finish reason %s → usable', async (reason) => {
    expect(await checked(reason)).toBeNull();
  });

  it('finish reason MAX_TOKENS → answer-cut', async () => {
    const error = await checked('MAX_TOKENS');

    expect(error?.code).toBe('answer-cut');
    expect(error?.kind).toBe('permanent');
    expectSafe(error!);
  });

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])(
    'finish reason %s → answer-blocked',
    async (reason) => {
      const error = await checked(reason);

      expect(error?.code).toBe('answer-blocked');
      expect(error?.kind).toBe('permanent');
      expect(error?.message).toContain(reason);
      expectSafe(error!);
    },
  );

  it('an answer without metadata → usable', () => {
    expect(factory.checkAnswer(new AIMessage('hi'), MODEL)).toBeNull();
  });
});
