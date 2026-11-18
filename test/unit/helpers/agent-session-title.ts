import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DetectOptions } from '../../../src/cli/session/detect';
import {
  readClaudeSessionTitle,
  readCodexSessionTitle,
} from '../../../src/cli/session/session-title';

export const sessionTitleAgents = [
  {
    agent: 'claude',
    markerEnv: 'CLAUDECODE',
    sessionEnv: 'CLAUDE_CODE_SESSION_ID',
    env: (id: string) => ({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id }),
    file: (root: string, id: string) => join(root, 'proj-a', `${id}.jsonl`),
    titleLine: (id: string, title: unknown) =>
      JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }),
    untitledLine: (id: string) =>
      JSON.stringify({ type: 'user', content: 'hi', sessionId: id }),
    read: (id: string, root: string) =>
      readClaudeSessionTitle(id, { projectsDir: root }),
    detection: (id: string, root: string): DetectOptions => ({
      env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id },
      readTitle: (sessionId) =>
        readClaudeSessionTitle(sessionId, { projectsDir: root }),
    }),
  },
  {
    agent: 'codex',
    markerEnv: 'CODEX_BIN_PATH',
    sessionEnv: 'CODEX_THREAD_ID',
    env: (id: string) => ({ CODEX_THREAD_ID: id }),
    file: (root: string, _id: string) => join(root, 'session_index.jsonl'),
    titleLine: (id: string, title: unknown) =>
      JSON.stringify({
        id,
        thread_name: title,
        updated_at: '2026-09-12T00:00:00Z',
      }),
    untitledLine: (id: string) => JSON.stringify({ id, preview: 'hi' }),
    read: (id: string, root: string) =>
      readCodexSessionTitle(id, { codexHome: root }),
    // Exercise production reader dispatch, including its CODEX_HOME wiring.
    detection: (id: string, root: string): DetectOptions => ({
      env: { CODEX_THREAD_ID: id, CODEX_HOME: root },
    }),
  },
] as const;

export function writeSessionTitleFixture(
  fixture: (typeof sessionTitleAgents)[number],
  root: string,
  id: string,
  lines: string[],
): void {
  const file = fixture.file(root, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}
