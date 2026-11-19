import { createHash, randomBytes } from 'node:crypto';

import { ApiAccessDeniedError } from '../../../shared/errors.js';
import { decryptSecret, encryptSecret } from '../secret-crypto.js';
import { getDB, type DB } from './db.js';

export const API_TOKEN_PREFIX = 'acapi_';
const LAST_USED_INTERVAL_MS = 60 * 60 * 1000;

/** An account and its GitHub sign-in, decrypted; none for a GitHub App's. */
export interface ApiTokenOwner {
  userId: string;
  username: string;
  githubToken: string | null;
}

export const hashApiToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** A fresh bearer and its SHA-256, the only form a service token is kept in. */
export function newApiToken(): { token: string; hash: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashApiToken(token) };
}

async function mintApiToken() {
  const minted = newApiToken();
  return { ...minted, ciphertext: await encryptSecret(minted.token) };
}

/**
 * The account's token, minted once and returned on every exchange. One
 * statement stores the newest OAuth sign-in (a GitHub App's is never kept)
 * only while the API admits the account, so neither a removal race nor
 * concurrent first exchanges mint a second.
 */
export async function exchangeApiToken(
  owner: ApiTokenOwner,
  db: DB = getDB(),
): Promise<string> {
  const minted = await mintApiToken();
  const githubCiphertext =
    owner.githubToken === null ? null : await encryptSecret(owner.githubToken);
  // The exchange's admission check, as assertApiAccess decides it;
  // per-request assertApiAccess writes back renamed usernames.
  const [row] = await db.query<{ token_ciphertext: string }>(
    `INSERT INTO api_tokens (
       user_id, username, token_hash, token_ciphertext, github_ciphertext,
       created_at
     )
     SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_access_policy WHERE owner_user_id = ?)
         OR (EXISTS (SELECT 1 FROM api_access_policy WHERE owner_user_id IS NOT NULL)
             AND EXISTS (SELECT 1 FROM api_access_users WHERE user_id = ?))
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       github_ciphertext = coalesce(excluded.github_ciphertext, github_ciphertext)
     RETURNING token_ciphertext`,
    [
      owner.userId,
      owner.username,
      minted.hash,
      minted.ciphertext,
      githubCiphertext,
      Date.now(),
      owner.userId,
      owner.userId,
    ],
  );
  if (!row) throw new ApiAccessDeniedError();
  return decryptSecret(row.token_ciphertext);
}

/** Replaces the account's token in one statement. */
export async function rotateApiToken(
  userId: string,
  db: DB = getDB(),
): Promise<string> {
  const minted = await mintApiToken();
  const rows = await db.query(
    `UPDATE api_tokens SET token_hash = ?, token_ciphertext = ?
      WHERE user_id = ?
      RETURNING user_id`,
    [minted.hash, minted.ciphertext, userId],
  );
  if (rows.length === 0) throw new ApiAccessDeniedError();
  return minted.token;
}

/** The account a token belongs to, recording its use at most once an hour. */
export async function findApiTokenOwner(
  token: string,
  db: DB = getDB(),
): Promise<ApiTokenOwner | null> {
  const [row] = await db.read((reader) =>
    reader.query<{
      user_id: string;
      username: string;
      github_ciphertext: string | null;
      last_used_at: number | null;
    }>(
      `SELECT user_id, username, github_ciphertext, last_used_at
         FROM api_tokens
        WHERE token_hash = ?`,
      [hashApiToken(token)],
    ),
  );
  if (!row) return null;
  const now = Date.now();
  if (now - (row.last_used_at ?? 0) >= LAST_USED_INTERVAL_MS) {
    await db.query('UPDATE api_tokens SET last_used_at = ? WHERE user_id = ?', [
      now,
      row.user_id,
    ]);
  }
  return {
    userId: row.user_id,
    username: row.username,
    githubToken:
      row.github_ciphertext === null
        ? null
        : await decryptSecret(row.github_ciphertext),
  };
}
