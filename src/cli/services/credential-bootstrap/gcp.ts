import { createPrivateKey, randomUUID } from 'crypto';
import { z } from 'zod';
import anycloudRole from '../../../shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { withRetry } from '../../../shared/utils.js';
import type { GCPOperator } from './gcp-cli-runner.js';
import {
  createGCPTransport,
  GCPBootstrapError,
  type GCPTransport,
} from './gcp-transport.js';

// The published role, as role connections get it (gcp-anycloud-role.json).
export const GCP_ANYCLOUD_ROLE_ID = 'anycloud';
export const GCP_GENERATION_DESCRIPTION_PREFIX =
  'AnyCloud credential generation ';

const projectSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string().regex(/^\d+$/),
  lifecycleState: z.literal('ACTIVE'),
});
const accountSchema = z.object({
  projectId: z.string(),
  email: z.string(),
  uniqueId: z.string().regex(/^\d+$/),
  description: z.string().optional(),
});
const policySchema = z
  .object({
    etag: z.string().min(1),
    bindings: z
      .array(
        z
          .object({
            role: z.string(),
            members: z.array(z.string()),
            condition: z.unknown().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const roleSchema = z.object({
  etag: z.string().min(1),
  includedPermissions: z.array(z.string()).default([]),
  deleted: z.boolean().optional(),
  stage: z.string().optional(),
});
const keySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string(),
  client_email: z.string(),
  client_id: z.string(),
  private_key_id: z.string().regex(/^[a-f0-9]+$/),
  private_key: z.string().min(1),
});

export interface GCPGenerationPreview {
  operator: GCPOperator;
  projectNumber: string;
  accountId: string;
  email: string;
}

/** Creation responses held only by this invocation, never reconstructed from a name. */
export interface GCPGenerationOwnership {
  projectId: string;
  projectNumber: string;
  email: string;
  uniqueId: string;
  invocationId: string;
  keyIds: string[];
  projectRoles: string[];
}

function decode<T>(value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new GCPBootstrapError(
      'GCP returned invalid output; the request may have succeeded.',
    );
  return result.data;
}

export function isGCPPermissionDenied(error: unknown): boolean {
  return (
    error instanceof GCPBootstrapError && error.code === 'PERMISSION_DENIED'
  );
}

export function validateGCPGenerationName(credentialName: string): string {
  const accountId = `anycloud-${credentialName}`;
  if (
    !credentialName ||
    accountId.length > 30 ||
    !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(accountId)
  ) {
    throw new Error(
      'GCP generation requires a credential name of 1–21 lowercase letters, digits, or hyphens, ending in a letter or digit.',
    );
  }
  return accountId;
}

const accountPath = (projectId: string, identity: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(identity)}`;

export async function getGCPGenerationPreview(
  operator: GCPOperator,
  credentialName: string,
): Promise<GCPGenerationPreview> {
  const accountId = validateGCPGenerationName(credentialName);
  const transport = await createGCPTransport(operator);
  const project = decode(
    await transport.request('projects', `/v1/projects/${operator.projectId}`),
    projectSchema,
  );
  if (project.projectId !== operator.projectId)
    throw new Error(
      'GCP returned a different project from the selected target.',
    );
  return {
    operator,
    projectNumber: project.projectNumber,
    accountId,
    email: `${accountId}@${operator.projectId}.iam.gserviceaccount.com`,
  };
}

export function describeGCPGeneration(owned: GCPGenerationOwnership): string {
  return `GCP project ${owned.projectId}, service account ${owned.email} (unique ID ${owned.uniqueId}, invocation ${owned.invocationId})`;
}

async function assertOwnedAccount(
  transport: GCPTransport,
  owned: GCPGenerationOwnership,
  newlyCreated = false,
): Promise<void> {
  if (
    !/^\d+$/.test(owned.uniqueId) ||
    !/^\d+$/.test(owned.projectNumber) ||
    !z.string().uuid().safeParse(owned.invocationId).success
  ) {
    throw new Error(
      'Missing GCP creation-time ownership record; reconcile manually.',
    );
  }
  const account = decode(
    await withRetry(
      () =>
        transport.request('iam', accountPath(owned.projectId, owned.uniqueId)),
      'GCP new service-account visibility',
      {
        maxAttempts: 6,
        waitMs: 1_000,
        maxWaitMs: 8_000,
        jitter: false,
        shouldRetry: (error) =>
          newlyCreated &&
          error instanceof GCPBootstrapError &&
          error.status === 404 &&
          error.code === 'NOT_FOUND',
      },
    ),
    accountSchema,
  );
  if (
    account.projectId !== owned.projectId ||
    account.email !== owned.email ||
    account.uniqueId !== owned.uniqueId ||
    account.description !==
      `${GCP_GENERATION_DESCRIPTION_PREFIX}${owned.invocationId}`
  ) {
    throw new Error(
      'GCP service-account ownership changed; refusing to mutate it.',
    );
  }
}

/**
 * Create the project's published role, or add the published permissions an
 * existing one lacks, as the role-connection setup does. Other credentials and
 * role connections may share it, so this never removes a permission and
 * cleanup never deletes it.
 */
async function ensureAnycloudRole(
  transport: GCPTransport,
  projectId: string,
): Promise<string> {
  const name = `projects/${projectId}/roles/${GCP_ANYCLOUD_ROLE_ID}`;
  const path = `/v1/${name}`;
  const isCode = (error: unknown, code: string) =>
    error instanceof GCPBootstrapError && error.code === code;
  const read = () =>
    transport
      .request('iam', path)
      .then((role) => decode(role, roleSchema))
      .catch((error: unknown) => {
        if (isCode(error, 'NOT_FOUND')) return undefined;
        throw error;
      });
  if (!(await read())) {
    try {
      await transport.request(
        'iam',
        `/v1/projects/${projectId}/roles`,
        'POST',
        {
          roleId: GCP_ANYCLOUD_ROLE_ID,
          role: anycloudRole,
        },
      );
      return name;
    } catch (error) {
      // Another invocation created it first.
      if (!isCode(error, 'ALREADY_EXISTS')) throw error;
    }
  }
  const addMissing = async () => {
    const role = await read();
    if (!role || role.deleted || role.stage === 'DISABLED')
      throw new Error(
        `GCP role ${GCP_ANYCLOUD_ROLE_ID} is deleted, disabled or unreadable; undelete or enable it, or reconcile manually.`,
      );
    const missing = anycloudRole.includedPermissions.filter(
      (permission) => !role.includedPermissions.includes(permission),
    );
    if (missing.length)
      await transport.request(
        'iam',
        `${path}?updateMask=includedPermissions`,
        'PATCH',
        {
          includedPermissions: [...role.includedPermissions, ...missing],
          etag: role.etag,
        },
      );
  };
  // A concurrent change to the role makes its etag stale: read it again.
  await withRetry(addMissing, 'GCP role update', {
    maxAttempts: 4,
    waitMs: 1_000,
    jitter: false,
    shouldRetry: (error) => isCode(error, 'ABORTED'),
  });
  return name;
}

async function changeGrants(
  transport: GCPTransport,
  owned: GCPGenerationOwnership,
  roles: readonly string[],
  add: boolean,
): Promise<void> {
  const changeOnce = async () => {
    await assertOwnedAccount(transport, owned, add);
    const path = `/v1/projects/${owned.projectId}`;
    const policy = decode(
      await transport.request('projects', `${path}:getIamPolicy`, 'POST', {
        options: { requestedPolicyVersion: 3 },
      }),
      policySchema,
    );
    const member = `serviceAccount:${owned.email}`;
    let changed = false;
    for (const role of roles) {
      const binding = policy.bindings.find(
        (candidate) => candidate.role === role && !candidate.condition,
      );
      const present = binding?.members.includes(member) === true;
      if (add && present)
        throw new Error(
          'GCP grant already exists; it cannot be attributed to this invocation.',
        );
      if (!add && !present) continue;
      changed = true;
      if (add) {
        if (binding) binding.members.push(member);
        else policy.bindings.push({ role, members: [member] });
      } else {
        policy.bindings = policy.bindings.flatMap((candidate) => {
          if (candidate !== binding) return [candidate];
          const members = candidate.members.filter((value) => value !== member);
          return members.length ? [{ ...candidate, members }] : [];
        });
      }
    }
    if (!changed) return;
    await assertOwnedAccount(transport, owned, add);
    // Preserve the provider's etag and conditions; conflicts or lost writes are terminal.
    const saved = decode(
      await transport.request('projects', `${path}:setIamPolicy`, 'POST', {
        policy,
      }),
      policySchema,
    );
    const confirmed = roles.every(
      (role) =>
        saved.bindings.some(
          (candidate) =>
            candidate.role === role &&
            !candidate.condition &&
            candidate.members.includes(member),
        ) === add,
    );
    if (!confirmed)
      throw new Error(
        'GCP did not confirm the requested grant change; reconcile manually.',
      );
  };
  // IAM can reject a grant for the just-created identity even after an earlier
  // lookup succeeded. Only this exact, definitive rejection permits a fresh
  // policy read and write; key issuance, conflicts, and lost writes never replay.
  await withRetry(changeOnce, 'GCP new service-account grant visibility', {
    maxAttempts: 6,
    waitMs: 1_000,
    maxWaitMs: 8_000,
    jitter: false,
    shouldRetry: (error) =>
      add &&
      error instanceof GCPBootstrapError &&
      error.status === 400 &&
      error.code === 'INVALID_ARGUMENT' &&
      error.missingServiceAccount === owned.email,
  });
}

export async function cleanupGCPGeneration(
  operator: GCPOperator,
  owned: GCPGenerationOwnership,
): Promise<void> {
  if (operator.projectId !== owned.projectId)
    throw new Error('GCP cleanup target differs from the selected project.');
  const transport = await createGCPTransport(operator);
  const project = decode(
    await transport.request('projects', `/v1/projects/${owned.projectId}`),
    projectSchema,
  );
  if (project.projectNumber !== owned.projectNumber)
    throw new Error('GCP project identity changed; reconcile manually.');
  const path = accountPath(owned.projectId, owned.uniqueId);
  const inspectKeys = async () => {
    await assertOwnedAccount(transport, owned);
    const result = decode(
      await transport.request('iam', `${path}/keys?keyTypes=USER_MANAGED`),
      z.object({ keys: z.array(z.object({ name: z.string() })).default([]) }),
    );
    const keys = result.keys.map((key) => key.name.split('/').pop()!);
    if (keys.some((key) => !owned.keyIds.includes(key)))
      throw new Error(
        'GCP identity has unattributed keys; reconcile manually.',
      );
    return keys;
  };
  try {
    await inspectKeys();
    for (const keyId of owned.keyIds) {
      await assertOwnedAccount(transport, owned);
      // The creation receipt identifies issued keys even when a list omits them.
      try {
        await transport.request(
          'iam',
          `${path}/keys/${encodeURIComponent(keyId)}`,
          'DELETE',
        );
      } catch (error) {
        if (
          !(error instanceof GCPBootstrapError) ||
          error.status !== 404 ||
          error.code !== 'NOT_FOUND'
        )
          throw error;
      }
    }
    if (owned.projectRoles.length)
      await changeGrants(transport, owned, owned.projectRoles, false);
    const deletedKeyVisible = new Error(
      'GCP identity still has keys; reconcile manually.',
    );
    // Recheck visibility only for owned keys; deletion and grant writes stay single-attempt.
    await withRetry(
      async () => {
        if ((await inspectKeys()).length) throw deletedKeyVisible;
      },
      'GCP key deletion visibility',
      {
        maxAttempts: 6,
        waitMs: 1_000,
        maxWaitMs: 8_000,
        jitter: false,
        shouldRetry: (error) => error === deletedKeyVisible,
      },
    );
    await assertOwnedAccount(transport, owned);
    await transport.request('iam', path, 'DELETE');
  } catch (error) {
    throw new Error(
      `${errorMessage(error)} Inspect ${describeGCPGeneration(owned)}, known keys ${owned.keyIds.join(', ') || 'none'} for manual reconciliation.`,
    );
  }
}

export async function generateGCPCredentials(
  preview: GCPGenerationPreview,
): Promise<{
  projectId: string;
  clientEmail: string;
  privateKey: string;
  ownership: GCPGenerationOwnership;
  cleanup: () => Promise<void>;
}> {
  const { operator } = preview;
  const transport = await createGCPTransport(operator);
  const project = decode(
    await transport.request('projects', `/v1/projects/${operator.projectId}`),
    projectSchema,
  );
  if (
    project.projectId !== operator.projectId ||
    project.projectNumber !== preview.projectNumber
  )
    throw new Error(
      'GCP project changed since the preview; confirm the target again.',
    );
  const invocationId = randomUUID();
  let owned: GCPGenerationOwnership | undefined;
  try {
    // Before the account, so an operator who can't manage roles leaves nothing.
    const role = await ensureAnycloudRole(transport, operator.projectId);
    const account = decode(
      await transport.request(
        'iam',
        `/v1/projects/${operator.projectId}/serviceAccounts`,
        'POST',
        {
          accountId: preview.accountId,
          serviceAccount: {
            displayName: `AnyCloud credential ${preview.accountId}`,
            description: `${GCP_GENERATION_DESCRIPTION_PREFIX}${invocationId}`,
          },
        },
      ),
      accountSchema,
    );
    if (
      account.projectId !== operator.projectId ||
      account.email !== preview.email ||
      account.description !==
        `${GCP_GENERATION_DESCRIPTION_PREFIX}${invocationId}`
    )
      throw new Error('GCP returned an unexpected created identity.');
    owned = {
      projectId: operator.projectId,
      projectNumber: preview.projectNumber,
      email: account.email,
      uniqueId: account.uniqueId,
      invocationId,
      keyIds: [],
      projectRoles: [],
    };
    await changeGrants(transport, owned, [role], true);
    owned.projectRoles.push(role);
    await assertOwnedAccount(transport, owned, true);
    const response = decode(
      await transport.request(
        'iam',
        `${accountPath(owned.projectId, owned.uniqueId)}/keys`,
        'POST',
        {
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
          keyAlgorithm: 'KEY_ALG_RSA_2048',
        },
      ),
      z.object({ name: z.string(), privateKeyData: z.string() }),
    );
    let key: z.infer<typeof keySchema>;
    try {
      key = keySchema.parse(
        JSON.parse(
          Buffer.from(response.privateKeyData, 'base64').toString('utf8'),
        ),
      );
      createPrivateKey(key.private_key);
    } catch {
      throw new Error(
        'GCP returned invalid generated key material; reconcile manually.',
      );
    }
    if (
      key.project_id !== owned.projectId ||
      key.client_email !== owned.email ||
      key.client_id !== owned.uniqueId ||
      !response.name.endsWith(`/keys/${key.private_key_id}`)
    )
      throw new Error('GCP returned a key for an unexpected identity.');
    owned.keyIds.push(key.private_key_id);
    const ownership = owned;
    return {
      projectId: owned.projectId,
      clientEmail: owned.email,
      privateKey: key.private_key,
      ownership,
      cleanup: () => cleanupGCPGeneration(operator, ownership),
    };
  } catch (error) {
    const target = owned
      ? describeGCPGeneration(owned)
      : `GCP project ${operator.projectId}, service account ${preview.email}, invocation ${invocationId} (unique ID unknown)`;
    throw Object.assign(
      new Error(
        `${errorMessage(error)} Inspect ${target} for manual reconciliation; resources were retained and no uncertain mutation was retried.`,
      ),
      { cause: error },
    );
  }
}
