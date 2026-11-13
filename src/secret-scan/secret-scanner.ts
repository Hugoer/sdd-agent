import { Injectable, type Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  MIN_OWN_SECRET_LENGTH,
  SECRET_PATTERNS,
  type SecretKind,
} from './secret-patterns.js';

export interface SecretFinding {
  kind: SecretKind;
  start: number;
  end: number; // exclusive
}

/**
 * Spec 4 "Secret scanner" (L9, LW4). Runs at the two ports on everything the bot posts; a step that stores
 * what it posts calls `redact()` first. Never logs or returns a matched value.
 */
@Injectable()
export class SecretScanner {
  /** The exact values of the bot's own secrets (`own-secret`). */
  private readonly ownSecrets: string[];

  constructor(config: ConfigService<Env, true>) {
    this.ownSecrets = [
      config.get('GITHUB_WEBHOOK_SECRET', { infer: true }),
      config.get('GOOGLE_API_KEY', { infer: true }),
    ].filter((value) => value.length >= MIN_OWN_SECRET_LENGTH);
  }

  /** Every secret in the text, by position, without overlaps (an overlap joins the two into the first). */
  scan(text: string): SecretFinding[] {
    const found: SecretFinding[] = [];
    for (const { kind, pattern } of SECRET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.push({
          kind,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
    for (const secret of this.ownSecrets) {
      for (
        let at = text.indexOf(secret);
        at !== -1;
        at = text.indexOf(secret, at + 1)
      ) {
        found.push({ kind: 'own-secret', start: at, end: at + secret.length });
      }
    }
    // Stable sort: at the same start, the longer finding first, then the order of the patterns.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: SecretFinding[] = [];
    for (const finding of found) {
      const last = merged.at(-1);
      if (last && finding.start < last.end)
        last.end = Math.max(last.end, finding.end);
      else merged.push({ ...finding });
    }
    return merged;
  }

  /** The text with every finding replaced by `[REDACTED: <kind>]`, and the kinds found. */
  redact(text: string): { text: string; findings: { kind: SecretKind }[] } {
    const findings = this.scan(text);
    let redacted = '';
    let from = 0;
    for (const { kind, start, end } of findings) {
      redacted += `${text.slice(from, start)}[REDACTED: ${kind}]`;
      from = end;
    }
    return {
      text: findings.length === 0 ? text : redacted + text.slice(from),
      findings: findings.map(({ kind }) => ({ kind })),
    };
  }
}

/**
 * The texts a port is about to send, redacted (spec 4 "At the ports"). One log line when something was found:
 * the method, what it is posted on, the count and the kinds; never a value or the text.
 */
export function redactAtPort(
  scanner: SecretScanner,
  logger: Logger,
  method: string,
  target: string,
  texts: string[],
): string[] {
  const results = texts.map((text) => scanner.redact(text));
  const kinds = results.flatMap((result) =>
    result.findings.map(({ kind }) => kind),
  );
  if (kinds.length > 0) {
    logger.warn(
      `secret-scan ${method} ${target}: redacted ${kinds.length} (${[...new Set(kinds)].join(', ')})`,
    );
  }
  return results.map((result) => result.text);
}
