import type {
  ConfigurationOptions,
  CoreV1Event,
  V1Pod,
} from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import {
  imagePullFromEvents,
  POD_EVENTS_TIMEOUT_MS,
  podImagePull,
} from '../../../../src/api/services/kubernetes/pod-image-pull.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

const WORKLOAD = 'workload';

function pulled(message: string, container = WORKLOAD): CoreV1Event {
  return {
    reason: 'Pulled',
    message,
    involvedObject: { fieldPath: `spec.containers{${container}}` },
    metadata: {},
  };
}

const pullIn = (duration: string) =>
  pulled(
    `Successfully pulled image "ghcr.io/a/b:1" in ${duration} (${duration} including waiting). Image size: 123 bytes.`,
  );
const present = pulled(
  'Container image "ghcr.io/a/b:1" already present on machine and can be accessed by the pod',
);

describe('imagePullFromEvents', () => {
  it.each([
    ['345ms', 345],
    ['41.2s', 41_200],
    ['2m3.456s', 123_456],
    ['1h0m1s', 3_601_000],
  ])('reads kubelet pull time %s as %d ms', (duration, elapsedMs) => {
    expect(imagePullFromEvents([pullIn(duration)], WORKLOAD)).toEqual({
      schemaVersion: 1,
      method: 'kubelet',
      outcome: 'succeeded',
      elapsedMs,
    });
  });

  it('reads the pull time from a message before Kubernetes 1.28', () => {
    expect(
      imagePullFromEvents(
        [pulled('Successfully pulled image "ghcr.io/a/b:1" in 41.2s')],
        WORKLOAD,
      ),
    ).toMatchObject({ elapsedMs: 41_200 });
  });

  it("keeps the pull over a restart's already-present event", () => {
    expect(
      imagePullFromEvents([present, pullIn('9.5s')], WORKLOAD),
    ).toMatchObject({ elapsedMs: 9500 });
  });

  it('records that the Node already had the image', () => {
    expect(imagePullFromEvents([present], WORKLOAD)).toEqual({
      schemaVersion: 1,
      method: 'kubelet',
      outcome: 'succeeded',
      elapsedMs: 0,
      alreadyPresent: true,
    });
  });

  it("ignores other containers' pulls and unreadable times", () => {
    expect(
      imagePullFromEvents(
        [
          pulled(
            'Successfully pulled image "runner" in 2s (2s including waiting)',
            'runner-install',
          ),
          pullIn('3 seconds'),
        ],
        WORKLOAD,
      ),
    ).toBeUndefined();
  });
});

describe('podImagePull', () => {
  const pod: V1Pod = { metadata: { name: 'p', namespace: 'ns', uid: 'uid-1' } };

  it('gives up on events that do not arrive in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Node's AbortSignal.timeout ignores fake timers; this one follows them.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const listNamespacedEvent = vi.fn(
        (_: unknown, options?: ConfigurationOptions) =>
          new Promise<never>((_, reject) => {
            const request = {
              setSignal: (signal: AbortSignal) =>
                signal.addEventListener('abort', () => reject(signal.reason)),
            };
            options?.middleware?.[0]?.pre(request as never);
          }),
      );
      const pull = podImagePull(
        makeClusterKubernetesClientFixture({ core: { listNamespacedEvent } }),
        pod,
        WORKLOAD,
      );
      await vi.advanceTimersByTimeAsync(POD_EVENTS_TIMEOUT_MS);
      await expect(pull).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('records nothing when events cannot be read', async () => {
    const listNamespacedEvent = vi.fn(async () => {
      throw new Error('forbidden');
    });
    await expect(
      podImagePull(
        makeClusterKubernetesClientFixture({ core: { listNamespacedEvent } }),
        pod,
        WORKLOAD,
      ),
    ).resolves.toBeUndefined();
  });
});
