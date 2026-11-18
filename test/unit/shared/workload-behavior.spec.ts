import { describe, expect, it } from 'vitest';

import {
  workloadRequestsManagedHttpIngress,
  workloadRequiresRunningContainer,
  workloadTypeBucket,
  workloadTypeLabel,
} from '../../../src/shared/workload-behavior.js';
import { WorkloadType } from '../../../src/shared/workload.js';

describe('workload behavior', () => {
  it.each([
    [WorkloadType.Job, false, false, 'jobs', 'job'],
    [WorkloadType.Service, true, true, 'services', 'service'],
    [WorkloadType.Vm, true, false, 'vms', 'vm'],
  ] as const)(
    'classifies %s exhaustively',
    (workloadType, requiresRunning, defaultIngress, bucket, label) => {
      expect(workloadRequiresRunningContainer(workloadType)).toBe(
        requiresRunning,
      );
      expect(workloadRequestsManagedHttpIngress(workloadType)).toBe(
        defaultIngress,
      );
      expect(workloadTypeBucket(workloadType)).toBe(bucket);
      expect(workloadTypeLabel(workloadType)).toBe(label);
    },
  );
});
