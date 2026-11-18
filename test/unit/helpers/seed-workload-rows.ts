import { getDB } from '../../../src/api/services/repositories/db.js';
import { encryptSecret } from '../../../src/api/services/secret-crypto.js';

/** Keep deep-history query-plan fixtures fast without bypassing owner completeness. */
export async function seedWorkloadRows(
  sql: string,
  params: unknown[],
  image: string,
  usernames: string[],
): Promise<void> {
  const owners = await Promise.all(
    usernames.map(async (username) => ({
      username,
      encrypted: await encryptSecret(username),
    })),
  );
  await getDB().transaction((tx) => {
    tx.query(sql, params);
    for (const owner of owners) {
      tx.query(
        `INSERT INTO container_specs (workload_id, image, registry_username)
         SELECT d.id, ?, ? FROM workloads d
         WHERE d.user_id = ? AND d.deployment_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM container_specs s WHERE s.workload_id = d.id)`,
        [image, owner.encrypted, owner.username],
      );
    }
  });
}
