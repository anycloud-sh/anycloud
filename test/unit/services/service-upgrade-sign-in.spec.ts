import { describe, expect, it, vi } from 'vitest';

import {
  createServiceUpgradeDomain,
  type ServiceUpgradeDomainDependencies,
} from '../../../src/api/services/service-upgrade-domain.js';
import { GithubSignInRequiredError } from '../../../src/shared/errors.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { makeStoredWorkload } from '../helpers/fixtures.js';

const signedOut = {
  id: `local:${'1'.repeat(32)}`,
  username: 'local',
  token: null,
};

function upgradeWith(dnsRecordId: string | null) {
  const found = makeStoredWorkload({
    id: 'svc',
    workloadType: WorkloadType.Service,
    state: WorkloadState.Running,
    dnsRecordId,
  });
  // The gate runs before any of these; past it, the checkpoint step stops.
  const deps: ServiceUpgradeDomainDependencies = {
    store: { getWorkloadForScope: vi.fn(async () => found) },
    resolveScope: vi.fn(async () => ({ kind: 'api' }) as const),
    prepareCheckpoint: vi.fn(async () => {
      throw new Error('past the sign-in gate');
    }),
    preflightSecrets: vi.fn(),
    inspectImage: vi.fn(),
    buildDockerCommand: vi.fn(),
    updateService: vi.fn(),
    recordEvent: vi.fn(),
    now: () => 0,
  };
  return createServiceUpgradeDomain(deps).upgrade(
    signedOut,
    { id: 'svc', image: 'nginx:2' },
    '0.0.0',
  );
}

describe('Service upgrade without a GitHub sign-in', () => {
  it('stops for a Service with a public DNS record', async () => {
    await expect(upgradeWith('dns-record-1')).rejects.toBeInstanceOf(
      GithubSignInRequiredError,
    );
  });

  it('continues for a Service that never published one', async () => {
    await expect(upgradeWith(null)).rejects.toThrow('past the sign-in gate');
  });
});

describe('Service upgrade on a Graviton type', () => {
  it("inspects the new image for the Service's arm64 build", async () => {
    const found = makeStoredWorkload({
      id: 'svc',
      workloadType: WorkloadType.Service,
      state: WorkloadState.Running,
      cloudProvider: CloudType.AWS,
      vmType: 'm8g.xlarge',
    });
    const inspectImage = vi.fn(async () => {
      throw new Error('inspected');
    });
    const upgrade = createServiceUpgradeDomain({
      store: { getWorkloadForScope: vi.fn(async () => found) },
      resolveScope: vi.fn(async () => ({ kind: 'api' }) as const),
      prepareCheckpoint: vi.fn(async () => {}),
      preflightSecrets: vi.fn(async () => {}),
      inspectImage,
      buildDockerCommand: vi.fn(),
      updateService: vi.fn(),
      recordEvent: vi.fn(),
      now: () => 0,
    }).upgrade(signedOut, { id: 'svc', image: 'nginx:2' }, '0.0.0');

    await expect(upgrade).rejects.toThrow('inspected');
    expect(inspectImage).toHaveBeenCalledWith('nginx:2', null, 'arm64');
  });
});
