import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readClaudeSessionTitle,
  readCodexSessionTitle,
} from '../../../src/cli/session/session-title';
import { startCanaryProcess } from './agent-canary-process';
import { connectClaudeSession } from './claude-session';
import { connectCodexAppServer } from './codex-app-server';
import {
  claudeCanaryEnvironment,
  claudeMetadataEnvironment,
} from './claude-auth';
import { isRecord, parseJson } from './json';

const CLAUDE_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 5_000;
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function findClaudeTranscript(
  sessionId: string,
  projectsDir: string,
): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function createClaudeTitleSession(
  mode: 'metadata' | 'generated' = 'metadata',
) {
  // Only the generated-title test needs authentication or a model request.
  const authenticatedEnv =
    mode === 'generated' ? claudeCanaryEnvironment(process.env) : undefined;
  const root = mkdtempSync(join(tmpdir(), 'anycloud-claude-title-'));
  const sessionId = randomUUID();
  const configDir = join(root, 'claude');
  const projectsDir =
    mode === 'metadata' ? join(configDir, 'projects') : PROJECTS_DIR;
  const env =
    mode === 'metadata'
      ? claudeMetadataEnvironment(process.env, configDir)
      : {
          ...authenticatedEnv,
          MAX_THINKING_TOKENS: '0',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128',
        };
  let running: ReturnType<typeof startCanaryProcess> | undefined;
  let client: ReturnType<typeof connectClaudeSession> | undefined;

  function start() {
    if (client) return client;
    const args = [
      '--print',
      '--session-id',
      sessionId,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ];
    if (mode === 'metadata') {
      mkdirSync(configDir);
      args.push('--bare');
    } else {
      args.push(
        '--safe-mode',
        '--model',
        'haiku',
        '--system-prompt',
        'Answer briefly.',
        '--max-turns',
        '1',
      );
    }
    running = startCanaryProcess(
      process.env.CLAUDE_CODE_EXECPATH ?? 'claude',
      args,
      { cwd: root, env },
    );
    client = connectClaudeSession(running, sessionId, {
      allowInference: mode === 'generated',
      timeoutMs: mode === 'generated' ? CLAUDE_TIMEOUT_MS : 15_000,
    });
    return client;
  }

  async function run(): Promise<void> {
    if (mode !== 'generated')
      throw new Error('Claude metadata sessions cannot start model turns');
    if (running) throw new Error('Claude canary session already started');
    await start().send(
      'Explain what a B-tree data structure is in one short sentence.',
    );
    await finish();
  }

  async function setName(name: string): Promise<void> {
    if (mode !== 'metadata')
      throw new Error('Use a Claude metadata session to set a name');
    if (!name.trim() || /[\r\n]/.test(name))
      throw new Error('Claude session name must be non-empty and single-line');
    await start().send(`/rename ${name}`);
  }

  async function finish(): Promise<void> {
    if (!running) throw new Error('Claude canary session has not started');
    running.child.stdin.end();
    await running.waitForSuccess(EXIT_TIMEOUT_MS);
  }

  async function cleanup(): Promise<void> {
    try {
      client?.close();
      await running?.stop();
    } finally {
      try {
        const transcript = findClaudeTranscript(sessionId, projectsDir);
        if (transcript)
          rmSync(dirname(transcript), { recursive: true, force: true });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  function generatedTitle(): string | null {
    const transcript = findClaudeTranscript(sessionId, projectsDir);
    if (!transcript)
      throw new Error(
        'Claude did not write a transcript for the pinned session',
      );
    const lines = readFileSync(transcript, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = parseJson(lines[i]);
        if (
          isRecord(entry) &&
          entry.type === 'ai-title' &&
          typeof entry.aiTitle === 'string'
        )
          return entry.aiTitle;
      } catch {
        /* Ignore incomplete trailing records. */
      }
    }
    return null;
  }

  return {
    sessionId,
    run,
    setName,
    finish,
    cleanup,
    generatedTitle,
    readTitle: () => readClaudeSessionTitle(sessionId, { projectsDir }),
  };
}

/** Pass only execution essentials; never inherit credentials or a parent thread id. */
export function codexCanaryEnvironment(
  env: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    SHELL: env.SHELL,
    LANG: env.LANG,
    TMPDIR: env.TMPDIR,
    USER: env.USER,
    CODEX_HOME: codexHome,
  };
}

export async function createCodexTitleSession() {
  const root = mkdtempSync(join(tmpdir(), 'anycloud-codex-title-'));
  let running: ReturnType<typeof startCanaryProcess> | undefined;
  let rpc: ReturnType<typeof connectCodexAppServer> | undefined;
  const codexHome = join(root, 'codex');

  async function cleanup(): Promise<void> {
    try {
      rpc?.close();
      await running?.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  try {
    mkdirSync(codexHome);
    running = startCanaryProcess(
      'codex',
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'cli_auth_credentials_store="file"',
      ],
      { cwd: root, env: codexCanaryEnvironment(process.env, codexHome) },
    );
    rpc = connectCodexAppServer(running);
    const client = rpc;
    const server = running;
    await client.request('initialize', {
      clientInfo: { name: 'anycloud_title_canary', version: '1.0.0' },
    });
    client.notify('initialized');
    const result = await client.request('thread/start', {
      cwd: root,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    if (
      !isRecord(result.thread) ||
      typeof result.thread.id !== 'string' ||
      !result.thread.id
    ) {
      throw new Error('Codex did not return a thread id');
    }
    const sessionId = result.thread.id;

    const setName = async (name: string): Promise<void> => {
      await client.request('thread/name/set', { threadId: sessionId, name });
    };

    const finish = async (): Promise<void> => {
      server.child.stdin.end();
      await server.waitForSuccess(EXIT_TIMEOUT_MS);
    };

    const childThreadId = async (): Promise<string> => {
      await client.request('thread/shellCommand', {
        threadId: sessionId,
        command: 'printf \'%s\' "$CODEX_THREAD_ID"',
        timeoutMs: 10_000,
      });
      const completed = await client.notification(
        'item/completed',
        sessionId,
        (params) =>
          isRecord(params.item) && params.item.type === 'commandExecution',
      );
      const item = completed.item;
      if (
        !isRecord(item) ||
        item.type !== 'commandExecution' ||
        item.exitCode !== 0 ||
        typeof item.aggregatedOutput !== 'string'
      ) {
        throw new Error(
          `Codex child command failed: ${JSON.stringify(completed)}`,
        );
      }
      const turn = await client.notification('turn/completed', sessionId);
      if (!isRecord(turn.turn) || turn.turn.status !== 'completed') {
        throw new Error(`Codex shell turn failed: ${JSON.stringify(turn)}`);
      }
      return item.aggregatedOutput.trim();
    };

    return {
      sessionId,
      setName,
      finish,
      cleanup,
      childThreadId,
      readTitle: () => readCodexSessionTitle(sessionId, { codexHome }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
