import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceSku } from '@azure/arm-compute';
import {
  AuthenticationError,
  AuthenticationRequiredError,
} from '@azure/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateRegionAvailability } from '../../../src/api/services/gateways/cloud.js';
import {
  AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS,
  AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
  AzureCatalogOverlayCoordinator,
  collectAzureCatalogRegionObservation,
  type AzureCatalogOverlaySource,
  type AzureCatalogRegionReader,
} from '../../../src/api/services/catalog-overlays/azure.js';
import {
  azureCatalogTargetKey,
  buildAzureCatalogDefinition,
  buildAzureCatalogRegionObservation,
  createAzureSkuAvailabilityIndex,
  indexAzureResourceSku,
  type AzureCatalogRegion,
  type AzureCatalogRegionObservation,
} from '../../../src/api/services/catalog-overlays/azure-model.js';
import { FileAzureCatalogOverlayStore } from '../../../src/api/services/catalog-overlays/azure-store.js';

const credentials = {
  subscriptionId: 'sub-a',
  directoryId: 'tenant',
  applicationId: 'app',
  secret: 'secret',
};
const temporaryDirectories: string[] = [];

function createFileStore(): {
  directory: string;
  store: FileAzureCatalogOverlayStore;
} {
  const directory = mkdtempSync(join(tmpdir(), 'azure-overlay-coordinator-'));
  temporaryDirectories.push(directory);
  return { directory, store: new FileAzureCatalogOverlayStore(directory) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function catalogSource(
  revision = 'r1',
  regions: Record<string, string[]> = {
    eastus: ['Standard_D2s_v5', 'Standard_NC4as_T4_v3'],
    westus2: ['Standard_D2s_v5'],
  },
): AzureCatalogOverlaySource {
  return { revision, catalog: { typesPerRegion: regions } };
}

function observation(
  region: AzureCatalogRegion,
  restrictedTargets: readonly string[] = [],
  observedAt = 100,
): AzureCatalogRegionObservation {
  return {
    region: region.region,
    observedAt,
    restrictedTargets,
    catalogTargets: region.targetKeys.size,
    totalEntries: region.targetKeys.size + 1,
    vmEntries: region.targetKeys.size,
  };
}

describe('Azure catalog overlay model', () => {
  it('builds shared region target sets from the in-memory catalog', () => {
    const definition = buildAzureCatalogDefinition({
      typesPerRegion: {
        eastus: ['Standard_D2s_v5'],
        'East US': ['standard_d2s_v5', 'Standard_NC4as_T4_v3'],
        westus2: ['Standard_D2s_v5'],
      },
    });

    expect([...definition.regions]).toEqual([
      [
        'eastus',
        {
          region: 'eastus',
          targetFingerprint: expect.any(String),
          targetKeys: new Set([
            azureCatalogTargetKey('Standard_D2s_v5', 'eastus'),
            azureCatalogTargetKey('Standard_NC4as_T4_v3', 'eastus'),
          ]),
        },
      ],
      [
        'westus2',
        {
          region: 'westus2',
          targetFingerprint: expect.any(String),
          targetKeys: new Set([
            azureCatalogTargetKey('Standard_D2s_v5', 'westus2'),
          ]),
        },
      ],
    ]);
    expect(definition.catalogTargets).toBe(3);
  });

  it('uses one exact server-side location filter and diffs that region', async () => {
    const catalogRegion = buildAzureCatalogDefinition({
      typesPerRegion: {
        eastus: ['Standard_D2s_v5', 'Standard_NC4as_T4_v3'],
      },
    }).regions.get('eastus')!;
    const list = vi.fn(async function* (options: {
      filter: string;
    }): AsyncIterable<ResourceSku> {
      expect(options).toEqual({ filter: "location eq 'eastus'" });
      yield {
        resourceType: 'virtualMachines',
        name: 'Standard_D2s_v5',
        locations: ['East US'],
      };
      yield { resourceType: 'disks', name: 'Premium_LRS' };
    });

    const result = await collectAzureCatalogRegionObservation(
      list,
      catalogRegion,
      123,
    );

    expect(list).toHaveBeenCalledOnce();
    expect(result).toEqual({
      region: 'eastus',
      observedAt: 123,
      restrictedTargets: [
        azureCatalogTargetKey('Standard_NC4as_T4_v3', 'eastus'),
      ],
      catalogTargets: 2,
      totalEntries: 2,
      vmEntries: 1,
    });
  });

  it('treats one usable duplicate SKU record as usable', () => {
    const index = createAzureSkuAvailabilityIndex();
    for (const sku of [
      {
        resourceType: 'virtualMachines',
        name: 'Standard_D2s_v5',
        locations: ['eastus'],
        restrictions: [{ type: 'Location', values: ['eastus'] }],
      },
      {
        resourceType: 'virtualMachines',
        name: 'standard_d2s_v5',
        locationInfo: [{ location: 'East US' }],
      },
    ] satisfies ResourceSku[]) {
      indexAzureResourceSku(index, sku);
    }
    const catalogRegion = buildAzureCatalogDefinition({
      typesPerRegion: { eastus: ['Standard_D2s_v5'] },
    }).regions.get('eastus')!;

    expect(
      buildAzureCatalogRegionObservation(catalogRegion, index)
        .restrictedTargets,
    ).toEqual([]);
  });
});

describe('AzureCatalogOverlayCoordinator', () => {
  it('single-flights missing regions and performs zero calls after a complete hit', async () => {
    let now = 0;
    const releases = new Map<
      string,
      (value: AzureCatalogRegionObservation) => void
    >();
    const reader = vi.fn(
      (region: AzureCatalogRegion) =>
        new Promise<AzureCatalogRegionObservation>((resolve) => {
          releases.set(region.region, resolve);
        }),
    );
    const createRegionReader = vi.fn(() => reader);
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader,
      getCatalogSource: () => catalogSource(),
      now: () => now,
    });
    const first = coordinator.createProvider(credentials);
    const second = coordinator.createProvider({
      ...credentials,
      applicationId: 'rotated-app',
    });

    const firstRefresh = first.refresh('first');
    const secondRefresh = second.refresh('second');
    expect(createRegionReader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(first.read()).toBeUndefined();
    const eastRelease = releases.get('eastus')!;
    const eastRegion = reader.mock.calls
      .map(([value]) => value)
      .find((value) => value.region === 'eastus')!;
    eastRelease(observation(eastRegion));
    await vi.waitFor(() =>
      expect(
        first.read()?.assessCandidate({
          vmType: 'Standard_D2s_v5',
          region: 'eastus',
        }),
      ).toBe(CandidateRegionAvailability.Verified),
    );
    expect(
      first.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'westus2',
      }),
    ).toBe(CandidateRegionAvailability.Unknown);

    for (const [region, release] of releases) {
      if (region === 'eastus') continue;
      const catalogRegion = reader.mock.calls
        .map(([value]) => value)
        .find((value) => value.region === region)!;
      release(observation(catalogRegion));
    }
    await Promise.all([firstRefresh, secondRefresh]);

    now += 365 * 24 * 60 * 60_000;
    await first.refresh('one-year-later');
    expect(createRegionReader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(
      first.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'eastus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
  });

  it('retains successful slices and retries only failed regions after the failure gate', async () => {
    let now = 0;
    const attempts = new Map<string, number>();
    const reader: AzureCatalogRegionReader = async (region) => {
      const count = (attempts.get(region.region) ?? 0) + 1;
      attempts.set(region.region, count);
      if (region.region === 'northcentralus' && count === 1) {
        throw new Error('Resource SKUs throttled');
      }
      return observation(region);
    };
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () =>
        catalogSource('r1', {
          eastus: ['Standard_D2s_v5'],
          northcentralus: ['Standard_D2s_v5'],
          westus2: ['Standard_D2s_v5'],
        }),
      now: () => now,
    });
    const provider = coordinator.createProvider(credentials);

    await provider.refresh('initial');
    expect(Object.fromEntries(attempts)).toEqual({
      eastus: 1,
      northcentralus: 1,
      westus2: 1,
    });
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'northcentralus',
      }),
    ).toBe(CandidateRegionAvailability.Unknown);

    await provider.refresh('still-gated');
    expect(attempts.get('northcentralus')).toBe(1);
    now += AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS + 1;
    await provider.refresh('retry-missing');
    expect(Object.fromEntries(attempts)).toEqual({
      eastus: 1,
      northcentralus: 2,
      westus2: 1,
    });
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'northcentralus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
  });

  it('bounds regional requests with the shared all-settled helper', async () => {
    let active = 0;
    let peak = 0;
    const reader: AzureCatalogRegionReader = async (region) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return observation(region);
    };
    const regions = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource('r1', regions),
    });

    await coordinator.createProvider(credentials).refresh('bounded');

    expect(peak).toBe(AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY);
  });

  it('shares the regional request bound across subscriptions', async () => {
    let active = 0;
    let peak = 0;
    const reader = vi.fn(async (region: AzureCatalogRegion) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return observation(region);
    });
    const regions = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource('r1', regions),
    });
    const providers = Array.from({ length: 8 }, (_, index) =>
      coordinator.createProvider({
        ...credentials,
        subscriptionId: `sub-${index}`,
      }),
    );

    await Promise.all(
      providers.map((provider, index) => provider.refresh(`sub-${index}`)),
    );

    expect(reader).toHaveBeenCalledTimes(providers.length * 12);
    expect(peak).toBe(AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY);
  });

  it('reuses durable regions after LRU eviction and process restart', async () => {
    const { directory, store } = createFileStore();
    const regions = Object.fromEntries(
      Array.from({ length: 49 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const reader = vi.fn(async (region: AzureCatalogRegion) =>
      observation(region),
    );
    const createCoordinator = (
      overlayStore: FileAzureCatalogOverlayStore = store,
    ) =>
      new AzureCatalogOverlayCoordinator({
        createRegionReader: () => reader,
        getCatalogSource: () => catalogSource('r1', regions),
        store: overlayStore,
      });
    const createProviders = (coordinator: AzureCatalogOverlayCoordinator) =>
      Array.from({ length: 9 }, (_, index) =>
        coordinator.createProvider({
          ...credentials,
          subscriptionId: `sub-${index}`,
        }),
      );
    const coordinator = createCoordinator();
    const providers = createProviders(coordinator);

    await Promise.all(
      providers.map((provider, index) => provider.refresh(`initial-${index}`)),
    );
    expect(reader).toHaveBeenCalledTimes(9 * 49);

    for (const [index, provider] of providers.entries()) {
      await provider.refresh(`round-robin-${index}`);
    }
    expect(reader).toHaveBeenCalledTimes(9 * 49);

    const restartedProviders = createProviders(
      createCoordinator(new FileAzureCatalogOverlayStore(directory)),
    );
    for (const [index, provider] of restartedProviders.entries()) {
      await provider.refresh(`restarted-${index}`);
    }
    expect(reader).toHaveBeenCalledTimes(9 * 49);
  });

  it('refetches only regions whose catalog targets changed', async () => {
    const { store } = createFileStore();
    const requested: string[] = [];
    const reader = vi.fn(async (region: AzureCatalogRegion) => {
      requested.push(region.region);
      return observation(region);
    });
    const first = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource(),
      store,
    });
    await first.createProvider(credentials).refresh('initial');
    expect(requested).toEqual(['eastus', 'westus2']);
    requested.length = 0;

    const second = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () =>
        catalogSource('r2', {
          eastus: ['Standard_D2s_v5', 'Standard_NC4as_T4_v3'],
          westus2: ['Standard_D2s_v5', 'Standard_D4s_v5'],
        }),
      store,
    });
    await second.createProvider(credentials).refresh('catalog-changed');

    expect(requested).toEqual(['westus2']);
  });

  it('writes regional and global invalidations through to disk', async () => {
    const { store } = createFileStore();
    const requested: string[] = [];
    const createCoordinator = () =>
      new AzureCatalogOverlayCoordinator({
        createRegionReader: () => async (region) => {
          requested.push(region.region);
          return observation(region);
        },
        getCatalogSource: () => catalogSource(),
        store,
      });
    const firstProvider = createCoordinator().createProvider(credentials);
    await firstProvider.refresh('initial');
    requested.length = 0;

    firstProvider.invalidate('SkuNotAvailable', 'East US');
    await createCoordinator()
      .createProvider(credentials)
      .refresh('regional-invalidation');
    expect(requested).toEqual(['eastus']);
    requested.length = 0;

    firstProvider.invalidate('compute-registration');
    await createCoordinator()
      .createProvider(credentials)
      .refresh('global-invalidation');
    expect(requested).toEqual(['eastus', 'westus2']);
  });

  it('does not persist a regional result invalidated while it was in flight', async () => {
    const { store } = createFileStore();
    let release!: (value: AzureCatalogRegionObservation) => void;
    const first = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      getCatalogSource: () =>
        catalogSource('r1', { eastus: ['Standard_D2s_v5'] }),
      store,
    });
    const firstProvider = first.createProvider(credentials);
    const pending = firstProvider.refresh('before-registration');
    const catalogRegion = buildAzureCatalogDefinition(
      catalogSource('r1', { eastus: ['Standard_D2s_v5'] }).catalog,
    ).regions.get('eastus')!;
    firstProvider.invalidate('compute-registration');
    release(observation(catalogRegion));
    await pending;

    expect(store.read(credentials)?.size ?? 0).toBe(0);
    const reader = vi.fn(async (region: AzureCatalogRegion) =>
      observation(region),
    );
    const restarted = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () =>
        catalogSource('r1', { eastus: ['Standard_D2s_v5'] }),
      store,
    });
    await restarted.createProvider(credentials).refresh('after-registration');
    expect(reader).toHaveBeenCalledOnce();
  });

  it('does not let an obsolete refresh overwrite a newer catalog snapshot', async () => {
    const { store } = createFileStore();
    let source = catalogSource('r1', {
      eastus: ['Standard_D2s_v5'],
      westus2: ['Standard_D2s_v5'],
    });
    let releaseWest!: (value: AzureCatalogRegionObservation) => void;
    let oldWest!: AzureCatalogRegion;
    const oldReader = vi.fn((region: AzureCatalogRegion) => {
      if (region.region === 'eastus') {
        return Promise.resolve(observation(region, [], 10));
      }
      oldWest = region;
      return new Promise<AzureCatalogRegionObservation>((resolve) => {
        releaseWest = resolve;
      });
    });
    const newReader = vi.fn(async (region: AzureCatalogRegion) =>
      observation(region, [], 20),
    );
    let readerCount = 0;
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => (readerCount++ === 0 ? oldReader : newReader),
      getCatalogSource: () => source,
      store,
    });
    const provider = coordinator.createProvider(credentials);

    const obsoleteRefresh = provider.refresh('old-catalog');
    await vi.waitFor(() =>
      expect(
        provider.read()?.assessCandidate({
          vmType: 'Standard_D2s_v5',
          region: 'eastus',
        }),
      ).toBe(CandidateRegionAvailability.Verified),
    );

    source = catalogSource('r2', {
      eastus: ['Standard_D2s_v5', 'Standard_D4s_v5'],
      westus2: ['Standard_D2s_v5'],
    });
    await provider.refresh('new-catalog');
    expect(newReader).toHaveBeenCalledTimes(2);
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D4s_v5',
        region: 'eastus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);

    releaseWest(observation(oldWest, [], 10));
    await obsoleteRefresh;

    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D4s_v5',
        region: 'eastus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
    await provider.refresh('after-obsolete-refresh');
    expect(newReader).toHaveBeenCalledTimes(2);
  });

  it('fails open and replaces a corrupt persisted overlay', async () => {
    const { directory, store } = createFileStore();
    const initial = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => async (region) => observation(region),
      getCatalogSource: () => catalogSource(),
      store,
    });
    await initial.createProvider(credentials).refresh('initial');
    writeFileSync(join(directory, readdirSync(directory)[0]!), '{');

    const reader = vi.fn(async (region: AzureCatalogRegion) =>
      observation(region),
    );
    const replacement = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource(),
      store: new FileAzureCatalogOverlayStore(directory),
    });
    await replacement.createProvider(credentials).refresh('corrupt-cache');

    expect(reader).toHaveBeenCalledTimes(2);
    store.clearCache();
    expect(store.read(credentials)?.size).toBe(2);
  });

  it('stops launching regions after a systemic authentication failure', async () => {
    const now = 0;
    const reader = vi.fn(async () => {
      throw { code: 'AuthorizationFailed', statusCode: 403 };
    });
    const regions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource('r1', regions),
      now: () => now,
    });
    const provider = coordinator.createProvider(credentials);

    await expect(provider.refresh('bad-credential')).rejects.toMatchObject({
      code: 'AuthorizationFailed',
    });
    expect(reader.mock.calls.length).toBeGreaterThan(0);
    expect(reader.mock.calls.length).toBeLessThanOrEqual(
      AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
    );
    const callsAfterFailure = reader.mock.calls.length;
    await provider.refresh('failure-gated');
    expect(reader).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it.each([
    [
      'AuthenticationError',
      () =>
        new AuthenticationError(400, {
          error: 'invalid_request',
          error_description: 'AADSTS90002: Tenant not found.',
        }),
    ],
    [
      'AuthenticationRequiredError',
      () =>
        new AuthenticationRequiredError({
          scopes: ['https://management.azure.com/.default'],
          message: 'invalid_request: AADSTS90002: Tenant not found.',
        }),
    ],
  ])('stops after an Azure Identity %s', async (_name, createError) => {
    const error = createError();
    const reader = vi.fn(async () => {
      throw error;
    });
    const regions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource('r1', regions),
      now: () => 0,
    });
    const provider = coordinator.createProvider(credentials);

    await expect(provider.refresh('invalid-tenant')).rejects.toBe(error);
    expect(reader.mock.calls.length).toBeGreaterThan(0);
    expect(reader.mock.calls.length).toBeLessThanOrEqual(
      AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
    );
    const callsAfterFailure = reader.mock.calls.length;
    await provider.refresh('failure-gated');
    expect(reader).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('stops launching regions after throttling and honors Retry-After', async () => {
    let now = 0;
    const throttled = {
      code: 'TooManyRequests',
      statusCode: 429,
      response: {
        headers: {
          get: (name: string) => (name === 'retry-after' ? '120' : undefined),
        },
      },
    };
    const reader = vi.fn(async () => {
      throw throttled;
    });
    const regions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `region${index}`,
        ['Standard_D2s_v5'],
      ]),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource('r1', regions),
      now: () => now,
    });
    const provider = coordinator.createProvider(credentials);

    await expect(provider.refresh('throttled')).rejects.toBe(throttled);
    expect(reader.mock.calls.length).toBeGreaterThan(0);
    expect(reader.mock.calls.length).toBeLessThanOrEqual(
      AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
    );
    const callsAfterThrottle = reader.mock.calls.length;

    now = AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS + 1;
    await provider.refresh('retry-after-still-closed');
    expect(reader).toHaveBeenCalledTimes(callsAfterThrottle);

    now = 120_001;
    await expect(provider.refresh('retry-after-open')).rejects.toBe(throttled);
    expect(reader.mock.calls.length).toBeGreaterThan(callsAfterThrottle);
    expect(reader.mock.calls.length).toBeLessThanOrEqual(
      callsAfterThrottle + AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
    );
  });

  it('clears a regional failure gate when that region is invalidated', async () => {
    const attempts = new Map<string, number>();
    const reader: AzureCatalogRegionReader = async (region) => {
      const count = (attempts.get(region.region) ?? 0) + 1;
      attempts.set(region.region, count);
      if (count === 1) throw new Error(`${region.region} unavailable`);
      return observation(region);
    };
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () =>
        catalogSource('r1', {
          northcentralus: ['Standard_D2s_v5'],
          westus2: ['Standard_D2s_v5'],
        }),
      now: () => 0,
    });
    const provider = coordinator.createProvider(credentials);

    await expect(provider.refresh('initial')).rejects.toThrow(
      'northcentralus unavailable',
    );
    provider.invalidate('SkuNotAvailable', 'northcentralus');
    await provider.refresh('target-rejection');

    expect(Object.fromEntries(attempts)).toEqual({
      northcentralus: 2,
      westus2: 1,
    });
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'northcentralus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
  });

  it('clears failure gates after Compute registration', async () => {
    let attempts = 0;
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => async (region) => {
        attempts += 1;
        if (attempts === 1) throw new Error('Compute is not registered');
        return observation(region);
      },
      getCatalogSource: () =>
        catalogSource('r1', { eastus: ['Standard_D2s_v5'] }),
      now: () => 0,
    });
    const provider = coordinator.createProvider(credentials);

    await expect(provider.refresh('pre-registration')).rejects.toThrow(
      'Compute is not registered',
    );
    await provider.refresh('failure-gated');
    expect(attempts).toBe(1);

    provider.invalidate('compute-registration');
    await provider.refresh('post-registration');
    expect(attempts).toBe(2);
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'eastus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
  });

  it('does not restore a failure gate from a stale refresh', async () => {
    let rejectFirst!: (error: Error) => void;
    const reader = vi.fn((region: AzureCatalogRegion) =>
      reader.mock.calls.length === 1
        ? new Promise<AzureCatalogRegionObservation>((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(observation(region)),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () =>
        catalogSource('r1', { eastus: ['Standard_D2s_v5'] }),
      now: () => 0,
    });
    const provider = coordinator.createProvider(credentials);

    const pending = provider.refresh('pre-registration');
    expect(reader).toHaveBeenCalledOnce();
    provider.invalidate('compute-registration');
    rejectFirst(new Error('stale pre-registration failure'));
    await expect(pending).rejects.toThrow('stale pre-registration failure');

    await provider.refresh('post-registration');
    expect(reader).toHaveBeenCalledTimes(2);
    expect(
      provider.read()?.assessCandidate({
        vmType: 'Standard_D2s_v5',
        region: 'eastus',
      }),
    ).toBe(CandidateRegionAvailability.Verified);
  });

  it('invalidates one rejected region lazily and Compute changes globally', async () => {
    const calls: string[] = [];
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => async (region) => {
        calls.push(region.region);
        return observation(region);
      },
      getCatalogSource: () => catalogSource(),
    });
    const provider = coordinator.createProvider(credentials);
    const east = { vmType: 'Standard_D2s_v5', region: 'eastus' };
    const west = { vmType: 'Standard_D2s_v5', region: 'westus2' };
    await provider.refresh('initial');
    expect(calls).toHaveLength(2);
    const immutableSnapshot = provider.read()!;

    provider.invalidate('SkuNotAvailable', 'eastus');
    expect(calls).toHaveLength(2);
    expect(immutableSnapshot.assessCandidate(east)).toBe(
      CandidateRegionAvailability.Verified,
    );
    expect(provider.read()?.assessCandidate(east)).toBe(
      CandidateRegionAvailability.Unknown,
    );
    expect(provider.read()?.assessCandidate(west)).toBe(
      CandidateRegionAvailability.Verified,
    );
    await provider.refresh('target-rejection');
    expect(calls).toEqual(['eastus', 'westus2', 'eastus']);

    provider.invalidate('compute-registration');
    expect(calls).toHaveLength(3);
    expect(provider.read()).toBeUndefined();
    await provider.refresh('compute-registration');
    expect(calls).toEqual(['eastus', 'westus2', 'eastus', 'eastus', 'westus2']);
  });

  it('reuses regions whose target fingerprints survive a catalog revision', async () => {
    let revision = 'r1';
    const reader = vi.fn(async (region: AzureCatalogRegion) =>
      observation(region),
    );
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: () => reader,
      getCatalogSource: () => catalogSource(revision),
    });
    const provider = coordinator.createProvider(credentials);

    await provider.refresh('initial');
    expect(provider.read()).toBeDefined();
    revision = 'r2';
    expect(provider.read()).toBeDefined();
    await provider.refresh('new-catalog');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('never serves one subscription from another', async () => {
    const coordinator = new AzureCatalogOverlayCoordinator({
      createRegionReader: (creds) => async (region) =>
        observation(
          region,
          creds.subscriptionId === 'sub-b'
            ? [azureCatalogTargetKey('Standard_D2s_v5', region.region)]
            : [],
        ),
      getCatalogSource: () =>
        catalogSource('r1', { eastus: ['Standard_D2s_v5'] }),
    });
    const a = coordinator.createProvider(credentials);
    const b = coordinator.createProvider({
      ...credentials,
      subscriptionId: 'sub-b',
    });
    const candidate = { vmType: 'Standard_D2s_v5', region: 'eastus' };

    await Promise.all([a.refresh('a'), b.refresh('b')]);
    expect(a.read()?.assessCandidate(candidate)).toBe(
      CandidateRegionAvailability.Verified,
    );
    expect(b.read()?.assessCandidate(candidate)).toBe(
      CandidateRegionAvailability.Unknown,
    );
  });
});
