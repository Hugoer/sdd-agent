import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod';
import { LlmError } from '../contracts/llm-error.js';
import type { StepName } from '../contracts/step.js';
import { modelLabel } from '../github/labels.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from './chat-model.factory.js';
import { ContextLoadService } from './context-load.service.js';
import { ContextLoaderService } from './context-loader.service.js';
import { LOAD_SKILL, requestOf, stepSkillFile } from './context-tools.js';
import { ExecutionLogService } from './execution-log.service.js';
import { findInjectionKinds } from './injection-patterns.js';
import { InjectionWarningService } from './injection-warning.service.js';
import type { LlmCall, LlmResult } from './llm-call.js';
import {
  answerChars,
  buildPrompt,
  notesFor,
  totalChars,
  type PromptMessage,
  type PromptSizes,
} from './prompt.js';

/** Spec 11 (SDW17): a file the call loaded: its `context_loads` row, counted at the end of the call. */
interface CountedFile {
  rowId: string;
  path: string;
  text: string;
}

/** Spec 4 LlmService.call() step 3 (plan P2): the model call's own limit; LangChain's retries are off. */
export const CALL_TIMEOUT_MS = 300_000;
/** The first ask and at most 2 re-asks (step 6). */
export const MAX_ATTEMPTS = 3;

/** What one model request gave: a valid output, (spec 11) files to load, or an error and whether it was a mismatch. */
type Attempt<T> =
  | { ok: true; output: T; raw: AIMessage; durationMs: number }
  /** Spec 11: the answer to a request that offered the tools asks for files (a load turn). */
  | { ok: true; loads: ToolCall[]; raw: AIMessage; durationMs: number }
  | {
      ok: false;
      error: LlmError;
      /** The format problem, told to the model in the re-ask; absent for any other error. */
      mismatch?: string;
      /** Spec 7: the answer's length, when it was text longer than the call's maximum. */
      tooLong?: { chars: number; maxChars: number };
      raw?: AIMessage;
      durationMs: number;
    };

/**
 * Spec 4 "LlmService.call()" (L10, LW6, LW9) with spec 11's load turns (SDW12, SDW13): guard → warnings → prompt
 * → model → one ExecutionLog row per request → files loaded on demand → re-ask on a mismatch. Every failure is an
 * LlmError, or a ProviderError from posting a warning or (spec 11, plan P21) from reading a file on demand.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(CHAT_MODEL_FACTORY) private readonly factory: ChatModelFactory,
    private readonly warnings: InjectionWarningService,
    private readonly logs: ExecutionLogService,
    private readonly loads: ContextLoadService,
    private readonly loader: ContextLoaderService,
  ) {}

  async call<T>(input: LlmCall<T>): Promise<LlmResult<T>> {
    const { context, setup } = input;
    // Spec 11 (SDW13): every request of this call is a row with this id and its turn number.
    const callId = randomUUID();
    // Spec 11 (SDW7): the two tools when something can be loaded; only then the lists and "Loading:". Spec 7: all
    // four when the call reads repo files.
    const repoFiles = input.repoFiles === true;
    const tools = this.loader.tools(setup, repoFiles);
    // 1–2. Guard every untrusted block and build the messages; warnings are posted before the model is called.
    const prompt = buildPrompt(
      input.frame,
      {
        skill: setup.skill,
        repo: setup.repo,
        loading: tools.length > 0 ? this.loader.limits : undefined,
        repoFiles,
      },
      input.turns,
    );
    for (const { source, kinds } of prompt.injections) {
      await this.warnings.warn(context.task, source, kinds);
    }
    const injectionKinds = [
      ...new Set(prompt.injections.flatMap(({ kinds }) => kinds)),
    ];
    const cutSources = prompt.cuts.map(({ source }) => source.key);
    /** SDW17: every file the call loaded (its row, path and text), counted at the end. */
    const toCount = await this.recordStartFiles(input, callId);

    const budget = this.loader.budget(setup);
    /** SD7: the names of the `load_skill` requests that ended `not-found`. */
    const lookedFor: string[] = [];
    /** The tools the next request offers: none once a request was refused for a limit, and none on a re-ask. */
    let offered = tools.length > 0 ? tools : undefined;
    // Kept as LangChain messages: a load turn's message goes back as received (Risk 2).
    const messages: BaseMessage[] = toMessages(prompt.messages);
    const sizes: PromptSizes = { ...prompt.sizes };
    /** Messages already stored on an earlier row: a later turn stores only the ones added since (L18, SDW9). */
    let stored = 0;
    /** Spec 7: the re-asks so far that asked for a shorter answer (plan P2's stop message counts them). */
    let shortenRequests = 0;
    for (let attempt = 1, turn = 1; ; turn++) {
      const sent = [...messages];
      const asked = await this.ask(
        setup.model.name,
        input.output,
        sent,
        offered,
      );
      // Plan P2: the last too-long answer stops the run with a message for people, on its row too.
      const result =
        !asked.ok && asked.tooLong && attempt === MAX_ATTEMPTS
          ? {
              ...asked,
              error: tooLongError(
                setup.model.name,
                asked.tooLong,
                shortenRequests,
                context.step,
              ),
            }
          : asked;
      const raw = result.raw;
      const logId = await this.logs.record({
        task: context.task,
        runId: context.runId,
        lane: context.lane,
        step: context.step,
        model: setup.model,
        skillCommit: setup.commit,
        attempt,
        callId,
        turn,
        error: result.ok
          ? undefined
          : { code: result.error.code, message: result.error.message },
        durationMs: result.durationMs,
        sizes: { ...sizes },
        answerChars: raw ? answerChars(raw) : undefined,
        injectionKinds,
        cutSources,
        prompt: mapChatMessagesToStoredMessages(sent.slice(stored)),
        answer: raw ? mapChatMessagesToStoredMessages([raw])[0] : undefined,
        usage: raw?.usage_metadata,
        providerMeta: raw?.response_metadata,
      });
      stored = sent.length;
      // SD5: the files this request carried first (the start files on turn 1, the previous turn's loads) get
      // their estimate from its input tokens per character sent; none when it reported no input tokens.
      const inputTokens = raw?.usage_metadata?.input_tokens;
      const sentChars = totalChars(sizes);
      if (inputTokens && sentChars > 0)
        await this.loads.setEstimates(
          callId,
          turn - 1,
          inputTokens / sentChars,
        );
      this.logger.log(
        `llm ${context.step} ${context.task.externalRef} ${setup.model.name} (${setup.model.level}) turn ${turn} ` +
          `attempt ${attempt}: ${result.ok ? 'SUCCESS' : `ERROR ${result.error.code}`}` +
          `${result.ok && 'loads' in result ? ` (${result.loads.length} to load)` : ''} in ${Math.round(result.durationMs)} ms`,
      );
      if (result.ok && 'loads' in result) {
        // 5. Each request in order (one context_loads row each), then the model's message as received and one
        // tool message per request; the model's text next to the calls is ignored.
        messages.push(result.raw);
        sizes.other += answerChars(result.raw);
        for (const call of result.loads) {
          const request = requestOf(call);
          const { answer, outcome, loaded } = await this.loader.load(
            {
              task: context.task,
              runId: context.runId,
              step: context.step,
              callId,
              turn,
              setup,
              repoFiles: repoFiles ? { tag: prompt.tag } : undefined,
            },
            request,
            budget,
          );
          if (outcome === 'not-found' && request.tool === LOAD_SKILL)
            lookedFor.push(request.name ?? '');
          if (loaded) toCount.push(loaded);
          messages.push(
            new ToolMessage({
              content: answer,
              tool_call_id: call.id ?? '',
              name: call.name,
            }),
          );
          sizes.loaded += answer.length;
        }
        if (budget.limitHit !== null) offered = undefined;
        continue;
      }
      if (result.ok) {
        await this.countTokens(setup, toCount);
        const notes = notesFor(setup.model, prompt.cuts, {
          skill: setup.skill,
          repo: setup.repo,
          budget,
          limits: this.loader.limits,
          lookedFor,
        });
        return { output: result.output, model: setup.model, notes, logId };
      }
      // SD10: after a Google error nothing is counted; after invalid-answer the model did answer, so it is.
      if (result.mismatch === undefined) throw result.error;
      if (attempt === MAX_ATTEMPTS) {
        await this.countTokens(setup, toCount);
        throw result.error;
      }
      // 6. Re-ask, without tools (SDW12): the model's answer and the format problem, as two more turns. With no
      // answer at all there is nothing to repeat, so only the message is added (an empty turn can be refused).
      attempt++;
      offered = undefined;
      if (result.tooLong) shortenRequests++;
      const answer = raw?.text ?? '';
      const reask =
        `Your answer did not match the required format: ${result.mismatch}. ` +
        'Answer again with only the corrected output.';
      if (answer !== '') messages.push(new AIMessage(answer));
      messages.push(new HumanMessage(reask));
      sizes.other += answer.length + reask.length;
    }
  }

  /**
   * Spec 11 step 2: one `context_loads` row per file given at start, the step's SKILL.md and the root AGENTS.md
   * (trigger `start`, turn 0, `loaded`). A root AGENTS.md that matches an injection pattern still loads (trusted,
   * base branch): one log line with its kinds, never its text, and the kinds on its row (SDW8, GM13). Gives the
   * rows to count at the end.
   */
  private async recordStartFiles<T>(
    { context, setup }: LlmCall<T>,
    callId: string,
  ): Promise<CountedFile[]> {
    const { skill, repo } = setup;
    const files = [
      {
        kind: 'step-skill' as const,
        skill: skill.step,
        path: stepSkillFile(skill),
        text: skill.instructions,
      },
      ...(repo.rootAgents
        ? [
            {
              kind: 'agents' as const,
              path: 'AGENTS.md',
              text: repo.rootAgents.text,
            },
          ]
        : []),
    ];
    const rows: CountedFile[] = [];
    for (const file of files) {
      const injectionKinds = findInjectionKinds(file.text);
      if (file.kind === 'agents' && injectionKinds.length > 0)
        this.logger.warn(
          `context ${context.step} @${setup.commit.slice(0, 7)}: AGENTS.md matches an injection pattern ` +
            `(${injectionKinds.join(', ')}); loaded anyway, the repository's instructions on the base branch are trusted`,
        );
      const rowId = await this.loads.insert({
        task: context.task,
        runId: context.runId,
        step: context.step,
        callId,
        turn: 0,
        trigger: 'start',
        kind: file.kind,
        skill: 'skill' in file ? file.skill : undefined,
        path: file.path,
        commit: setup.commit,
        model: setup.model.name,
        outcome: 'loaded',
        bytes: Buffer.byteLength(file.text),
        chars: file.text.length,
        injectionKinds,
      });
      rows.push({ rowId, path: file.path, text: file.text });
    }
    return rows;
  }

  /**
   * SDW17 (step 7): each loaded file of the call gets the provider's count, in parallel: a count stored for the
   * same path, commit and model is reused, else `countTokens` is asked (10 s, in the adapter). A failure leaves the
   * row empty; nothing here changes the call's output or error. One log line per file, never its text.
   */
  private async countTokens(
    setup: LlmCall<unknown>['setup'],
    files: CountedFile[],
  ): Promise<void> {
    const model = setup.model.name;
    await Promise.all(
      files.map(async ({ rowId, path, text }) => {
        let outcome: string;
        try {
          const known = await this.loads.knownTokens(path, setup.commit, model);
          const tokens = known ?? (await this.factory.countTokens(model, text));
          if (tokens === null) {
            outcome = 'count failed (no count from the provider)';
          } else {
            await this.loads.setTokens(rowId, tokens);
            outcome = `${tokens.toLocaleString('en-US')} (${known === null ? 'counted' : 'known'})`;
          }
        } catch (error) {
          outcome = `count failed (${error instanceof Error ? error.name : typeof error})`;
        }
        this.logger.log(
          `context tokens ${path} @${setup.commit.slice(0, 7)} ${model}: ${outcome}`,
        );
      }),
    );
  }

  /**
   * Steps 3–4 for one request: the model call (300 s, no hidden retry) through the provider seam (spec 11, plan
   * P7: the format as a request option), the provider's checks, the judge on the raw text.
   */
  private async ask<T>(
    modelName: string,
    output: LlmCall<T>['output'],
    messages: BaseMessage[],
    tools: StructuredToolInterface[] | undefined,
  ): Promise<Attempt<T>> {
    const started = performance.now();
    let raw: unknown;
    try {
      raw = await this.factory
        .request(modelName, {
          tools,
          schema: isSchema(output) ? output : undefined,
        })
        .invoke(messages, { timeout: CALL_TIMEOUT_MS });
    } catch (error) {
      const durationMs = performance.now() - started;
      const failed = this.toLlmError(error, modelName);
      return failed.code === 'invalid-answer'
        ? {
            ok: false,
            error: failed,
            mismatch: 'there was no answer',
            durationMs,
          }
        : { ok: false, error: failed, durationMs };
    }
    const durationMs = performance.now() - started;
    if (!AIMessage.isInstance(raw)) {
      return mismatch(modelName, 'there was no answer', durationMs);
    }
    const refused = this.factory.checkAnswer(raw, modelName);
    if (refused) return { ok: false, error: refused, raw, durationMs };
    // Spec 11: tool calls answer a request only when it offered the tools; otherwise the text is judged.
    if (tools && raw.tool_calls?.length)
      return { ok: true, loads: raw.tool_calls, raw, durationMs };

    const judged = judge(raw.text, output);
    return judged.ok
      ? { ok: true, output: judged.output, raw, durationMs }
      : {
          ...mismatch(modelName, judged.problem, durationMs),
          raw,
          tooLong: judged.tooLong,
        };
  }

  /** Plan P2: a timeout is `provider-unavailable` here, for every provider; anything else is the factory's. */
  private toLlmError(error: unknown, model: string): LlmError {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      return new LlmError(
        `${this.factory.provider} gave no answer from model \`${model}\` within ${CALL_TIMEOUT_MS / 1000} s`,
        'transient',
        'provider-unavailable',
      );
    }
    return this.factory.toLlmError(error, model);
  }
}

/**
 * Step 4: Zod judges a schema answer; a text answer must not be empty, nor (spec 7) longer than its maximum. Never
 * quotes the answer.
 */
function judge<T>(
  text: string,
  output: LlmCall<T>['output'],
):
  | { ok: true; output: T }
  | {
      ok: false;
      problem: string;
      tooLong?: { chars: number; maxChars: number };
    } {
  if (!isSchema(output)) {
    if (text.trim() === '')
      return { ok: false, problem: 'the answer is empty' };
    const maxChars = output === 'text' ? Infinity : output.text.maxChars;
    if (text.length > maxChars) {
      return {
        ok: false,
        problem: `your answer has ${count(text.length)} characters; at most ${count(maxChars)} fit: shorten it`,
        tooLong: { chars: text.length, maxChars },
      };
    }
    return { ok: true, output: text as T };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problem:
        text.trim() === '' ? 'the answer is empty' : 'the answer is not JSON',
    };
  }
  const result = output.safeParse(value);
  if (result.success) return { ok: true, output: result.data };
  return {
    ok: false,
    problem: result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  };
}

function isSchema<T>(output: LlmCall<T>['output']): output is z.ZodType<T> {
  return output !== 'text' && 'safeParse' in output;
}

/**
 * Plan P2: the stop after the last too-long answer speaks to people: how long, the limit, the re-asks that asked
 * for less, and the step's `model: max-*` label. No final period: the stop comment adds one before the cause.
 */
function tooLongError(
  model: string,
  { chars, maxChars }: { chars: number; maxChars: number },
  shortenRequests: number,
  step: StepName,
): LlmError {
  const after =
    shortenRequests === 0
      ? ''
      : `, also after ${shortenRequests} request${shortenRequests === 1 ? '' : 's'} to shorten it`;
  return new LlmError(
    `model \`${model}\` answered with ${count(chars)} characters, more than the ${count(maxChars)} a document may ` +
      `have${after}. Adding \`${modelLabel(step)}\` before \`/retry\` may help`,
    'permanent',
    'invalid-answer',
  );
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function mismatch(
  model: string,
  problem: string,
  durationMs: number,
): Extract<Attempt<never>, { ok: false }> {
  return {
    ok: false,
    error: new LlmError(
      `model \`${model}\` gave no valid answer: ${problem}`,
      'permanent',
      'invalid-answer',
    ),
    mismatch: problem,
    durationMs,
  };
}

function toMessages(messages: PromptMessage[]): BaseMessage[] {
  return messages.map(({ role, content }) =>
    role === 'system'
      ? new SystemMessage(content)
      : role === 'user'
        ? new HumanMessage(content)
        : new AIMessage(content),
  );
}
