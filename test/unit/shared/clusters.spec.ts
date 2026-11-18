import { describe, expect, it } from 'vitest';
import {
  CLUSTER_STEP_ORDER,
  ClusterState,
  ClusterStep,
  clusterWorkloadState,
} from '../../../src/shared/clusters.js';
import { WorkloadState } from '../../../src/shared/workload.js';

describe('clusterWorkloadState', () => {
  it('reads a creation by how far it got: VM, then Kubernetes, then the API', () => {
    expect(
      CLUSTER_STEP_ORDER.map((step) =>
        clusterWorkloadState(ClusterState.Bootstrapping, step),
      ),
    ).toEqual([
      WorkloadState.Provisioning, // intent: the VM is next
      WorkloadState.Initializing, // management VM up: K3s next
      WorkloadState.Initializing,
      WorkloadState.Initializing,
      WorkloadState.Starting, // connected: the API release next
      WorkloadState.Starting,
      WorkloadState.Starting,
    ]);
  });

  it('maps every other stored state whatever the step', () => {
    const states = (state: ClusterState) =>
      new Set(
        CLUSTER_STEP_ORDER.map((step) => clusterWorkloadState(state, step)),
      );
    expect(states(ClusterState.Ready)).toEqual(
      new Set([WorkloadState.Running]),
    );
    expect(states(ClusterState.Failed)).toEqual(
      new Set([WorkloadState.Failed]),
    );
    expect(states(ClusterState.DestroyFailed)).toEqual(
      new Set([WorkloadState.Failed]),
    );
    expect(states(ClusterState.Destroying)).toEqual(
      new Set([WorkloadState.Terminated]),
    );
    expect(states(ClusterState.Destroyed)).toEqual(
      new Set([WorkloadState.Terminated]),
    );
    expect(clusterWorkloadState(ClusterState.Ready, ClusterStep.Release)).toBe(
      WorkloadState.Running,
    );
  });
});
