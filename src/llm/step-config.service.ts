import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type Lane,
  type UnifiedTask,
} from '../contracts/issue-provider.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import { StepConfigError } from '../contracts/llm-error.js';
import type { StepName, StepSetup } from '../contracts/step.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from './chat-model.factory.js';
import {
  contextLine,
  missingFoldersError,
  repoContext,
  repoSkillProblems,
  rootAgentsProblem,
  type CommitReads,
} from './repo-catalog.js';
import { RepoCatalogService } from './repo-catalog.service.js';
import { invalidSkills, type SkillProblem } from './skill-header.js';
import {
  listSkill,
  loadSkill,
  missingSkills,
  readStepSkill,
  type SkillListing,
} from './skill-loader.js';
import {
  resolveModel,
  stepsFor,
  type WorkflowConfig,
} from './workflow-config.js';

/** `workflow.json` as read at one commit of the base branch. */
export interface WorkflowAtCommit {
  commit: string;
  config: WorkflowConfig;
}

/**
 * Spec 4 "Skill of a step run" and "Run-start check": everything a step reads from the target repo comes from
 * one base-branch commit, read once per commit through `RepoCatalogService` (spec 11, SDW15). Throws StepConfigError for a wrong map or skill; a ProviderError from GitHub (unknown
 * base branch, outage) passes through unchanged. `base` defaults to TARGET_BASE_BRANCH (the smoke script's
 * `--base` reads another branch).
 */
@Injectable()
export class StepConfigService {
  private readonly logger = new Logger(StepConfigService.name);
  private readonly baseBranch: string;

  constructor(
    @Inject(REPO_PROVIDER) private readonly repo: RepoProvider,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    @Inject(CHAT_MODEL_FACTORY) private readonly models: ChatModelFactory,
    config: ConfigService<Env, true>,
    private readonly catalog: RepoCatalogService,
  ) {
    this.baseBranch = config.get('TARGET_BASE_BRANCH', { infer: true });
  }

  /** Steps 1–2: the branch's commit now, and the map validated at that commit. */
  async readWorkflow(base = this.baseBranch): Promise<WorkflowAtCommit> {
    const { commit, config } = await this.readsAt(base);
    return { commit, config };
  }

  /**
   * Steps 1–8, the repo's context at the same commit (spec 11) and the model from the task's labels (read by the
   * caller at the start of this step run). Spec 11: the same checks as the run start, for this step's skill and
   * every repo skill, at every step.
   */
  async prepare(
    step: StepName,
    task: UnifiedTask,
    base = this.baseBranch,
  ): Promise<StepSetup> {
    const { commit, config, reads } = await this.readsAt(base);
    checkContent(reads, config, [step]);
    const skill = loadSkill(reads, config.skills, step, this.logger);
    const repo = repoContext(reads, config.skills[step]);
    this.logger.log(contextLine(step, commit, repo, skill));
    const { maxModelSteps } = this.issues.readControls(task);
    const { name, level } = resolveModel(config.models, step, maxModelSteps);
    return {
      commit,
      skill,
      model: { provider: this.models.provider, name, level },
      repo,
    };
  }

  /** The run-start check (overview §3 R6): `checkContent` for every step the run uses. */
  async checkRun(
    lane: Lane,
    grillSkip: boolean,
    base = this.baseBranch,
  ): Promise<void> {
    const { config, reads } = await this.readsAt(base);
    checkContent(reads, config, stepsFor(lane, grillSkip));
  }

  /** The base branch's commit now (one `resolveRef`, spec 4) and what the bot read there (SDW15). */
  private async readsAt(
    base: string,
  ): Promise<WorkflowAtCommit & { reads: CommitReads }> {
    const commit = await this.repo.resolveRef(base);
    const reads = await this.catalog.at(commit);
    if ('error' in reads.workflow) throw reads.workflow.error;
    return { commit, config: reads.workflow.config, reads };
  }
}

/**
 * One problem per stop, the first failing check (spec 11 plan P1, at run start and at every step):
 * 1. `invalid workflow.json` (read by the caller), then a `repoSkills` folder not in the tree (SDW11);
 * 2. spec 4's listing checks: every missing step at once, then a SKILL.md too large;
 * 3. the root AGENTS.md: too large or not text (SDW2, LW3);
 * 4. `invalid skills` (SD12): these steps' skills in step order, then every repo skill and duplicate name in
 *    `repoSkills` folder order, all at once.
 */
function checkContent(
  reads: CommitReads,
  config: WorkflowConfig,
  steps: StepName[],
): void {
  const folders = missingFoldersError(reads.catalog);
  if (folders) throw folders;

  const missing: StepName[] = [];
  const problems: SkillProblem[] = [];
  const checked = new Set<string>();
  let tooLarge: StepConfigError | undefined;
  for (const step of steps) {
    let listing: SkillListing | null;
    try {
      listing = listSkill(reads.listing, config.skills, step);
    } catch (error) {
      if (!(error instanceof StepConfigError)) throw error;
      tooLarge ??= error;
      continue;
    }
    if (!listing) {
      missing.push(step);
      continue;
    }
    const read = readStepSkill(reads, listing);
    checked.add(listing.skillFile.path);
    if (read.blank) missing.push(step);
    else if (read.problem) problems.push(read.problem);
  }
  if (missing.length > 0) throw missingSkills(missing);
  if (tooLarge) throw tooLarge;

  const agents = rootAgentsProblem(reads);
  if (agents) throw agents;

  problems.push(...repoSkillProblems(reads, config.repoSkills, checked));
  if (problems.length > 0) throw invalidSkills(problems);
}
