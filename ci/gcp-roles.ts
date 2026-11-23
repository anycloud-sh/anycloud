/**
 * Puts CI's standing GCP account on two custom roles and nothing else at
 * runtime: the published Anycloud role a customer's role connection or
 * `--generate` key gets, and `anycloud_ci` (gcp-ci-role.json) for what CI's
 * harness, cluster seed and catalog do beyond the product. Each is created or
 * given the permissions it lacks, never narrowed, so a permission missing from
 * gcp-anycloud-role.json fails CI as it would fail a customer.
 *
 * Usage: npx tsx ci/gcp-roles.ts (GCP_PROJECT_ID, GCP_CLIENT_EMAIL and
 * GCP_PRIVATE_KEY set).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import anycloudRole from '../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import ciRole from './gcp-ci-role.json' with { type: 'json' };
import { ensureGCPRole } from '../src/cli/services/credential-bootstrap/gcp.js';
import {
  gcpOperator,
  runGcloud,
} from '../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import {
  createGCPTransport,
  GCPBootstrapError,
  type GCPTransport,
} from '../src/cli/services/credential-bootstrap/gcp-transport.js';
import { withRetry } from '../src/shared/utils.js';

interface Policy {
  etag: string;
  bindings?: Array<{ role: string; members: string[]; condition?: unknown }>;
}

export async function bindCIRoles(
  transport: GCPTransport,
  projectId: string,
  email: string,
): Promise<void> {
  const roles = [
    await ensureGCPRole(transport, projectId),
    await ensureGCPRole(transport, projectId, 'anycloud_ci', ciRole),
  ];
  const member = `serviceAccount:${email}`;
  const path = `/v1/projects/${projectId}`;
  const bindOnce = async () => {
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
  };
  // Parallel GCP members bind at once; a stale etag reads the policy again.
  await withRetry(bindOnce, 'GCP CI role binding', {
    maxAttempts: 6,
    waitMs: 500,
    shouldRetry: (error) =>
      error instanceof GCPBootstrapError && error.code === 'ABORTED',
  });
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
  const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/gu, '\n');
  if (!projectId || !email || !privateKey)
    throw new Error('Set GCP_PROJECT_ID, GCP_CLIENT_EMAIL and GCP_PRIVATE_KEY');
  const root = await mkdtemp(join(tmpdir(), 'gcp-roles-'));
  try {
    const key = join(root, 'key.json');
    await writeFile(
      key,
      JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        client_email: email,
        private_key: privateKey,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
      { mode: 0o600 },
    );
    const environment = { CLOUDSDK_CONFIG: join(root, 'gcloud') };
    await runGcloud(
      ['auth', 'activate-service-account', email, `--key-file=${key}`],
      environment,
    );
    await bindCIRoles(
      await createGCPTransport(gcpOperator(email, projectId, environment)),
      projectId,
      email,
    );
    console.log(`${email} holds the anycloud and anycloud_ci roles`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
