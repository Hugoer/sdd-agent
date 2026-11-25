// Spec 5 "Run start" (RL3): the run's row, then the checks that come before its first step. Steps 2–3 are safe
// to repeat (RLW9): the check reads again and the warning has its marker (spec 12: so does the 🔑 notice).
import { Injectable, Logger } from '@nestjs/common';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { Run } from '../generated/prisma/client.js';
import { InjectionWarningService } from '../llm/injection-warning.service.js';
import {
  SecretNoticeService,
  noticeKinds,
} from '../llm/secret-notice.service.js';
import { StepConfigService } from '../llm/step-config.service.js';
import { placeholderKinds } from '../secret-scan/secret-patterns.js';
import { kindList, SecretScanner } from '../secret-scan/secret-scanner.js';
import { RunService, type RunStart } from './run.service.js';
import type { HeldLease } from './session-lease.service.js';

/** Spec "Run start" step 3: the source spec 4's warning and spec 12's notice name. */
const DESCRIPTION = { key: 'description', label: 'the issue description' };

@Injectable()
export class RunStartService {
  private readonly logger = new Logger(RunStartService.name);

  constructor(
    private readonly runs: RunService,
    private readonly stepConfig: StepConfigService,
    private readonly warnings: InjectionWarningService,
    private readonly notices: SecretNoticeService,
    private readonly scanner: SecretScanner,
  ) {}

  /** Step 1: run N+1 and `Task.currentRunId`, in one transaction (plan P15: refused while a run is current). */
  async create(lease: HeldLease, tag: string, start: RunStart): Promise<Run> {
    const run = await this.runs.create(lease, start);
    this.logger.log(`${tag} run ${run.number} started (${run.lane})`);
    return run;
  }

  /**
   * Steps 2–3: the skills and models the run needs (a StepConfigError stops it, nothing posted), then, on the
   * description: redacted (spec 12 BDW1, plan DP11), the 🔑 notice if it held a secret, and the injection warning
   * on the redacted text, if due. The title's notice comes with the first model call (BDW3).
   */
  async check(ref: TaskRef, run: Run, description: string): Promise<void> {
    await this.stepConfig.checkRun(run.lane as Lane, run.grillSkip);
    const { text, findings } = this.scanner.redact(description);
    if (findings.length > 0)
      this.logger.warn(
        `secret-scan run-start ${ref.externalRef} description: redacted ${findings.length} (${kindList(findings)})`,
      );
    const kinds = noticeKinds(DESCRIPTION, placeholderKinds(text));
    if (kinds.length > 0) await this.notices.notify(ref, DESCRIPTION, kinds);
    await this.warnings.check(ref, DESCRIPTION, text);
  }
}
