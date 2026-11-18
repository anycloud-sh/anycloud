import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createCheckpointStorageProvider,
  createComputeProvider,
  createApiOwnershipProvider,
  createCatalogOverlayProvider,
  createInputStorageProvider,
  createOutputStorageProvider,
  encryptCredential,
  loadBillingIdentity,
  loadWorkloadConfigs,
  resolveRuntimeBucketStorageRegions,
  resolveProvisioningConfig,
  validateStorageCapabilities,
  validateComputeCapabilities,
  validateComputeCandidateConfig,
  validateWorkloadStorageRequest,
} from '../../../src/api/services/cloud-config.js';
import config from '../../../src/api/config.js';
import {
  getCredentialSecretStore,
  resetPersistence,
  getProvisioningAttemptStore as ledger,
  getWorkloadQueryStore as queryStore,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import type { VmCostIdentity } from '../../../src/api/services/cost-calculation/contracts.js';
import { AWS } from '../../../src/api/services/gateways/aws.js';
import { GCP } from '../../../src/api/services/gateways/gcp.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
  DiskTier,
  AWSCreds,
  LambdaCreds,
} from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  CatalogUnavailableError,
  InvalidAnycloudConfigError,
} from '../../../src/shared/errors.js';
import * as catalogReadiness from '../../../src/api/services/catalog-readiness.js';
import {
  TEST_AWS_CRED,
  TEST_GCP_CRED,
  TEST_AZURE_CRED,
} from '../helpers/fixtures.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { internalsOf } from '../helpers/internals';
import {
  CandidateRegionAvailability,
  candidateRegionKey,
  createCloudCompute,
} from '../../../src/api/services/gateways/cloud.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { provisionTestVm } from '../../helpers/workload-store.js';

const awsCompute: CloudConfig = {
  cloudProvider: CloudType.AWS,
  region: 'us-east-1',
  credentials: TEST_AWS_CRED,
};

const allRuntimeStorageRoles = ['input', 'output', 'checkpoint'] as const;
const runtimeStorageProviders = {
  input: createInputStorageProvider,
  output: createOutputStorageProvider,
  checkpoint: createCheckpointStorageProvider,
};

const TEST_AWS_SESSION_CRED = {
  ...TEST_AWS_CRED,
  sessionToken: 'source-session-token',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createApiOwnershipProvider', () => {
  it('preserves an unknown GCP zone for exact instance discovery', async () => {
    const discoverInstanceZone = vi
      .spyOn(GCP.prototype as any, 'discoverInstanceZone')
      .mockResolvedValue(null);
    const provider = createApiOwnershipProvider({
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'e2-micro',
      credentials: TEST_GCP_CRED,
    });

    await expect(
      provider?.backfillExactVM({
        cloudId: 'legacy-vm',
        apiIdentity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ownerKind: 'workload',
        ownerId: 'workload-1',
        userId: 'user-1',
      }),
    ).resolves.toBe('missing');
    expect(discoverInstanceZone).toHaveBeenCalledWith('legacy-vm');
  });
});

describe('observed VM compute construction', () => {
  it('keeps a missing GCP attempt zone unknown for authoritative exact-name discovery', async () => {
    const discover = vi
      .spyOn(GCP.prototype as any, 'discoverInstanceZone')
      .mockResolvedValue('us-central1-f');
    const provider = createComputeProvider(
      {
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'e2-micro',
        credentials: TEST_GCP_CRED,
      },
      'observed-vm',
    );
    const controller = new AbortController();

    await expect(
      provider.observeVMReleaseOnce('legacy-native-vm', {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ state: 'present' });
    expect(discover).toHaveBeenCalledExactlyOnceWith(
      'legacy-native-vm',
      controller.signal,
    );
  });
});

describe('createCatalogOverlayProvider', () => {
  it('exposes the account catalog role only for Azure', () => {
    expect(
      createCatalogOverlayProvider({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_D2s_v5',
        credentials: TEST_AZURE_CRED,
      })?.cloud,
    ).toBe(CloudType.Azure);
    expect(createCatalogOverlayProvider(awsCompute)).toBeNull();
  });
});

describe('same-cloud storage regions', () => {
  it('uses storageRegion for same-cloud storage without changing compute region', () => {
    const cloudConfig: CloudConfig = {
      ...awsCompute,
      region: 'eu-south-1',
      inputBucket: 'input-bucket',
      inputStorageRegion: 'us-east-1',
    };

    const compute = createComputeProvider(cloudConfig);
    const inputStorage = createInputStorageProvider(cloudConfig);

    expect(compute.region).toBe('eu-south-1');
    expect(inputStorage.region).toBe('us-east-1');
  });

  it('keeps input/output/checkpoint bucket regions independent at runtime', async () => {
    const bucketRegions: Record<string, string> = {
      'input-bucket': 'us-east-1',
      'output-bucket': 'us-west-2',
      'checkpoint-bucket': 'eu-west-1',
    };
    vi.spyOn(
      internalsOf<AwsInternals>(AWS.prototype),
      'getBucketRegion',
    ).mockImplementation((bucketName) =>
      Promise.resolve(bucketRegions[bucketName]),
    );

    const resolved = await resolveRuntimeBucketStorageRegions(
      {
        ...awsCompute,
        region: 'eu-south-1',
        inputBucket: 'input-bucket',
        outputBucket: 'output-bucket',
        spot: true,
      },
      'checkpoint-bucket',
      allRuntimeStorageRoles,
      runtimeStorageProviders,
    );

    expect(resolved.region).toBe('eu-south-1');
    expect(resolved.inputStorageRegion).toBe('us-east-1');
    expect(resolved.outputStorageRegion).toBe('us-west-2');
    expect(resolved.checkpointStorageRegion).toBe('eu-west-1');
    expect(createInputStorageProvider(resolved).region).toBe('us-east-1');
    expect(createOutputStorageProvider(resolved).region).toBe('us-west-2');
    expect(createCheckpointStorageProvider(resolved).region).toBe('eu-west-1');
  });
});

describe('createCheckpointStorageProvider', () => {
  it('falls back to compute credentials when no checkpoint credentials are set', () => {
    // This is the behavior every existing caller relies on (no caller populates
    // checkpointStorageCredentials yet), so it must stay byte-compatible.
    const provider = createCheckpointStorageProvider(awsCompute);
    expect(provider.type).toBe(CloudType.AWS);
  });

  it('ignores output storage credentials (checkpoint is its own axis)', () => {
    const provider = createCheckpointStorageProvider({
      ...awsCompute,
      outputStorageCredentials: TEST_AZURE_CRED,
      outputStorageRegion: 'eastus',
    });
    expect(provider.type).toBe(CloudType.AWS);
  });

  it('routes checkpointStorageCredentials into the storage provider', () => {
    // Cross-cloud storage requires an explicit region — the throw proves the
    // checkpoint creds (not the compute creds) were selected.
    expect(() =>
      createCheckpointStorageProvider({
        ...awsCompute,
        checkpointStorageCredentials: TEST_GCP_CRED,
      }),
    ).toThrow(/storageRegion is required/);
  });
});

describe('loadBillingIdentity', () => {
  const firstVm = {
    workload_id: 'billing-identity',
    credential_id: 'vm-account',
    region: 'us-east-1',
    vm_type: 't3.medium',
  };
  const credentials: {
    stored: CloudCredentials;
    expected: VmCostIdentity['credentials'];
  }[] = [
    {
      stored: TEST_AWS_SESSION_CRED,
      expected: {
        accessKeyId: TEST_AWS_CRED.accessKeyId,
        secretAccessKey: TEST_AWS_CRED.secretAccessKey,
        sessionToken: 'source-session-token',
      },
    },
    {
      stored: TEST_AZURE_CRED,
      expected: {
        applicationId: TEST_AZURE_CRED.applicationId,
        secret: TEST_AZURE_CRED.secret,
        directoryId: TEST_AZURE_CRED.directoryId,
        subscriptionId: TEST_AZURE_CRED.subscriptionId,
      },
    },
    {
      stored: { ...TEST_GCP_CRED, billingExportDataset: 'fixture.billing' },
      // Keep the existing extractor's field contract; this projection does
      // not independently expand the GCP credential shape.
      expected: {
        projectId: TEST_GCP_CRED.projectId,
        privateKey: TEST_GCP_CRED.privateKey,
        clientEmail: TEST_GCP_CRED.clientEmail,
      },
    },
    {
      stored: { cloudProvider: CloudType.Lambda, apiKey: 'lambda-key' },
      expected: { apiKey: 'lambda-key' },
    },
  ];

  beforeEach(async () => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
    await upsertCredential(
      getDB(),
      'workload-account',
      await encryptCredential(TEST_AZURE_CRED),
      CloudType.Azure,
    );
    await upsertCredential(
      getDB(),
      'vm-account',
      await encryptCredential(TEST_AWS_SESSION_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: firstVm.workload_id,
      userId: 'billing-test-user',
      workloadType: 'job',
      requestedComputeProvider: CloudType.Azure,
      image: 'fixture:synthetic',
      dockerCommand: 'never-executed',
      sshPrivateKey: 'synthetic-unused-key',
      credentialId: 'workload-account',
      env: { BILLING_UNUSED: 'payload' },
      githubToken: 'synthetic-unused-token',
    });
  });

  it.each(credentials)(
    'uses the selected $stored.cloudProvider credential and its existing field shape',
    async ({ stored, expected }) => {
      const id = 'selected-' + stored.cloudProvider;
      await upsertCredential(
        getDB(),
        id,
        await encryptCredential(stored),
        stored.cloudProvider,
      );
      await expect(
        loadBillingIdentity({ ...firstVm, credential_id: id }),
      ).resolves.toEqual({
        cloudProvider: stored.cloudProvider,
        credentials: expected,
      });
    },
  );

  it('reads only selected identity and structural metadata without full VM aggregates', async () => {
    const queries = vi.spyOn(getDB(), 'query');
    const identity = await loadBillingIdentity(firstVm);
    expect(identity).toEqual({
      cloudProvider: CloudType.AWS,
      credentials: credentials[0].expected,
    });
    expect(queries).toHaveBeenCalledOnce();
    const sql = queries.mock.calls[0][0];
    expect(sql).not.toMatch(/\b(?:d|s)\.\*|\bSUM\s*\(|\bGROUP\s+BY\b/i);
    for (const row of await queries.mock.results[0].value) {
      for (const column of [
        'ssh_private_key',
        'registry_username',
        'registry_token',
        'env',
        'docker_options',
        'vm_type',
        'gpu_type',
      ]) {
        expect(row).not.toHaveProperty(column);
      }
    }
  });

  it.each([null, 'missing-account'])(
    'does not substitute the workload credential for explicit %s',
    async (credentialId) => {
      await expect(
        loadBillingIdentity({ ...firstVm, credential_id: credentialId }),
      ).resolves.toBeNull();
    },
  );

  it.each([CloudType.Local])(
    'preserves the credentialless %s fallback',
    async (provider) => {
      await getDB().query(
        'UPDATE workloads SET requested_compute_provider=? WHERE id=?',
        [provider, firstVm.workload_id],
      );
      await expect(
        loadBillingIdentity({ ...firstVm, credential_id: null }),
      ).resolves.toEqual({ cloudProvider: provider, credentials: undefined });
    },
  );

  it('reuses VM-provider fallback without borrowing that VM credential', async () => {
    await getDB().query(
      'UPDATE workloads SET requested_compute_provider=NULL WHERE id=?',
      [firstVm.workload_id],
    );
    await provisionTestVm(
      firstVm.workload_id,
      { cloudId: 'fallback-vm', ip: '192.0.2.1' },
      { credentialId: firstVm.credential_id },
    );
    await expect(
      ledger().getWorkloadBillingIdentity(firstVm.workload_id, null),
    ).resolves.toEqual({ cloudProvider: CloudType.AWS, encryptedData: null });
    await expect(
      loadBillingIdentity({ ...firstVm, credential_id: null }),
    ).resolves.toBeNull();
  });

  it('skips a workload that disappeared after discovery', async () => {
    await expect(
      loadBillingIdentity({ ...firstVm, workload_id: 'missing-owner' }),
    ).resolves.toBeNull();
  });

  it('rejects missing spec ownership without falling back to another identity', async () => {
    await getDB().query('DROP TRIGGER container_specs_no_detach');
    await getDB().query('DELETE FROM container_specs WHERE workload_id=?', [
      firstVm.workload_id,
    ]);
    await expect(loadBillingIdentity(firstVm)).rejects.toThrow(
      'container spec ownership is incomplete',
    );
  });

  it.each(['', 'not-valid-ciphertext'])(
    'rejects unusable selected credential bytes %j',
    async (encrypted) => {
      await getDB().query(
        'UPDATE credentials SET encrypted_data=? WHERE id=?',
        [encrypted, firstVm.credential_id],
      );
      await expect(loadBillingIdentity(firstVm)).rejects.toThrow();
    },
  );

  it('uses the deleted node pool attempt identity without re-reading the node pool', async () => {
    await expect(
      loadBillingIdentity({
        ...firstVm,
        workload_id: null,
        node_pool_id: 'no-longer-retained-node-pool',
      }),
    ).resolves.toEqual({
      cloudProvider: CloudType.AWS,
      credentials: credentials[0].expected,
    });
  });

  it.each([
    { node_pool_id: 'deleted-node-pool' },
    { cluster_id: 'destroyed-installation' },
  ])(
    'uses the resource-scoped attempt identity for %j without re-reading the owner',
    async (owner) => {
      await expect(
        loadBillingIdentity({ ...firstVm, workload_id: null, ...owner }),
      ).resolves.toEqual({
        cloudProvider: CloudType.AWS,
        credentials: credentials[0].expected,
      });
    },
  );

  it.each([
    { region: null },
    { vm_type: null },
    { credential_id: null },
    { credential_id: 'missing-account' },
    { node_pool_id: null },
  ])('preserves node pool guards for %j', async (missing) => {
    await expect(
      loadBillingIdentity({
        ...firstVm,
        workload_id: null,
        node_pool_id: 'deleted-node-pool',
        ...missing,
      }),
    ).resolves.toBeNull();
  });
});

describe('Service checkpoint storage identity', () => {
  beforeEach(() => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
  });

  it('loads separate checkpoint credentials for Jobs and all Services', async () => {
    await upsertCredential(
      getDB(),
      'compute-aws',
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await upsertCredential(
      getDB(),
      'checkpoint-gcp',
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );

    const workloads = [
      {
        id: 'service-checkpoint-identity',
        workloadType: 'service' as const,
        image: 'alpine:latest',
      },
      {
        id: 'hosted-api-checkpoint-identity',
        workloadType: 'service' as const,
        image: `${packageJson.apiImage}:0.0.0-test`,
      },
      {
        id: 'job-checkpoint-identity',
        workloadType: 'job' as const,
        image: 'alpine:latest',
      },
    ];
    for (const workload of workloads) {
      await createWorkload(getDB(), {
        id: workload.id,
        userId: 'test-user',
        workloadType: workload.workloadType,
        image: workload.image,
        dockerCommand: '',
        sshPrivateKey: 'ssh-test-key',
        credentialId: 'compute-aws',
        checkpointStorageCredentialId: 'checkpoint-gcp',
        checkpointStorageRegion: 'us-central1',
        checkpointBucket: 'durable-state',
        vmType: 't3.small',
        spot: false,
      });
    }

    const service = await queryStore().getWorkload(
      'service-checkpoint-identity',
    );
    const hostedApi = await queryStore().getWorkload(
      'hosted-api-checkpoint-identity',
    );
    const job = await queryStore().getWorkload('job-checkpoint-identity');
    if (!service || !hostedApi || !job) {
      throw new Error('missing test workload');
    }

    const serviceConfig = await loadWorkloadConfigs(service);
    const hostedApiConfig = await loadWorkloadConfigs(hostedApi);
    const jobConfig = await loadWorkloadConfigs(job);

    expect(serviceConfig?.checkpointStorageCredentials).toEqual(TEST_GCP_CRED);
    expect(hostedApiConfig?.checkpointStorageCredentials).toEqual(
      TEST_GCP_CRED,
    );
    expect(jobConfig?.checkpointStorageCredentials).toEqual(TEST_GCP_CRED);
  });
});

describe("a VM Job's nested virtualization", () => {
  beforeEach(() => resetPersistence());

  it('reaches the cloud config only when the Job asked for it', async () => {
    config.cipherKey = 'a'.repeat(64);
    await upsertCredential(
      getDB(),
      'compute-gcp',
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );
    for (const [id, requireNestedVirtualization] of [
      ['plain-job', false],
      ['kvm-job', true],
    ] as const) {
      await createWorkload(getDB(), {
        id,
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        dockerCommand: '',
        sshPrivateKey: 'ssh-test-key',
        credentialId: 'compute-gcp',
        vmType: 'n2-standard-4',
        requireNestedVirtualization,
      });
    }
    const plain = await queryStore().getWorkload('plain-job');
    const kvm = await queryStore().getWorkload('kvm-job');
    expect((await loadWorkloadConfigs(plain!))?.nestedVirtualization).toBe(
      undefined,
    );
    expect((await loadWorkloadConfigs(kvm!))?.nestedVirtualization).toBe(true);
  });
});

describe('validateStorageCapabilities', () => {
  // The capability ("can this storage mint scoped cross-cloud creds?") is the
  // branded CloudStorage scoped-token capability (canMintScopedStorageToken),
  // determined by constructing the storage provider, not a hardcoded cloud or a
  // capability flag.

  it('accepts an AWS cross-cloud input storage credential', () => {
    expect(() =>
      validateStorageCapabilities({
        ...awsCompute,
        inputBucket: 'in',
        inputStorageCredentials: TEST_AWS_CRED,
        inputStorageRegion: 'us-east-1',
      }),
    ).not.toThrow();
  });

  it('rejects AWS cross-cloud input storage credentials with a session token', () => {
    expect(() =>
      validateStorageCapabilities({
        ...awsCompute,
        inputBucket: 'in',
        inputStorageCredentials: TEST_AWS_SESSION_CRED,
        inputStorageRegion: 'us-east-1',
      }),
    ).toThrow('GetFederationToken requires long-term IAM user credentials');
  });

  it('rejects AWS cross-cloud output storage credentials with a session token', () => {
    expect(() =>
      validateStorageCapabilities({
        ...awsCompute,
        outputBucket: 'out',
        outputStorageCredentials: TEST_AWS_SESSION_CRED,
        outputStorageRegion: 'us-east-1',
      }),
    ).toThrow('GetFederationToken requires long-term IAM user credentials');
  });

  it('rejects AWS cross-cloud checkpoint storage credentials with a session token', () => {
    expect(() =>
      validateStorageCapabilities({
        ...awsCompute,
        checkpointStorageCredentials: TEST_AWS_SESSION_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
    ).toThrow('GetFederationToken requires long-term IAM user credentials');
  });

  it('rejects a non-AWS (GCP) cross-cloud input storage credential', () => {
    expect(() =>
      validateStorageCapabilities({
        ...awsCompute,
        inputBucket: 'in',
        inputStorageCredentials: TEST_GCP_CRED,
        inputStorageRegion: 'us-central1',
      }),
    ).toThrow('requires credentials that can mint scoped bucket-sync tokens');
  });

  it('rejects a non-AWS (GCP) cross-cloud checkpoint storage credential for a VM Job, and accepts it on the pool path (RFC 0043 D-s3gcs)', () => {
    const config = {
      ...awsCompute,
      checkpointStorageCredentials: TEST_GCP_CRED,
      checkpointStorageRegion: 'us-central1',
    };
    expect(() => validateStorageCapabilities(config)).toThrow(
      'requires credentials that can mint scoped bucket-sync tokens',
    );
    expect(() => validateStorageCapabilities(config, false)).not.toThrow();
  });
});

describe('validateComputeCandidateConfig', () => {
  it('validates bucket names against explicit storage credentials when present', () => {
    const azureWithAwsStorage: CloudConfig = {
      cloudProvider: CloudType.Azure,
      credentials: TEST_AZURE_CRED,
      region: 'eastus',
      vmType: 'Standard_D2s_v5',
      inputBucket: 'valid.name',
      inputStorageCredentials: TEST_AWS_CRED,
      inputStorageRegion: 'us-east-1',
    };

    expect(() =>
      validateComputeCandidateConfig(
        azureWithAwsStorage,
        createComputeProvider(azureWithAwsStorage),
      ),
    ).not.toThrow();
  });

  it('0044/S23: admits a Spot pool without restart, and refuses Spot on Lambda', () => {
    const spot: CloudConfig = {
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: 'us-east-1',
      vmType: 't3.large',
      spot: true,
    };
    const stopOnEvict = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      spotLaunch: true,
      stoppedVmObservation: { observeStoppedVm: vi.fn() },
    });

    expect(() =>
      validateComputeCandidateConfig(spot, stopOnEvict),
    ).not.toThrow();
    // A VM spot Job still needs restart.
    expect(() => validateComputeCapabilities(spot, stopOnEvict)).toThrow(
      'AWS does not support spot instances',
    );
    for (const cloudProvider of [CloudType.GCP, CloudType.Azure]) {
      const config = {
        ...spot,
        cloudProvider,
        credentials:
          cloudProvider === CloudType.GCP ? TEST_GCP_CRED : TEST_AZURE_CRED,
      };
      expect(() =>
        validateComputeCandidateConfig(config, createComputeProvider(config)),
      ).not.toThrow();
    }
    const lambda: CloudConfig = {
      cloudProvider: CloudType.Lambda,
      credentials: new LambdaCreds(),
      region: 'us-east-1',
      spot: true,
    };
    expect(() =>
      validateComputeCandidateConfig(lambda, createComputeProvider(lambda)),
    ).toThrow('Lambda does not support spot instances');
  });
});

/** The private reads these tests stub behind the public resolution paths. */
type AwsInternals = {
  getBucketRegion: AWS['getBucketRegion'];
  runCandidatePreflight: AWS['runCandidatePreflight'];
};
type GcpInternals = {
  runCandidatePreflight: GCP['runCandidatePreflight'];
};

describe('compute runtime config resolution', () => {
  beforeEach(() => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
    vi.spyOn(
      internalsOf<AwsInternals>(AWS.prototype),
      'runCandidatePreflight',
    ).mockImplementation(async (candidates) => ({
      enabled: new Set(candidates.map((candidate) => candidate.region)),
      zeroByVmType: new Map(),
      unknownByVmType: new Map(),
      complete: true,
    }));
    vi.spyOn(
      internalsOf<GcpInternals>(GCP.prototype),
      'runCandidatePreflight',
    ).mockImplementation(async (candidates) => ({
      availability: new Map(
        candidates.map((candidate) => [
          candidateRegionKey(candidate),
          CandidateRegionAvailability.Verified,
        ]),
      ),
      complete: true,
    }));
  });

  async function saveCredential(id: string, credential: CloudCredentials) {
    await upsertCredential(
      getDB(),
      id,
      await encryptCredential(credential),
      credential.cloudProvider,
    );
  }

  it('rejects a remote workload without a selected credential', async () => {
    await createWorkload(getDB(), {
      id: 'remote-missing-credential',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: null,
      vmType: 't3.small',
      spot: false,
    });
    const workload = await queryStore().getWorkload(
      'remote-missing-credential',
    );
    if (!workload) throw new Error('missing remote-missing-credential');

    await expect(
      resolveProvisioningConfig(
        workload,
        queryStore(),
        getCredentialSecretStore(),
      ),
    ).resolves.toEqual({
      state: WorkloadState.Invalid,
      message: 'Missing credentials for remote workload',
    });
  });

  it('keeps selected-credential workloads queued while their catalog is unavailable', async () => {
    vi.spyOn(catalogReadiness, 'ensureCatalogReady').mockRejectedValueOnce(
      new CatalogUnavailableError(
        'Catalog for AWS is temporarily unavailable; retry shortly.',
      ),
    );
    await saveCredential('aws-only', TEST_AWS_CRED);
    await createWorkload(getDB(), {
      id: 'selected-catalog-unavailable',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'aws-only',
      vmType: 't3.small',
      spot: false,
    });
    const workload = await queryStore().getWorkload(
      'selected-catalog-unavailable',
    );
    if (!workload) throw new Error('missing selected-catalog-unavailable');

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      getCredentialSecretStore(),
    );

    expect(resolution.state).toBe(WorkloadState.Queued);
    if (resolution.state !== WorkloadState.Queued) {
      throw new Error(`expected queued, got ${resolution.state}`);
    }
    expect(resolution.message).toContain('Catalog for AWS');
  });

  it('resolves an omitted stored disk tier before target selection', async () => {
    await saveCredential('aws-default-tier', TEST_AWS_CRED);
    await createWorkload(getDB(), {
      id: 'aws-default-tier',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'aws-default-tier',
      region: 'us-east-1',
      vmType: 't3.small',
      spot: false,
    });
    const workload = await queryStore().getWorkload('aws-default-tier');
    if (!workload) throw new Error('missing aws-default-tier');
    expect(workload.diskTier).toBeNull();

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      getCredentialSecretStore(),
    );

    expect(resolution.state).toBe(WorkloadState.Provisioning);
    if (resolution.state !== WorkloadState.Provisioning) {
      throw new Error(`expected provisioning, got ${resolution.state}`);
    }
    expect(resolution.config.diskTier).toBe(DiskTier.High);
  });

  it('resolves credentialless Local compute without a saved credential', async () => {
    await createWorkload(getDB(), {
      id: 'local-credentialless',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: null,
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      spot: false,
    });
    const workload = await queryStore().getWorkload('local-credentialless');
    if (!workload) throw new Error('missing local-credentialless');

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      getCredentialSecretStore(),
    );

    expect(resolution.state).toBe(WorkloadState.Provisioning);
    if (resolution.state !== WorkloadState.Provisioning) {
      throw new Error(`expected provisioning, got ${resolution.state}`);
    }
    expect(resolution.credentialId).toBeUndefined();
    expect(resolution.config.cloudProvider).toBe(CloudType.Local);
    expect(resolution.config.region).toBe('local');
    expect(resolution.config.vmType).toBe('local');
  });

  it('loads explicit storage credentials for credentialless Local compute', async () => {
    await upsertCredential(
      getDB(),
      'local-storage-cred',
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: 'local-credentialless-storage',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: null,
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      spot: false,
      inputBucket: 'input-bucket',
      inputStorageCredentialId: 'local-storage-cred',
      inputStorageRegion: 'us-east-1',
    });
    const workload = await queryStore().getWorkload(
      'local-credentialless-storage',
    );
    if (!workload) throw new Error('missing local-credentialless-storage');

    const credentials = getCredentialSecretStore();
    resetPersistence();

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      credentials,
    );

    expect(resolution.state).toBe(WorkloadState.Provisioning);
    if (resolution.state !== WorkloadState.Provisioning) {
      throw new Error(`expected provisioning, got ${resolution.state}`);
    }
    expect(resolution.config.inputStorageCredentials).toEqual(TEST_AWS_CRED);
    expect(resolution.config.inputStorageRegion).toBe('us-east-1');
  });

  it('marks selected-region array targets invalid when no candidate exists there', async () => {
    await saveCredential('gcp-only', TEST_GCP_CRED);
    await createWorkload(getDB(), {
      id: 'selected-region-miss',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'gcp-only',
      region: 'us-east-1',
      vmType: ['e2-standard-2'],
      spot: false,
    });
    const workload = await queryStore().getWorkload('selected-region-miss');
    if (!workload) throw new Error('missing selected-region-miss');

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      getCredentialSecretStore(),
    );

    expect(resolution.state).toBe(WorkloadState.Invalid);
    if (resolution.state !== WorkloadState.Invalid) {
      throw new Error(`expected invalid, got ${resolution.state}`);
    }
    expect(resolution.message).toContain(
      'Region "us-east-1" does not offer VM type "e2-standard-2" on GCP',
    );
  });

  it('keeps a region-unpinned unknown target queued for catalog refresh', async () => {
    await saveCredential('gcp-only', TEST_GCP_CRED);
    await createWorkload(getDB(), {
      id: 'region-unpinned-catalog-miss',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      dockerCommand: '',
      sshPrivateKey: 'ssh-test-key',
      credentialId: 'gcp-only',
      vmType: ['definitely-not-a-real-vm-type'],
      spot: false,
    });
    const workload = await queryStore().getWorkload(
      'region-unpinned-catalog-miss',
    );
    if (!workload) throw new Error('missing region-unpinned-catalog-miss');

    const resolution = await resolveProvisioningConfig(
      workload,
      queryStore(),
      getCredentialSecretStore(),
    );

    expect(resolution.state).toBe(WorkloadState.Queued);
    if (resolution.state !== WorkloadState.Queued) {
      throw new Error(`expected queued, got ${resolution.state}`);
    }
    expect(resolution.message).toContain('waiting for catalog refresh');
  });
});
describe('validateComputeCapabilities', () => {
  it('does not throw for AWS with spot (preemptible)', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
        spot: true,
      }),
    ).not.toThrow();
  });

  it('throws when spot requested on Lambda (not preemptible)', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: true,
      }),
    ).toThrow('Lambda does not support spot instances');
  });

  it('throws InvalidAnycloudConfigError (→ HTTP 400) for capability violations', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: true,
      }),
    ).toThrow(InvalidAnycloudConfigError);
  });

  it('accepts a high disk tier without a machine-family registry gate', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.GCP,
        credentials: TEST_GCP_CRED,
        region: 'us-east4',
        availabilityZone: 'c',
        vmType: 'future-standard-4',
        diskTier: DiskTier.High,
      }),
    ).not.toThrow();
  });

  it('still rejects disk tier on an unsupported provider', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        diskTier: DiskTier.High,
      }),
    ).toThrow('Lambda does not support --disk-tier');
  });

  it('accepts disk tier on AWS compute', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.AWS,
        credentials: TEST_AWS_CRED,
        region: 'us-east-1',
        vmType: 'm5.large',
        diskTier: DiskTier.High,
      }),
    ).not.toThrow();
  });

  it('accepts disk tier on Azure compute', () => {
    expect(() =>
      validateComputeCapabilities({
        cloudProvider: CloudType.Azure,
        credentials: TEST_AZURE_CRED,
        region: 'eastus',
        vmType: 'Standard_NC6s_v3',
        diskTier: DiskTier.High,
      }),
    ).not.toThrow();
  });
});

describe('validateWorkloadStorageRequest', () => {
  it('does not throw for Lambda spot with checkpoint storage credentials', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: true,
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
    ).not.toThrow();
  });

  it('throws when spot lacks checkpoint storage credentials and native storage identity', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: true,
      }),
    ).toThrow(
      'Lambda does not provide storage. Set checkpointStorageCredentials',
    );
  });

  it('throws when checkpoint storage credentials are set without region', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: true,
        checkpointStorageCredentials: TEST_AWS_CRED,
      }),
    ).toThrow('checkpointStorageRegion is required');
  });

  it('accepts checkpoint storage credentials without a configured checkpoint target', () => {
    // Saved/config-file storage defaults may exist before a workload chooses
    // an explicit bucket. Preserve that harmless shape.
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        spot: false,
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
    ).not.toThrow();
  });

  it('requires storage credentials for an explicit checkpoint bucket when compute has no native storage identity', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        checkpointBucket: 'durable-state',
      }),
    ).toThrow(
      'Lambda does not provide storage. Set checkpointStorageCredentials',
    );
  });

  it('accepts an explicit checkpoint bucket with cross-cloud storage credentials', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        checkpointBucket: 'durable-state',
        checkpointStorageCredentials: TEST_AWS_CRED,
        checkpointStorageRegion: 'us-east-1',
      }),
    ).not.toThrow();
  });

  it('throws when a bucket is requested on Lambda (no native storage) without storage creds', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        inputBucket: 'my-bucket',
      }),
    ).toThrow('Lambda does not provide storage');
  });

  it('does not throw for AWS with buckets (native storage)', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
        inputBucket: 'input-bucket',
        outputBucket: 'output-bucket',
      }),
    ).not.toThrow();
  });

  it('throws when storage creds set without region (config-shape rule)', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        inputBucket: 'my-bucket',
        inputStorageCredentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'key',
          secretAccessKey: 'secret',
        },
      }),
    ).toThrow('inputStorageRegion is required');
  });

  it('needs no storage region for Cloudflare R2, which has none', () => {
    expect(() =>
      validateWorkloadStorageRequest({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        inputBucket: 'my-bucket',
        inputStorageCredentials: {
          cloudProvider: CloudType.Cloudflare,
          accountId: 'acct',
          apiToken: 'token',
        },
      }),
    ).not.toThrow();
  });

  it('reports why R2 refuses a storage region instead of "cannot mint"', () => {
    expect(() =>
      validateStorageCapabilities({
        cloudProvider: CloudType.Lambda,
        credentials: new LambdaCreds(),
        inputBucket: 'my-bucket',
        inputStorageCredentials: {
          cloudProvider: CloudType.Cloudflare,
          accountId: 'acct',
          apiToken: 'token',
        },
        inputStorageRegion: 'us-east-1',
      }),
    ).toThrow('R2 has no regions');
  });
});
