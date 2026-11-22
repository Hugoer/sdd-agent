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
  /**
   * A Zod schema (Gemini is asked for the format, Zod judges it), or 'text' (T is string), or (spec 7) text with a
   * maximum: a longer answer is re-asked like any other mismatch.
   */
  output: z.ZodType<T> | 'text' | TextOutput;
  /** Spec 7 (SP2): offer `list_files` and `read_file` over the repo at the step's commit (Spec, Plan, refresh). */
  repoFiles?: true;
}

/** Spec 7 "Contracts" → `src/llm`: a text answer of at most `maxChars` characters (T is string). */
export interface TextOutput {
  text: { maxChars: number };
}

export interface LlmResult<T> {
  output: T;
  model: ResolvedModel;
  /** Lines a step adds to what it posts (`withNotes`). */
  notes: string[];
  /** The id of this call's last ExecutionLog row. */
  logId: string;
}
