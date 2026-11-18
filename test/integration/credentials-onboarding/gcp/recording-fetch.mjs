// Test-only observation of actual creation responses in the CLI process.
// Private keys and operator tokens are never written to the ownership record.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const originalFetch = globalThis.fetch;
const projectId = process.env.ANYCLOUD_TEST_GCP_PROJECT;
const email = process.env.ANYCLOUD_TEST_GCP_EMAIL;
const recordPath = process.env.ANYCLOUD_TEST_GCP_OWNERSHIP;
let projectNumber;

globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (
    !response.ok ||
    !['iam.googleapis.com', 'cloudresourcemanager.googleapis.com'].includes(
      url.hostname,
    )
  )
    return response;
  const method = init?.method ?? 'GET';
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith(`/v1/projects/${projectId}`)) return response;
  try {
    const data = await response.clone().json();
    if (
      method === 'GET' &&
      url.hostname === 'cloudresourcemanager.googleapis.com'
    ) {
      if (data.projectId !== projectId || !/^\d+$/.test(data.projectNumber))
        throw new Error();
      projectNumber = data.projectNumber;
    }
    let owned = fs.existsSync(recordPath)
      ? JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      : undefined;
    if (method === 'POST' && path.endsWith('/serviceAccounts')) {
      if (
        owned ||
        !projectNumber ||
        data.projectId !== projectId ||
        data.email !== email ||
        !/^\d+$/.test(data.uniqueId)
      )
        throw new Error();
      const invocationId = data.description?.match(
        /^AnyCloud credential generation ([a-f0-9-]{36})$/,
      )?.[1];
      if (!invocationId) throw new Error();
      owned = {
        projectId,
        projectNumber,
        email,
        uniqueId: data.uniqueId,
        invocationId,
        keyIds: [],
        projectRoles: [],
      };
      fs.writeFileSync(recordPath, JSON.stringify(owned), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    if (!owned || method !== 'POST') return response;
    if (path.endsWith(':setIamPolicy')) {
      const roles = (data.bindings ?? [])
        .filter(
          (binding) =>
            !binding.condition &&
            binding.members?.includes(`serviceAccount:${email}`),
        )
        .map((binding) => binding.role);
      if (url.hostname === 'cloudresourcemanager.googleapis.com')
        owned.projectRoles = roles;
    }
    if (
      path ===
      `/v1/projects/${projectId}/serviceAccounts/${owned.uniqueId}/keys`
    ) {
      const key = JSON.parse(
        Buffer.from(data.privateKeyData, 'base64').toString('utf8'),
      );
      if (
        key.project_id !== projectId ||
        key.client_email !== email ||
        key.client_id !== owned.uniqueId ||
        !/^[a-f0-9]+$/.test(key.private_key_id) ||
        typeof key.private_key !== 'string'
      )
        throw new Error();
      owned.keyIds.push(key.private_key_id);
      owned.privateKeyFingerprint = createHash('sha256')
        .update(key.private_key)
        .digest('hex');
    }
    fs.writeFileSync(recordPath, JSON.stringify(owned), { mode: 0o600 });
  } catch {
    throw new Error(
      'Could not record GCP generation ownership; reconcile the known target manually.',
    );
  }
  return response;
};
