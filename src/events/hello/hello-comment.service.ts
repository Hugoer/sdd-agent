import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { App } from 'octokit';
import type { Env } from '../../config/env.schema.js';

export interface HelloTarget {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  deliveryId: string;
}

/** Fixed text: contains no issue content, so nothing needs secret scanning. */
export function helloCommentBody(deliveryId: string): string {
  return `👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery \`${deliveryId}\`.`;
}

/**
 * Minimal GitHub App client for spec 1: the only Octokit import until spec 3's
 * GitHubModule replaces it.
 */
@Injectable()
export class HelloCommentService {
  private readonly app: App;

  constructor(config: ConfigService<Env, true>) {
    this.app = new App({
      appId: config.get('GITHUB_APP_ID', { infer: true }),
      privateKey: readFileSync(
        config.get('GITHUB_APP_PRIVATE_KEY_PATH', { infer: true }),
        'utf8',
      ),
    });
  }

  async postHello(target: HelloTarget): Promise<void> {
    const octokit = await this.app.getInstallationOctokit(
      target.installationId,
    );
    await octokit.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.issueNumber,
      body: helloCommentBody(target.deliveryId),
    });
  }
}
