import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Env } from '../config/env.schema.js';
import type { TaskRef } from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import type { StepName, StepSetup } from '../contracts/step.js';
import {
  ContextLoadService,
  type LoadOutcome,
} from './context-load.service.js';
import {
  CONTEXT_TOOLS,
  LOAD_FILE,
  LOAD_SKILL,
  canLoad,
  checkRequest,
  cleanText,
  loadedAnswer,
  markLoaded,
  newBudget,
  reasonOf,
  unreadableAnswer,
  type LoadBudget,
  type LoadLimits,
  type LoadRequest,
  type RequestedFile,
} from './context-tools.js';
import { findInjectionKinds } from './injection-patterns.js';
import { RepoCatalogService, readText } from './repo-catalog.service.js';

/** What one request gave the model; for a `loaded` file also its row and text, counted at the end of the call. */
export interface LoadResult {
  answer: string;
  outcome: LoadOutcome;
  loaded?: { rowId: string; path: string; text: string };
}

/**
 * Plan P15: the call a request belongs to (its rows' columns). 2026-11-21 (build): it holds the call's `setup`, whose
 * lists the request is checked against, instead of P15's `model` and `commit` (`setup.model.name`, `setup.commit`).
 */
export interface LoadContext {
  task: TaskRef;
  runId?: string;
  step: StepName;
  callId: string;
  /** The request whose answer asked for it. */
  turn: number;
  setup: StepSetup;
}

/**
 * Spec 11 "The two tools" (SDW8, SDW14, plan P10, P21): runs one request of the model. It checks the request
 * against the call's lists and budget, reads the file at the call's commit (a repo skill's SKILL.md from the
 * commit's memory, anything else from GitHub every time), writes one `context_loads` row and one log line, and
 * gives the tool answer. For specs 9 and 10 too: the same two tools inside a LangGraph loop, with its own budget.
 */
@Injectable()
export class ContextLoaderService {
  private readonly logger = new Logger(ContextLoaderService.name);
  /** SD6, from `.env`. */
  readonly limits: LoadLimits;

  constructor(
    @Inject(REPO_PROVIDER) private readonly repo: RepoProvider,
    private readonly catalog: RepoCatalogService,
    private readonly loads: ContextLoadService,
    config: ConfigService<Env, true>,
  ) {
    this.limits = {
      maxLoads: config.get('SKILL_DISCOVERY_MAX_LOADS', { infer: true }),
      maxBytes: config.get('SKILL_DISCOVERY_MAX_BYTES', { infer: true }),
    };
  }

  /** The two tool definitions for a setup, or none when nothing can be loaded (SDW7). */
  tools(setup: StepSetup): StructuredToolInterface[] {
    return canLoad(setup) ? CONTEXT_TOOLS : [];
  }

  /** A new call's budget under the `.env` limits. */
  budget(setup: StepSetup): LoadBudget {
    return newBudget(setup, this.limits);
  }

  /**
   * One request, in the flowchart's order. A GitHub error while reading writes the row with outcome `error`, then
   * passes through unchanged (plan P21): the worker retries the event.
   */
  async load(
    call: LoadContext,
    request: LoadRequest,
    budget: LoadBudget,
  ): Promise<LoadResult> {
    const { setup } = call;
    const reads = await this.catalog.at(setup.commit);
    const skillMdBytes = new Map(
      reads.catalog.skills.map(({ skillFile }) => [
        skillFile.path,
        skillFile.size,
      ]),
    );
    const checked = checkRequest(
      request,
      setup,
      budget,
      this.limits,
      skillMdBytes,
    );
    if (checked.outcome !== 'read') {
      await this.record(call, request, checked.outcome, checked.file);
      return { outcome: checked.outcome, answer: checked.answer };
    }

    const { file } = checked;
    let text: string | null;
    try {
      text = file.repoSkill
        ? (reads.skillMd.get(file.path) ?? null)
        : await readText(this.repo, setup.commit, file.path);
    } catch (error) {
      const status =
        error instanceof ProviderError ? error.detail.status : undefined;
      await this.record(
        call,
        request,
        'error',
        file,
        `GitHub ${status === undefined ? 'error, no status' : `status ${status}`}`,
      );
      throw error;
    }
    if (text === null) {
      await this.record(call, request, 'unreadable', file);
      return { outcome: 'unreadable', answer: unreadableAnswer(file) };
    }

    const injectionKinds = findInjectionKinds(text);
    if (injectionKinds.length > 0)
      this.logger.warn(
        `${this.prefix(call)}: ${file.path} matches an injection pattern (${injectionKinds.join(', ')}); loaded ` +
          "anyway, the repository's instructions on the base branch are trusted",
      );
    markLoaded(budget, file);
    const rowId = await this.record(call, request, 'loaded', file, undefined, {
      chars: text.length,
      injectionKinds,
    });
    return {
      outcome: 'loaded',
      answer: loadedAnswer(file, text),
      loaded: { rowId, path: file.path, text },
    };
  }

  /** The request's row, then its log line (no content); the row's id. */
  private async record(
    call: LoadContext,
    request: LoadRequest,
    outcome: LoadOutcome,
    file: RequestedFile | undefined,
    why?: string,
    loaded?: { chars: number; injectionKinds: string[] },
  ): Promise<string> {
    const tool =
      request.tool === LOAD_SKILL || request.tool === LOAD_FILE
        ? request.tool
        : undefined;
    const requested =
      request.tool === LOAD_SKILL
        ? request.name
        : (request.path ?? request.name);
    const id = await this.loads.insert({
      task: call.task,
      runId: call.runId,
      step: call.step,
      callId: call.callId,
      turn: call.turn,
      trigger: 'tool',
      tool,
      requested,
      reason: reasonOf(request),
      kind: file?.kind,
      skill: file?.skill,
      path: file?.path,
      commit: call.setup.commit,
      model: call.setup.model.name,
      outcome,
      bytes: file?.bytes,
      chars: loaded?.chars,
      injectionKinds: loaded?.injectionKinds ?? [],
    });
    const detail =
      why ??
      (outcome === 'loaded' || outcome === 'too-large'
        ? `${file?.bytes.toLocaleString('en-US')} bytes`
        : undefined);
    this.logger.log(
      `${this.prefix(call)}: ${cleanText(request.tool, 64)} ${cleanText(requested ?? '', 1024)} → ${outcome}` +
        (detail ? ` (${detail})` : ''),
    );
    return id;
  }

  /** `context grill #12 turn 1`. */
  private prefix({ step, task, turn }: LoadContext): string {
    const ref = task.externalRef;
    return `context ${step} ${ref.slice(Math.max(0, ref.lastIndexOf('#')))} turn ${turn}`;
  }
}
