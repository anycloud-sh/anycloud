import { describe, expect, it } from 'vitest';
import {
  byRegionRank,
  classifyLaunchFailure,
  pickTarget,
  untriedTargetCount,
  withoutDeniedRegions,
} from '../../../src/api/services/launch-targets';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure';
import { candidateRegionKey } from '../../../src/api/services/gateways/cloud';
import { CloudFailureDiagnosis, CloudType } from '../../../src/shared/cloud';
import { makeMockCloudCompute } from '../helpers/fixtures';

describe('launch targets', () => {
  const denied = (error: unknown) =>
    error instanceof Error && error.message === 'denied';
  const compute = makeMockCloudCompute({
    rawClassifyError: (error) =>
      denied(error)
        ? CloudFailureDiagnosis.PermissionDenied
        : CloudFailureDiagnosis.CapacityExhausted,
    permissionDenial: (error) =>
      denied(error) ? { action: 'denied', regional: true } : undefined,
  });
  const classify = (message: string, pin: object) =>
    classifyLaunchFailure(
      compute,
      { cloudProvider: CloudType.GCP, region: 'us-central1' },
      new Error(message),
      pin,
    );

  it('routes a launch failure by the owner pins, and a denial only as a denial', () => {
    expect(classify('full', {})).toEqual({
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
      regionDenied: null,
      disposition: FailureDisposition.FailoverTarget,
    });
    expect(classify('denied', {})).toMatchObject({
      diagnosis: CloudFailureDiagnosis.PermissionDenied,
      regionDenied: 'denied',
      disposition: FailureDisposition.FailoverTarget,
    });
    // A pinned owner cannot fail over: it ends invalid, naming the action.
    expect(classify('denied', { region: 'us-central1' })).toMatchObject({
      regionDenied: null,
      disposition: FailureDisposition.TerminalInvalid,
      metadata: { message: expect.stringContaining('denied in us-central1') },
    });
  });

  it('keeps a pinned region the provider denied, and drops it otherwise', () => {
    const candidates = [
      { vmType: 'n2', region: 'us-central1' },
      { vmType: 'n2', region: 'us-east1' },
    ];
    const denied = {
      ...candidates[0]!,
      credentialId: null,
      availabilityZone: null,
      diagnosis: CloudFailureDiagnosis.PermissionDenied,
      disposition: FailureDisposition.FailoverTarget,
      spot: false,
      regionDenied: 'denied',
    };
    expect(
      withoutDeniedRegions(candidates, [denied], false, CloudType.GCP),
    ).toEqual({ candidates: [candidates[1]] });
    expect(
      withoutDeniedRegions(candidates, [denied], true, CloudType.GCP),
    ).toEqual({ candidates });
    expect(
      withoutDeniedRegions([candidates[0]!], [denied], false, CloudType.GCP),
    ).toEqual({
      invalid: expect.stringContaining(
        'perform denied in any of the 1 regions offering the requested VM types',
      ),
    });
  });

  it('counts the targets a failover can still go to untried', () => {
    const [east, central, west] = ['us-east1', 'us-central1', 'us-west1'].map(
      (region) => ({ vmType: 'n2', region }),
    );
    const full = (region: string, disposition: string) => ({
      vmType: 'n2',
      region,
      credentialId: null,
      availabilityZone: null,
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
      disposition: disposition as FailureDisposition,
      spot: false,
      regionDenied: null,
    });
    const count = (failures: ReturnType<typeof full>[]) =>
      untriedTargetCount(
        [east!, central!, west!],
        central!,
        failures,
        CloudType.GCP,
        false,
      );
    expect(count([])).toBe(2);
    expect(count([full('us-east1', FailureDisposition.FailoverTarget)])).toBe(
      1,
    );
    // A retry on the same target doesn't count it as tried.
    expect(count([full('us-east1', FailureDisposition.RetrySameTarget)])).toBe(
      2,
    );
    expect(
      count([
        full('us-east1', FailureDisposition.FailoverTarget),
        full('us-west1', FailureDisposition.FailoverTarget),
      ]),
    ).toBe(0);
    // Per target: a refusal of another target in the same region isn't one.
    expect(
      untriedTargetCount(
        [central!, { vmType: 'n4', region: 'us-central1' }],
        central!,
        [full('us-central1', FailureDisposition.FailoverTarget)],
        CloudType.GCP,
        false,
      ),
    ).toBe(1);
  });

  it('counts only the verified class pickTarget keeps a verified target in', () => {
    const [a, b, c] = ['r-a', 'r-b', 'r-c'].map((region) => ({
      vmType: 'gpu',
      region,
    }));
    const verifiedKeys = new Set([candidateRegionKey(a!)]);
    const failed = {
      ...a!,
      credentialId: null,
      availabilityZone: null,
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
      disposition: FailureDisposition.FailoverTarget,
      spot: false,
      regionDenied: null,
    };
    // A verified target that failed is picked again; nothing untried is left
    // in its class, so its retry waits.
    const candidates = [a!, b!, c!];
    const target = pickTarget(
      candidates,
      [failed],
      CloudType.Lambda,
      false,
      verifiedKeys,
    );
    expect(target).toBe(a);
    expect(
      untriedTargetCount(
        candidates,
        target,
        [failed],
        CloudType.Lambda,
        false,
        verifiedKeys,
      ),
    ).toBe(0);
    // An unverified target counts every other untried candidate.
    expect(
      untriedTargetCount(
        candidates,
        b!,
        [],
        CloudType.Lambda,
        false,
        verifiedKeys,
      ),
    ).toBe(2);
  });

  it("interleaves types by each one's region rank, keeping type and zone order", () => {
    const a = (region: string, availabilityZone?: string) => ({
      vmType: 'a',
      region,
      availabilityZone,
    });
    const b = (region: string) => ({ vmType: 'b', region });
    // a ranks r1 then r2; b, offered elsewhere, ranks r3 then r1.
    expect(
      byRegionRank([a('r1', 'r1a'), a('r1', 'r1b'), a('r2'), b('r3'), b('r1')]),
    ).toEqual([a('r1', 'r1a'), a('r1', 'r1b'), b('r3'), a('r2'), b('r1')]);
    // A zone the preflight couldn't read stays after its type's verified ones.
    const unknownLast = [a('r1', 'r1a'), a('r2', 'r2a'), a('r1', 'r1b')];
    expect(byRegionRank(unknownLast)).toEqual(unknownLast);
  });
});
