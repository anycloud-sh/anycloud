import { z } from 'zod';
import type { HostedClusterConfig } from '../config.js';
import { CloudType } from '../../shared/cloud.js';
import { isComputeProvider } from '../../shared/providers.js';
import type { SystemReleaseClusterRecord } from '../../shared/system-release-values.js';
import type { ClusterInstallerRepository } from './cluster-installer-store.js';
import {
  serializeClusterConnection,
  type ClusterConnectionDocument,
} from './kubernetes/cluster-connection.js';

export class HostedClusterRefusedError extends Error {
  constructor(reason: string) {
    super(`Refusing to start: ${reason}`);
    this.name = 'HostedClusterRefusedError';
  }
}

const text = z.string().trim().min(1);
const clusterRecordSchema = z
  .object({
    cloudProvider: z
      .enum(CloudType)
      .refine(isComputeProvider, 'not a compute cloud'),
    cloudAccount: text.nullable(),
    region: text,
    zone: text.nullable(),
    vmType: text,
    managementVmId: text,
    networkScope: text,
    k3s: z.object({ version: text, sha256: z.string().length(64) }).strict(),
    checkpointBucket: z
      .object({ name: text, managed: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict() satisfies z.ZodType<SystemReleaseClusterRecord>;

function parseClusterRecord(
  raw: string | undefined,
): SystemReleaseClusterRecord | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HostedClusterRefusedError('cluster.record is not JSON');
  }
  const parsed = clusterRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new HostedClusterRefusedError(
      `cluster.record is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Every value but the record is required: a Helm-managed API without them was
 * installed by an older chart. A release written before 0.1.74 has no record.
 */
export function hostedClusterEnvironment(
  raw: Record<
    Exclude<keyof HostedClusterConfig, 'record'>,
    string | undefined
  > & {
    record?: string;
  },
): HostedClusterConfig {
  const read = (key: Exclude<keyof HostedClusterConfig, 'record'>): string => {
    const value = raw[key];
    if (!value) {
      throw new HostedClusterRefusedError(
        `cluster.${key} is not set; the API chart must render the cluster values (upgrade the chart with the API)`,
      );
    }
    return value;
  };
  const joinEndpoint = read('joinEndpoint');
  if (!/^https:\/\//.test(joinEndpoint)) {
    throw new HostedClusterRefusedError(
      'cluster.joinEndpoint must be the public https control-plane endpoint',
    );
  }
  return {
    name: read('name'),
    kubernetesIdentity: read('kubernetesIdentity'),
    joinEndpoint,
    certificateAuthorityData: read('certificateAuthorityData'),
    record: parseClusterRecord(raw.record),
  };
}

export interface RecordHostedClusterInput {
  /** The installation id; the installer's record carries the same id. */
  clusterId: string;
  ownerUserId: string;
  environment: HostedClusterConfig;
  installations: Pick<ClusterInstallerRepository, 'recordSelf' | 'adoptSelf'>;
  /** Reads the `kube-system` namespace UID through the in-cluster connection. */
  observeKubernetesIdentity(
    connection: ClusterConnectionDocument,
  ): Promise<string>;
}

/**
 * The hosted API's one cluster record, written on first start with its
 * in-cluster ServiceAccount. The control plane it can reach must be the one
 * bootstrap observed for this chart. A database that records another
 * identity for the same installation was restored from a backup into a new
 * cluster (`cluster create --checkpoint-bucket`): the API adopts the new
 * cluster.
 */
export async function recordHostedCluster(
  input: RecordHostedClusterInput,
): Promise<'recorded' | 'exists' | 'adopted'> {
  const connection: ClusterConnectionDocument = {
    kind: 'in-cluster',
    server: input.environment.joinEndpoint,
    certificateAuthorityData: input.environment.certificateAuthorityData,
  };
  const observed = await input.observeKubernetesIdentity(connection);
  if (observed !== input.environment.kubernetesIdentity) {
    throw new HostedClusterRefusedError(
      `this API runs in cluster ${observed} but was installed for ${input.environment.kubernetesIdentity}`,
    );
  }
  const result = await input.installations.recordSelf({
    id: input.clusterId,
    ownerUserId: input.ownerUserId,
    name: input.environment.name,
    kubernetesIdentity: observed,
    connection: serializeClusterConnection(connection),
    record: input.environment.record,
  });
  if (result !== 'identity-mismatch') return result;
  const adopted = await input.installations.adoptSelf({
    id: input.clusterId,
    kubernetesIdentity: observed,
    connection: serializeClusterConnection(connection),
    record: input.environment.record,
  });
  if (!adopted) {
    throw new HostedClusterRefusedError(
      `the database's record of cluster ${input.clusterId} could not adopt Kubernetes identity ${observed}`,
    );
  }
  return 'adopted';
}
