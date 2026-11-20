// Spec 11 SDW16, SD12, plan P9 and P19: the `SKILL.md` header reader and the Agent Skills header check. Pure
// functions: a file's text comes in, a field or a problem goes out. No YAML package (SDW16): only `name:` and
// `description:` are read, in the forms below; any other YAML form is "a form the bot can't read".
import { StepConfigError } from '../contracts/llm-error.js';

/** A header field as read: its value, absent (or null), or written in a form the reader doesn't know. */
export type HeaderField =
  | { kind: 'value'; value: string }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export interface SkillHeader {
  name: HeaderField;
  description: HeaderField;
}

/** One broken skill: its `SKILL.md` path and the reason of SD12's table. A duplicate name has no path. */
export interface SkillProblem {
  path?: string;
  reason: string;
}

/** The Agent Skills limits (SD12). */
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1_024;
/** SD12's table, row "Not text (LW3)". */
export const NOT_TEXT = 'not text';

const MISSING: HeaderField = { kind: 'missing' };
const UNREADABLE: HeaderField = { kind: 'unreadable' };
const FENCE = /^---[ \t]*$/;
/** A top-level key: no indentation, then `:` followed by a space or the end of the line. */
const KEY_LINE = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
/** Lowercase letters, digits and hyphens; no hyphen first, last or twice in a row. */
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Characters that can't start a plain value (YAML indicators): flow collections, anchors, aliases, tags… */
const NOT_PLAIN_START = new Set([
  '{',
  '}',
  '[',
  ']',
  ',',
  '&',
  '*',
  '!',
  '%',
  '@',
  '`',
]);

/**
 * `name` and `description` from the block between the first two `---` lines (the file's first line must be one);
 * null = no header. CRLF line ends and a leading byte-order mark are accepted (P19).
 */
export function readSkillHeader(text: string): SkillHeader | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!FENCE.test(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (end < 0) return null;
  const block = lines.slice(1, end);

  const fields = new Map<string, HeaderField>();
  for (let i = 0; i < block.length;) {
    const match = isIndented(block[i]) ? null : KEY_LINE.exec(block[i]);
    let next = i + 1;
    while (
      next < block.length &&
      (block[next].trim() === '' || isIndented(block[next]))
    )
      next++;
    if (match && (match[1] === 'name' || match[1] === 'description')) {
      const key = match[1];
      // A key written twice is a YAML error: the bot can't tell which value was meant.
      fields.set(
        key,
        fields.has(key)
          ? UNREADABLE
          : readValue(match[2] ?? '', block.slice(i + 1, next)),
      );
    }
    i = next;
  }
  return {
    name: fields.get('name') ?? MISSING,
    description: fields.get('description') ?? MISSING,
  };
}

/**
 * SD12's check of one skill: the first problem of its `SKILL.md`, or null. `folder` is the skill's folder name,
 * which `name` must equal.
 */
export function checkSkillHeader(
  path: string,
  folder: string,
  text: string,
): SkillProblem | null {
  const header = readSkillHeader(text);
  if (!header) return { path, reason: 'no header' };

  const { name, description } = header;
  if (name.kind === 'unreadable') return { path, reason: unreadable('name') };
  if (name.kind === 'missing' || name.value.trim() === '')
    return { path, reason: 'no name' };
  if (!NAME_RULE.test(name.value))
    return {
      path,
      reason: `name \`${shown(name.value)}\` is not lowercase letters, digits and hyphens`,
    };
  if (name.value.length > MAX_NAME_CHARS)
    return {
      path,
      reason: `name \`${shown(name.value)}\` is over ${MAX_NAME_CHARS} characters`,
    };
  if (name.value !== folder)
    return {
      path,
      reason: `name \`${shown(name.value)}\` is not the folder name \`${shown(folder)}\``,
    };

  if (description.kind === 'unreadable')
    return { path, reason: unreadable('description') };
  if (description.kind === 'missing' || description.value.trim() === '')
    return { path, reason: 'no description' };
  if ([...description.value].length > MAX_DESCRIPTION_CHARS)
    return {
      path,
      reason: `description over ${MAX_DESCRIPTION_CHARS.toLocaleString('en-US')} characters`,
    };
  return null;
}

/** SD12's table, last row: the same name in two `repoSkills` folders, named once, without a path. */
export function duplicateSkill(
  name: string,
  first: string,
  second: string,
): SkillProblem {
  return {
    reason: `\`${shown(name)}\` is in both \`${shown(first)}\` and \`${shown(second)}\``,
  };
}

/** Every broken skill in one error, in the order given (SD12: step skills in step order, then repo skills). */
export function invalidSkills(problems: SkillProblem[]): StepConfigError {
  return new StepConfigError(
    `invalid skills: ${problems
      .map(({ path, reason }) => (path ? `${path}: ${reason}` : reason))
      .join('; ')}`,
  );
}

/** SDW18 for a repo value in a message: no backticks, one line, at most 64 characters. */
export function shown(value: string): string {
  return [...value.replace(/`/g, '').replace(/[\r\n\t]+/g, ' ')]
    .slice(0, MAX_NAME_CHARS)
    .join('');
}

function unreadable(field: string): string {
  return `\`${field}\` written in a form the bot can't read: use plain, quoted or block text`;
}

function isIndented(line: string): boolean {
  return line.length > 0 && (line[0] === ' ' || line[0] === '\t');
}

/** A value: what follows the key's `:` on its line, and its indented (or blank) continuation lines. */
function readValue(rest: string, continuation: string[]): HeaderField {
  const first = rest.trim();
  if (first === '' || first.startsWith('#')) {
    // The value starts on the next line (a plain value), or there is none.
    if (continuation.every((line) => line.trim() === '')) return MISSING;
    return readPlain('', continuation);
  }
  if (first[0] === '"') return readQuoted(rest.trimStart(), continuation, '"');
  if (first[0] === "'") return readQuoted(rest.trimStart(), continuation, "'");
  if (first[0] === '|' || first[0] === '>')
    return readBlock(first, continuation);
  return readPlain(first, continuation);
}

/**
 * A plain value: the first line and every continuation line, joined with spaces (a blank line is a line break);
 * a ` #` comment is dropped (P19). A value that starts with a YAML indicator or holds `: ` is another YAML form.
 */
function readPlain(first: string, continuation: string[]): HeaderField {
  const parts: string[] = [];
  let pendingBreaks = 0;
  for (const raw of [first, ...continuation]) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (parts.length > 0) pendingBreaks++;
      continue;
    }
    if (trimmed.startsWith('#')) break; // a comment line ends the value
    const line = trimmed.replace(/[ \t]+#.*$/, '');
    if (parts.length === 0 && !startsPlain(line)) return UNREADABLE;
    if (/:([ \t]|$)/.test(line)) return UNREADABLE;
    parts.push(
      parts.length === 0
        ? line
        : (pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' ') + line,
    );
    pendingBreaks = 0;
  }
  return parts.length === 0
    ? MISSING
    : { kind: 'value', value: parts.join('') };
}

function startsPlain(line: string): boolean {
  if (NOT_PLAIN_START.has(line[0])) return false;
  // `- `, `? ` and `: ` start a sequence or a mapping; `-x` is a plain value.
  return !/^[-?:]([ \t]|$)/.test(line);
}

/**
 * A single- or double-quoted value, on one line or folded over several (a line break is a space, a blank line a
 * line break). Double quotes know YAML's common escapes; anything after the closing quote but a comment is
 * another YAML form.
 */
function readQuoted(
  first: string,
  continuation: string[],
  quote: '"' | "'",
): HeaderField {
  const lines = [first.slice(1), ...continuation];
  let out = '';
  for (let index = 0; index < lines.length; index++) {
    const line = index === 0 ? lines[0] : lines[index].replace(/^[ \t]+/, '');
    let escapedBreak = false;
    for (let k = 0; k < line.length; k++) {
      const char = line[k];
      if (char === quote) {
        if (quote === "'" && line[k + 1] === "'") {
          out += "'";
          k++;
          continue;
        }
        const after = line.slice(k + 1);
        const rest = lines.slice(index + 1);
        const clean =
          /^([ \t]+#.*)?[ \t]*$/.test(after) &&
          rest.every((l) => l.trim() === '' || l.trim().startsWith('#'));
        return clean ? { kind: 'value', value: out } : UNREADABLE;
      }
      if (char === '\\' && quote === '"') {
        if (k === line.length - 1) {
          escapedBreak = true;
          break;
        }
        const escaped = unescape(line, k);
        if (!escaped) return UNREADABLE;
        out += escaped.text;
        k += escaped.length - 1;
        continue;
      }
      out += char;
    }
    if (index === lines.length - 1) break;
    if (escapedBreak) continue;
    out = out.replace(/[ \t]+$/, '');
    let blanks = 0;
    while (index + 1 < lines.length && lines[index + 1].trim() === '') {
      blanks++;
      index++;
    }
    out += blanks > 0 ? '\n'.repeat(blanks) : ' ';
  }
  return UNREADABLE; // no closing quote
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  ' ': ' ',
};

/** The escape at `line[at]` (a backslash): its text and length, or null for one the reader doesn't know. */
function unescape(
  line: string,
  at: number,
): { text: string; length: number } | null {
  const code = line[at + 1];
  if (code in SIMPLE_ESCAPES) return { text: SIMPLE_ESCAPES[code], length: 2 };
  const digits = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
  const hex = line.slice(at + 2, at + 2 + digits);
  if (digits === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== digits)
    return null;
  const point = Number.parseInt(hex, 16);
  if (point > 0x10ffff) return null;
  return { text: String.fromCodePoint(point), length: 2 + digits };
}

/**
 * A block value: `|` keeps line breaks, `>` folds lines into spaces; `-` drops the final line break, `+` keeps
 * every trailing one (P19). An indentation number, or a line less indented than the first, is another YAML form.
 */
function readBlock(header: string, continuation: string[]): HeaderField {
  const match = /^([|>])([-+]?)([ \t]+#.*)?[ \t]*$/.exec(header);
  if (!match) return UNREADABLE;
  const [, style, chomping] = match;

  const firstContent = continuation.findIndex((line) => line.trim() !== '');
  if (firstContent < 0) return MISSING;
  const indent = /^[ \t]*/.exec(continuation[firstContent])![0].length;
  const body: string[] = [];
  for (const line of continuation) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (/^[ \t]*/.exec(line)![0].length < indent) return UNREADABLE;
    body.push(line.slice(indent));
  }
  let trailing = 0;
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
    trailing++;
  }
  const content = style === '|' ? body.join('\n') : fold(body);
  const ending =
    chomping === '-' ? '' : chomping === '+' ? '\n'.repeat(trailing + 1) : '\n';
  return { kind: 'value', value: content + ending };
}

/** YAML folding: a break between two lines is a space; each blank line is a break; more-indented lines keep theirs. */
function fold(lines: string[]): string {
  let out = '';
  let started = false;
  let previousNormal = false;
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks++;
      continue;
    }
    const normal = !/^[ \t]/.test(line);
    if (!started) out += '\n'.repeat(blanks) + line;
    else if (previousNormal && normal)
      out += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + line;
    else out += '\n' + '\n'.repeat(blanks) + line;
    started = true;
    previousNormal = normal;
    blanks = 0;
  }
  return out;
}
