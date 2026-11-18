import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { SessionLeaseService } from './session-lease.service.js';
import { WorkflowModule } from './workflow.module.js';

describe('WorkflowModule', () => {
  it('spec 6: exports SessionLeaseService, so a step module can check its lease in its own writes (assertHeld)', () => {
    expect(Reflect.getMetadata('exports', WorkflowModule)).toContain(
      SessionLeaseService,
    );
  });
});
