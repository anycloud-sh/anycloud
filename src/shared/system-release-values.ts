import { clusterHostname } from './api-ingress.js';
import {
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from './system-release.js';
import type {
  CloudCredentials,
  CloudType,
  InstanceCloudCredentials,
} from './cloud.js';
import {
  SYSTEM_RELEASE_API_PORT,
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_NAMESPACE,
  isPinnedApiImage,
  isPinnedChartReference,
} from './system-release.js';

/**
 * Release intent as the cluster sees it: one `HelmChart` object whose values and
 * annotations carry the installation's monotonic revision and operation. The
 * object is applied through the Kubernetes API exactly once per revision and
 * never written into K3s's watched manifests directory, so a host restart
 * replays nothing.
 */
export interface SystemReleaseValues {
  release: {
    revision: number;
    operationId: string;
    image: string;
    version: string;
  };
  installation: {
    id: string;
    ownerUsername: string;
    ownerUserId: string;
    /** GitHub Apps whose user tokens the API's exchange accepts. */
    githubAppIds: number[];
    apiUrl: string;
  };
  /**
   * What the hosted API records about the cluster it runs in: bootstrap's
   * observed `kube-system` UID (the API refuses to start against another) and
   * the public control-plane endpoint.
   */
  cluster: SystemReleaseClusterValues;
  ingress: { mode: 'traefik'; host: string };
  api: { port: number };
  /** Database backup target with its storage credential; null disables backups. */
  backup: SystemReleaseBackupValues | null;
  /** Fill the empty state volume from `backup` before the API's first start. */
  state: { restoreFromBackup: boolean };
}

export interface SystemReleaseBackupValues {
  bucket: string;
  region: string;
  cloudProvider: CloudType;
  /** A stored credential, or the management VM's own identity (RFC 0049 C26 (e)). */
  credentials: CloudCredentials | InstanceCloudCredentials;
  /** The cluster's AWS account, GCP project or Azure subscription, for `backup.json`. */
  account?: string;
  /** The cluster's name, region and management VM type, for `backup.json`. */
  target?: { name: string; region: string; vmType: string };
}

interface SystemReleaseClusterValues {
  name: string;
  kubernetesIdentity: string;
  joinEndpoint: string;
  certificateAuthorityData: string;
  /**
   * What delete and upgrade need from the creating machine (RFC 0049 C26 (a)),
   * which the hosted API keeps on its own row. Never the SSH key or the K3s
   * server token. Null in values written before 0.1.74.
   */
  record: SystemReleaseClusterRecord | null;
}

export interface SystemReleaseClusterRecord {
  cloudProvider: CloudType;
  /** AWS account, GCP project or Azure subscription; null on Lambda. */
  cloudAccount: string | null;
  region: string;
  zone: string | null;
  vmType: string;
  /** The management VM's provider id. */
  managementVmId: string;
  /** Names and tags of the cluster's network resources: `anycloud-cluster-<id>`. */
  networkScope: string;
  k3s: { version: string; sha256: string };
  checkpointBucket: { name: string; managed: boolean } | null;
}

export interface SystemReleaseIntentInput {
  installationId: string;
  cluster: SystemReleaseClusterValues;
  revision: number;
  operationId: string;
  apiImage: string;
  apiVersion: string;
  ownerUsername: string;
  ownerUserId: string;
  githubAppIds: number[];
  apiUrl: string;
  /** The API image's own digest-pinned chart (`oci://…@sha256:…`). */
  chart: string;
  helmJobImage: string;
  backup: SystemReleaseBackupValues | null;
  restoreFromBackup: boolean;
}

/** The subset of a `helm.cattle.io/v1` HelmChart this release writes and reads. */
export interface HelmChartObject {
  apiVersion: 'helm.cattle.io/v1';
  kind: 'HelmChart';
  metadata: {
    name: string;
    namespace: string;
    annotations: Record<string, string>;
    resourceVersion?: string;
    uid?: string;
  };
  spec: {
    /**
     * Digest-pinned OCI reference, pulled by helm-controller's Job. Without
     * `spec.version` Helm pulls by digest alone; with one it would also
     * resolve that tag and refuse when it has moved.
     */
    chart: string;
    /**
     * Releases before 0.1.68 inlined the chart here, and it overrides `chart`.
     * Writes send null, which removes it under the merge patch.
     */
    chartContent?: string | null;
    targetNamespace: string;
    createNamespace: boolean;
    jobImage: string;
    /** Lets the helm-controller install Job tolerate the cluster's control-plane taint. */
    bootstrap: true;
    failurePolicy: 'abort';
    backOffLimit: number;
    timeout: string;
    valuesContent: string;
  };
}

export function systemReleaseValues(
  input: SystemReleaseIntentInput,
): SystemReleaseValues {
  if (!isPinnedApiImage(input.apiImage)) {
    throw new Error('Release intent requires a digest-pinned API image');
  }
  if (!isPinnedChartReference(input.chart)) {
    throw new Error('Release intent requires a digest-pinned API chart');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error('Release revision must be a positive integer');
  }
  return {
    release: {
      revision: input.revision,
      operationId: input.operationId,
      image: input.apiImage,
      version: input.apiVersion,
    },
    installation: {
      id: input.installationId,
      ownerUsername: input.ownerUsername,
      ownerUserId: input.ownerUserId,
      githubAppIds: input.githubAppIds,
      apiUrl: input.apiUrl,
    },
    cluster: input.cluster,
    ingress: {
      mode: 'traefik',
      host: clusterHostname(input.installationId),
    },
    api: { port: SYSTEM_RELEASE_API_PORT },
    backup: input.backup,
    state: { restoreFromBackup: input.restoreFromBackup },
  };
}

export function buildSystemReleaseHelmChart(
  input: SystemReleaseIntentInput,
): HelmChartObject {
  const values = systemReleaseValues(input);
  return {
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name: SYSTEM_RELEASE_HELM_CHART_NAME,
      namespace: SYSTEM_RELEASE_NAMESPACE,
      annotations: {
        [RELEASE_REVISION_ANNOTATION]: String(input.revision),
        [RELEASE_OPERATION_ANNOTATION]: input.operationId,
        [RELEASE_INSTALLATION_ANNOTATION]: input.installationId,
      },
    },
    spec: {
      chart: input.chart,
      targetNamespace: SYSTEM_RELEASE_NAMESPACE,
      createNamespace: true,
      jobImage: input.helmJobImage,
      // helm-controller adds tolerations to its install Job only for bootstrap
      // charts; without this the Job cannot schedule onto the tainted single
      // management Node and the release never starts.
      bootstrap: true,
      // The pinned controller's default `reinstall` would delete and recreate
      // the release on failure; `abort` retains everything for explicit repair.
      failurePolicy: 'abort',
      backOffLimit: 0,
      timeout: '600s',
      valuesContent: JSON.stringify(values),
    },
  };
}
