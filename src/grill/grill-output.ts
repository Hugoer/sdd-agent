// Spec 6 "Model, skill and prompt" → Output, with GMW4's rules: what Grill Me's model answers. Gemini gets the
// schema as JSON schema; Zod judges the answer, and spec 4 re-asks with these messages on a mismatch. Pure.
import { z } from 'zod';

export interface GrillOutputLimits {
  /** `GRILL_CONFIDENCE_THRESHOLD`: at or above it the bot writes the Spec. */
  threshold: number;
  /** The last question number asked in this run; 0 before the first question comment. */
  lastAsked: number;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** Built per call: the rules depend on the threshold and on the questions asked so far. */
export function grillOutputSchema({ threshold, lastAsked }: GrillOutputLimits) {
  return z
    .object({
      confidence: z.number().int().min(0).max(100),
      questions: z
        .array(z.object({ question: text(600), guess: text(600) }))
        .max(20),
      open: z.array(z.number().int()),
      gaps: z.array(text(200)).max(10),
    })
    .superRefine((answer, ctx) => {
      // At or above the threshold the bot writes the Spec: questions and open numbers are never read.
      if (answer.confidence >= threshold) return;
      const unknown = answer.open.filter(
        (number) => number < 1 || number > lastAsked,
      );
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `open lists ${unknown.map((n) => `Q${n}`).join(', ')}, but ${askedSoFar(lastAsked)}`,
        });
      }
      if (answer.questions.length === 0 && answer.open.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `below ${threshold} you must ask at least one new question or list the open questions you are waiting for`,
        });
      }
    });
}

export type GrillOutput = z.infer<ReturnType<typeof grillOutputSchema>>;

function askedSoFar(lastAsked: number): string {
  if (lastAsked === 0) return 'no question was asked yet';
  if (lastAsked === 1) return 'only Q1 was asked';
  return `only Q1–Q${lastAsked} were asked`;
}
