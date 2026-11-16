// Spec 4 "Contracts" (src/llm): what a step hands to LlmService.call() and what it gets back. Types only.
import type { z } from 'zod';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { ResolvedModel, StepName, StepSetup } from '../contracts/step.js';

/** Where an untrusted text came from: `key` names its warning marker, `label` is shown to the model and humans. */
export interface UntrustedSource {
  key: string; // e.g. 'description', 'comment-4821'
  label: string; // e.g. 'the issue description', 'this comment'
  url?: string;
}

/** `text`: written by the bot. `untrusted`: anything from GitHub, guarded and wrapped when the call is built. */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'untrusted'; source: UntrustedSource; text: string };

export interface Turn {
  role: 'user' | 'assistant';
  blocks: Block[];
}

export interface LlmCall<T> {
  context: { task: TaskRef; step: StepName; lane?: Lane; runId?: string };
  setup: StepSetup;
  /** The step's own instructions (role, task, output rules), written in the step's spec. */
  frame: string;
  turns: Turn[];
  /** A Zod schema (Gemini is asked for the format, Zod judges it), or 'text' (T is string). */
  output: z.ZodType<T> | 'text';
}

export interface LlmResult<T> {
  output: T;
  model: ResolvedModel;
  /** Lines a step adds to what it posts (`withNotes`). */
  notes: string[];
  /** The id of this call's last ExecutionLog row. */
  logId: string;
}
