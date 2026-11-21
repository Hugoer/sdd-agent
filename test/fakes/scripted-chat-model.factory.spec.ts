import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '../../src/contracts/llm-error.js';
import { CONTEXT_TOOLS } from '../../src/llm/context-tools.js';
import {
  SCRIPTED_USAGE,
  ScriptedChatModelFactory,
} from './scripted-chat-model.factory.js';

const schema = z.object({ summary: z.string() });

describe('ScriptedChatModelFactory', () => {
  it('answers a request from the script and records the call: its messages, no tools, the format', async () => {
    const factory = new ScriptedChatModelFactory().replyJson({ summary: 'ok' });

    const raw = await factory
      .request('model-a', { schema })
      .invoke([new HumanMessage('hello')]);

    expect(AIMessage.isInstance(raw)).toBe(true);
    expect(raw.text).toBe('{"summary":"ok"}');
    expect(raw.tool_calls).toEqual([]);
    expect(raw.usage_metadata).toEqual(SCRIPTED_USAGE);
    expect(raw.response_metadata).toMatchObject({ finish_reason: 'STOP' });
    expect(factory.created).toEqual(['model-a']);
    expect(factory.calls).toEqual([
      {
        model: 'model-a',
        messages: [expect.any(HumanMessage) as HumanMessage],
        tools: [],
        schema: true,
      },
    ]);
    expect(factory.calls[0].messages.map((m) => m.text)).toEqual(['hello']);
    expect(factory.remaining).toBe(0);
  });

  it('spec 11: answers with tool calls and no text; records the tools offered', async () => {
    const factory = new ScriptedChatModelFactory().reply({
      toolCalls: [
        { name: 'load_skill', args: { name: 'money-rules', reason: 'r' } },
        { name: 'load_file', args: { path: 'src/AGENTS.md' }, id: 'own-id' },
      ],
    });

    const raw = await factory
      .request('model-a', { tools: CONTEXT_TOOLS, schema })
      .invoke([new HumanMessage('hi')]);

    expect(raw.text).toBe('');
    expect(raw.tool_calls).toEqual([
      {
        type: 'tool_call',
        name: 'load_skill',
        args: { name: 'money-rules', reason: 'r' },
        id: 'call-1',
      },
      {
        type: 'tool_call',
        name: 'load_file',
        args: { path: 'src/AGENTS.md' },
        id: 'own-id',
      },
    ]);
    expect(factory.calls[0]).toMatchObject({
      tools: ['load_skill', 'load_file'],
      schema: true,
    });
  });

  it('a request with tools and no format (text output)', async () => {
    const factory = new ScriptedChatModelFactory().reply({ answer: 'text' });

    await factory
      .request('model-a', { tools: CONTEXT_TOOLS })
      .invoke([new HumanMessage('hi')]);

    expect(factory.calls[0]).toMatchObject({
      tools: ['load_skill', 'load_file'],
      schema: false,
    });
  });

  it('gives a malformed answer as it is', async () => {
    const factory = new ScriptedChatModelFactory().reply({
      answer: 'not json',
    });

    const raw = await factory
      .request('model-a', { schema })
      .invoke([new HumanMessage('hi')]);

    expect(raw.text).toBe('not json');
  });

  it('answers in plain text without a schema, with no usage when told so', async () => {
    const factory = new ScriptedChatModelFactory().reply({
      answer: 'text',
      usage: null,
    });

    const answer = await factory.create('model-a').invoke('hi');

    expect(answer.text).toBe('text');
    expect(answer.usage_metadata).toBeUndefined();
    expect(factory.calls[0]).toMatchObject({ tools: [], schema: false });
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
