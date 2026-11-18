import { describe, expect, it } from 'vitest';
import {
  KUBERNETES_COMPONENT_LABEL,
  KUBERNETES_OWNER_API_ANNOTATION,
  kubernetesWorkloadIdentity,
} from '../../../../src/api/services/kubernetes/identity';

describe('Kubernetes workload identity', () => {
  it('retains pre-rename Worker resource names and ownership keys', () => {
    const identity = kubernetesWorkloadIdentity({
      kind: 'deployment',
      workloadId: 'worker-a',
      userId: 'owner-a',
    });
    expect(identity).toMatchObject({
      name: 'anycloud-deployment-worker-a-6a65e237ae',
      podSelector: 'anycloud.sh/deployment-hash=6a65e237ae44c428',
      imagePullSecretName:
        'anycloud-deployment-worker-a-registry-auth-6a65e237ae',
      labels: {
        'app.kubernetes.io/component': 'kubernetes-deployment',
        'anycloud.sh/deployment-hash': '6a65e237ae44c428',
      },
      annotations: { 'anycloud.sh/deployment-id': 'worker-a' },
    });
  });

  it('creates stable kind-specific DNS identities and ownership metadata', () => {
    const serve = kubernetesWorkloadIdentity({
      kind: 'serve',
      workloadId: 'User/model with a very long workload identity',
      userId: 'octocat',
    });
    const job = kubernetesWorkloadIdentity({
      kind: 'job',
      workloadId: 'User/model with a very long workload identity',
      userId: 'octocat',
    });

    expect(serve.name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(serve.name.length).toBeLessThanOrEqual(63);
    expect(serve.imagePullSecretName.length).toBeLessThanOrEqual(63);
    expect(serve.labels[KUBERNETES_COMPONENT_LABEL]).toBe('kubernetes-serve');
    expect(job.labels[KUBERNETES_COMPONENT_LABEL]).toBe('kubernetes-job');
    expect(job.name).not.toBe(serve.name);
    expect(serve.annotations[KUBERNETES_OWNER_API_ANNOTATION]).toBe(
      '00000000000000000000000000000001',
    );
    expect(
      kubernetesWorkloadIdentity({
        kind: 'serve',
        workloadId: 'User/model with a very long workload identity',
        userId: 'octocat',
      }),
    ).toEqual(serve);
    expect(serve.annotations).toEqual({
      'anycloud.sh/deployment-id':
        'User/model with a very long workload identity',
      'anycloud.sh/user-id': 'octocat',
      [KUBERNETES_OWNER_API_ANNOTATION]: '00000000000000000000000000000001',
    });
  });
});
