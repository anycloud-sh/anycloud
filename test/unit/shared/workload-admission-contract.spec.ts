import { describe, expect, it } from 'vitest';
import { workloadAdmissionInputSchema } from '../../../src/shared/api-contract/workload-admission-schemas.js';

describe('Workload admission contract', () => {
  it('accepts a submission and refuses unknown fields', () => {
    expect(
      workloadAdmissionInputSchema.parse({
        image: 'app:latest',
        cloudConfig: {},
      }),
    ).toEqual({ image: 'app:latest', cloudConfig: {} });
    expect(() =>
      workloadAdmissionInputSchema.parse({
        image: 'app:latest',
        cloudConfig: {},
        workload: 'other',
      }),
    ).toThrow();
  });

  it.each(['', [''], []])('rejects an empty VM type value %#', (vmType) => {
    expect(() =>
      workloadAdmissionInputSchema.parse({
        image: 'app:latest',
        cloudConfig: { vmType },
      }),
    ).toThrow();
  });
});
