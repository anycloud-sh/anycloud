/**
 * Puts CI's standing GCP account on two custom roles and nothing else at
 * runtime: the published Anycloud role a customer's role connection or
 * `--generate` key gets, and `anycloud_ci` (gcp-ci-role.json) for what CI's
 * harness, cluster seed and catalog do beyond the product. So a permission
 * missing from src/shared/cloud-policies/gcp-anycloud-role.json fails CI as it
 * would fail a customer.
 *
 * Each role is created or given the permissions it lacks, as `--generate`
 * does. Main and scheduled runs also remove permissions the files don't list,
 * so an unmerged branch's additions don't outlive it; other runs warn of them.
 *
 * Usage: npx tsx ci/gcp-roles.ts (GCP_PROJECT_ID, GCP_CLIENT_EMAIL and
 * GCP_PRIVATE_KEY set).
 */

import { pathToFileURL } from 'node:url';
import { JWT } from 'google-auth-library';

import anycloudRole from '../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import ciRole from './gcp-ci-role.json' with { type: 'json' };
import {
  ensureGCPRole,
  GCP_ANYCLOUD_ROLE_ID,
} from '../src/cli/services/credential-bootstrap/gcp.js';
import {
  gcpTransport,
  GCPBootstrapError,
  type GCPTransport,
} from '../src/cli/services/credential-bootstrap/gcp-transport.js';
import { withRetry } from '../src/shared/utils.js';

interface Policy {
  etag: string;
  bindings?: Array<{ role: string; members: string[]; condition?: unknown }>;
}

/** Concurrent members write at once; a stale etag reads again. */
const retryAborted = (operation: () => Promise<void>, name: string) =>
  withRetry(operation, name, {
    maxAttempts: 8,
    waitMs: 500,
    maxWaitMs: 8_000,
    shouldRetry: (error) =>
      error instanceof GCPBootstrapError && error.code === 'ABORTED',
  });

async function ensureRole(
  transport: GCPTransport,
  projectId: string,
  roleId: string,
  document: { includedPermissions: string[] },
  exact: boolean,
): Promise<string> {
  const name = await ensureGCPRole(transport, projectId, roleId, document);
  await retryAborted(async () => {
    const role = (await transport.request('iam', `/v1/${name}`)) as {
      etag: string;
      includedPermissions?: string[];
    };
    const extra = (role.includedPermissions ?? []).filter(
      (permission) => !document.includedPermissions.includes(permission),
    );
    if (!extra.length) return;
    if (!exact) {
      console.log(
        `::warning::${name} holds permissions its file doesn't list: ${extra.join(', ')}`,
      );
      return;
    }
    await transport.request(
      'iam',
      `/v1/${name}?updateMask=includedPermissions`,
      'PATCH',
      { includedPermissions: document.includedPermissions, etag: role.etag },
    );
    console.log(`Removed from ${name}: ${extra.join(', ')}`);
  }, `GCP role ${roleId} reset`);
  return name;
}

export async function bindCIRoles(
  transport: GCPTransport,
  projectId: string,
  email: string,
  { exact = false }: { readonly exact?: boolean } = {},
): Promise<void> {
  const roles = [
    await ensureRole(
      transport,
      projectId,
      GCP_ANYCLOUD_ROLE_ID,
      anycloudRole,
      exact,
    ),
    await ensureRole(transport, projectId, 'anycloud_ci', ciRole, exact),
  ];
  const member = `serviceAccount:${email}`;
  const path = `/v1/projects/${projectId}`;
  await retryAborted(async () => {
    const policy = (await transport.request(
      'projects',
      `${path}:getIamPolicy`,
      'POST',
      { options: { requestedPolicyVersion: 3 } },
    )) as Policy;
    const bindings = policy.bindings ?? [];
    let changed = false;
    for (const role of roles) {
      const binding = bindings.find((b) => b.role === role && !b.condition);
      if (binding?.members.includes(member)) continue;
      changed = true;
      if (binding) binding.members.push(member);
      else bindings.push({ role, members: [member] });
    }
    if (!changed) return;
    await transport.request('projects', `${path}:setIamPolicy`, 'POST', {
      policy: { ...policy, bindings },
    });
  }, 'GCP CI role binding');
  // A new binding takes a while to take effect; the members start right after.
  const permissions = [
    ...anycloudRole.includedPermissions,
    ...ciRole.includedPermissions,
  ];
  const notYet = new Error(`${email} does not yet hold every CI permission`);
  await withRetry(
    async () => {
      const { permissions: held = [] } = (await transport.request(
        'projects',
        `${path}:testIamPermissions`,
        'POST',
        { permissions },
      )) as { permissions?: string[] };
      if (held.length !== permissions.length) throw notYet;
    },
    'GCP CI role propagation',
    {
      maxAttempts: 20,
      waitMs: 1_000,
      maxWaitMs: 30_000,
      shouldRetry: (error) => error === notYet,
    },
  );
}

async function main(): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  const email = process.env.GCP_CLIENT_EMAIL;
  const key = process.env.GCP_PRIVATE_KEY?.replace(/\\n/gu, '\n');
  if (!projectId || !email || !key)
    throw new Error('Set GCP_PROJECT_ID, GCP_CLIENT_EMAIL and GCP_PRIVATE_KEY');
  const { token } = await new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  }).getAccessToken();
  if (!token) throw new Error(`No GCP access token for ${email}`);
  await bindCIRoles(gcpTransport(token), projectId, email, {
    exact:
      process.env.GITHUB_REF === 'refs/heads/main' ||
      process.env.GITHUB_EVENT_NAME === 'schedule',
  });
  console.log(`${email} holds the anycloud and anycloud_ci roles`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
