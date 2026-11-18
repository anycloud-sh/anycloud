import { describe, expect, it } from 'vitest';
import { workloadAdmissionInputSchema } from '../../../src/shared/api-contract/workload-admission-schemas.js';

describe('Workload admission contract', () => {
  it('accepts the dedicated and targeted submission shapes', () => {
    expect(
      workloadAdmissionInputSchema.parse({
        image: 'deployment:latest',
        cloudConfig: {},
      }),
    ).toEqual({ image: 'deployment:latest', cloudConfig: {} });
    expect(
      workloadAdmissionInputSchema.parse({
        deployment: 'deployment',
        id: 'job-a',
      }),
    ).toEqual({ deployment: 'deployment', id: 'job-a' });
  });

  it('0036/S22 keeps the two strict submission shapes mutually exclusive', () => {
    expect(() =>
      workloadAdmissionInputSchema.parse({
        deployment: 'deployment',
        image: 'deployment:latest',
        cloudConfig: {},
      }),
    ).toThrow();
    expect(() =>
      workloadAdmissionInputSchema.parse({
        deployment: 'deployment',
        workloadType: 'service',
      }),
    ).toThrow();
    expect(() =>
      workloadAdmissionInputSchema.parse({
        workload: 'deployment',
        id: 'job-a',
      }),
    ).toThrow();
  });

  it.each(['', [''], []])('rejects an empty VM type value %#', (vmType) => {
    expect(() =>
      workloadAdmissionInputSchema.parse({
        image: 'deployment:latest',
        cloudConfig: { vmType },
      }),
    ).toThrow();
  });
});
