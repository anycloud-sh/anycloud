import { describe, expect, it } from 'vitest';

import { buildKubernetesPodParts } from '../../../../src/api/services/kubernetes/pod-parts.js';
import { kubernetesWorkloadIdentity } from '../../../../src/api/services/kubernetes/identity.js';

function identity() {
  return kubernetesWorkloadIdentity({
    kind: 'deployment',
    workloadId: 'model-a',
    userId: 'owner-id',
  });
}

describe('Kubernetes Pod parts', () => {
  it('maps CPU, memory, and GPU to equal requests and limits', () => {
    const parts = buildKubernetesPodParts({
      namespace: 'anycloud',
      identity: identity(),
      workloadName: 'Kubernetes Deployment',
      request: {
        workloadId: 'model-a',
        image: 'ghcr.io/octocat/deployment:latest',
        gpuCount: 4,
        dockerOptions: { cpus: '2.5', memory: '32g' },
      },
    });

    expect(parts.containerBase.resources).toEqual({
      requests: { cpu: '2500m', memory: '32Gi', 'nvidia.com/gpu': '4' },
      limits: { cpu: '2500m', memory: '32Gi', 'nvidia.com/gpu': '4' },
    });
  });

  it('logs in to GHCR with the token alone', () => {
    const parts = buildKubernetesPodParts({
      namespace: 'anycloud',
      identity: identity(),
      workloadName: 'Kubernetes Deployment',
      request: {
        workloadId: 'model-a',
        image: 'ghcr.io/octocat/private:latest',
        gpuCount: 0,
        githubToken: 'github-token',
      },
    });

    const pullSecret = parts.secrets.find(
      (secret) => secret.type === 'kubernetes.io/dockerconfigjson',
    );
    const config = JSON.parse(
      pullSecret!.stringData!['.dockerconfigjson']!,
    ) as {
      auths: Record<string, { username: string; password: string }>;
    };
    expect(config.auths['ghcr.io']).toMatchObject({
      username: 'x-access-token',
      password: 'github-token',
    });
    // The token pulls the image and never reaches the container.
    expect(parts.secrets).toEqual([pullSecret]);
    expect(
      parts.containerBase.env?.filter((entry) =>
        entry.name.startsWith('GITHUB_'),
      ),
    ).toEqual([]);
  });
});
