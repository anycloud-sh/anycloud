import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkloadStatusHttpError,
  TerminalWorkloadWithoutMarkerError,
  isTerminalWorkloadState,
  requireWorkloadStillActive,
} from '../../integration/helpers/observe-ac-timing-status.mjs';
import { rejectionOf } from '../helpers/rejection';

const request = {
  apiUrl: 'http://api.test',
  workloadId: 'mace-test',
  accessToken: 'test-token',
  version: '1.2.3',
};

function statusResponse(state: string) {
  return new Response(JSON.stringify({ workload: { state } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function runObserver(args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [resolve('test/integration/helpers/observe-ac-timing.mjs'), ...args],
        {
          env: {
            ...process.env,
            ANYCLOUD_OBSERVER_ACCESS_TOKEN: 'test-token',
            ANYCLOUD_OBSERVER_VERSION: '1.2.3',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('observer did not stop promptly'));
      }, 5_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveResult({ code, stderr });
      });
    },
  );
}

describe('first-inference observer workload-state checks', () => {
  it.each(['completed', 'failed', 'errored', 'invalid', 'terminated'])(
    'fails promptly when the workload reaches terminal state %s',
    async (state) => {
      const fetchImpl = vi.fn().mockResolvedValue(statusResponse(state));

      const error = await rejectionOf(
        requireWorkloadStillActive({ ...request, fetchImpl }),
      );

      expect(error).toBeInstanceOf(TerminalWorkloadWithoutMarkerError);
      expect(error).toMatchObject({
        state,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each(['queued', 'provisioning', 'initializing', 'running', 'finalizing'])(
    'continues observing while the workload is in active state %s',
    async (state) => {
      const fetchImpl = vi.fn().mockResolvedValue(statusResponse(state));

      await expect(
        requireWorkloadStillActive({ ...request, fetchImpl }),
      ).resolves.toBe(state);
    },
  );

  it('sends the observer credentials and workload identity to status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse('starting'));

    await requireWorkloadStillActive({ ...request, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://api.test/v1/workloads/mace-test');
    expect(init).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer test-token',
        'AnyCloud-Client-Version': '1.2.3',
      },
    });
    expect(init.body).toBeUndefined();
  });

  it('classifies not-found as retryable while submission races the observer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('workload not found', { status: 404 }));

    const error = await rejectionOf(
      requireWorkloadStillActive({ ...request, fetchImpl }),
    );

    expect(error).toBeInstanceOf(WorkloadStatusHttpError);
    expect(error).toMatchObject({
      status: 404,
      retryable: true,
    });
  });

  it('classifies authentication failures as non-retryable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const error = await rejectionOf(
      requireWorkloadStillActive({ ...request, fetchImpl }),
    );

    expect(error).toBeInstanceOf(WorkloadStatusHttpError);
    expect(error).toMatchObject({
      status: 401,
      retryable: false,
    });
  });

  it('rejects a malformed successful status response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(
      requireWorkloadStillActive({ ...request, fetchImpl }),
    ).rejects.toThrow('Workload status response is missing workload.state');
  });

  it('does not treat unknown states as terminal', () => {
    expect(isTerminalWorkloadState('future-active-state')).toBe(false);
  });

  it('stops the observer after one failed stream attempt when status is terminal', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/v1/workloads/mace-test/logs?follow=true') {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('container is not available');
        return;
      }
      if (request.url === '/v1/workloads/mace-test') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ workload: { state: 'errored' } }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolveListening) => {
      server.listen(0, '127.0.0.1', resolveListening);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('mock observer server did not expose a TCP address');
    }
    const directory = await mkdtemp(join(tmpdir(), 'ac-observer-status-'));
    const output = join(directory, 'observer.json');

    try {
      const result = await runObserver([
        '--api-url',
        `http://127.0.0.1:${address.port}`,
        '--workload-id',
        'mace-test',
        '--run-id',
        'run-test',
        '--output',
        output,
        '--timeout-ms',
        '30000',
      ]);
      const report = JSON.parse(await readFile(output, 'utf8'));

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'reached terminal state "errored" before the expected first-inference marker',
      );
      expect(requests).toEqual([
        '/v1/workloads/mace-test/logs?follow=true',
        '/v1/workloads/mace-test',
      ]);
      expect(report).toMatchObject({
        phase: 'failed',
        terminalState: 'errored',
        streamAttempts: 1,
      });
    } finally {
      await new Promise<void>((resolveClosed) =>
        server.close(() => resolveClosed()),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
