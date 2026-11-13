import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '../../src/contracts/llm-error.js';
import {
  SCRIPTED_USAGE,
  ScriptedChatModelFactory,
} from './scripted-chat-model.factory.js';

const schema = z.object({ summary: z.string() });

function structured(factory: ScriptedChatModelFactory) {
  return factory
    .create('model-a')
    .withStructuredOutput(schema, { method: 'jsonSchema', includeRaw: true });
}

describe('ScriptedChatModelFactory', () => {
  it('answers from the script and records the call', async () => {
    const factory = new ScriptedChatModelFactory().replyJson({ summary: 'ok' });

    const { raw, parsed } = await structured(factory).invoke([
      new HumanMessage('hello'),
    ]);

    expect(parsed).toEqual({ summary: 'ok' });
    expect(raw.text).toBe('{"summary":"ok"}');
    expect((raw as AIMessage).usage_metadata).toEqual(SCRIPTED_USAGE);
    expect(raw.response_metadata).toMatchObject({ finish_reason: 'STOP' });
    expect(factory.created).toEqual(['model-a']);
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0].model).toBe('model-a');
    expect(factory.calls[0].messages.map((m) => m.text)).toEqual(['hello']);
    expect(factory.calls[0].structured).toEqual({
      method: 'jsonSchema',
      includeRaw: true,
    });
    expect(factory.remaining).toBe(0);
  });

  it('gives a malformed answer as it is, with nothing parsed', async () => {
    const factory = new ScriptedChatModelFactory().reply({
      answer: 'not json',
    });

    const { raw, parsed } = await structured(factory).invoke('hi');

    expect(raw.text).toBe('not json');
    expect(parsed).toBeNull();
  });

  it('answers in plain text without a schema, with no usage when told so', async () => {
    const factory = new ScriptedChatModelFactory().reply({
      answer: 'text',
      usage: null,
    });

    const answer = await factory.create('model-a').invoke('hi');

    expect(answer.text).toBe('text');
    expect(answer.usage_metadata).toBeUndefined();
    expect(factory.calls[0].structured).toBeUndefined();
  });

  it('throws a scripted error from the call', async () => {
    const error = new LlmError('down', 'transient', 'provider-unavailable');
    const factory = new ScriptedChatModelFactory().reply({ error });

    await expect(factory.create('model-a').invoke('hi')).rejects.toBe(error);
  });

  it('throws when called with no scripted reply left', async () => {
    const factory = new ScriptedChatModelFactory();

    await expect(factory.create('model-a').invoke('hi')).rejects.toThrow(
      'no scripted reply left',
    );
    expect(factory.calls).toHaveLength(1);
  });

  it('maps finish reasons and foreign errors like a provider', () => {
    const factory = new ScriptedChatModelFactory();
    const cut = new AIMessage({
      content: 'x',
      response_metadata: { finish_reason: 'MAX_TOKENS' },
    });

    expect(factory.checkAnswer(cut, 'm')?.code).toBe('answer-cut');
    expect(factory.checkAnswer(new AIMessage('x'), 'm')).toBeNull();
    expect(factory.toLlmError(new TypeError('boom'), 'm').code).toBe(
      'bad-request',
    );
  });
});
