import { describe, expect, it, vi } from 'vitest';

import {
  classifyStartupReadiness,
  hasSatisfiedServiceStartupDwell,
  toPublicContainerStatus,
} from '../../../src/api/services/container-health';
import { ContainerState } from '../../../src/shared/runtime.js';

describe('classifyStartupReadiness', () => {
  const exited = (exitCode: number) => ({
    state: ContainerState.Exited,
    exitCode,
  });

  it('treats a clean job exit as ready (jobs may finish fast)', () => {
    expect(classifyStartupReadiness(exited(0), 'job')).toBe('ready');
  });

  it('treats a non-zero job exit as a startup failure', () => {
    expect(() => classifyStartupReadiness(exited(1), 'job')).toThrow(
      'Container exited during startup',
    );
  });

  it('treats ANY server exit, including code 0, as a startup failure', () => {
    // Regression guard: job semantics (exit 0 = healthy/complete) must not leak
    // into services, or the endpoint gets published for a container that already
    // exited and the workload sits Running while serving nothing.
    expect(() => classifyStartupReadiness(exited(0), 'service')).toThrow(
      'Service container exited during startup',
    );
    expect(() => classifyStartupReadiness(exited(1), 'service')).toThrow(
      'Service container exited during startup',
    );
  });

  it('treats any VM exit as a startup failure', () => {
    expect(() => classifyStartupReadiness(exited(0), 'vm')).toThrow(
      'VM container exited during startup',
    );
    expect(() => classifyStartupReadiness(exited(1), 'vm')).toThrow(
      'VM container exited during startup',
    );
  });

  it('treats a Dead container the same as Exited', () => {
    const dead = { state: ContainerState.Dead, exitCode: 0 };
    expect(() => classifyStartupReadiness(dead, 'service')).toThrow(
      'Service container exited during startup',
    );
    expect(classifyStartupReadiness(dead, 'job')).toBe('ready');
  });

  it('treats a running container as ready for every workload type', () => {
    expect(
      classifyStartupReadiness({ state: ContainerState.Running }, 'job'),
    ).toBe('ready');
    expect(
      classifyStartupReadiness({ state: ContainerState.Running }, 'service'),
    ).toBe('ready');
    expect(
      classifyStartupReadiness({ state: ContainerState.Running }, 'vm'),
    ).toBe('ready');
  });

  it('treats a restarting server as a startup failure', () => {
    const restarting = {
      state: ContainerState.Restarting,
      exitCode: 6,
      logs: 'Container logs:\nNo devices were found',
    };

    expect(() => classifyStartupReadiness(restarting, 'service')).toThrow(
      'Service container restarting during startup',
    );
    expect(() => classifyStartupReadiness(restarting, 'vm')).toThrow(
      'VM container restarting during startup',
    );
    expect(classifyStartupReadiness(restarting, 'job')).toBe('pending');
  });
});

describe('hasSatisfiedServiceStartupDwell', () => {
  it('requires a Service container to stay running for the dwell window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));

      expect(
        hasSatisfiedServiceStartupDwell(
          {
            state: ContainerState.Running,
            startedAt: '2026-01-01T00:00:00.000Z',
          },
          30_000,
        ),
      ).toBe(true);
      expect(
        hasSatisfiedServiceStartupDwell(
          {
            state: ContainerState.Running,
            startedAt: '2026-01-01T00:00:20.000Z',
          },
          30_000,
        ),
      ).toBe(false);
      expect(
        hasSatisfiedServiceStartupDwell(
          { state: ContainerState.Running },
          30_000,
        ),
      ).toBe(false);
      expect(
        hasSatisfiedServiceStartupDwell(
          { state: ContainerState.Restarting },
          30_000,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toPublicContainerStatus', () => {
  it('omits internal startup timing while preserving public container fields', () => {
    const status = toPublicContainerStatus({
      state: ContainerState.Exited,
      exitCode: 0,
      oomKilled: false,
      logs: '',
      uptime: '2m',
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(status).toEqual({
      state: ContainerState.Exited,
      exitCode: 0,
      oomKilled: false,
      logs: '',
      uptime: '2m',
    });
    expect('startedAt' in status).toBe(false);
    expect(JSON.stringify(status)).not.toContain('startedAt');
  });
});
