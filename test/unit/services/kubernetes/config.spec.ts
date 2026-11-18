import { describe, expect, it } from 'vitest';
import { createDefaultLocalKubernetesConfig } from '../../../../src/api/services/kubernetes/config';

describe('createDefaultLocalKubernetesConfig', () => {
  it('uses a stable namespace default', () => {
    expect(createDefaultLocalKubernetesConfig()).toEqual({
      namespace: 'anycloud',
    });
  });

  it('accepts an explicit namespace', () => {
    expect(
      createDefaultLocalKubernetesConfig({ namespace: ' workloads ' })
        .namespace,
    ).toBe('workloads');
  });
});
