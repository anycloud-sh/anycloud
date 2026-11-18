import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../../../../src/api/services/kubernetes/identity.js';
import { nodePoolNamespace } from '../../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  podRequests,
  quantity,
} from '../../../../../../src/api/services/pool-fit.js';
import type { CliClient } from '../../cli.js';
import { cliArgs } from '../../cli-surface.js';
import type {
  BurstJobSubmission,
  BurstSample,
  ClaimBurstTarget,
} from '../../contracts/claim-burst.js';
import type { KubernetesQualificationTransport } from '../../kubernetes-transport.js';
import { unscopedCliEnvironment } from '../../local-api-process.js';
import { executeLocalKubernetesCommand } from './command.js';
import {
  localClusterKwokVmType,
  localClusterPricedVmType,
  localClusterServerContainer,
} from './constants.js';
import type { ClusterLocalEnvironment } from './environment.js';
import { KwokClaimers } from './kwok.js';

/** CLI processes submitting at once. */
const SUBMITTERS = 16;

/** Docker's `12.5%` and `1.2GiB / 4GiB`. */
function dockerStats(line: string): { cpu: number; memory: number } {
  const [cpu, memory] = line.trim().split('|');
  const [, amount, unit] = /^([\d.]+)\s*([KMG]i?B|B)/u.exec(memory ?? '') ?? [];
  const scale: Record<string, number> = {
    B: 1,
    KiB: 2 ** 10,
    MiB: 2 ** 20,
    GiB: 2 ** 30,
    kB: 1e3,
    MB: 1e6,
    GB: 1e9,
  };
  return {
    cpu: Number.parseFloat(cpu ?? '0'),
    memory: Number(amount ?? 0) * (scale[unit ?? 'B'] ?? 1),
  };
}

/** S12's substrate on the local cluster (`contracts/claim-burst.ts`). */
export class LocalClaimBurst implements ClaimBurstTarget {
  readonly #environment: ClusterLocalEnvironment;
  readonly #cli: Pick<CliClient, 'run'>;
  readonly #transport: Pick<KubernetesQualificationTransport, 'poolJobStatus'>;
  readonly #apiUrl: () => string;
  readonly #runId: string;
  #claimers: KwokClaimers | undefined;

  constructor(input: {
    readonly environment: ClusterLocalEnvironment;
    readonly cli: Pick<CliClient, 'run'>;
    readonly transport: Pick<KubernetesQualificationTransport, 'poolJobStatus'>;
    readonly apiUrl: () => string;
    readonly runId: string;
  }) {
    this.#environment = input.environment;
    this.#cli = input.cli;
    this.#transport = input.transport;
    this.#apiUrl = input.apiUrl;
    this.#runId = input.runId;
  }

  /**
   * A production default's management node, `t3.medium`: 2 vCPU, the first
   * two this process may use, and 4 GiB.
   */
  async prepare(): Promise<void> {
    const allowed = /^Cpus_allowed_list:\s*(\S+)$/mu.exec(
      await readFile('/proc/self/status', 'utf8'),
    )?.[1];
    const cpus = (allowed ?? '')
      .split(',')
      .flatMap((range) => {
        const [first = NaN, last = first] = range.split('-').map(Number);
        return Array.from({ length: last - first + 1 }, (_, i) => first + i);
      })
      .slice(0, 2);
    if (cpus.length < 2) throw new Error(`Too few CPUs: ${String(allowed)}`);
    this.#environment.constrainManagement({
      cpus: cpus.join(','),
      memoryBytes: 4 * 2 ** 30,
    });
    await this.#environment.prepare();
  }

  usePoolVmType(name: string, kind: 'priced' | 'kwok'): void {
    this.#environment.useVmType(
      name,
      kind === 'priced' ? localClusterPricedVmType : localClusterKwokVmType,
    );
  }

  preparePoolJobImages(nodePoolId: string): Promise<void> {
    return this.#environment.preparePoolJobImages(nodePoolId);
  }

  /** The least allocatable CPU any of the pool's Nodes has left. */
  async poolNodeFreeMillicores(nodePoolId: string): Promise<number> {
    const { core } = this.#environment.adminClients();
    const nodes = await core.listNode({
      labelSelector: `anycloud.sh/node-pool=${nodePoolId}`,
    });
    const free = await Promise.all(
      nodes.items.map(async (node) => {
        const pods = await core.listPodForAllNamespaces({
          fieldSelector: `spec.nodeName=${node.metadata!.name!},status.phase!=Succeeded,status.phase!=Failed`,
        });
        return (
          quantity(node.status!.allocatable!.cpu, 1000) -
          pods.items.reduce((sum, pod) => sum + podRequests(pod).cpu, 0)
        );
      }),
    );
    return Math.min(...free);
  }

  async submitPoolJobs(
    nodePoolId: string,
    jobs: readonly BurstJobSubmission[],
  ): Promise<readonly { id: string; exitCode: number; output: string }[]> {
    const results: { id: string; exitCode: number; output: string }[] = [];
    let next = 0;
    const submitter = async () => {
      for (let job = jobs[next++]; job; job = jobs[next++]) {
        const result = await this.#cli.run(
          cliArgs(
            'job',
            // Without --memory a replica requests its CPU share of the
            // catalog type's memory: GiBs on x2iedn.8xlarge, more than the
            // small local Nodes hold for 20 replicas.
            {
              id: job.id,
              'node-pool': nodePoolId,
              cpus: job.cpus,
              memory: '128m',
            },
            [this.#environment.workloadImage()],
            ['sh', '-c', job.script],
          ),
          {
            timeoutMs: 120_000,
            label: `burst-submit-${job.id}`,
            // The CLI tags a non-interactive submit with the session it detects.
            env: {
              ...unscopedCliEnvironment,
              ...(job.session && {
                CLAUDECODE: '1',
                CLAUDE_CODE_SESSION_ID: job.session,
              }),
            },
            recordArtifact: false,
          },
        );
        results.push({
          id: job.id,
          exitCode: result.exitCode ?? 1,
          output: result.combined,
        });
      }
    };
    await Promise.all(Array.from({ length: SUBMITTERS }, submitter));
    return results;
  }

  async terminatePoolJobs(ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += 50) {
      await this.#cli.run(
        cliArgs('terminate', {}, ids.slice(start, start + 50)),
        { timeoutMs: 300_000, label: 'burst-terminate' },
      );
    }
  }

  async deleteReplicas(
    nodePoolId: string,
    deploymentId: string,
  ): Promise<void> {
    await this.#environment.adminClients().core.deleteCollectionNamespacedPod({
      namespace: nodePoolNamespace(nodePoolId),
      labelSelector: kubernetesWorkloadPodSelector(deploymentId),
    });
  }

  async deploymentOf(jobId: string): Promise<string | null> {
    return (
      (await this.#transport.poolJobStatus(jobId)).workload.deploymentId ?? null
    );
  }

  runsUrl(): string {
    return this.#environment.runsUrl();
  }

  openGate(gate: string): Promise<number> {
    return this.#environment.openGate(gate);
  }

  async setSessionThrottle(capUsd: number | null): Promise<void> {
    const result = await this.#cli.run(
      capUsd === null
        ? cliArgs('throttle unset', { 'agent-session': true })
        : cliArgs('throttle set', { 'agent-session': true }, [String(capUsd)]),
      { timeoutMs: 60_000, label: 'burst-throttle' },
    );
    if (result.exitCode !== 0) {
      throw new Error(`anycloud throttle failed: ${result.combined}`);
    }
  }

  jobs(deploymentId: string | null, closeWindow: boolean) {
    return this.#environment.claimBurst(deploymentId, closeWindow);
  }

  async sample(nodePoolId: string, deploymentId: string): Promise<BurstSample> {
    const { core, apps } = this.#environment.adminClients();
    const namespace = nodePoolNamespace(nodePoolId);
    const started = performance.now();
    const pods = await core.listNamespacedPod({
      namespace,
      labelSelector: kubernetesWorkloadPodSelector(deploymentId),
    });
    const apiserverListMs = performance.now() - started;
    const native = await apps
      .readNamespacedDeployment({
        name: kubernetesWorkloadResourceName('deployment', deploymentId),
        namespace,
      })
      .catch((error: unknown) => {
        if ((error as { code?: number }).code === 404) return undefined;
        throw error;
      });
    const server = localClusterServerContainer(this.#runId);
    const [stats, inspected] = await Promise.all([
      executeLocalKubernetesCommand('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}}|{{.MemUsage}}',
        server,
      ]),
      executeLocalKubernetesCommand('docker', [
        'inspect',
        '--format',
        '{{.RestartCount}}',
        server,
      ]),
    ]);
    const { cpu, memory } = dockerStats(stats.stdout);
    const unscheduled = pods.items
      .flatMap((pod) => pod.status?.conditions ?? [])
      .find(
        (condition) =>
          condition.type === 'PodScheduled' && condition.status === 'False',
      );
    return {
      at: Date.now(),
      desiredReplicas: native?.spec?.replicas ?? 0,
      readyPods: pods.items.filter(
        (pod) =>
          !pod.metadata?.deletionTimestamp &&
          pod.status?.conditions?.some(
            (condition) =>
              condition.type === 'Ready' && condition.status === 'True',
          ),
      ).length,
      pendingReason: unscheduled?.message ?? null,
      apiserverListMs,
      managementCpuPercent: cpu,
      managementMemoryBytes: memory,
      managementRestarts: Number(inspected.stdout.trim()),
    };
  }

  startKwok(): Promise<void> {
    return this.#environment.startKwok();
  }

  setInFlightCap(cap: number): Promise<void> {
    return this.#environment.setInFlightCap(cap);
  }

  startClaimers(nodePoolId: string, deploymentId: string, jobMs: number): void {
    this.#claimers = new KwokClaimers(this.#environment.adminClients(), {
      apiUrl: this.#apiUrl(),
      nodePoolId,
      deploymentId,
      jobMs,
    });
    this.#claimers.start();
  }

  async stopClaimers(): Promise<void> {
    await this.#claimers?.stop();
    this.#claimers = undefined;
  }
}
