// Spec 4 "Input guard" (L7): every untrusted text, in this order: detect (on the full text), cut, wrap. Pure
// functions; steps store their texts raw and the wrapping happens when a call is built.
import { randomBytes } from 'node:crypto';
import {
  findInjectionKinds,
  type InjectionKind,
} from './injection-patterns.js';

/** The most characters (JavaScript string length) of one untrusted text the model sees. */
export const MAX_UNTRUSTED_CHARS = 65_536;

export interface GuardedText {
  /** The opening tag, the text (cut if needed) and the closing tag. */
  wrapped: string;
  /** Detected on the full text, before the cut. */
  kinds: InjectionKind[];
  /** The original length when the text was cut; undefined when it was kept whole. */
  cutFrom?: number;
}

/** `untrusted-data-` and 16 random hex characters, new for every call, so no text can hold the closing tag. */
export function newDataTag(): string {
  return `untrusted-data-${randomBytes(8).toString('hex')}`;
}

/** Detect → cut → wrap one untrusted text with this call's tag. */
export function guardText(
  text: string,
  tag: string,
  sourceLabel: string,
): GuardedText {
  const kinds = findInjectionKinds(text);
  const { text: kept, cutFrom } = cutText(text);
  const wrapped = `<${tag} source="${sourceLabel}">\n${kept}\n</${tag}>`;
  return cutFrom === undefined
    ? { wrapped, kinds }
    : { wrapped, kinds, cutFrom };
}

/**
 * Longer than 65,536 characters → the first 65,536 and the spec's marker line. A cut never splits a surrogate
 * pair: when the last kept unit is a high surrogate, it goes too.
 */
export function cutText(text: string): { text: string; cutFrom?: number } {
  if (text.length <= MAX_UNTRUSTED_CHARS) return { text };
  let end = MAX_UNTRUSTED_CHARS;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return {
    text:
      `${text.slice(0, end)}\n[cut by the bot: this text had ${text.length.toLocaleString('en-US')} characters, ` +
      `only the first ${MAX_UNTRUSTED_CHARS.toLocaleString('en-US')} are shown]`,
    cutFrom: text.length,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
