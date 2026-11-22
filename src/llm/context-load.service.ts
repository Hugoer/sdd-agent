import { Injectable } from '@nestjs/common';
import type { TaskRef } from '../contracts/issue-provider.js';
import type { StepName } from '../contracts/step.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Spec 11 SD5, SDW14, plan P21: what happened to one file given at start or asked for. */
export type LoadOutcome =
  | 'loaded'
  | 'already-loaded'
  | 'not-found'
  | 'too-large'
  | 'unreadable'
  | 'limit-reached'
  | 'error';

/** The columns a row is inserted with; `requested` and `reason` are cut at 300 characters here. */
export interface ContextLoadEntry {
  task: TaskRef;
  runId?: string;
  step: StepName;
  callId: string;
  /** The request whose answer asked for it; 0 = given at start. */
  turn: number;
  trigger: 'start' | 'tool';
  /** Spec 7: also the read tools. */
  tool?: 'load_skill' | 'load_file' | 'list_files' | 'read_file';
  /** The name or path as the model wrote it. */
  requested?: string;
  /** The model's reason; the loader passes `(none given)` when it gave none. */
  reason?: string;
  /** Spec 7: `repo-file` (`read_file`) and `listing` (`list_files`, `path` the folder). */
  kind?: 'step-skill' | 'repo-skill' | 'agents' | 'repo-file' | 'listing';
  /** The step name (`step-skill`) or the repo skill's name. */
  skill?: string;
  path?: string;
  commit: string;
  model: string;
  outcome: LoadOutcome;
  bytes?: number;
  /** The file's own text, in characters; only for `loaded` (plan P16). */
  chars?: number;
  injectionKinds: string[];
}

/** Spec 11 "Owned table: ContextLoad": the requested name and the reason are cut at this many characters. */
const MAX_TEXT = 300;

/**
 * The only writer of `context_loads` (spec 11). A row is inserted when its file is given or asked for; only its
 * two token columns are set later, in the same call.
 */
@Injectable()
export class ContextLoadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Inserts the row and returns its id. */
  async insert(entry: ContextLoadEntry): Promise<string> {
    const { id } = await this.prisma.contextLoad.create({
      data: {
        platform: entry.task.platform,
        taskId: entry.task.id,
        externalRef: entry.task.externalRef,
        runId: entry.runId ?? null,
        step: entry.step,
        callId: entry.callId,
        turn: entry.turn,
        trigger: entry.trigger,
        tool: entry.tool ?? null,
        requested: cut(entry.requested),
        reason: cut(entry.reason),
        kind: entry.kind ?? null,
        skill: entry.skill ?? null,
        path: entry.path ?? null,
        commit: entry.commit,
        model: entry.model,
        outcome: entry.outcome,
        bytes: entry.bytes ?? null,
        chars: entry.chars ?? null,
        injectionKinds: entry.injectionKinds,
      },
      select: { id: true },
    });
    return id;
  }

  /**
   * SD5: `estimatedTokens = round(chars × perChar)` on the files one request carried first: the call's rows of
   * `turn` (the start rows, turn 0, for request 1; a turn's loads for the next request), where `perChar` is that
   * request's input tokens per character sent. Rows without characters (nothing loaded) stay empty.
   */
  async setEstimates(
    callId: string,
    turn: number,
    perChar: number,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE context_loads SET estimated_tokens = ROUND(chars * ${perChar}::numeric)::int
      WHERE call_id = ${callId}::uuid AND turn = ${turn} AND chars IS NOT NULL`;
  }

  /** SD5: the provider's own count for the row's file. */
  async setTokens(id: string, tokens: number): Promise<void> {
    await this.prisma.contextLoad.update({ where: { id }, data: { tokens } });
  }

  /** SDW17: a count already stored for the same path, commit and model; null when there is none. */
  async knownTokens(
    path: string,
    commit: string,
    model: string,
  ): Promise<number | null> {
    const row = await this.prisma.contextLoad.findFirst({
      where: { path, commit, model, tokens: { not: null } },
      select: { tokens: true },
    });
    return row?.tokens ?? null;
  }
}

function cut(text: string | undefined): string | null {
  return text === undefined ? null : [...text].slice(0, MAX_TEXT).join('');
}
