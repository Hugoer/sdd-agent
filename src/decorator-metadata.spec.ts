import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class Dependency {}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

// Nest DI reads constructor types from decorator metadata; Vitest must emit it.
describe('decorator metadata under Vitest', () => {
  it('injects constructor dependencies by type', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();
    expect(moduleRef.get(Consumer).dependency).toBeInstanceOf(Dependency);
  });
});
