import type {
  DeploymentStatus,
  DeploymentSummary,
} from '../../shared/api-contract/deployments-schemas.js';
import type { ClusterSummary } from '../../shared/api-contract/clusters-schemas.js';
import type { NodePoolSummary } from '../../shared/api-contract/node-pools-schemas.js';
import { isTerminalState, WorkloadState } from '../../shared/workload.js';
import { componentLine } from '../renderers/component-line.js';
import { formatAge, formatDurationCompact } from './duration.js';
import { RELEASING_LABELS } from './releasing.js';
import {
  formatCurrency,
  formatLocation,
  printFields,
  printStateHeader,
  printUpgrade,
} from './output.js';

/** The state with the Workload "releasing" label while the VM is released. */
export function formatClusterState(
  cluster: ClusterSummary,
  compact = false,
): string {
  if (!cluster.releasing) return cluster.state;
  return `${cluster.state}${compact ? RELEASING_LABELS.stateCompact : RELEASING_LABELS.state}`;
}

/**
 * The installed API version. The hosted API's own record reports its pinned
 * image and release when Helm-managed, and its own version otherwise; an
 * installer cluster's apiVersion is only planned until its release.
 */
export function clusterApiVersion(cluster: ClusterSummary): string | null {
  return (
    cluster.release?.apiVersion ??
    (cluster.apiImage ? null : cluster.apiVersion)
  );
}

export function printClusterSummary(cluster: ClusterSummary): void {
  printStateHeader(cluster.state, cluster.releasing);
  const lines: Array<[string, string]> = [
    ['Name', cluster.name],
    ['ID', cluster.id],
  ];
  // A hosted API's record from before 0.1.74 carries no creation facts.
  if (cluster.cloudProvider) {
    lines.push([
      'Cloud',
      formatLocation(cluster.cloudProvider, cluster.region, cluster.zone),
    ]);
    if (cluster.cloudAccount) lines.push(['Account', cluster.cloudAccount]);
    lines.push(['VM', cluster.vmType ?? '']);
  }
  if (cluster.address) lines.push(['Address', cluster.address]);
  if (cluster.k3sVersion)
    lines.push(['Kubernetes', `K3s ${cluster.k3sVersion}`]);
  const apiVersion = clusterApiVersion(cluster);
  if (apiVersion) lines.push(['API', apiVersion]);
  if (cluster.managementApiUrl) lines.push(['URL', cluster.managementApiUrl]);
  lines.push(
    ['Node pools', String(cluster.activeNodePoolCount)],
    ['Age', formatAge(cluster.createdAt)],
  );
  if (cluster.lastError) lines.push(['Last error', cluster.lastError]);
  printFields(lines);
}

/** A node pool's `status`: the Workload state header, fields and ingress. */
export function printNodePoolSummary(nodePool: NodePoolSummary): void {
  // `locations` lists every VM row not yet ended, so none left means only the
  // pool's network remains to be removed and no VM row is billing.
  printStateHeader(
    nodePool.state,
    nodePool.releasing,
    nodePool.capacity.locations.length > 0
      ? RELEASING_LABELS.state
      : RELEASING_LABELS.network,
  );
  const lines: Array<[string, string]> = [
    ['ID', nodePool.id],
    ['Name', nodePool.name],
    ['Cluster', nodePool.clusterId],
    [
      'Cloud',
      formatLocation(
        nodePool.cloudProvider,
        nodePool.region ?? 'any region',
        nodePool.zone,
      ),
    ],
    ['VM types', nodePool.vmTypes.join(', ')],
    ['Pricing', nodePool.spot ? 'spot' : 'on-demand'],
    ...(nodePool.allowPrivilegedJobs
      ? [
          ['Privileged Jobs', 'admitted (root on the Node; deprecated)'] as [
            string,
            string,
          ],
        ]
      : []),
    ...(nodePool.userNamespaceJobs
      ? [
          ['User-namespace Jobs', 'every Job, in its own user namespace'] as [
            string,
            string,
          ],
        ]
      : []),
    ...(nodePool.requireNestedVirtualization
      ? [['Nested virtualization', 'on (KVM)'] as [string, string]]
      : []),
    [
      'OS disk',
      `${nodePool.osDiskSizeGb === null ? 'default size' : `${nodePool.osDiskSizeGb} GB`}, ${nodePool.osDiskTier ?? 'default'} tier`,
    ],
    [
      'VMs',
      `${nodePool.capacity.readyVmCount}/${nodePool.maxVmCount} ready, ${nodePool.capacity.startingVmCount} starting, ${nodePool.capacity.drainingVmCount} draining`,
    ],
  ];
  const scaledOut = nodePool.capacity.lastScaleOut;
  if (scaledOut) {
    const plural = (count: number, noun: string) =>
      `${count} ${noun}${count === 1 ? '' : 's'}`;
    const lost =
      scaledOut.lostVms > 0
        ? ` and ${plural(scaledOut.lostVms, 'lost VM')}`
        : '';
    lines.push([
      'Scale-out',
      `${plural(scaledOut.vms, 'VM')} for ${plural(scaledOut.pendingPods, 'Pending Pod')}${lost}, ${formatDurationCompact(Date.now() - scaledOut.at)} ago`,
    ]);
  }
  const { runners } = nodePool;
  if (runners) {
    lines.push([
      'Runners',
      `${runners.busy} busy, ${runners.idle} idle, ${runners.pending} Pending${runners.reasons.length > 0 ? ` (${runners.reasons.join('; ')})` : ''}`,
    ]);
  } else if (runners === null) {
    lines.push(['Runners', 'unavailable: the cluster could not be read']);
  }
  const { locations } = nodePool.capacity;
  if (locations.length > 0) {
    lines.push([
      'Live VMs',
      locations
        .map(
          ({ region, zone, vmType }) =>
            `${vmType} in ${zone ? `${region} (zone ${zone})` : region}`,
        )
        .join(', '),
    ]);
  }
  const releasing = locations.flatMap(({ vmType, releasing }) =>
    releasing
      ? `${vmType} for ${formatDurationCompact(Date.now() - releasing.since)}; usually under ${formatDurationCompact(Math.ceil(releasing.usuallyUnderSeconds / 60) * 60_000)}`
      : [],
  );
  if (releasing.length > 0) lines.push(['Releasing', releasing.join(', ')]);
  if (nodePool.lastError) lines.push(['Last error', nodePool.lastError]);
  printFields(lines);
  const { entryIp, release } = nodePool.ingress;
  if (!release) return;
  const failed = release.state === 'failed';
  const { daemonSet } = release;
  const ready =
    release.state === 'installed' &&
    entryIp !== null &&
    daemonSet !== null &&
    daemonSet.entryNodeReady &&
    daemonSet.ready === daemonSet.desired;
  const text = failed
    ? `failed: ${release.helmJob?.message ?? release.lastEvent ?? 'unknown error'}`
    : entryIp === null
      ? 'waiting for an entry VM'
      : release.state === 'absent'
        ? `${entryIp} · ${release.lastEvent ?? 'pending'}`
        : release.state === 'installing'
          ? `${entryIp} · installing`
          : daemonSet && !daemonSet.entryNodeReady
            ? `${entryIp} · entry VM not ready`
            : ready
              ? entryIp
              : `${entryIp} · starting`;
  console.log('');
  console.log(`   ${componentLine('ingress', ready, !failed && !ready, text)}`);
}

/**
 * The state cell. A list makes no live Kubernetes reads, so without a status
 * only the stored deletion facts settle it; otherwise the cell is blank.
 */
export function formatDeploymentState(deployment: DeploymentSummary): string {
  const { status } = deployment;
  if (status) {
    return `${status.state}${status.releasing ? RELEASING_LABELS.stateCompact : ''}`;
  }
  if (deployment.deletedAt !== null) return WorkloadState.Terminated;
  if (deployment.deletionRequestedAt !== null) {
    return `${WorkloadState.Terminated}${RELEASING_LABELS.stateCompact}`;
  }
  return '';
}

/** Jobs holding a slot (running or cleaning up) over every replica's slots. */
export function formatDeploymentJobs(deployment: DeploymentSummary): string {
  return `${deployment.jobs.unreleased}/${deployment.maxConcurrentJobsPerReplica * deployment.maxReplicas}`;
}

/** Ready replicas over the bounds; `-` while Kubernetes isn't read. */
export function formatDeploymentReplicas(
  deployment: DeploymentSummary,
): string {
  const { minReplicas: min, maxReplicas: max } = deployment;
  const ready = deployment.status?.readyReplicas;
  return `${ready ?? '-'}/${min === max ? min : `${min}-${max}`}`;
}

function readinessProbe(deployment: DeploymentSummary): string {
  if (!deployment.readinessProbe) return 'not set';
  const { exec, ...settings } = deployment.readinessProbe;
  const timings = Object.entries(settings)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return `exec: ${JSON.stringify(exec.command)}${timings ? ` (${timings})` : ''}`;
}

function blockingJobs(status: DeploymentStatus, verbose: boolean): string {
  const { total, jobs } = status.blockingJobs;
  const shown = jobs.slice(0, verbose ? jobs.length : 3);
  const remaining = total - shown.length;
  return `${shown
    .map((job) => {
      const facts: string[] = [job.state];
      if (isTerminalState(job.state)) facts.push('cleaning up');
      if (verbose) facts.push(`revision ${job.generation ?? 'unknown'}`);
      return `${job.id} (${facts.join(', ')})`;
    })
    .join(', ')}${remaining > 0 ? ` · ${remaining} more` : ''}`;
}

/**
 * A Deployment's `status`: the Workload state header, fields, and its latest
 * `Upgrade N`. Create, upgrade, and delete responses carry no observation,
 * so they print the fields alone.
 */
export function printDeploymentSummary(
  deployment: DeploymentSummary,
  options: { verbose?: boolean } = {},
): void {
  const { status } = deployment;
  const verbose = options.verbose ?? false;
  if (status) {
    printStateHeader(
      status.state,
      status.releasing,
      RELEASING_LABELS.stateCompact,
    );
  } else console.log('');
  const revision = (value: number | null) => String(value ?? 'unknown');
  const lines: Array<[string, string]> = [
    ['Name', deployment.name],
    ['ID', deployment.id],
    ['Node pool', deployment.nodePoolId],
    ['Image', deployment.image],
    ...(deployment.secretNames.length > 0
      ? [['Secrets', deployment.secretNames.join(', ')] as [string, string]]
      : []),
    [
      'Revision',
      verbose && status
        ? `${status.requestedGeneration} requested · ${revision(status.appliedGeneration)} applied · ${revision(status.podGeneration)} in Pod`
        : String(deployment.generation),
    ],
    ['Replicas', `${formatDeploymentReplicas(deployment)} ready`],
    [
      'Jobs',
      `${formatDeploymentJobs(deployment)} · ${deployment.jobs.queued} queued`,
    ],
    ['Readiness probe', readinessProbe(deployment)],
    ['Grace period', `${deployment.gracePeriodSeconds}s`],
    ['Age', formatAge(deployment.createdAt)],
  ];
  const { usage } = deployment;
  if (usage) {
    const idle = usage.replicaHours - usage.busyHours;
    const idleUsd = usage.costUsd - usage.busyCostUsd;
    lines.push([
      'Replica time',
      `${usage.replicaHours.toFixed(1)} h (${formatCurrency(usage.costUsd)}) · ${usage.busyHours.toFixed(1)} h busy (${formatCurrency(usage.busyCostUsd)}) · ${idle.toFixed(1)} h idle (${formatCurrency(idleUsd)})`,
    ]);
  }
  const settled =
    !status?.upgrade || status.upgrade.state === WorkloadState.Running;
  // A running Deployment's readiness line, or an unsettled upgrade's line,
  // carries the reason; other states show it as a field.
  const readiness = status?.state === WorkloadState.Running && settled;
  if (status) {
    if (!readiness && settled) lines.push(['Reason', status.reason]);
    const pending = deployment.workload?.pendingReason;
    if (pending && pending !== status.reason) lines.push(['Pending', pending]);
    if (status.blockingJobs.total > 0) {
      lines.push(['Waiting on', blockingJobs(status, verbose)]);
    }
    if (verbose) {
      lines.push(
        ['Pod', status.podName ?? 'unknown'],
        ['Pod UID', status.podUid ?? 'unknown'],
        ['Container ID', status.containerId ?? 'unknown'],
      );
    }
    if (status.observationError) {
      lines.push(['Last error', status.observationError]);
    }
  }
  printFields(lines);
  if (status && readiness) {
    console.log('');
    console.log(
      `   ${componentLine('ready', status.ready, false, status.reason)}`,
    );
  }
  const upgrade = status?.upgrade;
  if (!upgrade) return;
  printUpgrade(
    upgrade,
    deployment.image,
    'pod',
    upgrade.state === WorkloadState.Running ? '' : `: ${status.reason}`,
  );
}
