import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { CloudType } from '../../../src/shared/cloud.js';

let directory = '';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(directory, { recursive: true, force: true });
});

// A hosted API builds its backup storage at startup, before it has fetched any
// VM catalog: that must not need one (every GCP cluster's API crashed).
it('builds a GCP storage provider with no catalog on disk', async () => {
  directory = mkdtempSync(join(tmpdir(), 'no-catalog-'));
  vi.stubEnv('ANYCLOUD_DIR', directory);
  vi.resetModules();
  const { createStorageProvider } = await import(
    '../../../src/api/services/cloud-config.js'
  );
  const { readCatalog } = await import('../../../src/shared/catalog/index.js');
  expect(readCatalog(CloudType.GCP)).toBeUndefined();
  expect(() =>
    createStorageProvider({
      cloudProvider: CloudType.GCP,
      credentials: {
        projectId: 'project-test',
        privateKey: 'private-test',
        clientEmail: 'sa@project-test.iam.gserviceaccount.com',
      },
      region: 'us-central1',
    }),
  ).not.toThrow();
});
