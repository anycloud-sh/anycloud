import { describe, expect, it, vi } from 'vitest';
import { KubeConfig } from '@kubernetes/client-node';
import { createKubernetesClients } from '../../../../src/api/services/kubernetes/client';

describe('Kubernetes client construction', () => {
  it('constructs clients from an explicit config without environment discovery', () => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'explicit', server: 'https://kubernetes.invalid' }],
      users: [{ name: 'explicit' }],
      contexts: [
        {
          name: 'explicit',
          cluster: 'explicit',
          user: 'explicit',
          namespace: 'anycloud',
        },
      ],
      currentContext: 'explicit',
    });
    const loadFromDefault = vi.spyOn(kubeConfig, 'loadFromDefault');

    const clients = createKubernetesClients(kubeConfig);

    expect(clients.kubeConfig).toBe(kubeConfig);
    expect(loadFromDefault).not.toHaveBeenCalled();
  });

  it('rejects an explicit config without a current cluster', () => {
    expect(() => createKubernetesClients(new KubeConfig())).toThrow(
      'Kubernetes config has no current cluster',
    );
  });
});
