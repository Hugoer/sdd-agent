import { describe, expect, it } from 'vitest';
import { StepConfigError } from '../contracts/llm-error.js';
import {
  NOT_TEXT,
  checkSkillHeader,
  duplicateSkill,
  invalidSkills,
  readSkillHeader,
  shown,
} from './skill-header.js';

const PATH = '.claude/skills/money-rules/SKILL.md';
const FOLDER = 'money-rules';
const DESCRIPTION =
  'How this project stores, splits and rounds money amounts. Use when an issue adds, splits or rounds amounts.';

/** A SKILL.md with the given header lines and a body. */
function skill(...header: string[]): string {
  return [
    '---',
    ...header,
    '---',
    '',
    '# Money rules',
    'Amounts are integer cents.',
  ].join('\n');
}

function problemOf(text: string, folder = FOLDER): string | undefined {
  return checkSkillHeader(PATH, folder, text)?.reason;
}

function valueOf(text: string, field: 'name' | 'description'): unknown {
  const header = readSkillHeader(text);
  return header?.[field].kind === 'value'
    ? header[field].value
    : header?.[field].kind;
}

describe('checkSkillHeader: SD12, one test per row of the table', () => {
  it('a valid header → no problem', () => {
    expect(
      checkSkillHeader(
        PATH,
        FOLDER,
        skill(`name: ${FOLDER}`, `description: ${DESCRIPTION}`),
      ),
    ).toBeNull();
  });

  it.each([
    [
      'the file does not start with ---',
      `# Money rules\n---\nname: ${FOLDER}\n---`,
    ],
    [
      'a blank line before the header',
      `\n---\nname: ${FOLDER}\ndescription: d\n---`,
    ],
    ['no closing ---', `---\nname: ${FOLDER}\ndescription: d\n# Money rules`],
    ['an empty file', ''],
  ])('%s → no header', (_name, text) => {
    expect(problemOf(text)).toBe('no header');
  });

  it.each([
    ['no name key', skill(`description: ${DESCRIPTION}`)],
    ['an empty name', skill('name:', `description: ${DESCRIPTION}`)],
    ['a quoted empty name', skill('name: ""', `description: ${DESCRIPTION}`)],
    [
      'a name of spaces only',
      skill("name: '   '", `description: ${DESCRIPTION}`),
    ],
    [
      'a name that is only a comment',
      skill('name: # todo', `description: ${DESCRIPTION}`),
    ],
  ])('%s → no name', (_name, text) => {
    expect(problemOf(text)).toBe('no name');
  });

  it.each([
    ['Money Rules', 'Money Rules'],
    ['money_rules', 'money_rules'],
    ['-money-rules', '-money-rules'],
    ['money-rules-', 'money-rules-'],
    ['money--rules', 'money--rules'],
    ['règles', 'règles'],
  ])(
    'name %s → not lowercase letters, digits and hyphens',
    (value, shownValue) => {
      expect(
        problemOf(skill(`name: ${value}`, `description: ${DESCRIPTION}`)),
      ).toBe(
        `name \`${shownValue}\` is not lowercase letters, digits and hyphens`,
      );
    },
  );

  it('a 65-character name → over 64 characters, the value cut at 64; 64 is fine', () => {
    const long = 'a'.repeat(65);
    expect(
      problemOf(skill(`name: ${long}`, `description: ${DESCRIPTION}`), long),
    ).toBe(`name \`${'a'.repeat(64)}\` is over 64 characters`);
    const max = 'a'.repeat(64);
    expect(
      problemOf(skill(`name: ${max}`, `description: ${DESCRIPTION}`), max),
    ).toBeUndefined();
  });

  it('a name that is not the folder name → names both', () => {
    expect(problemOf(skill('name: money', `description: ${DESCRIPTION}`))).toBe(
      'name `money` is not the folder name `money-rules`',
    );
  });

  it.each([
    ['no description key', skill(`name: ${FOLDER}`)],
    ['an empty description', skill(`name: ${FOLDER}`, 'description:')],
    ['a description of spaces', skill(`name: ${FOLDER}`, 'description: "  "')],
    [
      'an empty block description',
      skill(`name: ${FOLDER}`, 'description: >', ''),
    ],
  ])('%s → no description', (_name, text) => {
    expect(problemOf(text)).toBe('no description');
  });

  it('a description over 1,024 characters → its reason; exactly 1,024 is fine', () => {
    expect(
      problemOf(skill(`name: ${FOLDER}`, `description: ${'d'.repeat(1025)}`)),
    ).toBe('description over 1,024 characters');
    expect(
      problemOf(skill(`name: ${FOLDER}`, `description: ${'d'.repeat(1024)}`)),
    ).toBeUndefined();
  });

  it.each([
    ['a flow mapping', 'description: {a: b}', 'description'],
    ['a flow sequence', 'description: [a, b]', 'description'],
    ['an anchor', `name: &n ${FOLDER}`, 'name'],
    ['an alias', 'name: *n', 'name'],
    ['a tag', `name: !!str ${FOLDER}`, 'name'],
    ['a sequence', 'description:\n  - one\n  - two', 'description'],
    [
      'a mapping inside a plain value',
      'description: Use when: an issue splits money',
      'description',
    ],
    ['a key written twice', `name: ${FOLDER}\nname: ${FOLDER}`, 'name'],
    [
      'an indentation number on a block',
      'description: |2\n    Indented text',
      'description',
    ],
    ['text after a closing quote', 'description: "Money" rules', 'description'],
    ['no closing quote', 'description: "Money rules', 'description'],
    ['an unknown escape', 'description: "Money \\q rules"', 'description'],
  ])('%s → written in a form the bot can not read', (_name, line, field) => {
    const lines =
      field === 'name'
        ? [line, `description: ${DESCRIPTION}`]
        : [`name: ${FOLDER}`, line];
    expect(problemOf(skill(...lines))).toBe(
      `\`${field}\` written in a form the bot can't read: use plain, quoted or block text`,
    );
  });

  it('the name is checked before the description: one reason per skill', () => {
    expect(problemOf(skill('name: Money Rules'))).toBe(
      'name `Money Rules` is not lowercase letters, digits and hyphens',
    );
  });

  it('a header value with backticks, line breaks and over 64 characters is cleaned and cut (SDW18)', () => {
    const value = `\`@everyone\` ${'X'.repeat(80)}`;
    expect(
      problemOf(skill(`name: "${value}"`, `description: ${DESCRIPTION}`)),
    ).toBe(
      `name \`${`@everyone ${'X'.repeat(80)}`.slice(0, 64)}\` is not lowercase letters, digits and hyphens`,
    );
    expect(shown('a\nb`c')).toBe('a bc');
  });

  it('the optional fields are neither checked nor used', () => {
    expect(
      problemOf(
        skill(
          `name: ${FOLDER}`,
          `description: ${DESCRIPTION}`,
          'license: Proprietary. LICENSE.txt has complete terms',
          'metadata: {author: x}',
          'allowed-tools: Bash(git:*) Read',
          'compatibility:',
          '  - anything',
        ),
      ),
    ).toBeUndefined();
  });
});

describe('readSkillHeader: the forms (SDW16, P19)', () => {
  it.each([
    [
      'plain',
      'description: Splits and rounds money.',
      'Splits and rounds money.',
    ],
    [
      'double-quoted',
      'description: "Splits: and rounds \\"money\\"."',
      'Splits: and rounds "money".',
    ],
    [
      'double-quoted escapes',
      'description: "a\\tb\\u00e9\\x41\\\\"',
      'a\tbéA\\',
    ],
    [
      'single-quoted',
      "description: 'It''s money: cents.'",
      "It's money: cents.",
    ],
    [
      'a trailing # comment after a plain value',
      'description: Splits money # the short one',
      'Splits money',
    ],
    [
      'a # inside a word',
      'description: Issue#12 splits money',
      'Issue#12 splits money',
    ],
    [
      'a comment after a quoted value',
      'description: "Splits money" # quoted',
      'Splits money',
    ],
    [
      'a URL in a plain value',
      'description: See https://example.com/x',
      'See https://example.com/x',
    ],
  ])('%s', (_name, line, expected) => {
    expect(valueOf(skill(`name: ${FOLDER}`, line), 'description')).toBe(
      expected,
    );
  });

  it('a plain value continued on indented lines is joined with spaces; a blank line is a line break', () => {
    expect(
      valueOf(
        skill(
          `name: ${FOLDER}`,
          'description: Splits and',
          '  rounds money.',
          '',
          '  Use always.',
        ),
        'description',
      ),
    ).toBe('Splits and rounds money.\nUse always.');
    expect(
      valueOf(
        skill(`name: ${FOLDER}`, 'description:', '  Starts on the next line.'),
        'description',
      ),
    ).toBe('Starts on the next line.');
  });

  it('a quoted value over several lines folds into spaces', () => {
    expect(
      valueOf(
        skill(
          `name: ${FOLDER}`,
          'description: "Splits and',
          '  rounds money."',
        ),
        'description',
      ),
    ).toBe('Splits and rounds money.');
  });

  it.each([
    ['|', ['  Line one', '  Line two', ''], 'Line one\nLine two\n'],
    ['|-', ['  Line one', '  Line two'], 'Line one\nLine two'],
    ['|+', ['  Line one', '', ''], 'Line one\n\n\n'],
    [
      '>',
      ['  Splits and', '  rounds money.', '', '  Use always.'],
      'Splits and rounds money.\nUse always.\n',
    ],
    ['>-', ['  Splits and', '  rounds money.'], 'Splits and rounds money.'],
    ['> # a comment', ['  Splits money.'], 'Splits money.\n'],
  ])('a %s block', (indicator, lines, expected) => {
    expect(
      valueOf(
        skill(`name: ${FOLDER}`, `description: ${indicator}`, ...lines),
        'description',
      ),
    ).toBe(expected);
  });

  it('a block name is read too', () => {
    expect(
      valueOf(
        skill('name: >-', `  ${FOLDER}`, `description: ${DESCRIPTION}`),
        'name',
      ),
    ).toBe(FOLDER);
  });

  it('CRLF line ends and a leading byte-order mark are accepted', () => {
    const text = `\uFEFF---\r\nname: ${FOLDER}\r\ndescription: >-\r\n  Splits\r\n  money.\r\n---\r\nBody\r\n`;
    expect(readSkillHeader(text)).toEqual({
      name: { kind: 'value', value: FOLDER },
      description: { kind: 'value', value: 'Splits money.' },
    });
    expect(checkSkillHeader(PATH, FOLDER, text)).toBeNull();
  });

  it('only the first two --- lines bound the header; a later --- is body text', () => {
    const text =
      skill(`name: ${FOLDER}`, `description: ${DESCRIPTION}`) +
      '\n---\nname: other\n---';
    expect(valueOf(text, 'name')).toBe(FOLDER);
  });

  it('a missing field is missing; no header is null', () => {
    expect(readSkillHeader(skill(`name: ${FOLDER}`))?.description).toEqual({
      kind: 'missing',
    });
    expect(readSkillHeader('# no header')).toBeNull();
  });
});

describe('invalidSkills and duplicateSkill', () => {
  it('several broken skills → one StepConfigError, in the order given, the duplicate named once without a path', () => {
    const error = invalidSkills([
      {
        path: '.github-agent/skills/spec/SKILL.md',
        reason: 'name `Spec` is not lowercase letters, digits and hyphens',
      },
      { path: '.claude/skills/no-desc/SKILL.md', reason: 'no description' },
      duplicateSkill('money-rules', '.claude/skills', '.agents/skills'),
      { path: '.claude/skills/bin/SKILL.md', reason: NOT_TEXT },
    ]);

    expect(error).toBeInstanceOf(StepConfigError);
    expect(error.message).toBe(
      'invalid skills: .github-agent/skills/spec/SKILL.md: name `Spec` is not lowercase letters, digits and ' +
        'hyphens; .claude/skills/no-desc/SKILL.md: no description; `money-rules` is in both `.claude/skills` and ' +
        '`.agents/skills`; .claude/skills/bin/SKILL.md: not text',
    );
  });
});
