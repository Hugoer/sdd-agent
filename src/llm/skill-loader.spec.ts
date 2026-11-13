import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepoProvider } from '../../test/fakes/in-memory-repo-provider.js';
import { StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import { SKILL_BYTES_LIMIT, listSkill, loadSkill } from './skill-loader.js';
import type { WorkflowConfig } from './workflow-config.js';

const DIR = '.github-agent/skills/spec';
const SKILLS: WorkflowConfig['skills'] = { spec: DIR, code: `${DIR}-code/` };

/** A repo whose `main` holds the given files under the spec skill; returns it with the SHA of `main`. */
async function repoWith(files: Record<string, string>) {
  const repo = new InMemoryRepoProvider();
  repo.seedFile('main', 'README.md', 'not a skill');
  for (const [path, text] of Object.entries(files))
    repo.seedFile('main', `${DIR}/${path}`, text);
  const commit = await repo.resolveRef('main');
  repo.calls.length = 0;
  return { repo, commit };
}

function quietLogger() {
  return { log: vi.fn<(message: string) => void>() };
}

async function failureOf(promise: Promise<unknown>): Promise<StepConfigError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the skill to fail');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StepConfigError);
  return error as StepConfigError;
}

describe('loadSkill', () => {
  it('SKILL.md first, then the other files by path, relative to the skill; every read at the commit', async () => {
    const { repo, commit } = await repoWith({
      'z-notes.md': 'z',
      'SKILL.md': '# Spec skill',
      'examples/b.md': 'b',
      'a.sh': 'echo never run',
    });

    const skill = await loadSkill(repo, SKILLS, 'spec', commit, quietLogger());

    expect(skill).toEqual({
      step: 'spec',
      path: DIR,
      commit,
      files: [
        { path: 'SKILL.md', text: '# Spec skill' },
        { path: 'a.sh', text: 'echo never run' },
        { path: 'examples/b.md', text: 'b' },
        { path: 'z-notes.md', text: 'z' },
      ],
    });
    expect(repo.calls.map((call) => call.args[0])).toEqual(
      Array<string>(5).fill(commit),
    );
    expect(repo.calls.map((call) => call.method)).toEqual([
      'listFiles',
      'readFile',
      'readFile',
      'readFile',
      'readFile',
    ]);
  });

  it('accepts a mapped directory with a trailing slash', async () => {
    const repo = new InMemoryRepoProvider();
    repo.seedFile('main', `${DIR}-code/SKILL.md`, 'code skill');
    const commit = await repo.resolveRef('main');

    const skill = await loadSkill(repo, SKILLS, 'code', commit, quietLogger());

    expect(skill.files).toEqual([{ path: 'SKILL.md', text: 'code skill' }]);
  });

  it('leaves out known binary types in any letter case, never reading them, and logs them without content', async () => {
    const { repo, commit } = await repoWith({
      'SKILL.md': 'secret-looking skill text',
      'assets/logo.PNG': 'binary',
      'docs/guide.Pdf': 'binary',
      'fonts/a.woff2': 'binary',
      'bundle.tar.gz': 'binary',
      'notes.txt': 'kept',
    });
    const logger = quietLogger();

    const skill = await loadSkill(repo, SKILLS, 'spec', commit, logger);

    expect(skill.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'notes.txt',
    ]);
    expect(
      repo.calls.filter((call) => call.method === 'readFile'),
    ).toHaveLength(2);
    expect(logger.log.mock.calls).toEqual([
      [
        `skill spec @${commit.slice(0, 7)}: 2 files, 29 chars, skipped 4 ` +
          '(assets/logo.PNG, bundle.tar.gz, docs/guide.Pdf, fonts/a.woff2)',
      ],
    ]);
    expect(String(logger.log.mock.calls[0][0])).not.toContain('skill text');
  });

  it('logs "1 file" and "skipped 0" for a one-file skill', async () => {
    const { repo, commit } = await repoWith({ 'SKILL.md': 'ok' });
    const logger = quietLogger();

    await loadSkill(repo, SKILLS, 'spec', commit, logger);

    expect(logger.log).toHaveBeenCalledWith(
      `skill spec @${commit.slice(0, 7)}: 1 file, 2 chars, skipped 0`,
    );
  });

  it.each<[string, Record<string, string>, WorkflowConfig['skills']]>([
    ['no entry in skills', { 'SKILL.md': 'x' }, { code: DIR }],
    ['no such directory', {}, SKILLS],
    ['no SKILL.md at the root', { 'docs/SKILL.md': 'x', 'a.md': 'a' }, SKILLS],
    ['skill.md in another letter case', { 'skill.md': 'x' }, SKILLS],
    ['an empty SKILL.md', { 'SKILL.md': '' }, SKILLS],
    ['a whitespace-only SKILL.md', { 'SKILL.md': ' \n\t\n' }, SKILLS],
  ])('%s → missing skills: spec', async (_name, files, skills) => {
    const { repo, commit } = await repoWith(files);

    const error = await failureOf(
      loadSkill(repo, skills, 'spec', commit, quietLogger()),
    );

    expect(error.message).toBe('missing skills: spec');
  });

  it('too large from the listing: no file is read', async () => {
    const { repo, commit } = await repoWith({
      'SKILL.md': 'x'.repeat(SKILL_BYTES_LIMIT - 10),
      'more.md': 'y'.repeat(11),
      'big.png': 'z'.repeat(500_000), // skipped: does not count
    });

    const error = await failureOf(
      loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
    );

    expect(error.message).toBe(
      'skill too large: spec (204,801 bytes, limit 204,800)',
    );
    expect(repo.calls.map((call) => call.method)).toEqual(['listFiles']);
  });

  it('exactly at the limit is allowed', async () => {
    const { repo, commit } = await repoWith({
      'SKILL.md': 'x'.repeat(SKILL_BYTES_LIMIT),
    });

    await expect(
      loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
    ).resolves.toMatchObject({ step: 'spec' });
  });

  it.each<[string, ProviderError]>([
    [
      'over 1 MB or not valid UTF-8 (permanent, no status)',
      new ProviderError(
        `readFile ${DIR}/notes.md at x: not valid UTF-8`,
        'permanent',
      ),
    ],
  ])(
    'a file that is %s → unreadable skill file: <path>',
    async (_name, raised) => {
      const { repo, commit } = await repoWith({
        'SKILL.md': 'ok',
        'notes.md': 'n',
      });
      const read = repo.readFile.bind(repo);
      vi.spyOn(repo, 'readFile').mockImplementation((ref, path) =>
        path.endsWith('notes.md') ? Promise.reject(raised) : read(ref, path),
      );

      const error = await failureOf(
        loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
      );

      expect(error.message).toBe(`unreadable skill file: ${DIR}/notes.md`);
    },
  );

  it('a listed file that reads as missing → unreadable skill file', async () => {
    const { repo, commit } = await repoWith({
      'SKILL.md': 'ok',
      'gone.md': 'g',
    });
    const read = repo.readFile.bind(repo);
    vi.spyOn(repo, 'readFile').mockImplementation((ref, path) =>
      path.endsWith('gone.md') ? Promise.resolve(null) : read(ref, path),
    );

    const error = await failureOf(
      loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
    );

    expect(error.message).toBe(`unreadable skill file: ${DIR}/gone.md`);
  });

  it.each<[string, ProviderError]>([
    [
      'an outage',
      new ProviderError('GitHub GET … → 503', 'transient', { status: 503 }),
    ],
    [
      'a 404',
      new ProviderError('GitHub GET … → 404', 'permanent', { status: 404 }),
    ],
    [
      'a 403',
      new ProviderError('GitHub GET … → 403', 'permanent', { status: 403 }),
    ],
  ])(
    'a GitHub failure (%s) passes through unchanged',
    async (_name, raised) => {
      const { repo, commit } = await repoWith({ 'SKILL.md': 'ok' });
      vi.spyOn(repo, 'readFile').mockRejectedValue(raised);

      await expect(
        loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
      ).rejects.toBe(raised);
    },
  );

  it('a GitHub failure on the listing passes through unchanged', async () => {
    const { repo, commit } = await repoWith({ 'SKILL.md': 'ok' });
    const down = new ProviderError('GitHub GET … → 502', 'transient', {
      status: 502,
    });
    repo.failNext(down);

    await expect(
      loadSkill(repo, SKILLS, 'spec', commit, quietLogger()),
    ).rejects.toBe(down);
  });
});

describe('listSkill', () => {
  it('lists without reading: SKILL.md first, the binary files apart', async () => {
    const { repo, commit } = await repoWith({
      'b.md': 'b',
      'SKILL.md': 'skill',
      'logo.png': 'p',
    });

    const listing = await listSkill(repo, SKILLS, 'spec', commit);

    expect(listing).toEqual({
      step: 'spec',
      dir: DIR,
      files: [
        { path: `${DIR}/SKILL.md`, size: 5, executable: false },
        { path: `${DIR}/b.md`, size: 1, executable: false },
      ],
      skipped: [{ path: `${DIR}/logo.png`, size: 1, executable: false }],
    });
    expect(repo.calls.map((call) => call.method)).toEqual(['listFiles']);
  });

  it('null for a missing skill (the caller names it)', async () => {
    const { repo, commit } = await repoWith({ 'SKILL.md': 'x' });

    await expect(listSkill(repo, SKILLS, 'plan', commit)).resolves.toBeNull();
  });
});
