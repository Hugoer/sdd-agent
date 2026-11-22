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
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import {
  ContextLoadService,
  type LoadOutcome,
} from './context-load.service.js';
import {
  CONTEXT_TOOLS,
  LIST_FILES,
  LOAD_FILE,
  LOAD_SKILL,
  READ_FILE,
  REPO_FILE_TOOLS,
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
import { guardText } from './input-guard.js';
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
  /** Spec 7: the call offers `list_files` and `read_file`; a repo file is wrapped in the call's data tag. */
  repoFiles?: { tag: string };
}

/**
 * Spec 11 "The two tools" (SDW8, SDW14, plan P10, P21): runs one request of the model. It checks the request
 * against the call's lists and budget, reads the file at the call's commit (a repo skill's SKILL.md from the
 * commit's memory, anything else from GitHub every time), writes one `context_loads` row and one log line, and
 * gives the tool answer. For specs 9 and 10 too: the same two tools inside a LangGraph loop, with its own budget.
 * Spec 7 "The read tools" (SPW2, SPW4, plan P18, P29): with `repoFiles`, also `list_files` (from the commit's
 * listing, in memory) and `read_file` (redacted, then guarded and wrapped as untrusted data; no warning comment).
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
    private readonly scanner: SecretScanner,
  ) {
    this.limits = {
      maxLoads: config.get('SKILL_DISCOVERY_MAX_LOADS', { infer: true }),
      maxBytes: config.get('SKILL_DISCOVERY_MAX_BYTES', { infer: true }),
    };
  }

  /**
   * The two tool definitions for a setup, or none when nothing can be loaded (SDW7). Spec 7: a call that reads
   * repo files gets all four, even when spec 11 has nothing to load.
   */
  tools(setup: StepSetup, repoFiles = false): StructuredToolInterface[] {
    if (repoFiles) return [...CONTEXT_TOOLS, ...REPO_FILE_TOOLS];
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
      call.repoFiles ? reads.listing : null,
    );
    if (checked.outcome === 'listed') {
      // Spec 7: a listing comes from the commit's listing; nothing is read.
      markLoaded(budget, checked.file);
      await this.record(call, request, 'loaded', checked.file, undefined, {
        chars: checked.answer.length,
        injectionKinds: [],
      });
      return { outcome: 'loaded', answer: checked.answer };
    }
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
    if (call.repoFiles && file.kind === 'repo-file')
      return this.repoFile(call, request, budget, file, text, call.repoFiles);

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

  /**
   * Spec 7: a repo file the model asked for with `read_file`. SPW2: `redact()` first (one log line per file with a
   * finding, never the value). Plan P18: then spec 4's guard: detected, cut at 65,536 characters with its marker
   * line, wrapped in the call's data tag. SPW4: its injection kinds are logged and stored on its row; nobody on the
   * issue wrote it, so no warning comment.
   */
  private async repoFile(
    call: LoadContext,
    request: LoadRequest,
    budget: LoadBudget,
    file: RequestedFile,
    read: string,
    { tag }: { tag: string },
  ): Promise<LoadResult> {
    const { text, findings } = this.scanner.redact(read);
    if (findings.length > 0)
      this.logger.warn(
        `${this.prefix(call)}: ${file.path}: redacted ${findings.length} ` +
          `(${[...new Set(findings.map(({ kind }) => kind))].join(', ')})`,
      );
    const label = `the file \`${cleanText(file.path, 1024).replace(/"/g, '')}\``;
    const guarded = guardText(text, tag, label);
    if (guarded.kinds.length > 0)
      this.logger.warn(
        `${this.prefix(call)}: ${file.path} matches an injection pattern (${guarded.kinds.join(', ')}); given as ` +
          'untrusted data',
      );
    markLoaded(budget, file);
    const rowId = await this.record(call, request, 'loaded', file, undefined, {
      chars: text.length,
      injectionKinds: guarded.kinds,
    });
    return {
      outcome: 'loaded',
      answer: guarded.wrapped,
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
    // A tool the call didn't offer leaves the column empty.
    const tool =
      request.tool === LOAD_SKILL || request.tool === LOAD_FILE
        ? request.tool
        : call.repoFiles &&
            (request.tool === LIST_FILES || request.tool === READ_FILE)
          ? request.tool
          : undefined;
    const requested =
      request.tool === LOAD_SKILL
        ? request.name
        : request.tool === LIST_FILES
          ? request.folder
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
