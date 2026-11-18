import type { StageProgress } from '../progress.js';

/** A Helm-managed API installed with an older inline chart switched to its own OCI chart, once. */
export interface ClusterLocalHostedChartRecord {
  /** The digest-pinned chart the API image names. */
  readonly chart: string;
  readonly podLogPermitted: true;
  readonly apiPod: string;
  readonly apiRestarts: 0;
}

export interface ClusterLocalContractResult {
  readonly contract: 'e2e-cluster-local';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: 'e2e-cluster-local';
  readonly records: {
    readonly cluster: {
      readonly id: string;
      readonly kubernetesIdentity: string;
      readonly intactAfterApiRestart: true;
    };
    readonly hostedChart: ClusterLocalHostedChartRecord;
  };
}

export interface ClusterLocalRecordedCluster {
  readonly id: string;
  readonly kubernetesIdentity: string;
}

interface ClusterLocalDependencies {
  readonly cluster: {
    prepare(): Promise<void>;
    registered(): ClusterLocalRecordedCluster;
    intact(): Promise<ClusterLocalRecordedCluster>;
    /** Crashes the API process and relaunches it on the same state root. */
    replaceController(): Promise<{
      readonly beforeControllerInstance: string;
      readonly afterControllerInstance: string;
    }>;
    /** The Helm-managed API applies its own chart over an older one. */
    hostedChartRepair(): Promise<ClusterLocalHostedChartRecord>;
  };
  /** Stage timeline for the run log: a cancelled job still shows how far it got. */
  readonly progress: Pick<StageProgress, 'mark'>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Local cluster contract: ${message}`);
}

/**
 * The runner's K3s server is recorded as the API's cluster before the API
 * serves; a hard API-process replacement keeps that record; and a
 * Helm-managed API built from this tree repairs an older inline chart.
 */
export class ClusterLocalContract {
  readonly #dependencies: ClusterLocalDependencies;

  constructor(dependencies: ClusterLocalDependencies) {
    this.#dependencies = dependencies;
  }

  async run(target: 'e2e-cluster-local'): Promise<ClusterLocalContractResult> {
    invariant(target === 'e2e-cluster-local', `unsupported target ${target}`);
    const { cluster: fixture, progress } = this.#dependencies;
    await fixture.prepare();
    const cluster = fixture.registered();
    progress.mark('cluster registered through the API');

    const replacement = await fixture.replaceController();
    invariant(
      replacement.afterControllerInstance !==
        replacement.beforeControllerInstance,
      'the API process was not replaced',
    );
    const intact = await fixture.intact();
    invariant(
      intact.id === cluster.id &&
        intact.kubernetesIdentity === cluster.kubernetesIdentity,
      'API replacement changed the cluster record',
    );
    progress.mark('API replaced; cluster record unchanged');

    const hostedChart = await fixture.hostedChartRepair();
    progress.mark('hosted API applied its own chart');
    return {
      contract: 'e2e-cluster-local',
      records: {
        cluster: {
          id: cluster.id,
          kubernetesIdentity: cluster.kubernetesIdentity,
          intactAfterApiRestart: true,
        },
        hostedChart,
      },
      qualification: 'conclusive',
      target: 'e2e-cluster-local',
      satisfied: true,
    };
  }
}
