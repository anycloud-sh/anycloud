import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCanaryProcess } from '../../integration/helpers/agent-canary-process';
import { connectCodexAppServer } from '../../integration/helpers/codex-app-server';
import { codexCanaryEnvironment } from '../../integration/helpers/agent-session-title';
import { isRecord, parseJsonArray } from '../../integration/helpers/json';

const readRequest = `require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
`;

describe('agent canary test selection', () => {
  it.each([
    {
      agent: 'claude',
      names: [
        'reads the named title and preserves it after process exit',
        'reads the renamed title and preserves it after process exit',
        'reflects the generated title recorded by Claude',
      ],
    },
    {
      agent: 'codex',
      names: [
        'reads the named title and preserves it after process exit',
        'reads the renamed title and preserves it after process exit',
        'exposes the native thread id to child commands',
      ],
    },
  ])(
    'discovers every required $agent assertion using the CI filter',
    ({ agent, names }) => {
      const root = mkdtempSync(join(tmpdir(), 'agent-title-discovery-'));
      const output = join(root, 'tests.json');
      try {
        execFileSync(
          process.execPath,
          [
            'node_modules/vitest/vitest.mjs',
            'list',
            'test/integration/agent-session-title.spec.ts',
            '-t',
            `^${agent} `,
            '--json',
            output,
          ],
          { timeout: 30_000, stdio: 'pipe' },
        );
        const tests = parseJsonArray(readFileSync(output, 'utf8'));
        expect(
          tests.map((entry) => (isRecord(entry) ? entry.name : null)),
        ).toEqual(names.map((name) => `${agent} session titles > ${name}`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

async function withServer(
  script: string,
  run: (
    client: ReturnType<typeof connectCodexAppServer>,
    child: ReturnType<typeof startCanaryProcess>,
    root: string,
  ) => Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-title-helper-'));
  const child = startCanaryProcess(process.execPath, ['-e', script], {
    cwd: root,
    env: { PATH: process.env.PATH },
  });
  const client = connectCodexAppServer(child, timeoutMs);
  try {
    await run(client, child, root);
  } finally {
    client.close();
    try {
      await child.stop(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe('Codex canary RPC lifecycle', () => {
  it('routes replies by id and retains notifications that arrive before the reply', async () => {
    await withServer(
      `${readRequest}
      for (const threadId of ['other', 'wanted']) process.stdout.write(JSON.stringify({method:'thread/name/updated',params:{threadId,threadName:'saved'}})+'\\n');
      process.stdout.write(JSON.stringify({id:request.id,result:{ok:true}})+'\\n');
    });`,
      async (client) => {
        expect(await client.request('thread/name/set', {})).toEqual({
          ok: true,
        });
        expect(
          await client.notification('thread/name/updated', 'wanted'),
        ).toEqual({ threadId: 'wanted', threadName: 'saved' });
      },
    );
  });

  it('fails on RPC errors instead of treating them as success', async () => {
    await withServer(
      `${readRequest}
      process.stdout.write(JSON.stringify({id:request.id,error:{code:-32601,message:'method unavailable'}})+'\\n');
    });`,
      async (client) => {
        await expect(client.request('thread/name/set', {})).rejects.toThrow(
          'method unavailable',
        );
      },
    );
  });

  it('rejects a pending request promptly when the server exits', async () => {
    await withServer(
      "process.stdin.once('data', () => process.exit(7));",
      async (client) => {
        await expect(client.request('thread/start', {})).rejects.toThrow(
          'exited before',
        );
      },
    );
  });

  it('rejects malformed protocol output', async () => {
    await withServer(
      "process.stdin.once('data', () => process.stdout.write('not json\\n'));",
      async (client) => {
        await expect(client.request('thread/start', {})).rejects.toThrow(
          'Invalid Codex app-server message',
        );
      },
    );
  });

  it('cleans up the process and directory after an RPC timeout', async () => {
    let directory = '';
    let child: ReturnType<typeof startCanaryProcess> | undefined;
    await expect(
      withServer(
        'setInterval(() => {}, 1000);',
        async (client, server, root) => {
          directory = root;
          child = server;
          await client.request('thread/start', {});
        },
        100,
      ),
    ).rejects.toThrow('timed out waiting for thread/start');
    expect(existsSync(directory)).toBe(false);
    expect(child?.child.signalCode).toBe('SIGKILL');
  });

  it('rejects pending notifications when the client closes', async () => {
    await withServer('process.stdin.resume();', async (client) => {
      const pending = client.notification('turn/completed', 'thread');
      const assertion = expect(pending).rejects.toThrow('client closed');
      client.close();
      await assertion;
    });
  });
});

describe('agent canary environment and availability', () => {
  it('isolates Codex from credentials, config, and inherited agent ids', () => {
    const env = Object.freeze({
      PATH: '/usr/bin',
      CODEX_HOME: '/real/home',
      CODEX_THREAD_ID: 'parent-thread',
      CODEX_BIN_PATH: '/parent/codex',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-claude',
      OPENAI_API_KEY: 'openai-key',
      CODEX_API_KEY: 'codex-key',
      ANTHROPIC_API_KEY: 'claude-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    });
    const child = codexCanaryEnvironment(env, '/temporary/codex');
    expect(child).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/temporary/codex' });
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_THREAD_ID',
      'CODEX_BIN_PATH',
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
    ]) {
      expect(child).not.toHaveProperty(key);
    }
    expect(env.CODEX_HOME).toBe('/real/home');
  });
});
