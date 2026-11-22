import { describe, expect, it } from 'vitest';
import { specComment, specMarker } from './document-comments.js';
import { documentText } from './document-text.js';

const COMMIT = '4f2c1ab'.padEnd(40, 'e');
const NOTES = [
  'Model: `gemini-4-carbon` (standard)',
  'Read: skill `money-rules` (`SKILL.md`), `src/index.ts`',
];

describe('specComment (spec "The document comment")', () => {
  it('full-sdd: marker, header, the Plan line, the document between its markers, the notes', () => {
    expect(
      specComment({
        versionId: 'v-1',
        version: 1,
        run: { number: 2, lane: 'full-sdd' },
        base: 'main',
        commit: COMMIT,
        text: '# Spec\n\nSplit evenly.',
        notes: NOTES,
      }),
    ).toBe(
      [
        '<!-- sdd-agent:spec:v-1 -->',
        '**Spec v1** · run 2 (`full-sdd`) · read at `main` @ `4f2c1ab`',
        '',
        "To change it, edit this comment. When it's right, an Approver (Write access) comments `/approve` and the " +
          "bot writes the Plan from the text as it reads then. `/refresh` checks it against today's `main`.",
        '',
        '<!-- sdd-agent:document -->',
        '# Spec',
        '',
        'Split evenly.',
        '<!-- sdd-agent:document-end -->',
        '',
        '---',
        '<sub>Model: `gemini-4-carbon` (standard)</sub>',
        '<sub>Read: skill `money-rules` (`SKILL.md`), `src/index.ts`</sub>',
      ].join('\n'),
    );
  });

  it('spec-code: the approval starts the code; another base branch is named', () => {
    const body = specComment({
      versionId: 'v-2',
      version: 1,
      run: { number: 1, lane: 'spec-code' },
      base: 'develop',
      commit: COMMIT,
      text: 'x',
      notes: [],
    });

    expect(body).toContain(
      '**Spec v1** · run 1 (`spec-code`) · read at `develop` @ `4f2c1ab`',
    );
    expect(body).toContain(
      'comments `/approve` and the bot starts coding from the text as it reads then. `/refresh` checks it against ' +
        "today's `develop`.",
    );
    expect(body).not.toContain('---');
  });

  it('starts with its marker, and the document reads back as stored', () => {
    const body = specComment({
      versionId: 'v-3',
      version: 1,
      run: { number: 1, lane: 'full-sdd' },
      base: 'main',
      commit: COMMIT,
      text: '# Spec\n\nAsk `@alice`.',
      notes: NOTES,
    });

    expect(body.startsWith(specMarker('v-3'))).toBe(true);
    expect(documentText(body)).toBe('# Spec\n\nAsk `@alice`.');
  });
});
