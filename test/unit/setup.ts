import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, inject, vi } from 'vitest';
import type { GithubSignIn } from '../../src/api/services/entities';

process.env.ANYCLOUD_TEST_DB_TEMPLATE_PATH = inject('testDatabaseTemplatePath');

// No spec under test/unit may read or write the developer's ~/.anycloud (a
// saved sign-in would change what a test sends). Its home is a scratch
// directory holding only the shared catalogs, and a spec that writes anything
// else there fails. Integration specs on this config keep their environment.
const unitDirectory = dirname(fileURLToPath(import.meta.url)) + sep;
if (expect.getState().testPath?.startsWith(unitDirectory)) {
  const home = mkdtempSync(join(tmpdir(), 'anycloud-unit-home-'));
  const defaultAnycloudDir = join(home, '.anycloud');
  mkdirSync(defaultAnycloudDir);
  symlinkSync(inject('testCatalogsPath'), join(defaultAnycloudDir, 'catalogs'));
  process.env.HOME = home;
  delete process.env.ANYCLOUD_DIR;
  afterAll(() => {
    try {
      expect(
        readdirSync(defaultAnycloudDir),
        'a unit test wrote to $HOME/.anycloud; give it its own ANYCLOUD_DIR',
      ).toEqual(['catalogs']);
    } finally {
      // Removes the catalogs link, not the shared catalogs.
      rmSync(home, { recursive: true, force: true });
    }
  });
}

// Mock GitHub authentication globally for all tests to prevent real GitHub API
// calls. Only `authenticate`, `issuingApp` and `resolveUser` are stubbed; real
// named exports (e.g. the error mappers) are preserved so they remain
// unit-testable.
vi.mock('../../src/api/services/gateways/github', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/api/services/gateways/github')
    >();
  return {
    ...actual,
    default: {
      ...actual.default,
      authenticate: vi.fn(
        async (_token: string): Promise<GithubSignIn> => ({
          id: '1',
          username: 'test-user',
          scopes: ['read:org', 'read:packages'],
        }),
      ),
      issuingApp: vi.fn(async (_token: string) => null),
      resolveUser: vi.fn(async (_token: string, username: string) => ({
        id: '2',
        username,
        type: 'User',
      })),
    },
  };
});
