import { describe, it, expect } from 'vitest';
import {
  buildWorkloadListOutput,
  listViewChoices,
} from '../../../../src/cli/renderers/workload-list.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { makeWorkloadListRow } from '../../helpers/fixtures.js';

describe('listViewChoices', () => {
  it('offers the user and session views only once the listing has them', () => {
    expect(
      listViewChoices({
        creators: [],
        sessions: [],
        stateCounts: new Map(),
        total: 0,
      }),
    ).toEqual([{ title: '📋 all (0)', value: '__all__' }]);
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
