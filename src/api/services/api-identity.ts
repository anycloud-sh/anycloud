import { randomBytes } from 'node:crypto';
import { hostedApiIdentity } from '../../shared/hosted-api-identity.js';

import type { DB } from './repositories/db.js';

export const OWNER_API_TAG = 'anycloud_owner_api';

const API_IDENTITY_METADATA_KEY = 'api_identity';
const API_IDENTITY_PATTERN = /^[0-9a-f]{32}$/;
/**
 * Recorded with every stamp so that changing how identities are derived stays a
 * recognisable, repairable condition instead of a mismatch indistinguishable
 * from a copied database. The rename that moved hosted identities from
 * `anycloud-hosted-controller` to `anycloud-hosted-api` would have invalidated
 * every stamp in the field had this feature already shipped.
 */
const API_IDENTITY_SCHEME = 'v1';
const TEST_API_IDENTITY = '00000000000000000000000000000001';

let activeApiIdentity: string | undefined;

export interface ResolveApiIdentityOptions {
  /** True only for the hosted-API command shape owned by Anycloud. */
  hosted: boolean;
  workloadId?: string;
}

export interface ApiBindingResult {
  /** True when this boot wrote the identity rather than matching one. */
  newlyBound: boolean;
}

function formatApiIdentityStamp(identity: string): string {
  return `${API_IDENTITY_SCHEME}:${identity}`;
}

/**
 * Read a stamp written by any scheme. Values without a prefix predate scheme
 * recording and exist only in unreleased development databases, so they are
 * read as the current scheme and rewritten on the next successful bind.
 */
export function parseApiIdentityStamp(value: string): {
  scheme: string;
  identity: string;
} {
  const separator = value.indexOf(':');
  if (separator === -1) {
    return { scheme: API_IDENTITY_SCHEME, identity: value };
  }
  return {
    scheme: value.slice(0, separator),
    identity: value.slice(separator + 1),
  };
}

function assertApiIdentity(value: string, source: string): string {
  const normalized = value.trim().toLowerCase();
  if (!API_IDENTITY_PATTERN.test(normalized)) {
    throw new Error(`${source} must contain exactly 32 hexadecimal characters`);
  }
  return normalized;
}

/**
 * A local API has no identity apart from the one its database carries, so it
 * has nothing to compare a stamp against. Hosted APIs derive theirs from the
 * workload id on every boot, which is what makes disagreement detectable.
 */
export function resolveApiIdentity(
  options: ResolveApiIdentityOptions,
): string | undefined {
  if (options.hosted) {
    return hostedApiIdentity(options.workloadId ?? '');
  }
  return undefined;
}

/**
 * Attach this process to the identity its database carries, writing one when
 * the database has none. A caller that knows its own identity passes it and the
 * two must agree; a caller without one adopts whatever it finds.
 */
export async function bindDatabaseApiIdentity(
  db: DB,
  apiIdentity?: string,
): Promise<ApiBindingResult> {
  const expected =
    apiIdentity === undefined
      ? undefined
      : assertApiIdentity(apiIdentity, 'API identity');
  if (expected && activeApiIdentity && activeApiIdentity !== expected) {
    throw new Error(
      `Process API identity changed from ${activeApiIdentity} to ${expected}`,
    );
  }

  const result = await db.transaction<ApiBindingResult & { identity: string }>(
    (tx) => {
      const rows = tx.query<{ value: string }>(
        'SELECT value FROM _metadata WHERE key = ?',
        [API_IDENTITY_METADATA_KEY],
      );
      const bound = rows[0]?.value;

      if (bound === undefined) {
        const minted = expected ?? randomBytes(16).toString('hex');
        tx.query('INSERT INTO _metadata (key, value) VALUES (?, ?)', [
          API_IDENTITY_METADATA_KEY,
          formatApiIdentityStamp(minted),
        ]);
        return { identity: minted, newlyBound: true };
      }

      const parsed = parseApiIdentityStamp(bound);
      if (parsed.scheme !== API_IDENTITY_SCHEME) {
        throw new Error(
          `SQLite database identity uses scheme ${parsed.scheme}, but this ` +
            `API writes scheme ${API_IDENTITY_SCHEME}; refusing to start ` +
            'because its identity cannot be read.',
        );
      }
      const identity = assertApiIdentity(parsed.identity, 'Bound API identity');
      if (expected !== undefined && identity !== expected) {
        throw new Error(
          `SQLite database is bound to API ${identity}, ` +
            `but this API's identity is ${expected}; refusing to start because ` +
            'the database may have been copied from another API installation',
        );
      }

      // Rewrite a stamp recorded before scheme prefixes existed.
      if (bound !== formatApiIdentityStamp(identity)) {
        tx.query('UPDATE _metadata SET value = ? WHERE key = ?', [
          formatApiIdentityStamp(identity),
          API_IDENTITY_METADATA_KEY,
        ]);
      }
      return { identity, newlyBound: false };
    },
  );

  if (activeApiIdentity && activeApiIdentity !== result.identity) {
    throw new Error(
      `Process API identity changed from ${activeApiIdentity} to ${result.identity}`,
    );
  }
  activeApiIdentity = result.identity;
  return { newlyBound: result.newlyBound };
}

/** Owning API identity attached to provider metadata created by this process. */
export function getApiIdentity(): string {
  if (activeApiIdentity) return activeApiIdentity;
  if (process.env.IS_TEST === 'true') return TEST_API_IDENTITY;
  throw new Error(
    'API identity is unavailable before persistence initialization',
  );
}

/** @internal Test isolation for suites that exercise multiple API identities. */
export function resetApiIdentityForTest(): void {
  if (process.env.IS_TEST !== 'true') {
    throw new Error('API identity can only be reset in tests');
  }
  activeApiIdentity = undefined;
}
