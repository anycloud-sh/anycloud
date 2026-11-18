import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { readCodexSessionTitle } from '../../../src/cli/session/session-title';
import {
  sessionTitleAgents,
  writeSessionTitleFixture,
} from '../helpers/agent-session-title';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const realHome = homedir();
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-title-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(homedir).mockReturnValue(realHome);
  rmSync(root, { recursive: true, force: true });
});

describe.each(sessionTitleAgents)('$agent session title reader', (fixture) => {
  const id = 'sess-1';
  const write = (lines: string[]) =>
    writeSessionTitleFixture(fixture, root, id, lines);
  const read = () => fixture.read(id, root);

  it('reads the latest title among unrelated records', () => {
    write([
      fixture.untitledLine(id),
      fixture.titleLine(id, 'First title'),
      fixture.untitledLine(id),
      fixture.titleLine(id, 'Latest title'),
      fixture.untitledLine(id),
    ]);
    expect(read()).toBe('Latest title');
  });

  it('reads a renamed title on the next lookup', () => {
    write([fixture.titleLine(id, 'First name')]);
    expect(read()).toBe('First name');
    appendFileSync(fixture.file(root, id), fixture.titleLine(id, 'New name'));
    expect(read()).toBe('New name');
  });

  it('sanitizes control characters and whitespace while preserving Unicode', () => {
    write([fixture.titleLine(id, '\u0000  Plan\tParis\nRésumé\u007f 🦀  ')]);
    expect(read()).toBe('Plan Paris Résumé 🦀');
  });

  it.each([undefined, null, 42, {}, [], '', ' \t\n\u0000'])(
    'returns null for an unusable title (%j)',
    (title) => {
      write([fixture.titleLine(id, title)]);
      expect(read()).toBeNull();
    },
  );

  it('does not revive an older title when the latest sanitizes to empty', () => {
    write([
      fixture.titleLine(id, 'Old name'),
      fixture.titleLine(id, ' \u0000 '),
    ]);
    expect(read()).toBeNull();
  });

  it('omits the label before a title is written, without deriving a prompt', () => {
    write([fixture.untitledLine(id)]);
    expect(read()).toBeNull();
  });

  it('returns null for a missing file or root', () => {
    expect(read()).toBeNull();
    expect(fixture.read(id, join(root, 'missing'))).toBeNull();
  });

  it('returns null for an unreadable title file', () => {
    mkdirSync(fixture.file(root, id), { recursive: true });
    expect(read()).toBeNull();
  });

  it('skips malformed and incomplete records after a valid title', () => {
    write([
      fixture.titleLine(id, 'Good title'),
      fixture.titleLine(id, 42),
      fixture.titleLine(id, null),
      '{ broken json',
      'null',
      '[]',
      fixture.titleLine(id, 'Partial title').slice(0, -2),
    ]);
    expect(read()).toBe('Good title');
  });

  it('never extracts nested title fields from another record', () => {
    write([
      JSON.stringify({ aiTitle: 'Stray title', thread_name: 'Stray title' }),
      JSON.stringify({
        type: 'tool-result',
        payload: JSON.parse(fixture.titleLine(id, 'Nested title')),
      }),
    ]);
    expect(read()).toBeNull();
  });

  it.each(['', '../escape', '/absolute'])('rejects unsafe ids (%j)', (id) => {
    expect(fixture.read(id, root)).toBeNull();
  });
});

describe('Claude title precedence', () => {
  const fixture = sessionTitleAgents[0];
  const id = 'claude-session';
  const customTitle = (title: string) =>
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id });

  it('prefers the latest custom-title even when a newer ai-title exists', () => {
    writeSessionTitleFixture(fixture, root, id, [
      customTitle('First name'),
      fixture.titleLine(id, 'Auto generated title'),
      customTitle('My renamed session'),
      fixture.titleLine(id, 'Later auto title'),
    ]);
    expect(fixture.read(id, root)).toBe('My renamed session');
  });

  it.each([
    'hi',
    '<system_instruction>You are working inside Conductor…</system_instruction>\n\ndeploy the training run',
  ])('does not derive an untitled SDK session label from %j', (prompt) => {
    writeSessionTitleFixture(fixture, root, id, [
      JSON.stringify({ type: 'queue-operation', operation: 'add' }),
      JSON.stringify({
        type: 'user',
        cwd: '/',
        message: { role: 'user', content: prompt },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: 'Failed to authenticate. API Error: 401' },
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: prompt }),
    ]);
    expect(fixture.read(id, root)).toBeNull();
  });
});

describe('Codex thread index', () => {
  const fixture = sessionTitleAgents[1];
  const id = 'codex-thread';

  it('matches the exact thread id among interleaved names and renames', () => {
    writeSessionTitleFixture(fixture, root, id, [
      fixture.titleLine('another-thread', 'Other name'),
      fixture.titleLine(id, 'First name'),
      fixture.titleLine('another-thread', 'Other rename'),
      fixture.titleLine(id, 'Renamed thread'),
      fixture.titleLine(`${id}-suffix`, 'Wrong prefix match'),
    ]);
    expect(fixture.read(id, root)).toBe('Renamed thread');
    expect(fixture.read('another-thread', root)).toBe('Other rename');
    expect(fixture.read('missing-thread', root)).toBeNull();
  });

  it('resolves CODEX_HOME on each call and allows an explicit override', () => {
    const otherHome = join(root, 'other-home');
    writeSessionTitleFixture(fixture, root, id, [
      fixture.titleLine(id, 'First home'),
    ]);
    writeSessionTitleFixture(fixture, otherHome, id, [
      fixture.titleLine(id, 'Other home'),
    ]);
    vi.stubEnv('CODEX_HOME', root);
    expect(readCodexSessionTitle(id)).toBe('First home');
    vi.stubEnv('CODEX_HOME', otherHome);
    expect(readCodexSessionTitle(id)).toBe('Other home');
    expect(readCodexSessionTitle(id, { codexHome: root })).toBe('First home');
  });

  it.each([undefined, ''])(
    'defaults an unset or empty CODEX_HOME (%j)',
    (home) => {
      vi.stubEnv('CODEX_HOME', home);
      vi.mocked(homedir).mockReturnValue(root);
      writeSessionTitleFixture(fixture, join(root, '.codex'), id, [
        fixture.titleLine(id, 'Default home'),
      ]);
      expect(readCodexSessionTitle(id)).toBe('Default home');
    },
  );
});
