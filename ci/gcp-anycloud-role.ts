/**
 * Puts CI's standing GCP identity on the published Anycloud role, the one a
 * customer's role connection or `--generate` key gets: create the role or add
 * the permissions it lacks, then bind the account to it. GCP runs hold no
 * predefined runtime role, so a permission missing from
 * gcp-anycloud-role.json fails CI as it would fail a customer.
 *
 * Usage: npx tsx ci/gcp-anycloud-role.ts (GCP_PROJECT_ID, GCP_CLIENT_EMAIL,
 * GCP_PRIVATE_KEY set).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import anycloudRole from '../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { ensureAnycloudRole } from '../src/cli/services/credential-bootstrap/gcp.js';
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

export async function bindAnycloudRole(
  transport: GCPTransport,
  projectId: string,
  email: string,
): Promise<void> {
  const role = await ensureAnycloudRole(transport, projectId);
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
    const binding = bindings.find((b) => b.role === role && !b.condition);
    if (binding?.members.includes(member)) return;
    if (binding) binding.members.push(member);
    else bindings.push({ role, members: [member] });
    await transport.request('projects', `${path}:setIamPolicy`, 'POST', {
      policy: { ...policy, bindings },
    });
  };
  // Parallel GCP members bind at once; a stale etag reads the policy again.
  await withRetry(bindOnce, 'GCP Anycloud role binding', {
    maxAttempts: 6,
    waitMs: 500,
    shouldRetry: (error) =>
      error instanceof GCPBootstrapError && error.code === 'ABORTED',
  });
  // A new binding takes a while to take effect; the members start right after.
  const notYet = new Error(
    `${email} does not yet hold every ${role} permission`,
  );
  await withRetry(
    async () => {
      const { permissions = [] } = (await transport.request(
        'projects',
        `${path}:testIamPermissions`,
        'POST',
        { permissions: anycloudRole.includedPermissions },
      )) as { permissions?: string[] };
      if (permissions.length !== anycloudRole.includedPermissions.length)
        throw notYet;
    },
    'GCP Anycloud role propagation',
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
  const root = await mkdtemp(join(tmpdir(), 'gcp-anycloud-role-'));
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
    await bindAnycloudRole(
      await createGCPTransport(gcpOperator(email, projectId, environment)),
      projectId,
      email,
    );
    console.log(`${email} holds projects/${projectId}/roles/anycloud`);
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
