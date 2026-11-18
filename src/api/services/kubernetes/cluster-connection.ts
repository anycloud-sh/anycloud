import { KubeConfig } from '@kubernetes/client-node';

/**
 * How the API reaches the installation's Kubernetes cluster. The installer
 * keeps the ServiceAccount-token connection bootstrap built (`installer`); the
 * hosted API uses its own Pod ServiceAccount through in-cluster discovery
 * (`in-cluster`) and stores no credential. Both carry the public control-plane
 * endpoint and certificate authority that node pool VMs join through. No
 * client-authored kubeconfig is parsed anywhere.
 */
export type ClusterConnectionDocument =
  | {
      kind: 'installer';
      server: string;
      certificateAuthorityData: string;
      credential: { kind: 'token'; token: string };
    }
  | {
      kind: 'in-cluster';
      /** `https://<public-ip>:6443`; what node pool VMs join through. */
      server: string;
      certificateAuthorityData: string;
    };

export class InvalidClusterConnectionError extends Error {
  constructor() {
    super('Stored cluster connection has an unexpected shape');
    this.name = 'InvalidClusterConnectionError';
  }
}

const CONNECTION_NAME = 'cluster';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new InvalidClusterConnectionError();
  }
  return value;
}

/** Exact shape check of a document this API wrote itself. */
export function parseClusterConnection(
  stored: string,
): ClusterConnectionDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new InvalidClusterConnectionError();
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const server = text(record.server);
  const certificateAuthorityData = text(record.certificateAuthorityData);
  if (!/^https:\/\//.test(server) || !BASE64.test(certificateAuthorityData)) {
    throw new InvalidClusterConnectionError();
  }
  if (record.kind === 'in-cluster') {
    return { kind: 'in-cluster', server, certificateAuthorityData };
  }
  if (record.kind !== 'installer') {
    throw new InvalidClusterConnectionError();
  }
  const credential = (record.credential ?? {}) as Record<string, unknown>;
  if (credential.kind !== 'token') {
    throw new InvalidClusterConnectionError();
  }
  return {
    kind: 'installer',
    server,
    certificateAuthorityData,
    credential: { kind: 'token', token: text(credential.token) },
  };
}

export function serializeClusterConnection(
  connection: ClusterConnectionDocument,
): string {
  return JSON.stringify(connection);
}

/**
 * Build a client configuration without the loader's file, exec or provider
 * paths. The in-cluster kind reads the Pod's own ServiceAccount, never the
 * public endpoint.
 */
export function kubeConfigFromClusterConnection(
  connection: ClusterConnectionDocument,
): KubeConfig {
  const kubeConfig = new KubeConfig();
  if (connection.kind === 'in-cluster') {
    kubeConfig.loadFromCluster();
    return kubeConfig;
  }
  kubeConfig.loadFromOptions({
    clusters: [
      {
        name: CONNECTION_NAME,
        server: connection.server,
        caData: connection.certificateAuthorityData,
        skipTLSVerify: false,
      },
    ],
    users: [{ name: CONNECTION_NAME, token: connection.credential.token }],
    contexts: [
      {
        name: CONNECTION_NAME,
        cluster: CONNECTION_NAME,
        user: CONNECTION_NAME,
      },
    ],
    currentContext: CONNECTION_NAME,
  });
  return kubeConfig;
}
