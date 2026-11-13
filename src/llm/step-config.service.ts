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
import type { StepName, StepSetup } from '../contracts/step.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from './chat-model.factory.js';
import { listSkill, loadSkill, missingSkills } from './skill-loader.js';
import {
  WORKFLOW_CONFIG_PATH,
  parseWorkflowConfig,
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
 * one base-branch commit. Throws StepConfigError for a wrong map or skill; a ProviderError from GitHub (unknown
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
  ) {
    this.baseBranch = config.get('TARGET_BASE_BRANCH', { infer: true });
  }

  /** Steps 1–2: the branch's commit now, and the map validated at that commit. */
  async readWorkflow(base = this.baseBranch): Promise<WorkflowAtCommit> {
    const commit = await this.repo.resolveRef(base);
    const text = await this.repo.readFile(commit, WORKFLOW_CONFIG_PATH);
    return { commit, config: parseWorkflowConfig(text) };
  }

  /** Steps 1–8 and the model from the task's labels (read by the caller at the start of this step run). */
  async prepare(
    step: StepName,
    task: UnifiedTask,
    base = this.baseBranch,
  ): Promise<StepSetup> {
    const { commit, config } = await this.readWorkflow(base);
    const skill = await loadSkill(
      this.repo,
      config.skills,
      step,
      commit,
      this.logger,
    );
    const { maxModelSteps } = this.issues.readControls(task);
    const { name, level } = resolveModel(config.models, step, maxModelSteps);
    return {
      commit,
      skill,
      model: { provider: this.models.provider, name, level },
    };
  }

  /** The run-start check (overview §3 R6): the listing only, every missing step named at once. */
  async checkRun(
    lane: Lane,
    grillSkip: boolean,
    base = this.baseBranch,
  ): Promise<void> {
    const { commit, config } = await this.readWorkflow(base);
    const missing: StepName[] = [];
    for (const step of stepsFor(lane, grillSkip)) {
      if (!(await listSkill(this.repo, config.skills, step, commit)))
        missing.push(step);
    }
    if (missing.length > 0) throw missingSkills(missing);
  }
}
