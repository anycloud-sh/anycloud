import { describe, it, expect } from 'vitest';
import {
  buildNodePoolDeploymentWatchLines,
  buildWorkloadListOutput,
  listViewChoices,
  nodePoolChoices,
} from '../../../../src/cli/renderers/workload-list.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import {
  makeDeploymentSummary,
  makeNodePoolSummary,
  makeWorkloadListRow,
} from '../../helpers/fixtures.js';

describe('listViewChoices', () => {
  it('offers the user and session views only once the listing has them', () => {
    expect(
      listViewChoices({
        creators: [],
        sessions: [],
        stateCounts: new Map(),
        total: 0,
      }),
    ).toEqual([
      { title: '☸️ by node pool', value: '__node_pools__' },
      { title: '📋 all (0)', value: '__all__' },
    ]);
    const two = ['a', 'b'].map((k) => ({
      username: k,
      session: k,
      displayForm: k,
      count: 1,
      latest: 0,
    }));
    expect(
      listViewChoices({
        creators: two,
        sessions: two,
        stateCounts: new Map(),
        total: 2,
      }).slice(0, 2),
    ).toEqual([
      { title: '👤 by user (2)', value: '__users__' },
      { title: '🤖 by session (2)', value: '__sessions__' },
    ]);
  });
});

describe('node pool state in list pickers and watch', () => {
  it('marks a terminated pool that is still releasing its VMs', () => {
    const nodePool = makeNodePoolSummary({
      state: WorkloadState.Terminated,
      releasing: true,
    });
    expect(nodePoolChoices([nodePool])[0]?.title).toContain(
      'terminated · releasing',
    );
    const lines = buildNodePoolDeploymentWatchLines(
      {
        nodePool,
        deployment: makeDeploymentSummary(),
        workloads: [],
      },
      { rows: 24, columns: 100 },
    );
    expect(lines[0]).toContain('Node pool: terminated · releasing,');
    expect(lines[1]).toBe('Deployment: unknown, Jobs 1/4 | model-deployment');
  });
});

describe('workload table state reasons', () => {
  it('shows why a Queued or Retrying row is waiting', () => {
    const { lines } = buildWorkloadListOutput(
      [
        makeWorkloadListRow({
          id: 'retrying-job',
          state: WorkloadState.Retrying,
          latestMessage: 'waiting for capacity',
        }),
        makeWorkloadListRow({
          id: 'running-job',
          state: WorkloadState.Running,
          latestMessage: 'stale reason',
        }),
      ],
      { effectiveCap: 200 },
    );
    const row = (id: string) => lines.find((line) => line.startsWith(id));
    expect(row('retrying-job')).toContain('— waiting for capacity');
    expect(row('running-job')).not.toContain('stale reason');
  });
});
