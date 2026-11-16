import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { StepConfigError } from '../contracts/llm-error.js';
import { ScriptedStepHandler } from '../../test/fakes/scripted-step-handler.js';
import { StepHandlerRegistry } from './step-handler.registry.js';
import { StepNotBuiltError } from './workflow-errors.js';

describe('StepHandlerRegistry (spec "Step-handler registry")', () => {
  it('register, then resolve returns the same handler', () => {
    const registry = new StepHandlerRegistry();
    const grill = new ScriptedStepHandler();

    registry.register('grill', grill);

    expect(registry.resolve('grill')).toBe(grill);
  });

  it('a second registration of a name → an error naming the handler; the first stays', () => {
    const registry = new StepHandlerRegistry();
    const first = new ScriptedStepHandler();
    registry.register('spec', first);

    expect(() => registry.register('spec', new ScriptedStepHandler())).toThrow(
      'a "spec" handler is already registered',
    );
    expect(registry.resolve('spec')).toBe(first);
  });

  it('an unregistered name → StepNotBuiltError, a StepConfigError (plan P1), with the spec message', () => {
    const registry = new StepHandlerRegistry();

    let thrown: unknown;
    try {
      registry.resolve('go-signal');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StepNotBuiltError);
    expect(thrown).toBeInstanceOf(StepConfigError);
    expect((thrown as Error).message).toBe(
      'this version of the bot has no `go-signal` step yet',
    );
  });

  it('cancelHooks lists the handlers that have one, in registration order', () => {
    const registry = new StepHandlerRegistry();
    const grill = new ScriptedStepHandler();
    const plain = { run: () => Promise.resolve() };
    registry.register('code', plain);
    registry.register('grill', grill);

    expect(registry.cancelHooks()).toEqual([{ name: 'grill', handler: grill }]);
  });

  it('a module outside src/workflow registers its handler in onModuleInit (later specs plug in unchanged)', async () => {
    const handler = new ScriptedStepHandler();

    @Injectable()
    class GrillRegistration implements OnModuleInit {
      constructor(private readonly registry: StepHandlerRegistry) {}
      onModuleInit(): void {
        this.registry.register('grill', handler);
      }
    }

    @Module({
      providers: [StepHandlerRegistry],
      exports: [StepHandlerRegistry],
    })
    class RegistryModule {}

    @Module({ imports: [RegistryModule], providers: [GrillRegistration] })
    class FakeGrillModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakeGrillModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(StepHandlerRegistry).resolve('grill')).toBe(handler);
    await moduleRef.close();
  });
});
