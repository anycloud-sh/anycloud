import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileAzureCatalogOverlayStore,
  type AzureCatalogOverlayIdentity,
  type AzureCatalogOverlayRegionState,
} from '../../../src/api/services/catalog-overlays/azure-store.js';

const identity: AzureCatalogOverlayIdentity = {
  directoryId: 'tenant-a',
  subscriptionId: 'subscription-a',
};
const temporaryDirectories: string[] = [];

function createStore(): {
  directory: string;
  store: FileAzureCatalogOverlayStore;
} {
  const directory = mkdtempSync(join(tmpdir(), 'azure-overlay-store-'));
  temporaryDirectories.push(directory);
  return { directory, store: new FileAzureCatalogOverlayStore(directory) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileAzureCatalogOverlayStore', () => {
  it('atomically round-trips compact observations in a private hashed file', () => {
    const { directory, store } = createStore();
    const regions = new Map<string, AzureCatalogOverlayRegionState>([
      [
        'westus2',
        {
          targetFingerprint: 'b'.repeat(64),
          observedAt: 20,
          restrictedTargets: new Set(['target-b', 'target-a', 'target-a']),
        },
      ],
      [
        'eastus',
        {
          targetFingerprint: 'a'.repeat(64),
          observedAt: 10,
          restrictedTargets: new Set(),
        },
      ],
    ]);

    store.write(identity, regions);

    expect(store.read(identity)).toEqual(
      new Map([
        [
          'eastus',
          {
            targetFingerprint: 'a'.repeat(64),
            observedAt: 10,
            restrictedTargets: new Set(),
          },
        ],
        [
          'westus2',
          {
            targetFingerprint: 'b'.repeat(64),
            observedAt: 20,
            restrictedTargets: new Set(['target-a', 'target-b']),
          },
        ],
      ]),
    );
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain(identity.directoryId);
    expect(files[0]).not.toContain(identity.subscriptionId);
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, files[0]!), 'utf8')).not.toContain(
      identity.subscriptionId,
    );

    store.write(identity, regions);
    expect(readdirSync(directory)).toEqual(files);
  });

  it('invalidates one normalized region or the complete account snapshot', () => {
    const { store } = createStore();
    store.write(
      identity,
      new Map([
        [
          'eastus',
          {
            targetFingerprint: 'a'.repeat(64),
            observedAt: 10,
            restrictedTargets: new Set(),
          },
        ],
        [
          'westus2',
          {
            targetFingerprint: 'b'.repeat(64),
            observedAt: 20,
            restrictedTargets: new Set(),
          },
        ],
      ]),
    );

    store.invalidate(identity, 'East US');
    expect([...store.read(identity)!.keys()]).toEqual(['westus2']);

    store.invalidate(identity);
    expect(store.read(identity)).toBeUndefined();
  });

  it('treats corrupt or unsupported cache files as misses', () => {
    const { directory, store } = createStore();
    store.write(identity, new Map());
    store.clearCache();
    const path = join(directory, readdirSync(directory)[0]!);

    writeFileSync(path, '{');
    expect(store.read(identity)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ schemaVersion: 2, regions: [] }));
    expect(store.read(identity)).toBeUndefined();
  });
});
