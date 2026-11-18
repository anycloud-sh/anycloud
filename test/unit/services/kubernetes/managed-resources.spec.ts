import { describe, expect, it, vi } from 'vitest';
import {
  deleteKubernetesResourcePlan,
  ensureKubernetesResourcePlan,
  KubernetesResourceOwnershipError,
  type ManagedKubernetesResource,
  type OwnedKubernetesResource,
} from '../../../../src/api/services/kubernetes/managed-resources';

function desired(name: string) {
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      labels: { 'app.kubernetes.io/component': 'kubernetes-job' },
      annotations: {
        'anycloud.sh/deployment-id': 'workload',
        'anycloud.sh/user-id': 'user',
        'anycloud.sh/generation': '2',
      },
    },
  };
}

function resource(name: string, events: string[]): ManagedKubernetesResource {
  return {
    kind: 'Test',
    namespace: 'anycloud',
    name,
    desired: desired(name),
    create: vi.fn(async () => {
      events.push(`create:${name}`);
    }),
    apply: vi.fn(async () => {
      events.push(`apply:${name}`);
    }),
    read: vi.fn(async () => desired(name)),
    ownershipErrorMessage: `${name} is foreign`,
  };
}

describe('managed Kubernetes resources', () => {
  it('leaves newly created resources for durable reconciliation', async () => {
    const events: string[] = [];
    const adopted = resource('adopted', events);
    const first = resource('first', events);
    const second = resource('second', events);
    const failure = resource('failure', events);
    vi.mocked(adopted.create).mockImplementation(async () => {
      events.push('create:adopted');
      throw { statusCode: 409 };
    });
    vi.mocked(failure.create).mockRejectedValue(new Error('create denied'));

    await expect(
      ensureKubernetesResourcePlan([adopted, first, second, failure]),
    ).rejects.toThrow('create denied');

    expect(events).toEqual([
      'create:adopted',
      'apply:adopted',
      'create:first',
      'create:second',
    ]);
  });

  it('stops at the failed resource and preserves its create error', async () => {
    const events: string[] = [];
    const first = resource('first', events);
    const failure = resource('failure', events);
    const after = resource('after', events);
    vi.mocked(failure.create).mockRejectedValue(new Error('create denied'));

    await expect(
      ensureKubernetesResourcePlan([first, failure, after]),
    ).rejects.toThrow('create denied');

    expect(events).toEqual(['create:first']);
    expect(after.create).not.toHaveBeenCalled();
  });

  it('rejects adoption when ownership metadata differs', async () => {
    const managed = resource('conflict', []);
    vi.mocked(managed.create).mockRejectedValue({ statusCode: 409 });
    vi.mocked(managed.read).mockResolvedValue({
      metadata: {
        ...desired('conflict').metadata,
        annotations: {
          'anycloud.sh/deployment-id': 'workload',
        },
      },
    });

    await expect(
      ensureKubernetesResourcePlan([managed]),
    ).rejects.toBeInstanceOf(KubernetesResourceOwnershipError);
  });

  it('repairs an owned resource left behind from an older generation', async () => {
    const managed = resource('old-generation', []);
    vi.mocked(managed.create).mockRejectedValue({ statusCode: 409 });
    const { metadata } = desired('old-generation');
    vi.mocked(managed.read).mockResolvedValue({
      metadata: {
        ...metadata,
        annotations: {
          ...metadata.annotations,
          'anycloud.sh/generation': '1',
        },
      },
    });

    await ensureKubernetesResourcePlan([managed]);

    expect(managed.apply).toHaveBeenCalledOnce();
  });

  it('deletes and waits for owned resources without touching foreign names', async () => {
    let ownedExists = true;
    const owned: OwnedKubernetesResource = {
      kind: 'Job',
      namespace: 'anycloud',
      name: 'owned',
      read: vi.fn(async () => {
        if (!ownedExists) throw { statusCode: 404 };
        return desired('owned');
      }),
      delete: vi.fn(async () => {
        ownedExists = false;
      }),
    };
    const foreign: OwnedKubernetesResource = {
      kind: 'Job',
      namespace: 'anycloud',
      name: 'foreign',
      ownershipLabels: {
        'app.kubernetes.io/component': 'kubernetes-job',
      },
      read: vi.fn(async () => ({
        metadata: {
          labels: { 'app.kubernetes.io/component': 'someone-else' },
          annotations: { 'anycloud.sh/deployment-id': 'workload' },
        },
      })),
      delete: vi.fn(async () => ({})),
    };

    await deleteKubernetesResourcePlan(
      [owned, foreign],
      { workloadId: 'workload', userId: 'user' },
      {
        timeoutMs: 10,
        intervalMs: 0,
      },
    );

    expect(owned.delete).toHaveBeenCalledWith('uid-owned');
    expect(foreign.delete).not.toHaveBeenCalled();
  });
});
