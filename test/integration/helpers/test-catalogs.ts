import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject, vi } from 'vitest';

/**
 * Point this process's ANYCLOUD_DIR at a directory that links the catalogs
 * test/global-setup.ts downloaded, so a spec reads them instead of the real
 * home's (none on a fresh runner) or a fetch. Call it before anything resolves
 * a catalog, at module top level when collection does.
 */
export function useTestCatalogs(
  directory = mkdtempSync(join(tmpdir(), 'anycloud-test-catalogs-')),
): string {
  mkdirSync(directory, { recursive: true });
  symlinkSync(inject('testCatalogsPath'), join(directory, 'catalogs'));
  vi.stubEnv('ANYCLOUD_DIR', directory);
  return directory;
}
