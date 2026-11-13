// Overview §4 (normative). Types and the DI token only; GitHub implementation: src/github.
import type { CommentRef, Platform } from './issue-provider.js';

export interface PullRequestRef {
  platform: Platform;
  repo: string;
  number: number;
  url: string;
}

export interface PushCredentials {
  authorName: string; // "<app>[bot]"
  authorEmail: string;
  remoteUrl: string; // explicit HTTPS URL; the developer's `origin` is never used or changed
  token: string; // short-lived installation token: passed per command, never persisted
  // (spec 3, G8: target repo only, contents: write only, new on every call)
  expiresAt: Date;
}

export interface RepoFile {
  path: string; // relative to the repo root
  size: number; // bytes
  executable: boolean; // git mode 100755
}

export interface RepoProvider {
  getPushCredentials(): Promise<PushCredentials>;
  /** file content at a ref on the code host (step skills: always the base branch); null = missing */
  readFile(ref: string, path: string): Promise<string | null>;
  /** every regular file under dir at a ref, at any depth (a step skill is its whole directory);
   *  null = no such directory */
  listFiles(ref: string, dir: string): Promise<RepoFile[] | null>;
  /** the commit SHA a branch or ref points to now, so a skill is read at one commit; unknown ref →
   *  permanent ProviderError (added 2026-11-12, spec 4) */
  resolveRef(ref: string): Promise<string>;
  openPullRequest(
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequestRef>;
  /** recovery after a crash between opening the PR and recording it */
  findPullRequest(branch: string): Promise<PullRequestRef | null>;
  postPullRequestComment(pr: PullRequestRef, body: string): Promise<CommentRef>;
  setQualityResult(
    pr: PullRequestRef,
    commitSha: string,
    result: 'success' | 'neutral' | 'failure',
    summary: string,
  ): Promise<void>;
}

export const REPO_PROVIDER = Symbol('REPO_PROVIDER');
