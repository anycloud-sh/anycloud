import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { z } from 'zod';
import { type GCPOperator } from '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import {
  cleanupGCPGeneration,
  describeGCPGeneration,
  GCP_CONTROLLER_PROJECT_ROLES,
  type GCPGenerationOwnership,
} from '../../../../src/cli/services/credential-bootstrap/gcp.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';

const evidenceSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string().regex(/^\d+$/),
  email: z.string().regex(/^anycloud-onb-gen-[a-f0-9]{12}@/),
  uniqueId: z.string().regex(/^\d+$/),
  invocationId: z.string().uuid(),
  keyIds: z.array(z.string().regex(/^[a-f0-9]+$/)),
  projectRoles: z.array(z.enum(GCP_CONTROLLER_PROJECT_ROLES)),
  privateKeyFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export interface GCPGenerationFixture {
  operator: GCPOperator;
  recordPath: string;
  email: string;
  environment: Record<string, string>;
}

export function prepareGCPGenerationFixture(
  root: string,
  operator: GCPOperator,
  credentialName: string,
): GCPGenerationFixture {
  if (!/^onb-gen-[a-f0-9]{12}$/.test(credentialName))
    throw new Error('Invalid GCP generation fixture name.');
  const recordPath = join(root, 'gcp-ownership.json');
  const email = `anycloud-${credentialName}@${operator.projectId}.iam.gserviceaccount.com`;
  const recorder = pathToFileURL(
    fileURLToPath(new URL('./recording-fetch.mjs', import.meta.url)),
  ).href;
  writeLocalApiToken(root);
  return {
    operator,
    recordPath,
    email,
    environment: {
      ...Object.fromEntries(
        Object.entries(operator.environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HOME: root,
      ANYCLOUD_DIR: root,
      CI: 'false',
      PATH: `${dirname(process.execPath)}:${operator.environment.PATH ?? ''}`,
      NODE_OPTIONS: `--import=${recorder}`,
      ANYCLOUD_TEST_GCP_PROJECT: operator.projectId,
      ANYCLOUD_TEST_GCP_EMAIL: email,
      ANYCLOUD_TEST_GCP_OWNERSHIP: recordPath,
    },
  };
}

export async function readGCPGenerationOwnership(
  fixture: GCPGenerationFixture,
): Promise<GCPGenerationOwnership & { privateKeyFingerprint?: string }> {
  let owned: z.infer<typeof evidenceSchema>;
  try {
    owned = evidenceSchema.parse(
      JSON.parse(await readFile(fixture.recordPath, 'utf8')),
    );
  } catch {
    throw new Error(
      `Missing valid creation record for ${fixture.email}; reconcile manually. No name-based cleanup is allowed.`,
    );
  }
  if (
    owned.projectId !== fixture.operator.projectId ||
    owned.email !== fixture.email
  )
    throw new Error('GCP generation cleanup record belongs to another target.');
  return owned;
}

export async function cleanupGCPGenerationFixture(
  fixture: GCPGenerationFixture,
  deleteAPICredential: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await deleteAPICredential();
  } catch (error) {
    failures.push(error);
  }
  try {
    const owned = await readGCPGenerationOwnership(fixture);
    console.info(`GCP generation teardown: ${describeGCPGeneration(owned)}`);
    await cleanupGCPGeneration(fixture.operator, owned);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `GCP generation teardown failed for ${fixture.email}; inspect the creation record for manual reconciliation.`,
    );
}
