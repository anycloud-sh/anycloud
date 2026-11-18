import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureCatalogOverlayCoordinator } from '../../../src/api/services/catalog-overlays/azure.js';
import {
  buildAzureCatalogRegionObservation,
  createAzureSkuAvailabilityIndex,
  indexAzureResourceSku,
  type AzureCatalogRegion,
} from '../../../src/api/services/catalog-overlays/azure-model.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Azure Resource SKU overlay at realistic regional scale', () => {
  it('bounds event-loop stalls while reading all catalog regions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anycloud-azure-skus-'));
    tempDirectories.push(directory);
    const fixturePath = join(directory, 'regional-resource-skus.json');
    const entry = {
      resourceType: 'virtualMachines',
      name: 'Standard_NC40ads_H100_v5',
      locations: ['eastus'],
      capabilities: Array.from({ length: 20 }, (_, index) => ({
        name: `Capability${index}`,
        value: 'x'.repeat(24),
      })),
    };
    const entries = 1_500;
    const payload = JSON.stringify({ value: Array(entries).fill(entry) });
    await writeFile(fixturePath, payload);

    const regions = [
      'eastus',
      ...Array.from({ length: 48 }, (_, index) => `region${index}`),
    ];
    const readRegion = vi.fn(async (catalogRegion: AzureCatalogRegion) => {
      const parsed = JSON.parse(await readFile(fixturePath, 'utf8')) as {
        value: (typeof entry)[];
      };
      const index = createAzureSkuAvailabilityIndex();
      for (const sku of parsed.value) indexAzureResourceSku(index, sku);
      return buildAzureCatalogRegionObservation(catalogRegion, index);
    });
    const coordinator = new AzureCatalogOverlayCoordinator({
      getCatalogSource: () => ({
        revision: 'r1',
        catalog: {
          typesPerRegion: Object.fromEntries(
            regions.map((region) => [region, ['Standard_NC40ads_H100_v5']]),
          ),
        },
      }),
      createRegionReader: () => readRegion,
    });
    const provider = coordinator.createProvider({
      subscriptionId: 'sub',
      directoryId: 'tenant',
      applicationId: 'app',
      secret: 'secret',
    });
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await provider.refresh('scale-regression');

    await new Promise((resolve) => setTimeout(resolve, 50));
    histogram.disable();
    const stallMs = histogram.max / 1e6;
    const regionalMiB = payload.length / 1024 / 1024;
    console.log(
      `azure-resource-sku-regional-scale: ${regionalMiB.toFixed(1)}MiB × ` +
        `${regions.length} regions (${(regionalMiB * regions.length).toFixed(0)}MiB cumulative) ` +
        `with a ${stallMs.toFixed(0)}ms API-loop stall`,
    );
    expect(regionalMiB).toBeGreaterThan(1.5);
    expect(readRegion).toHaveBeenCalledTimes(regions.length);
    expect(provider.read()).toBeDefined();
    expect(stallMs).toBeLessThan(500);
  }, 60_000);
});
