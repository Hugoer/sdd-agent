// Spec 6 "Contracts": what the Spec step (spec 7) reads from Grill Me.
import { Injectable } from '@nestjs/common';
import { questionsOf } from './grill-evaluation.service.js';
import {
  GrillStore,
  type RoundQuestion,
  type SessionStatus,
} from './grill.store.js';

export interface GrillTranscript {
  /**
   * Spec 7 plan P9: the session's status (`CLEAR`, `SKIPPED` or `STOPPED` when the Spec is written), so the Spec
   * says "skipped" exactly when Grill Me was skipped; null for a run with no session.
   */
  status: SessionStatus | null;
  /** The question comments, by number, each with its questions and guesses. */
  rounds: { number: number; questions: RoundQuestion[] }[];
  /** Every comment read as an answer, in creation order (then comment id); the text as written. */
  answers: {
    author: string;
    body: string;
    commentId: string;
    url: string | null;
  }[];
}

@Injectable()
export class GrillService {
  constructor(private readonly store: GrillStore) {}

  /** The run's session status, rounds and answers, in order; null and empty for a run with no session. */
  async transcript(runId: string): Promise<GrillTranscript> {
    const session = await this.store.session(runId);
    if (!session) return { status: null, rounds: [], answers: [] };
    const [rounds, answers] = await Promise.all([
      this.store.rounds(session.id),
      this.store.answers(session.id),
    ]);
    return {
      status: session.status as SessionStatus,
      rounds: rounds.map((round) => ({
        number: round.number,
        questions: questionsOf(round),
      })),
      answers: answers.map(({ author, body, commentId, url }) => ({
        author,
        body,
        commentId,
        url,
      })),
    };
  }
}
