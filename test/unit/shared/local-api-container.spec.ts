import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

import {
  inspectLocalApiContainer,
  isLocalApiContainerRunning,
  LOCAL_API_INSPECT_TIMEOUT_MS,
} from '../../../src/shared/local-api-container.js';

function dockerResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    error: undefined,
    signal: null,
    ...overrides,
  };
}

function inspectOutput(params: {
  running?: boolean;
  hostPort?: string | null;
  ports?: unknown;
}): string {
  const ports =
    params.ports ??
    (params.hostPort === null
      ? {}
      : {
          '8080/tcp': [
            { HostIp: '0.0.0.0', HostPort: params.hostPort ?? '8787' },
          ],
        });
  return `${JSON.stringify(params.running ?? true)}\t${JSON.stringify(ports)}\n`;
}

describe('local API container resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads running state and mapped port with one bounded Docker inspection', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({ stdout: inspectOutput({ hostPort: '8787' }) }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: true,
      hostPort: 8787,
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'docker',
      [
        'inspect',
        '--format',
        '{{json .State.Running}}\t{{json .NetworkSettings.Ports}}',
        'anycloud-api',
      ],
      { encoding: 'utf-8', timeout: LOCAL_API_INSPECT_TIMEOUT_MS },
    );
  });

  it('preserves stopped state and any mapped port', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({
        stdout: inspectOutput({ running: false, hostPort: '8787' }),
      }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: false,
      hostPort: 8787,
    });
  });

  it('reports a missing container', () => {
    mocks.spawnSync.mockReturnValue(dockerResult({ status: 1 }));

    expect(inspectLocalApiContainer()).toEqual({
      running: false,
      hostPort: null,
      failure: 'missing',
    });
  });

  it('reports an unavailable Docker daemon separately from a missing container', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({
        status: 1,
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: false,
      hostPort: null,
      failure: 'unavailable',
    });
  });

  it('reports a Docker timeout', () => {
    const error = Object.assign(new Error('spawnSync docker ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    mocks.spawnSync.mockReturnValue(
      dockerResult({ status: null, signal: 'SIGTERM', error }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: false,
      hostPort: null,
      failure: 'timeout',
    });
  });

  it('keeps running state when no port mapping is present', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({
        stdout: inspectOutput({ running: true, hostPort: null }),
      }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: true,
      hostPort: null,
    });
    expect(isLocalApiContainerRunning()).toBe(true);
  });

  it('keeps running state while marking malformed port output', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({ stdout: inspectOutput({ hostPort: 'not-a-port' }) }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: true,
      hostPort: null,
      failure: 'malformed',
    });
  });

  it('rejects malformed inspection output', () => {
    mocks.spawnSync.mockReturnValue(
      dockerResult({ stdout: 'not-json-and-no-separator\n' }),
    );

    expect(inspectLocalApiContainer()).toEqual({
      running: false,
      hostPort: null,
      failure: 'malformed',
    });
  });
});
