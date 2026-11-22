import { describe, expect, it } from 'vitest';
import {
  cleanDocument,
  diffBlock,
  DOCUMENT_END,
  DOCUMENT_START,
  documentText,
  lineCounts,
} from './document-text.js';

describe('cleanDocument (SPW20, plan P31)', () => {
  it('removes hidden sdd-agent markers, also one cut off at the end and one inside code', () => {
    expect(
      cleanDocument(
        'A <!-- sdd-agent:spec:x --> b\n```\nc <!-- sdd-agent:document-end -->\n```\nend <!-- sdd-agent:pl',
      ),
    ).toBe('A  b\n```\nc \n```\nend');
  });

  it('keeps an HTML comment that is not an sdd-agent marker', () => {
    expect(cleanDocument('a <!-- note --> b')).toBe('a <!-- note --> b');
  });

  it('puts a mention outside code in backticks and leaves an e-mail address alone', () => {
    expect(
      cleanDocument('Ask @alice or @org/team; mail bob@example.com.'),
    ).toBe('Ask `@alice` or `@org/team`; mail bob@example.com.');
  });

  it('leaves @ in a ``` block, a ~~~ block and inline code as written', () => {
    const text = [
      'Use `@Injectable()` here, as @alice said.',
      '',
      '```ts',
      '@Injectable()',
      'const s = `x`;',
      '```',
      '',
      '~~~js',
      '@Injectable()',
      'const t = `y`;',
      '~~~',
    ].join('\n');
    expect(cleanDocument(text)).toBe(text.replace('@alice', '`@alice`'));
  });

  it('treats a fence that is never closed as code to the end', () => {
    expect(cleanDocument('@bob\n~~~\n@Injectable()')).toBe(
      '`@bob`\n~~~\n@Injectable()',
    );
  });

  it('drops the @ of every mention, not the backtick, when a stray backtick is outside code', () => {
    expect(
      cleanDocument('Press the ` key, @alice.\n\n```ts\n@Injectable()\n```'),
    ).toBe('Press the ` key, alice.\n\n```ts\n@Injectable()\n```');
  });

  it('drops the @ when a stray backslash is outside code', () => {
    expect(cleanDocument('Path C:\\temp, ask \\@bob and `@Inline`')).toBe(
      'Path C:\\temp, ask \\bob and `@Inline`',
    );
  });

  it('keeps a stray backtick as written when there is no mention', () => {
    expect(cleanDocument('Press ` then `code`')).toBe('Press ` then `code`');
  });

  it('turns \\r\\n into \\n and trims', () => {
    expect(cleanDocument('\n  a\r\nb\r\n\n')).toBe('a\nb');
  });
});

describe('documentText (SPW5, plan P17)', () => {
  const comment = (document: string): string =>
    [
      '<!-- sdd-agent:spec:id -->',
      '**Spec v1** · run 2 (`full-sdd`)',
      '',
      'To change it, edit this comment.',
      '',
      DOCUMENT_START,
      document,
      DOCUMENT_END,
      '',
      '---',
      '<sub>Model: `gemini-4-carbon` (standard)</sub>',
    ].join('\n');

  it('is the text between the markers, without header or notes', () => {
    expect(documentText(comment('# Spec\n\nSplit the bill.'))).toBe(
      '# Spec\n\nSplit the bill.',
    );
  });

  it('reads back what cleanDocument stored', () => {
    const text = cleanDocument('# Spec\r\n\r\nAsk @alice.\n');
    expect(documentText(comment(text))).toBe(text);
  });

  it('is the whole comment without hidden markers when the start marker was removed', () => {
    const body = comment('Split.').replace(DOCUMENT_START, '');
    expect(documentText(body)).toBe(
      [
        '**Spec v1** · run 2 (`full-sdd`)',
        '',
        'To change it, edit this comment.',
        '',
        '',
        'Split.',
        '',
        '',
        '---',
        '<sub>Model: `gemini-4-carbon` (standard)</sub>',
      ].join('\n'),
    );
  });

  it('is the whole comment without hidden markers when the end marker was removed', () => {
    const body = comment('Split.').replace(DOCUMENT_END, '');
    expect(documentText(body)).toContain('**Spec v1**');
    expect(documentText(body)).not.toContain('sdd-agent');
  });

  it('counts the first start and the last end marker when a human typed more of them', () => {
    const body = comment(`a\n${DOCUMENT_END}\nb\n${DOCUMENT_START}\nc`);
    expect(documentText(body)).toBe('a\n\nb\n\nc');
  });

  it('gives the same text for an edit saved with \\r\\n', () => {
    const lf = comment('# Spec\n\nSplit the bill.\nRound down.');
    expect(documentText(lf.replaceAll('\n', '\r\n'))).toBe(documentText(lf));
  });

  it('is empty when nothing is left between the markers, or the comment is empty', () => {
    expect(documentText(comment('  \n '))).toBe('');
    expect(documentText('')).toBe('');
  });
});

describe('lineCounts (SPW14)', () => {
  const posted = 'a\nb\nc\nd';

  it('is 0 and 0 for the text as posted', () => {
    expect(lineCounts(posted, posted)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    });
  });

  it('is 1 and 1 for one line edited', () => {
    expect(lineCounts(posted, 'a\nB\nc\nd')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  it('counts a line added and a line removed', () => {
    expect(lineCounts(posted, 'a\nc\nd\ne')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(lineCounts(posted, 'a\nb\nc\nd\ne\nf')).toEqual({
      linesAdded: 2,
      linesRemoved: 0,
    });
  });

  it('is 0 and 0 when only the line ends changed', () => {
    expect(lineCounts(posted, 'a\r\nb\r\nc\r\nd\r\n')).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    });
  });
});

describe('diffBlock (plan P1)', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}.`);
  const before = lines.join('\n');

  it('shows a one-line change in 40 lines as one hunk with 2 unchanged lines around it', () => {
    const after = before.replace('Line 14.', 'Line fourteen.');
    expect(diffBlock(before, after)).toBe(
      [
        '```diff',
        '@@ -12,5 +12,5 @@',
        ' Line 12.',
        ' Line 13.',
        '-Line 14.',
        '+Line fourteen.',
        ' Line 15.',
        ' Line 16.',
        '```',
      ].join('\n'),
    );
  });

  it('shows changes far apart as two hunks, with no file lines', () => {
    const after = before
      .replace('Line 3.', 'Line three.')
      .replace('Line 30.', 'Line thirty.');
    const block = diffBlock(before, after) ?? '';
    expect(block.match(/^@@ /gm)).toHaveLength(2);
    expect(block).not.toMatch(/^(---|\+\+\+|Index:|=+$)/m);
  });

  it('uses a fence one backtick longer than the longest run inside', () => {
    const block = diffBlock('a\n````\nb', 'a\n````\nc') ?? '';
    expect(block.startsWith('`````diff\n')).toBe(true);
    expect(block.endsWith('\n`````')).toBe(true);
  });

  it('is null when the texts are the same, also when only line ends differ', () => {
    expect(diffBlock(before, before)).toBeNull();
    expect(
      diffBlock(before, `${before.replaceAll('\n', '\r\n')}\n`),
    ).toBeNull();
  });
});
