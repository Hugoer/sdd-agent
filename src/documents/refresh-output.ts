// Spec 7 "Refresh frame" (SP4, SP5): what a refresh call answers, the same for the Spec and the Plan. Gemini gets the
// schema as JSON schema; Zod judges the answer, and spec 4 re-asks with these messages on a mismatch. Pure.
import { z } from 'zod';
import { DOCUMENT_MAX_CHARS } from './document-text.js';

/** At most this many change lines. */
export const MAX_REFRESH_CHANGES = 10;

const count = (n: number): string => n.toLocaleString('en-US');

export const refreshOutputSchema = z
  .object({
    upToDate: z.boolean(),
    changes: z
      .array(z.string().trim().min(1).max(300))
      .max(MAX_REFRESH_CHANGES),
    // Plan P2: a too-long document is re-asked and stops with this message ("document: 71,200 characters, at most
    // 50,000 fit").
    document: z.string().max(DOCUMENT_MAX_CHARS, {
      error: (issue) =>
        `${count(typeof issue.input === 'string' ? issue.input.length : 0)} characters, at most ${count(DOCUMENT_MAX_CHARS)} fit`,
    }),
  })
  .superRefine((answer, ctx) => {
    if (answer.upToDate) {
      if (answer.changes.length > 0 || answer.document.trim() !== '')
        ctx.addIssue({
          code: 'custom',
          message:
            'upToDate is true, so leave changes and document empty; if something must change, set upToDate to false',
        });
      return;
    }
    if (answer.document.trim() === '')
      ctx.addIssue({
        code: 'custom',
        path: ['document'],
        message:
          'upToDate is false, so document must be the whole updated text',
      });
    if (answer.changes.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['changes'],
        message:
          'upToDate is false, so changes must say what you changed and why, one short line each',
      });
  });

export type RefreshOutput = z.infer<typeof refreshOutputSchema>;
