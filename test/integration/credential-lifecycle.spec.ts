import { spawn } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ORPCError } from '@orpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../src/shared/api-version.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadType } from '../../src/shared/workload.js';
import { errorMessage } from '../../src/shared/log-diagnostics.js';
import { createApiClient } from '../../src/shared/services/api-client/rpc.js';
import { getAnycloudVersion } from '../../src/shared/services/api-client/runtime.js';
import {
  AWS_REJECTED_KEY,
  AZURE_EXPIRED_CLIENT_SECRET,
  GCP_UNAUTHENTICATED,
  LAMBDA_INVALID_API_KEY,
} from './credentials-onboarding/personas.js';
import { Waiter, WaitTimeoutError } from './e2e/internal/wait.js';
import { startFakeS3, startFakeSts } from './fake-clouds/aws.js';
import { startFakeAzureAuthority } from './fake-clouds/azure.js';
import { startFakeGcpCompute } from './fake-clouds/gcp.js';
import { startFakeLambda } from './fake-clouds/lambda.js';
import { writeLocalApiToken } from './helpers/local-api-token.js';

/**
 * RFC 0034 fake-provider lane: the built API, spawned with endpoint
 * overrides, talking to fake management planes over real sockets. Assertions
 * stay on credential and workload state and the user-visible error
 * surface — never on scheduler cadence or attempt counts, which belong to
 * the local-provider tier.
 */
interface LifecycleJourney {
  id: string;
  contract: string;
}

const LIFECYCLE_JOURNEYS = [
  {
    id: 'aws.validate-rejected',
    contract:
      'A rejected AWS key fails deploy-time validation with no workload created.',
  },
  {
    id: 'azure.validate-rejected',
    contract:
      'An expired Azure client secret fails deploy-time validation at the token endpoint without reaching ARM.',
  },
  {
    id: 'gcp.validate-rejected',
    contract:
      'A rejected GCP service account fails deploy-time validation with no workload created.',
  },
  {
    id: 'gcp.validate-malformed-key',
    contract:
      'A malformed GCP private key is rejected locally without contacting the provider or creating a workload.',
  },
  {
    id: 'lambda.validate-rejected',
    contract:
      'A rejected Lambda API key fails deploy-time validation with no workload created.',
  },
  {
    id: 'aws.storage-listing',
    contract:
      'Bucket listing succeeds through the fake S3 endpoint with the saved credential.',
  },
] satisfies LifecycleJourney[];

function journeyTitle(id: string): string {
  const journey = LIFECYCLE_JOURNEYS.find((entry) => entry.id === id);
  if (!journey) throw new Error(`Unknown lifecycle journey: ${id}`);
  return `[${journey.id}] ${journey.contract}`;
}

// The per-install token the local API reads at boot, as `api start` writes it.
const API_TOKEN = 'e'.repeat(64);
// A loopback registry ref: the manifest preflight's SSRF guard answers
// ImageVerdict.Unknown for internal hosts without any network contact, so
// admission proceeds to the credential validation this lane exists to test.
const IMAGE = '127.0.0.1/anycloud/lifecycle-lane:latest';
const RAW_REQUEST_HEADERS = {
  authorization: `Bearer ${API_TOKEN}`,
  [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
};

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Port probe did not bind a TCP socket'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

interface LifecycleApi {
  url: string;
  client: ReturnType<typeof createApiClient>;
  output: () => string;
  close: () => Promise<void>;
}

/**
 * Env names that would leak ambient credentials or endpoint overrides into
 * the spawned API. GCP_API_ENDPOINT hard-errors when the SDK emulator
 * variables are set, so those are scrubbed too.
 */
const SCRUBBED_ENV_PREFIXES = [
  'AWS_',
  'AZURE_',
  'GCP_',
  'GOOGLE_',
  'LAMBDA_API_',
];
const SCRUBBED_ENV_NAMES = [
  'ANYCLOUD_CLOUD_PROVIDER',
  'STORAGE_EMULATOR_HOST',
  'BIGQUERY_EMULATOR_HOST',
  'NODE_EXTRA_CA_CERTS',
];

async function spawnLifecycleApi(
  overrides: Record<string, string>,
): Promise<LifecycleApi> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anycloud-lifecycle-api-'));
  writeLocalApiToken(join(stateDir, 'anycloud'), API_TOKEN);
  const port = await freeLoopbackPort();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SCRUBBED_ENV_NAMES.includes(name)) continue;
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    env[name] = value;
  }
  Object.assign(env, {
    PORT: String(port),
    SQLITE_PATH: join(stateDir, 'api.db'),
    IS_TEST: 'true',
    CIPHER_KEY: process.env.CIPHER_KEY ?? 'a'.repeat(64),
    ...overrides,
    ANYCLOUD_DIR: join(stateDir, 'anycloud'),
  });

  const child = spawn(process.execPath, ['dist/api/server.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];
  let childError: Error | undefined;
  child.once('error', (error) => {
    childError = error;
  });
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        if (
          childError === undefined &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const exited = new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.once('error', () => resolve());
          });
          child.kill('SIGKILL');
          await exited;
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    })();
    return closePromise;
  };

  const url = `http://127.0.0.1:${port}`;
  try {
    await new Waiter(new AbortController().signal)
      .for(
        'API readiness',
        async () => {
          if (childError) throw childError;
          if (child.exitCode !== null || child.signalCode !== null) {
            const exit =
              child.exitCode !== null
                ? `code ${child.exitCode}`
                : `signal ${child.signalCode}`;
            throw new Error(
              `API exited with ${exit} before ready:\n${chunks.join('')}`,
            );
          }
          return fetch(`${url}/v1/credentials`, {
            headers: RAW_REQUEST_HEADERS,
          }).then(
            (response) => response.ok,
            () => false, // Not listening yet.
          );
        },
        {
          timeoutMs: 60_000,
          intervalMs: 250,
          probeError: 'fail',
          unmet: (ready) => (ready ? undefined : 'not ready'),
        },
      )
      .catch((error: unknown) => {
        if (!(error instanceof WaitTimeoutError)) throw error;
        throw new Error(`API not ready in 60s:\n${chunks.join('')}`);
      });

    return {
      url,
      client: createApiClient(API_TOKEN, { apiUrl: url, retryDelayMs: 1 }),
      output: () => chunks.join(''),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type CredentialBody = Parameters<
  LifecycleApi['client']['credentials']['save']
>[0]['body'];

async function saveCredential(
  api: LifecycleApi,
  name: string,
  body: CredentialBody,
): Promise<void> {
  await api.client.credentials.save({
    params: { name },
    query: { overwrite: 'true' },
    body,
  });
}

async function submitVm(
  api: LifecycleApi,
  credentialName: string,
  cloudConfig: { cloudProvider: CloudType; region: string; vmType: string },
): Promise<unknown> {
  return api.client.admission.submit({
    image: IMAGE,
    cloudConfig,
    credentialName,
    workloadType: WorkloadType.Vm,
  });
}

async function listWorkloadIds(api: LifecycleApi): Promise<string[]> {
  const rows = await api.client.workloads.list({ query: {} });
  return rows.map((row) => row.id);
}

async function expectRejectedSubmission(
  api: LifecycleApi,
  credentialName: string,
  cloudConfig: { cloudProvider: CloudType; region: string; vmType: string },
  expected: {
    status: 400 | 503;
    code: 'WORKLOAD_ADMISSION_REJECTED' | 'WORKLOAD_ADMISSION_UNAVAILABLE';
    surfaces: string[];
  },
): Promise<void> {
  let failure: unknown;
  try {
    await submitVm(api, credentialName, cloudConfig);
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error(
      `Submission unexpectedly succeeded. API output:\n${api.output().slice(-4_000)}`,
    );
  }
  if (!(failure instanceof ORPCError)) {
    throw new Error(
      `Submission failed outside the declared API contract: ${errorMessage(failure)}. API output:\n${api.output().slice(-6_000)}`,
    );
  }
  expect(failure.defined).toBe(true);
  expect(failure.status).toBe(expected.status);
  expect(failure.code).toBe(expected.code);
  const message = failure.message;
  if (message === 'Internal server error') {
    throw new Error(
      `Submission failed with an undeclared 500 instead of a rejection. API output:\n${api.output().slice(-6_000)}`,
    );
  }
  for (const surface of expected.surfaces) {
    expect(message).toContain(surface);
  }
  expect(await listWorkloadIds(api)).toEqual([]);
}

const cleanups: Array<() => Promise<void>> = [];
function onCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.reverse()) {
    await cleanup().catch(() => undefined);
  }
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('credential lifecycle against fake providers', () => {
  it(journeyTitle('aws.validate-rejected'), async () => {
    const sts = await startFakeSts(AWS_REJECTED_KEY);
    onCleanup(sts.close);
    const api = await spawnLifecycleApi({ AWS_ENDPOINT_URL_STS: sts.url });
    onCleanup(api.close);

    await saveCredential(api, 'aws-rejected', {
      cloudProvider: CloudType.AWS,
      accessKeyId: AWS_REJECTED_KEY.accessKeyId,
      secretAccessKey: AWS_REJECTED_KEY.secretAccessKey,
    });
    // RFC 0047 S5: STS answers InvalidClientTokenId for a deleted key and a
    // propagating one alike, so validation backs off first, then reports the
    // key as invalid rather than asking the user to retry.
    await expectRejectedSubmission(
      api,
      'aws-rejected',
      { cloudProvider: CloudType.AWS, region: 'us-east-1', vmType: 't2.micro' },
      {
        status: 400,
        code: 'WORKLOAD_ADMISSION_REJECTED',
        surfaces: [
          `Cloud credential "aws-rejected" failed ${CloudType.AWS} validation`,
          AWS_REJECTED_KEY.errorMessage,
        ],
      },
    );
    expect(sts.calls).toContain('POST Action=GetCallerIdentity');
  });

  it(journeyTitle('azure.validate-rejected'), async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anycloud-lifecycle-az-'));
    onCleanup(() => rm(stateDir, { recursive: true, force: true }));
    const authority = await startFakeAzureAuthority(stateDir, {
      clientId: 'lifecycle-app',
      clientSecret: 'lifecycle-expired-secret',
    });
    onCleanup(authority.close);
    const api = await spawnLifecycleApi({
      AZURE_AUTHORITY_HOST: authority.url,
      AZURE_RESOURCE_MANAGER_ENDPOINT: authority.url,
      NODE_EXTRA_CA_CERTS: authority.certificatePath,
    });
    onCleanup(api.close);

    await saveCredential(api, 'azure-rejected', {
      cloudProvider: CloudType.Azure,
      applicationId: 'lifecycle-app',
      secret: 'lifecycle-expired-secret',
      subscriptionId: 'lifecycle-sub',
      directoryId: 'lifecycle-tenant',
    });
    await expectRejectedSubmission(
      api,
      'azure-rejected',
      {
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
      },
      {
        status: 400,
        code: 'WORKLOAD_ADMISSION_REJECTED',
        surfaces: [
          `Cloud credential "azure-rejected" failed ${CloudType.Azure} validation`,
          AZURE_EXPIRED_CLIENT_SECRET.body.error_description,
        ],
      },
    );
    expect(
      authority.calls.some((call) => call.includes('/oauth2/v2.0/token')),
    ).toBe(true);
    expect(
      authority.calls.some((call) => call.includes('/subscriptions/')),
    ).toBe(false);
  });

  it(journeyTitle('gcp.validate-rejected'), async () => {
    const compute = await startFakeGcpCompute({
      reject: GCP_UNAUTHENTICATED,
      clientEmail: 'rejected@lifecycle-project.iam.gserviceaccount.com',
    });
    onCleanup(compute.close);
    const api = await spawnLifecycleApi({
      GCP_API_ENDPOINT: compute.url,
      GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'lifecycle.fake',
    });
    onCleanup(api.close);

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    await saveCredential(api, 'gcp-rejected', {
      cloudProvider: CloudType.GCP,
      projectId: 'lifecycle-project',
      clientEmail: 'rejected@lifecycle-project.iam.gserviceaccount.com',
      privateKey,
    });
    await expectRejectedSubmission(
      api,
      'gcp-rejected',
      {
        cloudProvider: CloudType.GCP,
        region: 'us-east4',
        vmType: 'f1-micro',
      },
      {
        status: 503,
        code: 'WORKLOAD_ADMISSION_UNAVAILABLE',
        surfaces: [
          `${CloudType.GCP} could not conclusively validate cloud credential "gcp-rejected"`,
          GCP_UNAUTHENTICATED.body.error.status,
        ],
      },
    );
    expect(compute.calls.some((call) => call.endsWith('/instances'))).toBe(
      true,
    );
  });

  it(journeyTitle('gcp.validate-malformed-key'), async () => {
    const compute = await startFakeGcpCompute({
      reject: GCP_UNAUTHENTICATED,
      clientEmail: 'malformed@lifecycle-project.iam.gserviceaccount.com',
    });
    onCleanup(compute.close);
    const api = await spawnLifecycleApi({
      GCP_API_ENDPOINT: compute.url,
      GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'lifecycle.fake',
    });
    onCleanup(api.close);

    await saveCredential(api, 'gcp-malformed', {
      cloudProvider: CloudType.GCP,
      projectId: 'lifecycle-project',
      clientEmail: 'malformed@lifecycle-project.iam.gserviceaccount.com',
      privateKey: 'not-a-private-key',
    });
    await expectRejectedSubmission(
      api,
      'gcp-malformed',
      {
        cloudProvider: CloudType.GCP,
        region: 'us-east4',
        vmType: 'f1-micro',
      },
      {
        status: 400,
        code: 'WORKLOAD_ADMISSION_REJECTED',
        surfaces: [
          'GCP service-account private key is not a valid PEM private key',
        ],
      },
    );
    expect(compute.calls).toEqual([]);
  });

  it(journeyTitle('lambda.validate-rejected'), async () => {
    const lambda = await startFakeLambda({ reject: LAMBDA_INVALID_API_KEY });
    onCleanup(lambda.close);
    const api = await spawnLifecycleApi({ LAMBDA_API_BASE_URL: lambda.url });
    onCleanup(api.close);

    await saveCredential(api, 'lambda-rejected', {
      cloudProvider: CloudType.Lambda,
      apiKey: LAMBDA_INVALID_API_KEY.apiKey,
    });
    await expectRejectedSubmission(
      api,
      'lambda-rejected',
      {
        cloudProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
      },
      {
        status: 400,
        code: 'WORKLOAD_ADMISSION_REJECTED',
        surfaces: [
          `Cloud credential "lambda-rejected" failed ${CloudType.Lambda} validation`,
          LAMBDA_INVALID_API_KEY.body.error.message,
        ],
      },
    );
    expect(lambda.calls).toContain('GET /ssh-keys');
  });

  it(journeyTitle('aws.storage-listing'), async () => {
    const s3 = await startFakeS3({
      bucketName: 'lifecycle-fake-bucket',
      accessKeyId: AWS_REJECTED_KEY.accessKeyId,
    });
    onCleanup(s3.close);
    const api = await spawnLifecycleApi({ AWS_ENDPOINT_URL_S3: s3.url });
    onCleanup(api.close);

    await saveCredential(api, 'aws-storage', {
      cloudProvider: CloudType.AWS,
      accessKeyId: AWS_REJECTED_KEY.accessKeyId,
      secretAccessKey: AWS_REJECTED_KEY.secretAccessKey,
    });
    const listed = await api.client.bucket.list({
      params: { credentialName: 'aws-storage' },
      query: {},
    });
    expect(JSON.stringify(listed)).toContain('lifecycle-fake-bucket');
    expect(s3.calls).toContain('GET /');
  });
});
