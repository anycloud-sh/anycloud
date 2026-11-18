import { describe, expect, it, vi } from 'vitest';
import {
  InvalidClusterConnectionError,
  kubeConfigFromClusterConnection,
  parseClusterConnection,
  serializeClusterConnection,
  type ClusterConnectionDocument,
} from '../../../../src/api/services/kubernetes/cluster-connection.js';

const CA = Buffer.from('ca').toString('base64');
const installer: ClusterConnectionDocument = {
  kind: 'installer',
  server: 'https://203.0.113.5:6443',
  certificateAuthorityData: CA,
  credential: { kind: 'token', token: 'sa-token' },
};
const inCluster: ClusterConnectionDocument = {
  kind: 'in-cluster',
  server: 'https://203.0.113.5:6443',
  certificateAuthorityData: CA,
};

describe('cluster connection document', () => {
  it('round-trips both kinds through the stored form', () => {
    for (const document of [installer, inCluster]) {
      expect(
        parseClusterConnection(serializeClusterConnection(document)),
      ).toEqual(document);
    }
  });

  it('refuses stored documents of any other shape with one fixed error', () => {
    const rejected: unknown[] = [
      'not json',
      JSON.stringify(null),
      JSON.stringify({ ...installer, kind: 'kubeconfig' }),
      JSON.stringify({ ...installer, server: 'http://203.0.113.5:6443' }),
      JSON.stringify({ ...installer, certificateAuthorityData: 'not base64!' }),
      JSON.stringify({
        ...installer,
        credential: { kind: 'exec', command: 'x' },
      }),
      JSON.stringify({
        ...installer,
        credential: { kind: 'token', token: '' },
      }),
      JSON.stringify({ kind: 'in-cluster', server: 'https://x:6443' }),
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [{ name: 'c', cluster: { server: 'https://x:6443' } }],
      }),
    ];
    for (const stored of rejected) {
      expect(() => parseClusterConnection(stored as string)).toThrow(
        InvalidClusterConnectionError,
      );
    }
  });

  it('builds the installer client from inline options only', () => {
    const kubeConfig = kubeConfigFromClusterConnection(installer);
    expect(kubeConfig.getCurrentCluster()).toMatchObject({
      server: installer.server,
      caData: CA,
      skipTLSVerify: false,
    });
    expect(kubeConfig.getCurrentUser()).toMatchObject({ token: 'sa-token' });
  });

  it('builds the in-cluster client from the Pod ServiceAccount, not the public endpoint', () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.43.0.1');
    vi.stubEnv('KUBERNETES_SERVICE_PORT', '443');
    try {
      const kubeConfig = kubeConfigFromClusterConnection(inCluster);
      expect(kubeConfig.getCurrentCluster()).toMatchObject({
        server: 'https://10.43.0.1:443',
        caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        skipTLSVerify: false,
      });
      expect(kubeConfig.getCurrentUser()).toMatchObject({
        authProvider: { name: 'tokenFile' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
