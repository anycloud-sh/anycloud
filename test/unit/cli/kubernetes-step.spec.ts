import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/client';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

import {
  KubernetesStepFailedError,
  runKubernetesStep,
} from '../../../src/cli/use-cases/kubernetes-step.js';
import type { KubernetesStep } from '../../../src/shared/api-contract/system-release-schemas.js';
import type { ApiClient } from '../../../src/shared/services/api-client/rpc.js';

const IMAGE = 'ghcr.io/anycloud-sh/api:0.1.74';
const step = (state: KubernetesStep['state']): KubernetesStep => ({
  id: 'step0001',
  state,
  configuration: state === 'running' ? null : 'changed',
  startedAt: null,
  finishedAt: null,
  reason: state === 'failed' ? 'the K3s step exited 65: no token' : null,
});

function release(...answers: (KubernetesStep | null | Error)[]) {
  const kubernetes = vi.fn<ApiClient['systemRelease']['kubernetes']>();
  for (const answer of answers) {
    if (answer instanceof Error) kubernetes.mockRejectedValueOnce(answer);
    else kubernetes.mockResolvedValueOnce({ step: answer });
  }
  return { kubernetes };
}

describe("api upgrade's K3s step (RFC 0049 C26 (b))", () => {
  const report = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it('polls one step through a K3s restart', async () => {
    const api = release(
      step('running'),
      // The API answers through K3s, which is restarting.
      new ORPCError('INTERNAL_SERVER_ERROR', { status: 502 }),
      // After an answer, a 404 is the edge while K3s restarts, not an old API.
      new ORPCError('NOT_FOUND', { status: 404 }),
      new TypeError('fetch failed'),
      step('succeeded'),
    );

    await expect(runKubernetesStep(api, IMAGE, report)).resolves.toEqual(
      step('succeeded'),
    );

    const ids = new Set(api.kubernetes.mock.calls.map(([input]) => input.id));
    expect(ids.size).toBe(1);
    expect(api.kubernetes.mock.calls[0]![0]).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{16}$/u),
      image: IMAGE,
    });
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'Reconfiguring K3s on the management host...',
    );
  });

  it('throws a failed step and a refusal, and skips an API that predates the step', async () => {
    await expect(
      runKubernetesStep(release(step('failed')), IMAGE, report),
    ).rejects.toThrow(KubernetesStepFailedError);
    await expect(
      runKubernetesStep(
        release(new ORPCError('SYSTEM_RELEASE_REFUSED', { status: 400 })),
        IMAGE,
        report,
      ),
    ).rejects.toMatchObject({ code: 'SYSTEM_RELEASE_REFUSED' });
    for (const old of [
      new ORPCError('NOT_FOUND', { status: 404 }),
      new ORPCError('CLIENT_VERSION_MISMATCH', { status: 400 }),
    ]) {
      await expect(
        runKubernetesStep(release(old), IMAGE, report),
      ).resolves.toBeNull();
    }
    // An image the release already carries runs nothing.
    await expect(
      runKubernetesStep(release(null), IMAGE, report),
    ).resolves.toBeNull();
  });

  it('gives up at the deadline naming the last error, without requesting the upgrade', async () => {
    const api = release(new TypeError('fetch failed'));
    await expect(
      runKubernetesStep(api, IMAGE, report, { timeoutMs: 0 }),
    ).rejects.toThrow(
      'The K3s step did not report within 0 minutes (last: fetch failed). The hosted API upgrade was not requested',
    );
  });
});
