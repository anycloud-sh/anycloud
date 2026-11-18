import { ApiAccessDeniedError } from '../../../shared/errors.js';
import { normalizeUserId } from '../../../shared/hosted-api.js';
import type { User } from '../entities.js';
import { log } from '../logger.js';
import { getDB, type DB } from './db.js';
import type { OwnershipScope } from './ownership-filter.js';
import { hashApiToken, newApiToken } from './api-tokens.js';

const POLICY_ID = 1;

export interface ApiAccessPolicy {
  ownerUser: string;
  ownerUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiAccessUser {
  userId: string;
  username: string;
}

/**
 * A registered Deployment name's principal ID (RFC 0049 C29). SQLite's
 * `lower()` makes it, as it does the Deployment name index, so the two agree.
 */
const SERVICE_ACCOUNT_USER_PREFIX = 'serviceaccount:';
const serviceAccountUserIdSql = (name: string) =>
  `'${SERVICE_ACCOUNT_USER_PREFIX}' || lower(${name})`;

export function isServiceAccountUserId(userId: string): boolean {
  return userId.startsWith(SERVICE_ACCOUNT_USER_PREFIX);
}

/** An owner-issued service token's principal ID; its name is lowercase. */
const SERVICE_USER_PREFIX = 'service:';

export function serviceUserId(name: string): string {
  return `${SERVICE_USER_PREFIX}${name}`;
}

export function isServiceUserId(userId: string): boolean {
  return userId.startsWith(SERVICE_USER_PREFIX);
}

/** SQL for whether Deployment `alias` is unmanaged and its name registered. */
export function deploymentApiIdentitySql(alias: string): string {
  return `(${alias}.managed = 0 AND EXISTS (
    SELECT 1 FROM api_access_users r
     WHERE r.user_id = ${serviceAccountUserIdSql(`${alias}.name`)}))`;
}

/**
 * The live, unmanaged Deployment that holds registration `a`'s name, if any,
 * by the active-name index.
 */
const REGISTERED_USER_COLUMNS =
  'a.user_id AS userId, a.username, d.id AS deploymentId';
/** An entry, with the live Deployment its registered name is held by. */
type RegisteredUser = ApiAccessUser & { deploymentId: string | null };
const REGISTERED_DEPLOYMENT_JOIN = `LEFT JOIN deployments d
  ON a.user_id LIKE '${SERVICE_ACCOUNT_USER_PREFIX}%'
 AND lower(d.name) = substr(a.user_id, ${SERVICE_ACCOUNT_USER_PREFIX.length + 1})
 AND d.deleted_at IS NULL AND d.managed = 0`;

interface ApiAccessPolicyRow {
  owner_user: string;
  owner_user_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ApiAccessUserRow {
  user_id: string;
  username: string;
}

function rowToPolicy(row: ApiAccessPolicyRow): ApiAccessPolicy {
  return {
    ownerUser: row.owner_user,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row: ApiAccessUserRow): ApiAccessUser {
  return {
    userId: row.user_id,
    username: row.username,
  };
}

export async function getApiAccessPolicy(
  db: DB = getDB(),
): Promise<ApiAccessPolicy | null> {
  // Every authenticated request reads the policy, so it must not wait behind
  // queued writes; its writers are awaited transactions.
  const rows = await db.read((reader) =>
    reader.query<ApiAccessPolicyRow>(
      `SELECT owner_user, owner_user_id, created_at, updated_at
         FROM api_access_policy
        WHERE id = ?`,
      [POLICY_ID],
    ),
  );
  return rows[0] ? rowToPolicy(rows[0]) : null;
}

export async function upsertApiAccessOwner(
  ownerUser: string,
  ownerUserId: string,
  db: DB = getDB(),
): Promise<void> {
  const username = ownerUser.trim();
  if (!username) {
    throw new Error('Hosted API owner user is required');
  }
  const userId = normalizeUserId(ownerUserId);

  const now = Date.now();
  await db.transaction((tx) => {
    const existing = tx.query<ApiAccessPolicyRow>(
      `SELECT owner_user, owner_user_id, created_at, updated_at
         FROM api_access_policy
        WHERE id = ?`,
      [POLICY_ID],
    )[0];

    // A bound policy names an account, and accounts do not transfer. This is
    // the durable ownership check, and it stays fatal.
    if (existing?.owner_user_id && existing.owner_user_id !== userId) {
      throw new Error(
        `Hosted API owner is already bound to user id ${existing.owner_user_id}`,
      );
    }
    // An unbound policy predates durable ids, so its stored handle is only
    // whatever the owner was called when the API last started — not durable
    // evidence of who owns it. Treating a mismatch as fatal would crash the
    // boot of a database whose owner renamed before upgrading. Bind the policy
    // to the explicit startup identity; legacy workload rows remain scoped to
    // their captured usernames and are not rewritten.
    if (
      existing &&
      !existing.owner_user_id &&
      existing.owner_user.toLowerCase() !== username.toLowerCase()
    ) {
      log.info('Binding hosted API owner captured under a previous username', {
        id: 'system',
        previousUsername: existing.owner_user,
        username,
      });
    }

    if (existing) {
      tx.query(
        `UPDATE api_access_policy
            SET owner_user = ?, owner_user_id = ?, updated_at = ?
          WHERE id = ?`,
        [username, userId, now, POLICY_ID],
      );
    } else {
      tx.query(
        `INSERT INTO api_access_policy (
           id, owner_user, owner_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [POLICY_ID, username, userId, now, now],
      );
    }
  });
}

export async function listApiAccessUsers(
  db: DB = getDB(),
): Promise<RegisteredUser[]> {
  return db.query<RegisteredUser>(
    `SELECT ${REGISTERED_USER_COLUMNS}
       FROM api_access_users a ${REGISTERED_DEPLOYMENT_JOIN}
      ORDER BY a.username COLLATE NOCASE, a.user_id`,
  );
}

/**
 * Register a Deployment name, live or not yet created, unless a managed
 * Deployment holds it: Job code reads a managed replica's tokens.
 */
export async function registerApiServiceAccount(
  deploymentName: string,
  db: DB = getDB(),
): Promise<RegisteredUser | { managedDeploymentId: string }> {
  const name = deploymentName.trim();
  return db.transaction((tx) => {
    const [holder] = tx.query<{ id: string; managed: number }>(
      `SELECT id, managed FROM deployments
        WHERE lower(name) = lower(?) AND deleted_at IS NULL`,
      [name],
    );
    if (holder?.managed) return { managedDeploymentId: holder.id };
    const [row] = tx.query<ApiAccessUserRow>(
      `INSERT INTO api_access_users (user_id, username)
       VALUES (${serviceAccountUserIdSql('?')}, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username
       RETURNING user_id, username`,
      [name, name],
    );
    return { ...rowToUser(row!), deploymentId: holder?.id ?? null };
  });
}

/** A new service's token, or null when the name already has one. */
export async function issueServiceToken(
  name: string,
  db: DB = getDB(),
): Promise<string | null> {
  const { token, hash } = newApiToken();
  const rows = await db.query(
    `INSERT INTO api_access_users (user_id, username, token_hash)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING
     RETURNING user_id`,
    [serviceUserId(name), name, hash],
  );
  return rows.length ? token : null;
}

/** Replaces a service's token, or returns null when there is no such service. */
export async function rotateServiceToken(
  name: string,
  db: DB = getDB(),
): Promise<string | null> {
  const { token, hash } = newApiToken();
  const rows = await db.query(
    `UPDATE api_access_users SET token_hash = ?
      WHERE user_id = ?
      RETURNING user_id`,
    [hash, serviceUserId(name)],
  );
  return rows.length ? token : null;
}

/** The service a token belongs to; its row is its admission. */
export async function findServiceTokenUser(
  token: string,
  db: DB = getDB(),
): Promise<ApiAccessUser | null> {
  const [row] = await db.read((reader) =>
    reader.query<ApiAccessUserRow>(
      `SELECT user_id, username FROM api_access_users WHERE token_hash = ?`,
      [hashApiToken(token)],
    ),
  );
  return row ? rowToUser(row) : null;
}

/** A registration whose name a live, unmanaged Deployment holds. */
export interface ServiceAccountDeployment extends ApiAccessUser {
  deploymentId: string;
  nodePoolId: string;
  clusterId: string;
}

/** Every registration a token could match; registrations are few. */
export async function listServiceAccountDeployments(
  db: DB = getDB(),
): Promise<ServiceAccountDeployment[]> {
  return db.query<ServiceAccountDeployment>(
    `SELECT a.user_id AS userId, a.username, d.id AS deploymentId,
            d.node_pool_id AS nodePoolId, p.cluster_id AS clusterId
       FROM api_access_users a ${REGISTERED_DEPLOYMENT_JOIN}
       JOIN node_pools p ON p.id = d.node_pool_id`,
  );
}

export async function upsertApiAccessUser(
  user: ApiAccessUser,
  db: DB = getDB(),
): Promise<ApiAccessUser> {
  const normalized = {
    userId: normalizeUserId(user.userId),
    username: user.username.trim(),
  };
  if (!normalized.username) {
    throw new Error('GitHub username is required');
  }

  await db.query(
    `INSERT INTO api_access_users (user_id, username)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`,
    [normalized.userId, normalized.username],
  );
  return normalized;
}

/**
 * Removal also deletes the member's API token, so its next request fails,
 * and names the Deployment a removed registration's name held.
 */
export async function removeApiAccessUser(
  userId: string,
  db: DB = getDB(),
): Promise<RegisteredUser | null> {
  const serviceAccount = isServiceAccountUserId(userId);
  return db.transaction((tx) => {
    const [row] = tx.query<RegisteredUser>(
      `SELECT ${REGISTERED_USER_COLUMNS}
         FROM api_access_users a ${REGISTERED_DEPLOYMENT_JOIN}
        WHERE a.user_id = ${serviceAccount ? serviceAccountUserIdSql(`trim(substr(?, ${SERVICE_ACCOUNT_USER_PREFIX.length + 1}))`) : '?'}`,
      [
        serviceAccount || isServiceUserId(userId)
          ? userId
          : normalizeUserId(userId),
      ],
    );
    if (!row) return null;
    tx.query('DELETE FROM api_tokens WHERE user_id = ?', [row.userId]);
    tx.query('DELETE FROM api_access_users WHERE user_id = ?', [row.userId]);
    return row;
  });
}

/**
 * Every caller reads and acts on the whole API's workloads. A hosted API's
 * members are trusted peers who already share its credentials, secrets, and
 * spend controls; a local API has one owner, the holder of its per-install
 * token, who also reaches rows that earlier releases keyed by GitHub account.
 *
 * This decides what a caller may *reach*. Command-level filters such as
 * `--user` may still narrow what is displayed.
 */
export async function resolveOwnershipScope(): Promise<OwnershipScope> {
  return { kind: 'api' };
}

export async function assertApiAccess(
  user: Pick<User, 'id' | 'username'>,
  db: DB = getDB(),
): Promise<void> {
  const policy = await getApiAccessPolicy(db);
  if (!policy) return;

  if (!policy.ownerUserId) {
    throw new ApiAccessDeniedError();
  }

  if (user.id === policy.ownerUserId) {
    if (user.username !== policy.ownerUser) {
      await db.query(
        `UPDATE api_access_policy
            SET owner_user = ?, updated_at = ?
          WHERE id = ? AND owner_user_id = ?`,
        [user.username, Date.now(), POLICY_ID, user.id],
      );
    }
    return;
  }

  const rows = await db.query<ApiAccessUserRow>(
    `SELECT user_id, username
       FROM api_access_users
      WHERE user_id = ?`,
    [user.id],
  );
  const allowed = rows[0];
  if (!allowed) {
    throw new ApiAccessDeniedError();
  }

  if (user.username !== allowed.username) {
    await db.query(
      `UPDATE api_access_users SET username = ? WHERE user_id = ?`,
      [user.username, user.id],
    );
  }
}
