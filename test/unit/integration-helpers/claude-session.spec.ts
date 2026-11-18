import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCanaryProcess } from '../../integration/helpers/agent-canary-process';
import { connectClaudeSession } from '../../integration/helpers/claude-session';

const sessionId = 'claude-canary';
const success = {
  type: 'result',
  session_id: sessionId,
  subtype: 'success',
  is_error: false,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  total_cost_usd: 0,
};

function respond(result: unknown): string {
  return `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')}));`;
}

async function withClaude(
  script: string,
  run: (
    client: ReturnType<typeof connectClaudeSession>,
    process: ReturnType<typeof startCanaryProcess>,
    root: string,
  ) => Promise<void>,
  options: { timeoutMs?: number; allowInference?: boolean } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'claude-session-helper-'));
  const process = startCanaryProcess(
    globalThis.process.execPath,
    ['-e', script],
    {
      cwd: root,
      env: { PATH: globalThis.process.env.PATH },
    },
  );
  const client = connectClaudeSession(process, sessionId, {
    timeoutMs: 2_000,
    ...options,
  });
  try {
    await run(client, process, root);
  } finally {
    client.close();
    try {
      await process.stop(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe('Claude session input and results', () => {
  it('handles fragmented results and initialization events across sequential renames', async () => {
    await withClaude(
      `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({type:'system',subtype:'init'})+'\\n');
        const result = JSON.stringify({...${JSON.stringify(success)}, result:request.message.content})+'\\n';
        process.stdout.write(result.slice(0,20));
        setImmediate(() => process.stdout.write(result.slice(20)));
      });`,
      async (client) => {
        for (const name of ['first title', 'renamed title']) {
          expect(await client.send(`/rename ${name}`)).toEqual({
            ...success,
            result: `/rename ${name}`,
          });
        }
      },
    );
  });

  it('rejects overlapping inputs without losing the first result', async () => {
    await withClaude(respond(success), async (client) => {
      const first = client.send('/rename first');
      await expect(client.send('/rename second')).rejects.toThrow(
        'already pending',
      );
      expect(await first).toEqual(success);
    });
  });

  it('propagates a CLI-reported failure', async () => {
    await withClaude(
      respond({
        ...success,
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['native rename failed'],
      }),
      async (client) => {
        await expect(client.send('/rename title')).rejects.toThrow(
          'native rename failed',
        );
      },
    );
  });

  it.each(['not json', '[]'])(
    'rejects malformed protocol output (%s)',
    async (output) => {
      await withClaude(
        `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(output + '\n')}));`,
        async (client) => {
          await expect(client.send('/rename title')).rejects.toThrow(
            'Invalid Claude session result',
          );
        },
      );
    },
  );

  it('rejects a result belonging to another session', async () => {
    await withClaude(
      respond({ ...success, session_id: 'another-session' }),
      async (client) => {
        await expect(client.send('/rename title')).rejects.toThrow(
          'Unexpected Claude session result',
        );
      },
    );
  });
});

describe('Claude metadata token accounting', () => {
  it.each(Object.keys(success.usage))('rejects nonzero %s', async (counter) => {
    await withClaude(
      respond({
        ...success,
        usage: { ...success.usage, [counter]: 1 },
      }),
      async (client) => {
        await expect(client.send('/rename title')).rejects.toThrow(
          'must report zero tokens',
        );
      },
    );
  });

  it.each([
    { behavior: 'missing usage', result: { ...success, usage: undefined } },
    {
      behavior: 'missing token counter',
      result: {
        ...success,
        usage: { ...success.usage, cache_read_input_tokens: undefined },
      },
    },
    {
      behavior: 'missing model usage',
      result: { ...success, modelUsage: undefined },
    },
    {
      behavior: 'model usage',
      result: { ...success, modelUsage: { haiku: { inputTokens: 0 } } },
    },
    { behavior: 'cost', result: { ...success, total_cost_usd: 0.01 } },
  ])('rejects $behavior', async ({ result }) => {
    await withClaude(respond(result), async (client) => {
      await expect(client.send('/rename title')).rejects.toThrow(
        'must report zero tokens',
      );
    });
  });

  it('allows inference only when explicitly enabled for generated titles', async () => {
    const result = {
      ...success,
      usage: { ...success.usage, input_tokens: 10, output_tokens: 3 },
      modelUsage: { haiku: { inputTokens: 10, outputTokens: 3 } },
      total_cost_usd: 0.0001,
    };
    await withClaude(
      respond(result),
      async (client) => {
        expect(await client.send('Define a B-tree.')).toEqual(result);
      },
      { allowInference: true },
    );
  });
});

describe('Claude session lifecycle', () => {
  it('rejects pending input when the CLI exits before returning a result', async () => {
    await withClaude(
      "process.stdin.once('data', () => process.exit(7));",
      async (client) => {
        await expect(client.send('/rename title')).rejects.toThrow(
          'exited before',
        );
      },
    );
  });

  it('cleans up the process and directory after a timeout', async () => {
    let directory = '';
    let child: ReturnType<typeof startCanaryProcess> | undefined;
    await withClaude(
      'setInterval(() => {}, 1000);',
      async (client, process, root) => {
        directory = root;
        child = process;
        await expect(client.send('/rename title')).rejects.toThrow('timed out');
        await expect(client.send('/rename later')).rejects.toThrow('timed out');
      },
      { timeoutMs: 100 },
    );
    expect(existsSync(directory)).toBe(false);
    expect(child?.child.signalCode).toBe('SIGKILL');
  });

  it('rejects pending input when the client closes', async () => {
    await withClaude('process.stdin.resume();', async (client) => {
      const pending = client.send('/rename title');
      const assertion = expect(pending).rejects.toThrow('client closed');
      client.close();
      await assertion;
    });
  });
});
