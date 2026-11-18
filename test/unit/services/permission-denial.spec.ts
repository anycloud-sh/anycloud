import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';

// RFC 0047: a credential the provider authenticates but denies an action, on
// AWS only in some regions. Provisioning runs through the real deploy step,
// provider classifier, failure history, placement and retry scheduling; only
// the provider launch is replaced, and it throws the recorded denial.
const mocks = vi.hoisted(() => ({ provisionVMs: vi.fn(), stsSend: vi.fn() }));

vi.mock('../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock(
  '../../../src/api/services/catalog-readiness',
  async (importActual) => ({
    ...(await importActual<
      typeof import('../../../src/api/services/catalog-readiness')
    >()),
    ensureCatalogReady: vi.fn().mockResolvedValue(undefined),
  }),
);

// The candidate filter fails open without quota answers.
vi.mock('../../../src/api/services/quota/aws', () => ({
  AwsQuotaProvider: vi.fn().mockImplementation(function () {
    return {
      getEnabledRegions: vi.fn().mockRejectedValue(new Error('offline')),
      getZeroQuotaRegions: vi.fn().mockRejectedValue(new Error('offline')),
    };
  }),
}));

// The storage token mint, for a bucket on another cloud's credential.
vi.mock(
  '../../../src/api/services/provider-clients/aws',
  async (importActual) => ({
    ...(await importActual<
      typeof import('../../../src/api/services/provider-clients/aws')
    >()),
    createAwsStsClient: () => ({ send: mocks.stsSend }),
  }),
);

vi.mock('../../../src/api/services/vm-provisioner', async (importActual) => ({
  ...(await importActual<
    typeof import('../../../src/api/services/vm-provisioner')
  >()),
  provisionVMs: mocks.provisionVMs,
}));

import config, { RETRY_PROVISIONING_BASE_MS } from '../../../src/api/config';
import {
  encryptCredential,
  hashCredential,
  resolveProvisioningConfig,
} from '../../../src/api/services/cloud-config';
import {
  getCredentialSecretStore,
  getProvisioningAttemptStore,
  getWorkloadLifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { deploy } from '../../../src/api/services/workload-workflows/vm-host-startup';
import { vmHostStartupDeps } from '../../../src/api/services/job/default-runtime';
import { WorkloadReconciler } from '../../../src/api/services/workload-reconciler';
import { VMCreationError } from '../../../src/api/services/codes';
import type { ProvisionParams } from '../../../src/api/services/vm-provisioner';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { getRegionsForVMType } from '../../../src/shared/cloud-config';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudCredentials,
} from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { walkToState } from '../../helpers/workload-store.js';
import {
  AWS_EC2_REGION_DENIED,
  AWS_S3_ACCESS_DENIED,
  AWS_STS_FEDERATION_DENIED,
  AZURE_AUTHORIZATION_FAILED,
  GCP_PERMISSION_DENIED,
} from '../../integration/credentials-onboarding/personas.js';

const ADMIN_REQUEST =
  'https://anycloud.sh/reference/cli/credentials#ask-an-administrator';
const AWS_PERMISSIONS =
  'https://anycloud.sh/reference/cli/credentials#aws-permissions';
/** AWS's documentation account ID: no denial message may repeat it. */
const ACCOUNT = '123456789012';
const ACTION = AWS_EC2_REGION_DENIED.action;

/** The persona as each provider's SDK throws it, with a concrete account. */
function denial(
  persona = AWS_EC2_REGION_DENIED,
  cloud: CloudType = CloudType.AWS,
): Error {
  const error = new Error(persona.message.replaceAll('<account>', ACCOUNT));
  const { code, httpStatus } = persona;
  if (cloud === CloudType.AWS)
    return Object.assign(error, {
      name: code,
      Code: code,
      $metadata: { httpStatusCode: httpStatus },
    });
  if (cloud === CloudType.Azure)
    return Object.assign(error, { code, statusCode: httpStatus });
  return Object.assign(error, {
    code: httpStatus,
    errors: [{ message: persona.message, reason: 'forbidden' }],
  });
}

/** The reason names the action and the admin request, and no identifier. */
function expectDeniedMessage(message: string, action: string, link: string) {
  expect(message).toContain(action);
  expect(message).toContain(link);
  expect(message).not.toMatch(/123456789012|arn:|\/subscriptions\/|projects\//);
}

const CREDENTIALS: Partial<Record<CloudType, CloudCredentials>> = {
  [CloudType.AWS]: TEST_AWS_CRED,
  [CloudType.Azure]: TEST_AZURE_CRED,
  [CloudType.GCP]: TEST_GCP_CRED,
};

describe('provider permission denial', () => {
  let sshPrivateKey: string;
  let credentialId: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  /** Every launch throws this provider's denial. */
  async function deny(persona = AWS_EC2_REGION_DENIED, cloud = CloudType.AWS) {
    mocks.provisionVMs.mockReset().mockImplementation(async (...args) => {
      const params = args[1] as ProvisionParams;
      const { cloudConfig, workloadId } = params;
      // The launch fails after its attempt row exists, as in vm-provisioner.
      const ref = await getProvisioningAttemptStore().beginProvisioningAttempt(
        workloadId,
        `${workloadId}-${params.startIndex ?? 0}`,
        {
          region: cloudConfig.region,
          vmType: cloudConfig.vmType,
          credentialId,
        },
      );
      params.onAttempt?.(ref!);
      // A denied launch creates nothing, so the attempt is already over.
      await getProvisioningAttemptStore().endProvisioningAttempt(
        workloadId,
        ref!,
      );
      throw new VMCreationError(denial(persona, cloud), []);
    });
    credentialId = await upsertCredential(
      getDB(),
      hashCredential(CREDENTIALS[cloud]!),
      await encryptCredential(CREDENTIALS[cloud]!),
      cloud,
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000_000_000);
    resetPersistence();
    await deny();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createJob(
    id: string,
    vmType: string | string[],
    region?: string,
    cloud = CloudType.AWS,
  ) {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'ubuntu:24.04',
      requestedComputeProvider: cloud,
      region,
      vmType,
      spot: false,
      dockerCommand: 'echo ok',
      sshPrivateKey,
      credentialId,
    });
  }

  async function resolve(id: string) {
    const workload = await queries().getWorkload(id);
    if (!workload) throw new Error('missing workload');
    return resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );
  }

  /** One scheduler pass: place the Job, then run its deploy step there. */
  async function attempt(id: string) {
    const resolution = await resolve(id);
    if (resolution.state !== WorkloadState.Provisioning) return resolution;
    await getWorkloadLifecycle().updateState(id, WorkloadState.Provisioning);
    const workload = await queries().getWorkload(id);
    await deploy(
      vmHostStartupDeps(),
      resolution.config,
      workload!,
      resolution.credentialId,
    ).catch(() => undefined);
    return resolution;
  }

  async function lastFailure(id: string) {
    const metadata = (await eventLog().getWorkloadEvents(id))
      .map((event) => JSON.parse(event.metadata ?? '{}'))
      .findLast((entry) => entry.diagnosis);
    return metadata as { diagnosis: string; message: string };
  }

  it('0047/S9 ends a Job pinned to a denied region invalid, naming the action and region', async () => {
    await createJob('denied-pinned', 'c6i.xlarge', 'ap-south-1');
    await attempt('denied-pinned');

    expect((await queries().getWorkload('denied-pinned'))?.state).toBe(
      WorkloadState.Invalid,
    );
    const failure = await lastFailure('denied-pinned');
    expect(failure.diagnosis).toBe(CloudFailureDiagnosis.PermissionDenied);
    expectDeniedMessage(failure.message, ACTION, AWS_PERMISSIONS);
    expect(failure.message).toContain('ap-south-1');
  });

  it('0047 invariant 4: an unpinned Job never retries a denied region, for any VM type, and retries at once', async () => {
    const id = 'denied-unpinned';
    await createJob(id, ['m6i.xlarge', 'c6i.xlarge']);
    const first = await attempt(id);
    if (first.state !== WorkloadState.Provisioning) throw new Error('unplaced');
    const denied = first.config.region!;
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );
    // Failing over is automatic, so it asks no one for anything.
    expect((await lastFailure(id)).message).toBeUndefined();

    // No backoff: the denied region is never tried again, so waiting cannot help.
    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(),
      random: () => 1,
    });
    await reconciler.discoverNow();
    const entry = reconciler
      .entriesForTests()
      .find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({ kind: 'retry-launch' });
    expect(entry?.retryDueAt).toBe(Date.now());

    await walkToState(id, WorkloadState.Queued);
    const next = await resolve(id);
    expect(next.state).toBe(WorkloadState.Provisioning);
    if (next.state !== WorkloadState.Provisioning) return;
    expect(next.config.region).not.toBe(denied);
    expect(next.eligibleRegions).not.toContain(denied);

    // Another Job on the same credential keeps its own history.
    await createJob('other-job', ['m6i.xlarge', 'c6i.xlarge']);
    const other = await resolve('other-job');
    expect(
      other.state === WorkloadState.Provisioning && other.config.region,
    ).toBe(denied);
  });

  it('0047/S9 ends an unpinned Job invalid once every region offering it is denied, naming the action', async () => {
    const id = 'denied-everywhere';
    await createJob(id, 'c6i.xlarge');
    const regions = getRegionsForVMType('c6i.xlarge', CloudType.AWS, false);
    for (let pass = 0; pass <= regions.length; pass++) {
      const state = (await queries().getWorkload(id))?.state;
      if (state === WorkloadState.Invalid) break;
      if (state === WorkloadState.Retrying)
        await walkToState(id, WorkloadState.Queued);
      const resolution = await attempt(id);
      if (resolution.state === WorkloadState.Invalid) {
        expectDeniedMessage(resolution.message, ACTION, AWS_PERMISSIONS);
        expect(pass).toBe(regions.length);
        return;
      }
    }
    throw new Error('the Job never became invalid by region denial');
  });

  it('0047 a capacity failure after regional denials waits the first backoff, not one grown by the denials', async () => {
    const id = 'denied-then-capacity';
    await createJob(id, 'c6i.xlarge');
    for (let denied = 0; denied < 4; denied++) {
      if ((await queries().getWorkload(id))?.state === WorkloadState.Retrying)
        await walkToState(id, WorkloadState.Queued);
      await attempt(id);
    }
    // The next region allows the launch but has no capacity right now.
    mocks.provisionVMs.mockImplementationOnce(async () => {
      throw new VMCreationError(
        Object.assign(new Error('Insufficient capacity.'), {
          name: 'InsufficientInstanceCapacity',
          Code: 'InsufficientInstanceCapacity',
        }),
        [],
      );
    });
    await walkToState(id, WorkloadState.Queued);
    await attempt(id);
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Retrying,
    );

    const reconciler = new WorkloadReconciler({
      reconcile: vi.fn(),
      random: () => 1,
    });
    await reconciler.discoverNow();
    const entry = reconciler
      .entriesForTests()
      .find((candidate) => candidate.id === id);
    expect(entry?.retryDueAt).toBe(Date.now() + RETRY_PROVISIONING_BASE_MS);
  });

  // Lambda is excluded: its API keys are account-wide, with no per-action
  // permission to deny (owner decision, 2026-10-09).
  it.each([
    [CloudType.AWS, 'c6i.xlarge', AWS_S3_ACCESS_DENIED, AWS_PERMISSIONS],
    [
      CloudType.Azure,
      'Standard_D2s_v5',
      AZURE_AUTHORIZATION_FAILED,
      ADMIN_REQUEST,
    ],
    [CloudType.GCP, 'e2-standard-2', GCP_PERMISSION_DENIED, ADMIN_REQUEST],
  ] as const)(
    '0047/S6 ends an unpinned %s Job invalid at its first non-regional denial, naming the action',
    async (cloud, vmType, persona, link) => {
      await deny(persona, cloud);
      const id = `denied-${cloud.toLowerCase()}`;
      await createJob(id, vmType, undefined, cloud);
      const placed = await attempt(id);

      // Another region cannot grant the action, so there is no failover.
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Invalid,
      );
      expect(mocks.provisionVMs).toHaveBeenCalledTimes(1);
      const failure = await lastFailure(id);
      expect(failure.diagnosis).toBe(CloudFailureDiagnosis.PermissionDenied);
      expectDeniedMessage(failure.message, persona.action, link);
      if (placed.state !== WorkloadState.Provisioning)
        throw new Error('unplaced');
      expect(failure.message).toContain(placed.config.region);
    },
  );

  it('0047/S6 names the bucket credential when its own mint is denied, on another cloud', async () => {
    const storage = await upsertCredential(
      getDB(),
      hashCredential(TEST_AWS_CRED),
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    mocks.stsSend.mockRejectedValue(denial(AWS_STS_FEDERATION_DENIED));
    await deny(AZURE_AUTHORIZATION_FAILED, CloudType.Azure);
    const id = 'denied-storage-mint';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'ubuntu:24.04',
      requestedComputeProvider: CloudType.Azure,
      vmType: 'Standard_D2s_v5',
      spot: false,
      dockerCommand: 'echo ok',
      sshPrivateKey,
      credentialId,
      outputBucket: 'results',
      outputStorageCredentialId: storage,
      outputStorageRegion: 'us-east-1',
    });
    const resolution = await resolve(id);
    if (resolution.state !== WorkloadState.Provisioning)
      throw new Error('unplaced');
    await walkToState(id, WorkloadState.Downloading);
    await deploy(
      vmHostStartupDeps(),
      resolution.config,
      (await queries().getWorkload(id))!,
      resolution.credentialId,
      { resumeFrom: WorkloadState.Syncing },
    ).catch(() => undefined);

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Invalid,
    );
    const failure = await lastFailure(id);
    expect(failure.diagnosis).toBe(CloudFailureDiagnosis.PermissionDenied);
    expectDeniedMessage(
      failure.message,
      AWS_STS_FEDERATION_DENIED.action,
      AWS_PERMISSIONS,
    );
    expect(failure.message).toContain('output bucket');
  });
});
