// Spec 6 "One evaluation": prepare → ask the model → act. The act is one transaction (Tx1); a question comment is
// posted afterwards from its stored row (the handler), so a retry posts the same text once.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type {
  GrillAnswer,
  GrillRound,
  GrillSession,
} from '../generated/prisma/client.js';
import type { LlmResult } from '../llm/llm-call.js';
import { LlmService } from '../llm/llm.service.js';
import { StepConfigService } from '../llm/step-config.service.js';
import type { StepContext } from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { AnswerReader } from './answer-reader.service.js';
import { cleanModelText, roundComment } from './grill-comments.js';
import { grillFrame } from './grill-frame.js';
import { grillOutputSchema, type GrillOutput } from './grill-output.js';
import { grillTurns } from './grill-prompt.js';
import {
  GrillStore,
  type AnswerRecord,
  type EvaluationRecord,
  type RoundQuestion,
} from './grill.store.js';

/** What an evaluation did (spec "One evaluation", step 5). Posting, the 👀 and the stop body are the caller's. */
export type Evaluated = 'ASKED' | 'CLEAR' | 'WAITING' | 'LIMIT';

@Injectable()
export class GrillEvaluationService {
  private readonly logger = new Logger(GrillEvaluationService.name);
  private readonly k: number;
  private readonly threshold: number;
  private readonly maxRounds: number;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly stepConfig: StepConfigService,
    private readonly llm: LlmService,
    private readonly store: GrillStore,
    private readonly reader: AnswerReader,
    config: ConfigService<Env, true>,
  ) {
    this.k = config.get('GRILL_MAX_QUESTIONS_PER_ROUND', { infer: true });
    this.threshold = config.get('GRILL_CONFIDENCE_THRESHOLD', { infer: true });
    this.maxRounds = config.get('GRILL_MAX_ROUNDS', { infer: true });
  }

  /**
   * Steps 2–5 for the session and the answers it hasn't read yet. Step 4 (GM4): comments that arrived while the
   * model thought make the result SUPERSEDED (its own small transaction) and the model is asked again with them, so
   * every repetition needs a new comment.
   */
  async evaluate(
    context: StepContext,
    session: GrillSession,
    unread: AnswerRecord[],
  ): Promise<Evaluated> {
    const [rounds, answers, previous] = await Promise.all([
      this.store.rounds(session.id),
      this.store.answers(session.id),
      this.store.latestActingEvaluation(session.id),
    ]);
    let reading = unread;
    for (;;) {
      const result = await this.ask(context, session, {
        rounds,
        answers,
        unread: reading,
        first: previous === null,
      });
      const record = recordOf(result, session.rounds);
      const again = await this.reader.unread(
        context.task.ref,
        context.run,
        session.id,
      );
      const newer = again.filter(
        ({ commentId }) =>
          !reading.some((read) => read.commentId === commentId),
      );
      if (newer.length === 0) {
        return this.act(context, session, result.output, record, reading);
      }
      await this.store.recordSuperseded(context.lease, session.id, record);
      this.log(
        context,
        `evaluation → SUPERSEDED (${newer.length} newer comment${newer.length === 1 ? '' : 's'})`,
      );
      reading = again;
    }
  }

  /** Step 2 (the issue as it is now; the skill and the model at one base-branch commit) and step 3. */
  private async ask(
    context: StepContext,
    session: GrillSession,
    read: {
      rounds: GrillRound[];
      answers: GrillAnswer[];
      unread: AnswerRecord[];
      first: boolean;
    },
  ): Promise<LlmResult<GrillOutput>> {
    const { task, run } = context;
    const details = await this.issues.getTaskDetails(task.ref);
    const setup = await this.stepConfig.prepare('grill', details);
    return this.llm.call({
      context: { task: task.ref, step: 'grill', lane: run.lane, runId: run.id },
      setup,
      frame: grillFrame({
        k: this.k,
        threshold: this.threshold,
        rounds: session.rounds,
        max: this.maxRounds,
      }),
      turns: grillTurns({
        title: details.title,
        description: details.description,
        rounds: read.rounds.map((round) => ({
          number: round.number,
          questions: questionsOf(round),
        })),
        answers: read.answers.map((answer) => ({
          id: answer.commentId,
          author: answer.author,
          body: answer.body,
          url: answer.url,
          afterRound: answer.afterRound,
        })),
        newComments: read.unread.map((answer) => ({
          id: answer.commentId,
          author: answer.author,
          body: answer.body,
          url: answer.url,
        })),
        firstEvaluation: read.first,
      }),
      output: grillOutputSchema({
        threshold: this.threshold,
        lastAsked: session.lastQuestion,
      }),
    });
  }

  /** Step 5. `ASKED`: the first K questions, numbered on from the run's last one (GM5), stored with the round. */
  private async act(
    context: StepContext,
    session: GrillSession,
    output: GrillOutput,
    record: EvaluationRecord,
    read: AnswerRecord[],
  ): Promise<Evaluated> {
    if (output.confidence >= this.threshold) {
      // Clear: the session ends here; the questions are dropped (GMW4).
      await this.store.recordEvaluation(context.lease, session.id, {
        result: 'CLEAR',
        evaluation: record,
        answers: read,
      });
      this.log(context, `evaluation → CLEAR (confidence ${output.confidence})`);
      return 'CLEAR';
    }
    const open = openOf(output);
    if (output.questions.length === 0) {
      // Below the threshold with nothing new to ask: the schema lets that through only with questions still open
      // (GMW4). Waiting never counts against the limit.
      await this.store.recordEvaluation(context.lease, session.id, {
        result: 'WAITING',
        evaluation: record,
        answers: read,
      });
      this.log(
        context,
        `evaluation → WAITING (open ${open.map((number) => `Q${number}`).join(', ')}; 👀 on ${read.length} ` +
          `comment${read.length === 1 ? '' : 's'})`,
      );
      return 'WAITING';
    }
    if (session.rounds >= this.maxRounds) {
      // GM9: it wants to ask again, but the rounds are used up (a lowered setting counts too). The session ends.
      await this.store.recordEvaluation(context.lease, session.id, {
        result: 'LIMIT',
        evaluation: record,
        answers: read,
      });
      this.log(context, `evaluation → LIMIT (confidence ${output.confidence})`);
      return 'LIMIT';
    }
    const questions = output.questions
      .slice(0, this.k)
      .map(({ question, guess }, index) => ({
        number: session.lastQuestion + 1 + index,
        question: cleanModelText(question),
        guess: cleanModelText(guess),
      }));
    const roundId = randomUUID();
    const number = session.rounds + 1;
    await this.store.recordEvaluation(context.lease, session.id, {
      result: 'ASKED',
      evaluation: record,
      answers: read,
      round: {
        id: roundId,
        number,
        questions,
        stillOpen: open,
        body: roundComment({
          roundId,
          round: number,
          maxRounds: this.maxRounds,
          confidence: output.confidence,
          threshold: this.threshold,
          questions,
          stillOpen: open,
          notes: record.notes,
        }),
      },
    });
    this.log(
      context,
      `evaluation → ASKED (round ${number}, ${questions.length} of ${this.k} questions, confidence ${output.confidence})`,
    );
    return 'ASKED';
  }

  private log(context: StepContext, message: string): void {
    this.logger.log(
      `${issueTag(context.task.ref.externalRef)} run ${context.run.number} grill: ${message}`,
    );
  }
}

/** The evaluation's row, from the model's answer and the call (L16, plan P2). */
function recordOf(
  result: LlmResult<GrillOutput>,
  afterRound: number,
): EvaluationRecord {
  const { output } = result;
  return {
    logId: result.logId,
    model: result.model.name,
    modelLevel: result.model.level,
    afterRound,
    confidence: output.confidence,
    questionsProposed: output.questions.length,
    open: output.open,
    gaps: output.gaps,
    notes: result.notes,
  };
}

/** The earlier questions the model lists as still open, each once, in order. */
function openOf(output: GrillOutput): number[] {
  return [...new Set(output.open)].sort((a, b) => a - b);
}

/** A round's questions as Tx1 stored them. */
export function questionsOf(round: GrillRound): RoundQuestion[] {
  return round.questions as RoundQuestion[];
}
