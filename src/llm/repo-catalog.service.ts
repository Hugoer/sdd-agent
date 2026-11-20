import { Inject, Injectable } from '@nestjs/common';
import { StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import type { StepName } from '../contracts/step.js';
import {
  AGENTS_FILE,
  ROOT_AGENTS_BYTES_LIMIT,
  buildCatalog,
  type CommitReads,
} from './repo-catalog.js';
import { SKILL_BYTES_LIMIT, listSkill } from './skill-loader.js';
import {
  WORKFLOW_CONFIG_PATH,
  parseWorkflowConfig,
  type WorkflowConfig,
} from './workflow-config.js';

const STEPS: readonly StepName[] = [
  'grill',
  'spec',
  'plan',
  'code',
  'qualityGate',
];

/**
 * Spec 11 SDW15 and plan P10, P11: what the bot reads at a base-branch commit (`workflow.json`, one tree listing,
 * the root AGENTS.md, every step skill's and repo skill's SKILL.md), kept for the latest commit only. A commit's
 * content never changes, so the entry can't go stale; a new commit drops it, a restart empties it. It is not
 * workflow state (§7 rule 5). A GitHub error while reading passes through and nothing is kept.
 */
@Injectable()
export class RepoCatalogService {
  private kept: { commit: string; reads: Promise<CommitReads> } | null = null;

  constructor(@Inject(REPO_PROVIDER) private readonly repo: RepoProvider) {}

  /** The reads at `commit`: from memory when it is the kept commit, else read now (and kept). */
  at(commit: string): Promise<CommitReads> {
    if (this.kept?.commit === commit) return this.kept.reads;
    const reads = this.read(commit);
    this.kept = { commit, reads };
    reads.catch(() => {
      if (this.kept?.reads === reads) this.kept = null;
    });
    return reads;
  }

  private async read(commit: string): Promise<CommitReads> {
    const text = await this.repo.readFile(commit, WORKFLOW_CONFIG_PATH);
    let config: WorkflowConfig;
    try {
      config = parseWorkflowConfig(text);
    } catch (error) {
      if (!(error instanceof StepConfigError)) throw error;
      return {
        commit,
        workflow: { error },
        listing: [],
        catalog: buildCatalog([], []),
        rootAgents: null,
        skillMd: new Map(),
      };
    }

    const listing = (await this.repo.listFiles(commit, '')) ?? [];
    const catalog = buildCatalog(listing, config.repoSkills);

    let rootAgents: CommitReads['rootAgents'] = null;
    const root = catalog.rootAgents;
    if (root && root.size <= ROOT_AGENTS_BYTES_LIMIT) {
      const agents = await readText(this.repo, commit, AGENTS_FILE);
      rootAgents =
        agents === null
          ? 'unreadable'
          : agents.trim() === ''
            ? null
            : { text: agents, bytes: root.size };
    }

    // Every mapped step skill (a SKILL.md over the cap is never read: spec 4) and every repo skill.
    const paths = new Set<string>();
    for (const step of STEPS) {
      try {
        const skill = listSkill(listing, config.skills, step);
        if (skill && skill.skillFile.size <= SKILL_BYTES_LIMIT)
          paths.add(skill.skillFile.path);
      } catch (error) {
        if (!(error instanceof StepConfigError)) throw error; // too large
      }
    }
    for (const skill of catalog.skills) paths.add(skill.skillFile.path);
    const texts = await Promise.all(
      [...paths].map(
        async (path) =>
          [path, await readText(this.repo, commit, path)] as const,
      ),
    );

    return {
      commit,
      workflow: { config },
      listing,
      catalog,
      rootAgents,
      skillMd: new Map(texts),
    };
  }
}

/**
 * A file's text at `commit`, or null when it isn't text (spec 4 plan P6: the adapter raises a permanent
 * ProviderError without an HTTP status only for a file over 1 MB or not valid UTF-8; a listed file that reads as
 * missing counts the same). Any error with a status is a GitHub failure and passes through unchanged.
 */
export async function readText(
  repo: RepoProvider,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    return await repo.readFile(commit, path);
  } catch (error) {
    if (
      error instanceof ProviderError &&
      error.kind === 'permanent' &&
      error.detail.status === undefined
    )
      return null;
    throw error;
  }
}
