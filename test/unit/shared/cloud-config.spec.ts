import { describe, it, expect } from 'vitest';
import {
  completeCloudConfig,
  DEFAULT_DISK_TIER,
  getRegionByVMType,
  getRegionsForVMType,
  getRegions,
  getVMTypes,
  extractCredentials,
  getZoneSuffixes,
  cloudCredentialIdentityKey,
  requiresComputeCredentials,
  requiresExplicitCheckpointStorage,
  resolveZone,
  supportsDiskTier,
  supportsRegionFailover,
  validateBucketName,
  validateNewBucketName,
  resolveVMType,
  isCPUVMType,
  isGPUVMType,
  defaultRuntimeGpuAccess,
  defaultGpuAccess,
  gpuRuntimeForVMType,
  gpuCapabilityForVMType,
  isImageRuntimeCompatible,
  gpuAcceleratorName,
  getAvailableGPUs,
  parseGpuType,
} from '../../../src/shared/cloud-config.js';
import {
  CATALOG_BACKED_CLOUDS,
  PROVIDER_DATA,
  computeProviderData,
  isComputeProvider,
  storageOnlyComputeMessage,
} from '../../../src/shared/providers.js';
import { readCatalog } from '../../../src/shared/catalog/index.js';
import { ImageRuntime } from '../../../src/shared/image.js';
import {
  CloudConfig,
  CloudType,
  AWSCreds,
  GCPCreds,
  AzureCreds,
  AWSCredentials,
  GCPCredentials,
  AzureCredentials,
  LambdaCredentials,
  DiskTier,
  GpuRuntime,
} from '../../../src/shared/cloud.js';

describe('CloudConfig utilities', () => {
  describe('provider metadata helpers', () => {
    const computeClouds = Object.values(CloudType).filter(isComputeProvider);

    it('derives compute credential requirements from provider data', () => {
      for (const cloud of computeClouds) {
        expect(requiresComputeCredentials(cloud)).toBe(
          computeProviderData(cloud).computeCredentialMode ===
            'cloud-credentials',
        );
      }
    });

    it('refuses compute facts for a storage-only provider', () => {
      expect(isComputeProvider(CloudType.Cloudflare)).toBe(false);
      expect(() => requiresComputeCredentials(CloudType.Cloudflare)).toThrow(
        storageOnlyComputeMessage(CloudType.Cloudflare),
      );
      expect(CATALOG_BACKED_CLOUDS).not.toContain(CloudType.Cloudflare);
    });

    it('derives catalog-backed clouds from provider data', () => {
      expect(CATALOG_BACKED_CLOUDS).toEqual(
        (Object.keys(PROVIDER_DATA) as CloudType[]).filter(
          (cloud) => PROVIDER_DATA[cloud].compute?.catalogFile != null,
        ),
      );
    });

    it('keeps the Lambda default VM type in the provider catalog', () => {
      const defaultVmType = computeProviderData(CloudType.Lambda).defaultVmType;

      expect(
        getRegionsForVMType(defaultVmType, CloudType.Lambda),
        `Lambda default VM type "${defaultVmType}" is missing from its catalog`,
      ).not.toHaveLength(0);
    });

    it('derives region failover support from provider data', () => {
      for (const cloud of computeClouds) {
        expect(supportsRegionFailover(cloud)).toBe(
          computeProviderData(cloud).supportsRegionFailover,
        );
      }
    });

    it('supports disk tier on AWS, GCP, and Azure', () => {
      const supported = new Set<CloudType>([
        CloudType.AWS,
        CloudType.GCP,
        CloudType.Azure,
      ]);
      for (const cloud of computeClouds) {
        expect(supportsDiskTier(cloud)).toBe(supported.has(cloud));
      }
    });

    it('derives checkpoint storage requirements from provider data', () => {
      for (const cloud of computeClouds) {
        expect(requiresExplicitCheckpointStorage(cloud)).toBe(
          computeProviderData(cloud).checkpointStorageSource ===
            'explicit-storage-credential',
        );
      }
    });

    it('keeps two Cloudflare tokens on one account apart by name', () => {
      const account = { accountId: 'cf-account' };
      expect(
        cloudCredentialIdentityKey(CloudType.Cloudflare, account, 'r2-read'),
      ).not.toBe(
        cloudCredentialIdentityKey(CloudType.Cloudflare, account, 'r2-write'),
      );
    });

    it('builds stable credential identity keys', () => {
      expect(
        cloudCredentialIdentityKey(
          CloudType.GCP,
          {
            projectId: 'project-1',
            clientEmail: 'svc@example.com',
          },
          'fallback',
        ),
      ).toBe(JSON.stringify(['gcp', 'project-1', 'svc@example.com']));
      expect(
        cloudCredentialIdentityKey(
          CloudType.AWS,
          { accessKeyId: 'AKIA_TEST' },
          'fallback',
        ),
      ).toBe(JSON.stringify(['aws', 'AKIA_TEST']));
      expect(
        cloudCredentialIdentityKey(CloudType.Lambda, undefined, 'fallback'),
      ).toBe(JSON.stringify([CloudType.Lambda, 'fallback']));
    });
  });

  describe('completeCloudConfig', () => {
    it('leaves a storage-only GCP config without a zone, so it never needs the VM catalog', () => {
      const storage = { cloudProvider: CloudType.GCP, region: 'us-central1' };
      expect(
        completeCloudConfig(storage, { zone: false }).availabilityZone,
      ).toBeUndefined();
      // A config with placement still gets its zone.
      expect(completeCloudConfig(storage).availabilityZone).toMatch(/^[a-z]$/u);
    });

    it('uses high as the shared disk tier default', () => {
      expect(DEFAULT_DISK_TIER).toBe(DiskTier.High);
    });

    it('should set defaults when both region and vmType are undefined', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
      };

      const result = completeCloudConfig(config);

      expect(result.region).toBe('us-east-1');
      expect(result.vmType).toBe('t2.micro');
      // Should not mutate original
      expect(config.region).toBeUndefined();
      expect(config.vmType).toBeUndefined();
    });

    it('rejects an empty VM type instead of treating it as omitted', () => {
      expect(() =>
        completeCloudConfig({
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: '',
        }),
      ).toThrow(/Invalid GPU request/);
    });

    it.each([CloudType.AWS, CloudType.GCP, CloudType.Azure])(
      'resolves an omitted disk tier to the shared default for %s',
      (cloudProvider) => {
        const result = completeCloudConfig({ cloudProvider });

        expect(result.diskTier).toBe(DEFAULT_DISK_TIER);
      },
    );

    it('does not add a disk tier to a provider that does not support it', () => {
      const result = completeCloudConfig({ cloudProvider: CloudType.Local });

      expect(result.diskTier).toBeUndefined();
    });

    it('should set default vmType when only region is provided', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.GCP,
        region: 'europe-west1-b',
        credentials: new GCPCreds(),
      };

      const result = completeCloudConfig(config);

      expect(result.region).toBe('europe-west1-b');
      expect(result.vmType).toBe('f1-micro');
    });

    it('should find region when only vmType is provided for AWS', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        vmType: 't2.micro',
        credentials: new AWSCreds(),
      };

      const result = completeCloudConfig(config);

      expect(result.vmType).toBe('t2.micro');
      expect(result.region).toBe(
        getRegionsForVMType('t2.micro', CloudType.AWS)[0],
      );
    });

    it('should not modify config when both region and vmType are provided', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.Azure,
        region: 'westus',
        vmType: 'Standard_B2s',
        diskTier: DiskTier.Ultra,
        credentials: new AzureCreds(),
      };

      const result = completeCloudConfig(config);

      // The result is always a new branded object; the values pass through
      // untouched and the input is not mutated.
      expect(result).not.toBe(config);
      expect(result.region).toBe('westus');
      expect(result.vmType).toBe('Standard_B2s');
      expect(config).toEqual({
        cloudProvider: CloudType.Azure,
        region: 'westus',
        vmType: 'Standard_B2s',
        diskTier: DiskTier.Ultra,
        credentials: new AzureCreds(),
      });
    });

    it('should set defaults for GCP', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.GCP,
        credentials: new GCPCreds(),
      };

      const result = completeCloudConfig(config);

      expect(result.region).toBe('us-east4');
      expect(result.availabilityZone).toBe('a');
      expect(result.vmType).toBe('f1-micro');
    });

    it('should set defaults for Azure', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.Azure,
        credentials: new AzureCreds(),
      };

      const result = completeCloudConfig(config);

      expect(result.region).toBe('eastus');
      expect(result.vmType).toBe('Standard_B1s');
    });

    it('should resolve GPU alias to cloud-specific vmType', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
        vmType: 'h100',
      };

      const result = completeCloudConfig(config);

      // Should resolve to an actual AWS instance type, not "h100"
      expect(result.vmType).not.toBe('h100');
      expect(result.vmType!.length).toBeGreaterThan(0);
    });

    it('should resolve GPU alias with count', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.GCP,
        credentials: new GCPCreds(),
        vmType: 'H100:8',
      };

      const result = completeCloudConfig(config);

      expect(result.vmType).toBe('a3-highgpu-8g');
    });

    it('should pass through non-alias vmType unchanged', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
        vmType: 'p4d.24xlarge',
        region: 'us-east-1',
      };

      const result = completeCloudConfig(config);

      expect(result.vmType).toBe('p4d.24xlarge');
    });

    it('should walk vmType array to first catalog-resolvable entry', () => {
      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: new AWSCreds(),
        vmType: ['totally_fake_nonexistent_vm', 't3.large'],
      };

      const result = completeCloudConfig(config);

      expect(result.vmType).toBe('t3.large');
      expect(result.region).toBeDefined();
    });
  });

  describe('isGPUVMType', () => {
    it('detects accelerator-backed VM types from the catalog', () => {
      expect(isGPUVMType(CloudType.AWS, 'p5.48xlarge')).toBe(true);
      expect(isGPUVMType(CloudType.AWS, 't2.micro')).toBe(false);
    });

    it('matches VM types case-insensitively', () => {
      expect(isGPUVMType(CloudType.Azure, 'standard_nc40ads_h100_v5')).toBe(
        true,
      );
    });
  });

  describe('isCPUVMType', () => {
    it('distinguishes catalogued CPU types from GPU and unknown types', () => {
      expect(isCPUVMType(CloudType.AWS, 't2.micro')).toBe(true);
      expect(isCPUVMType(CloudType.AWS, 'T2.MICRO')).toBe(true);
      expect(isCPUVMType(CloudType.AWS, 'p5.48xlarge')).toBe(false);
      expect(isCPUVMType(CloudType.AWS, 'not-in-the-catalog')).toBe(false);
    });
  });

  describe('gpuCapabilityForVMType', () => {
    it.each([
      [CloudType.AWS, 't3.small', { kind: 'cpu' }],
      [CloudType.AWS, 'p5.48xlarge', { kind: 'nvidia', count: 8 }],
      [CloudType.GCP, 'a2-highgpu-1g', { kind: 'nvidia', count: 1 }],
      [CloudType.Azure, 'Standard_NC12s_v3', { kind: 'nvidia', count: 2 }],
      [CloudType.AWS, 'not-in-the-catalog', { kind: 'unknown' }],
      [CloudType.Local, 'no-catalog', { kind: 'unknown' }],
      [
        CloudType.AWS,
        'trn1.2xlarge',
        { kind: 'non-cuda', runtime: GpuRuntime.Neuron },
      ],
    ] as const)(
      'classifies %s %s without assuming CPU',
      (provider, vmType, expected) => {
        expect(gpuCapabilityForVMType(provider, vmType)).toEqual(expected);
      },
    );

    it.each([undefined, 0, 0.5, -1, Number.MAX_SAFE_INTEGER + 1])(
      'keeps invalid NVIDIA count %s unknown',
      (count) => {
        const entries = Object.values(
          readCatalog(CloudType.AWS)!.typesPerAccelerator,
        )
          .flat()
          .filter((entry) => entry.instanceType === 'g6e.xlarge');
        expect(entries.length).toBeGreaterThan(0);
        const originalCounts = entries.map((entry) => entry.count);
        try {
          for (const entry of entries) Object.assign(entry, { count });
          expect(gpuCapabilityForVMType(CloudType.AWS, 'g6e.xlarge')).toEqual({
            kind: 'nvidia',
            count: undefined,
          });
        } finally {
          entries.forEach((entry, index) => {
            entry.count = originalCounts[index]!;
          });
        }
      },
    );
  });

  describe('isImageRuntimeCompatible', () => {
    it.each([
      [CloudType.AWS, 'g4dn.12xlarge', ImageRuntime.Cuda, true],
      [CloudType.AWS, 'g4dn.12xlarge', ImageRuntime.Rocm, false],
      [CloudType.AWS, 'g4dn.12xlarge', ImageRuntime.Unknown, true],
      [CloudType.AWS, 'g4dn.12xlarge', null, true],
      [CloudType.AWS, 'g4dn.12xlarge', undefined, true],
      [CloudType.Azure, 'Standard_ND96isr_MI300X_v5', ImageRuntime.Cuda, false],
      [CloudType.Azure, 'Standard_ND96isr_MI300X_v5', ImageRuntime.Rocm, true],
      [CloudType.AWS, 'trn1.2xlarge', ImageRuntime.Cuda, false],
      [CloudType.AWS, 't3.small', ImageRuntime.Cuda, true],
    ] as const)(
      'checks %s %s against image runtime %s',
      (provider, vmType, runtime, expected) => {
        expect(isImageRuntimeCompatible(provider, vmType, runtime)).toBe(
          expected,
        );
      },
    );
  });

  describe('gpuRuntimeForVMType', () => {
    it('classifies an NVIDIA catalog vmType as cuda (AWS p5, GCP a2)', () => {
      // Sanity-check the catalog premise so the assertions are meaningful.
      expect(isGPUVMType(CloudType.AWS, 'p5.48xlarge')).toBe(true);
      expect(gpuRuntimeForVMType(CloudType.AWS, 'p5.48xlarge')).toBe(
        GpuRuntime.Cuda,
      );
      expect(gpuRuntimeForVMType(CloudType.GCP, 'a2-highgpu-1g')).toBe(
        GpuRuntime.Cuda,
      );
      // Case-insensitive, matching isGPUVMType.
      expect(gpuRuntimeForVMType(CloudType.AWS, 'P5.48XLARGE')).toBe(
        GpuRuntime.Cuda,
      );
    });

    it('classifies an Azure MI300X vmType as rocm for BOTH spellings', () => {
      // The "isr" SKU carries acceleratorName=MI300X in the catalog index.
      expect(
        gpuAcceleratorName(CloudType.Azure, 'Standard_ND96isr_MI300X_v5'),
      ).toBe('MI300X');
      expect(
        gpuRuntimeForVMType(CloudType.Azure, 'Standard_ND96isr_MI300X_v5'),
      ).toBe(GpuRuntime.Rocm);

      // The "is" SKU (no trailing 'r') ships with a BLANK acceleratorName, so it
      // is absent from the accelerator index — reverse-lookup finds nothing and
      // isGPUVMType is false — yet the name fallback still classifies it rocm.
      expect(
        gpuAcceleratorName(CloudType.Azure, 'Standard_ND96is_MI300X_v5'),
      ).toBeUndefined();
      expect(isGPUVMType(CloudType.Azure, 'Standard_ND96is_MI300X_v5')).toBe(
        false,
      );
      expect(
        gpuRuntimeForVMType(CloudType.Azure, 'Standard_ND96is_MI300X_v5'),
      ).toBe(GpuRuntime.Rocm);
    });

    it('classifies an Azure MI25 (NV-as-v4) vmType as rocm', () => {
      expect(gpuRuntimeForVMType(CloudType.Azure, 'Standard_NV16as_v4')).toBe(
        GpuRuntime.Rocm,
      );
    });

    it('classifies AWS Inferentia2/Trainium vmTypes as neuron', () => {
      // inf2/trn1 carry Inferentia2/Trainium accelerator names in the catalog.
      expect(isGPUVMType(CloudType.AWS, 'inf2.xlarge')).toBe(true);
      expect(gpuRuntimeForVMType(CloudType.AWS, 'inf2.xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'trn1.2xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'trn1n.32xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'trn2.48xlarge')).toBe(
        GpuRuntime.Neuron,
      );
    });

    it('recognizes catalog-missing Neuron families and keeps inf1 unsupported', () => {
      expect(gpuRuntimeForVMType(CloudType.AWS, 'trn2u.48xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'trn3.48xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'INF2.8XLARGE')).toBe(
        GpuRuntime.Neuron,
      );
      expect(gpuRuntimeForVMType(CloudType.AWS, 'inf1.xlarge')).toBe(
        GpuRuntime.Unsupported,
      );
    });

    it('returns null for a CPU vmType', () => {
      expect(gpuRuntimeForVMType(CloudType.AWS, 't3.large')).toBeNull();
      expect(gpuRuntimeForVMType(CloudType.GCP, 'n1-standard-4')).toBeNull();
    });

    it('never defaults an unknown accelerator to cuda — the whole live catalog classifies', () => {
      // Every accelerator name the real catalogs expose must land in one of the
      // three buckets; an unrecognized name must be 'unsupported', not 'cuda'.
      // This is the bug the type kills: silently CUDA-booting a non-NVIDIA SKU.
      for (const cloud of [
        CloudType.AWS,
        CloudType.GCP,
        CloudType.Azure,
        CloudType.Lambda,
      ]) {
        const accelerators = getAvailableGPUs(cloud);
        expect(accelerators.length).toBeGreaterThan(0);
        for (const accel of accelerators) {
          // Pick any instance type for this accelerator and classify it.
          const vmType = resolveVMType(accel, cloud);
          const runtime = gpuRuntimeForVMType(cloud, vmType);
          // resolveVMType may not find a count-1 entry for every name; only
          // assert when it resolved to a real GPU vmType.
          if (isGPUVMType(cloud, vmType)) {
            expect(runtime).not.toBeNull();
            expect(Object.values(GpuRuntime)).toContain(runtime);
          }
        }
      }
    });
  });

  describe('defaultGpuAccess', () => {
    it('shares per-VM NVIDIA defaults without Docker host IPC', () => {
      expect(
        defaultGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          { runtime: 'nvidia', shmSize: '8g' },
        ),
      ).toEqual({ runtime: 'nvidia', shmSize: '8g', gpus: 'all' });
    });

    it.each(['all', '2'])(
      'preserves explicit GPU intent %s without mutation',
      (gpus) => {
        const options = { gpus, runtime: 'nvidia' };
        expect(
          defaultGpuAccess(
            { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
            options,
          ),
        ).toBe(options);
      },
    );

    it.each(['t3.medium', 'inf2.xlarge', 'custom-gpu-host'])(
      'does not infer NVIDIA access for %s',
      (vmType) => {
        expect(
          defaultGpuAccess({ cloudProvider: CloudType.AWS, vmType }, null),
        ).toBeNull();
      },
    );
  });

  describe('defaultRuntimeGpuAccess', () => {
    it('defaults gpus:all and host IPC for a CUDA vm-host target', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          null,
        ),
      ).toEqual({ gpus: 'all', ipc: 'host' });
    });

    it('adds host IPC even when --gpus is explicit', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          { gpus: '2' },
        ),
      ).toEqual({ gpus: '2', ipc: 'host' });
    });

    it('adds host IPC for explicit --gpus when the VM type has no catalog runtime classification', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'custom-gpu-host' },
          { gpus: 'all' },
        ),
      ).toEqual({ gpus: 'all', ipc: 'host' });
    });

    it('adds host IPC for an explicit Local GPU request', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.Local, vmType: 'local' },
          { gpus: 'all' },
        ),
      ).toEqual({ gpus: 'all', ipc: 'host' });
    });

    it('keeps explicit Local shared memory instead of adding host IPC', () => {
      const dockerOptions = { gpus: 'all', shmSize: '256m' };
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.Local, vmType: 'local' },
          dockerOptions,
        ),
      ).toBe(dockerOptions);
      expect(dockerOptions).not.toHaveProperty('ipc');
    });

    it('does not add host IPC when shared memory is explicit', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          { shmSize: '8g' },
        ),
      ).toEqual({ shmSize: '8g', gpus: 'all' });
    });

    it('merges gpus:all into existing docker options', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          { memory: '32g' },
        ),
      ).toEqual({ memory: '32g', gpus: 'all', ipc: 'host' });
    });

    it('does not add host IPC when IPC is explicit', () => {
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          { ipc: 'private' },
        ),
      ).toEqual({ ipc: 'private', gpus: 'all' });
    });

    it('preserves explicit CUDA Docker values (same reference, no mutation)', () => {
      const dockerOptions = { gpus: '2', ipc: 'private' };
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
          dockerOptions,
        ),
      ).toBe(dockerOptions);
    });

    it('leaves CPU targets untouched (same reference)', () => {
      const dockerOptions = { shmSize: '4g' };
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 't3.large' },
          dockerOptions,
        ),
      ).toBe(dockerOptions);
    });

    it('does not default for a not-yet-resolved (non-scalar) vmType', () => {
      // The optimizer narrows vmType to a scalar before conduct; a residual
      // fallback list means unresolved, so no default is applied.
      expect(
        defaultRuntimeGpuAccess(
          {
            cloudProvider: CloudType.AWS,
            vmType: ['p5.48xlarge', 't3.large'],
          },
          null,
        ),
      ).toBeNull();
    });

    it('does not default --gpus for an AMD (ROCm) target', () => {
      // gpuRuntime is 'rocm', not 'cuda', so no bogus --gpus is injected — the
      // gateway will fail clearly at image selection instead.
      expect(
        gpuRuntimeForVMType(CloudType.Azure, 'Standard_ND96isr_MI300X_v5'),
      ).toBe(GpuRuntime.Rocm);
      expect(
        defaultRuntimeGpuAccess(
          {
            cloudProvider: CloudType.Azure,
            vmType: 'Standard_ND96isr_MI300X_v5',
          },
          null,
        ),
      ).toBeNull();
    });

    it('does not treat explicit --gpus as a CUDA fallback for a known ROCm target', () => {
      const dockerOptions = { gpus: 'all' };
      expect(
        defaultRuntimeGpuAccess(
          {
            cloudProvider: CloudType.Azure,
            vmType: 'Standard_ND96isr_MI300X_v5',
          },
          dockerOptions,
        ),
      ).toBe(dockerOptions);
    });

    it('does not default --gpus for a recognized Neuron target', () => {
      expect(gpuRuntimeForVMType(CloudType.AWS, 'inf2.xlarge')).toBe(
        GpuRuntime.Neuron,
      );
      expect(
        defaultRuntimeGpuAccess(
          { cloudProvider: CloudType.AWS, vmType: 'inf2.xlarge' },
          null,
        ),
      ).toBeNull();
    });
  });

  describe('resolveVMType', () => {
    it('parses provider accelerator names without weakening count syntax', () => {
      expect(parseGpuType('Radeon Pro V520:2')).toEqual({
        name: 'RADEON PRO V520',
        count: 2,
      });
      expect(parseGpuType('Virtex UltraScale+ (VU47P)')).toEqual({
        name: 'VIRTEX ULTRASCALE+ (VU47P)',
        count: 1,
      });
      expect(() => parseGpuType('h100:01')).toThrow(/Invalid GPU count/);
      expect(() => parseGpuType('h100:1:2')).toThrow(/Invalid GPU request/);
    });

    it('should resolve h100 with default count 1 from catalog', () => {
      // AWS has H100 with count 1 (p5.4xlarge) in catalog
      const aws = resolveVMType('h100', CloudType.AWS);
      expect(aws).not.toBe('h100');
      expect(aws).not.toBe('H100');
    });

    it('should resolve h100:8 for GCP from catalog metadata', () => {
      expect(resolveVMType('h100:8', CloudType.GCP)).toBe('a3-highgpu-8g');
    });

    it('should resolve a100 for GCP (count 1)', () => {
      expect(resolveVMType('a100', CloudType.GCP)).toBe('a2-highgpu-1g');
    });

    it('should resolve a100:8 for GCP', () => {
      expect(resolveVMType('a100:8', CloudType.GCP)).toBe('a2-highgpu-8g');
    });

    it('should resolve l4 for GCP (count 1)', () => {
      expect(resolveVMType('l4', CloudType.GCP)).toBe('g2-standard-4');
    });

    it('should return unknown vmType unchanged', () => {
      expect(resolveVMType('t2.micro', CloudType.AWS)).toBe('t2.micro');
    });

    it('should be case-insensitive', () => {
      expect(resolveVMType('H100:8', CloudType.GCP)).toBe(
        resolveVMType('h100:8', CloudType.GCP),
      );
      // AWS T4 has count=1 entries in catalog
      expect(resolveVMType('T4', CloudType.AWS)).toBe(
        resolveVMType('t4', CloudType.AWS),
      );
    });

    it('should parse count from colon syntax', () => {
      // Lambda has gpu_1x_h100_pcie for count=1
      const lambda1 = resolveVMType('h100', CloudType.Lambda);
      const lambda8 = resolveVMType('h100:8', CloudType.Lambda);
      expect(lambda1).not.toBe(lambda8);
      expect(lambda1).not.toBe('h100');
      expect(lambda8).not.toBe('h100:8');
    });

    it('should throw on invalid count', () => {
      expect(() => resolveVMType('h100:abc', CloudType.AWS)).toThrow(
        /Invalid GPU count/,
      );
      expect(() => resolveVMType('h100:0', CloudType.AWS)).toThrow(
        /Invalid GPU count/,
      );
    });
  });

  describe('getRegionByVMType', () => {
    it('should return the first globally ranked AWS region', () => {
      const region = getRegionByVMType('t2.micro', CloudType.AWS);

      expect(region).toBe(getRegionsForVMType('t2.micro', CloudType.AWS)[0]);
    });

    it('should return the first globally ranked GCP region', () => {
      const region = getRegionByVMType('f1-micro', CloudType.GCP);

      expect(region).toBe(getRegionsForVMType('f1-micro', CloudType.GCP)[0]);
    });

    it('should return a GCP region not a zone (no trailing single-letter suffix)', () => {
      const region = getRegionByVMType('n2-standard-2', CloudType.GCP);

      expect(region).toBeDefined();
      // GCP regions look like "us-central1", zones look like "us-central1-a"
      // The last segment of a region is never a single letter
      const lastSegment = region.split('-').pop()!;
      expect(lastSegment.length).toBeGreaterThan(1);
    });

    it('should return the first globally ranked Azure region', () => {
      const region = getRegionByVMType('Standard_B1s', CloudType.Azure);

      expect(region).toBe(
        getRegionsForVMType('Standard_B1s', CloudType.Azure)[0],
      );
    });

    it('should return local for Local cloud provider', () => {
      const region = getRegionByVMType('any-type', CloudType.Local);

      expect(region).toBe('local');
    });

    it('should throw for unknown VM type', () => {
      expect(() =>
        getRegionByVMType('non-existent-vm-type', CloudType.AWS),
      ).toThrow('No regions available for VM type');
    });
  });

  describe('getRegionsForVMType', () => {
    const globallyRankedCases: Array<{
      cloud: CloudType;
      placements: string[];
      prices: Record<string, number>;
      expected: string[];
    }> = [
      {
        cloud: CloudType.AWS,
        placements: ['us-east-1', 'eu-west-1', 'ap-south-1', 'ca-central-1'],
        prices: {
          'us-east-1': 3,
          'eu-west-1': 1,
          'ap-south-1': 1,
        },
        expected: ['ap-south-1', 'eu-west-1', 'us-east-1', 'ca-central-1'],
      },
      {
        cloud: CloudType.GCP,
        placements: [
          'us-central1-a',
          'europe-west1-b',
          'asia-south1-c',
          'asia-south1-b',
        ],
        prices: {
          'us-central1': 3,
          'europe-west1': 1,
          'asia-south1': 1,
        },
        expected: ['asia-south1', 'europe-west1', 'us-central1'],
      },
      {
        cloud: CloudType.Azure,
        placements: ['eastus', 'westeurope', 'centralindia'],
        prices: { eastus: 3, westeurope: 1, centralindia: 1 },
        expected: ['centralindia', 'westeurope', 'eastus'],
      },
    ];

    it.each(globallyRankedCases)(
      'should globally price-sort $cloud regions without geographic preference',
      ({ cloud, placements, prices, expected }) => {
        const catalog = readCatalog(cloud);
        expect(catalog, `${cloud} catalog should be loaded`).toBeDefined();
        const typeKey = 'region-ordering-test';
        catalog!.regionsPerType[typeKey] = placements;
        catalog!.pricePerTypeRegion[typeKey] = prices;

        try {
          expect(getRegionsForVMType(typeKey, cloud)).toEqual(expected);
        } finally {
          delete catalog!.regionsPerType[typeKey];
          delete catalog!.pricePerTypeRegion[typeKey];
        }
      },
    );

    it('should use the requested pricing model for global ordering', () => {
      const catalog = readCatalog(CloudType.AWS);
      expect(catalog, 'AWS catalog should be loaded').toBeDefined();
      const typeKey = 'region-spot-ordering-test';
      catalog!.regionsPerType[typeKey] = ['us-east-1', 'eu-west-1'];
      catalog!.pricePerTypeRegion[typeKey] = {
        'us-east-1': 2,
        'eu-west-1': 1,
      };
      catalog!.spotPricePerTypeRegion[typeKey] = {
        'us-east-1': 0.5,
        'eu-west-1': 0.75,
      };

      try {
        expect(getRegionsForVMType(typeKey, CloudType.AWS)).toEqual([
          'eu-west-1',
          'us-east-1',
        ]);
        expect(getRegionsForVMType(typeKey, CloudType.AWS, true)).toEqual([
          'us-east-1',
          'eu-west-1',
        ]);
      } finally {
        delete catalog!.regionsPerType[typeKey];
        delete catalog!.pricePerTypeRegion[typeKey];
        delete catalog!.spotPricePerTypeRegion[typeKey];
      }
    });

    it('should match VM type case-insensitively', () => {
      // Catalog has 'Standard_B1s' — lookup with different casing should match
      const original = getRegionsForVMType('Standard_B1s', CloudType.Azure);
      const lowercase = getRegionsForVMType('standard_b1s', CloudType.Azure);

      expect(original.length).toBeGreaterThan(0);
      expect(lowercase).toEqual(original);
    });
  });

  describe('getRegions', () => {
    it('should return all AWS regions', () => {
      const regions = getRegions(CloudType.AWS);

      expect(regions).toBeInstanceOf(Array);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions).toContain('us-east-1');
    });

    it('should return all GCP regions', () => {
      const regions = getRegions(CloudType.GCP);

      expect(regions).toBeInstanceOf(Array);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions.some((r) => r.startsWith('us-'))).toBe(true);
    });

    it('should return all Azure regions', () => {
      const regions = getRegions(CloudType.Azure);

      expect(regions).toBeInstanceOf(Array);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions).toContain('eastus');
    });

    it('should return local for Local provider', () => {
      const regions = getRegions(CloudType.Local);

      expect(regions).toEqual(['local']);
    });
  });

  describe('getVMTypes', () => {
    it('should return VM types for AWS region', () => {
      const vmTypes = getVMTypes(CloudType.AWS, 'us-east-1');

      expect(vmTypes).toBeInstanceOf(Array);
      expect(vmTypes.length).toBeGreaterThan(0);
      expect(vmTypes).toContain('t2.micro');
    });

    it('should return VM types for GCP zone', () => {
      const vmTypes = getVMTypes(CloudType.GCP, 'us-east4-a');

      expect(vmTypes).toBeInstanceOf(Array);
      expect(vmTypes.length).toBeGreaterThan(0);
    });

    it('should return VM types for Azure region', () => {
      const vmTypes = getVMTypes(CloudType.Azure, 'eastus');

      expect(vmTypes).toBeInstanceOf(Array);
      expect(vmTypes.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown region', () => {
      const vmTypes = getVMTypes(CloudType.AWS, 'non-existent-region');

      expect(vmTypes).toEqual([]);
    });

    it('should return local for Local provider', () => {
      const vmTypes = getVMTypes(CloudType.Local, 'any-region');

      expect(vmTypes).toEqual(['local']);
    });
  });

  describe('extractCredentials', () => {
    it('should extract AWS credentials', () => {
      const credentials: AWSCredentials = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'temporary-session-token',
      };

      const result = extractCredentials(credentials);

      expect(result).toEqual({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'temporary-session-token',
      });
      expect((result as any).cloudProvider).toBeUndefined();
    });

    it('should extract GCP credentials', () => {
      const credentials: GCPCredentials = {
        cloudProvider: CloudType.GCP,
        projectId: 'my-project',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        clientEmail: 'test@my-project.iam.gserviceaccount.com',
      };

      const result = extractCredentials(credentials);

      expect(result).toEqual({
        projectId: 'my-project',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        clientEmail: 'test@my-project.iam.gserviceaccount.com',
      });
      expect((result as any).cloudProvider).toBeUndefined();
    });

    it('should extract Azure credentials', () => {
      const credentials: AzureCredentials = {
        cloudProvider: CloudType.Azure,
        applicationId: 'app-id',
        secret: 'secret-value',
        directoryId: 'tenant-id',
        subscriptionId: 'sub-id',
      };

      const result = extractCredentials(credentials);

      expect(result).toEqual({
        applicationId: 'app-id',
        secret: 'secret-value',
        directoryId: 'tenant-id',
        subscriptionId: 'sub-id',
      });
      expect((result as any).cloudProvider).toBeUndefined();
    });
  });

  describe('getZoneSuffixes', () => {
    it('should return zone suffixes for a GCP region', () => {
      const suffixes = getZoneSuffixes('us-east4');

      expect(suffixes).toBeInstanceOf(Array);
      expect(suffixes.length).toBeGreaterThan(0);
      expect(suffixes).toContain('a');
    });

    it('should return empty array for non-existent region', () => {
      const suffixes = getZoneSuffixes('non-existent-region');

      expect(suffixes).toEqual([]);
    });

    it('should only return zones with available VM types', () => {
      const suffixes = getZoneSuffixes('us-east4');

      suffixes.forEach((suffix) => {
        const fullZone = `us-east4-${suffix}`;
        const vmTypes = getVMTypes(CloudType.GCP, fullZone);
        expect(vmTypes.length).toBeGreaterThan(0);
      });
    });

    it('should return zones in sorted order', () => {
      const suffixes = getZoneSuffixes('us-east4');

      const sorted = [...suffixes].sort();
      expect(suffixes).toEqual(sorted);
    });

    it('should only return single letter suffixes', () => {
      const suffixes = getZoneSuffixes('us-east4');

      suffixes.forEach((suffix) => {
        expect(suffix).toMatch(/^[a-z]$/);
      });
    });
  });

  describe('extractCredentials', () => {
    it('should extract Lambda credentials', () => {
      const credentials: LambdaCredentials = {
        cloudProvider: CloudType.Lambda,
        apiKey: 'secret_test_key',
      };

      const result = extractCredentials(credentials);

      expect(result).toEqual({ apiKey: 'secret_test_key' });
      expect((result as any).cloudProvider).toBeUndefined();
    });
  });

  // Capability is no longer a central boolean table. Runtime capabilities are
  // explicit server-side factories/roles; see test/unit/services/gateways and
  // test/unit/services/cloud-config.spec.ts for their guards and registry paths.

  // Compute and workload-storage capability checks live on the server; their
  // tests are in test/unit/services/cloud-config.spec.ts.

  describe('validateBucketName', () => {
    it('accepts valid names on all clouds', () => {
      for (const cloud of [CloudType.AWS, CloudType.Azure, CloudType.GCP]) {
        expect(() => validateBucketName(cloud, 'my-bucket-123')).not.toThrow();
      }
    });

    it('rejects uppercase on every cloud', () => {
      for (const cloud of [CloudType.AWS, CloudType.Azure, CloudType.GCP]) {
        expect(() =>
          validateBucketName(cloud, 'INVALID_BUCKET_UPPERCASE'),
        ).toThrow(/Invalid bucket name/);
      }
    });

    it('rejects names shorter than 3 or longer than 63 chars', () => {
      expect(() => validateBucketName(CloudType.AWS, 'ab')).toThrow(
        /3–63 characters/,
      );
      expect(() => validateBucketName(CloudType.AWS, 'a'.repeat(64))).toThrow(
        /3–63 characters/,
      );
    });

    it('rejects underscores on AWS and Azure, accepts on GCP', () => {
      expect(() => validateBucketName(CloudType.AWS, 'bad_name')).toThrow();
      expect(() => validateBucketName(CloudType.Azure, 'bad_name')).toThrow();
      expect(() => validateBucketName(CloudType.GCP, 'ok_name')).not.toThrow();
    });

    it('rejects consecutive hyphens on Azure, accepts on AWS/GCP', () => {
      expect(() => validateBucketName(CloudType.Azure, 'a--b')).toThrow();
      expect(() => validateBucketName(CloudType.AWS, 'a--b')).not.toThrow();
      expect(() => validateBucketName(CloudType.GCP, 'a--b')).not.toThrow();
    });

    it('rejects consecutive dots on AWS, accepts single dots', () => {
      expect(() => validateBucketName(CloudType.AWS, 'a..b')).toThrow();
      expect(() => validateBucketName(CloudType.AWS, 'a.b.c')).not.toThrow();
    });

    it('rejects names starting or ending with non-alphanumeric', () => {
      expect(() => validateBucketName(CloudType.AWS, '-abc')).toThrow();
      expect(() => validateBucketName(CloudType.AWS, 'abc-')).toThrow();
      expect(() => validateBucketName(CloudType.Azure, '-abc')).toThrow();
      expect(() => validateBucketName(CloudType.GCP, '.abc')).toThrow();
    });

    it('accepts dotted GCS names up to 222 chars, rejects components over 63', () => {
      const long = 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(60);
      expect(() => validateBucketName(CloudType.GCP, long)).not.toThrow();
      expect(() => validateBucketName(CloudType.AWS, long)).toThrow(
        /3–63 characters/,
      );
      const oversizedComponent = 'a'.repeat(64) + '.b';
      expect(() =>
        validateBucketName(CloudType.GCP, oversizedComponent),
      ).toThrow(/components must be 1–63/);
      const tooLongOverall = ('a'.repeat(60) + '.').repeat(4) + 'b';
      expect(() => validateBucketName(CloudType.GCP, tooLongOverall)).toThrow(
        /3–222 characters/,
      );
    });

    it('rejects GCS-reserved names locally', () => {
      expect(() =>
        validateBucketName(CloudType.GCP, 'goog-reserved-test'),
      ).toThrow(/cannot begin with "goog"/);
      expect(() =>
        validateBucketName(CloudType.GCP, 'my-google-bucket'),
      ).toThrow(/contain "google"/);
      expect(() =>
        validateBucketName(CloudType.GCP, 'my-g00gle-bucket'),
      ).toThrow(/contain "google"/);
      expect(() =>
        validateBucketName(CloudType.AWS, 'goog-reserved-test'),
      ).not.toThrow();
    });

    it.each([
      ['xn--abc', 'prefix "xn--"'],
      ['sthree-abc', 'prefix "sthree-"'],
      ['sthree-configurator', 'prefix "sthree-"'],
      ['amzn-s3-demo-abc', 'prefix "amzn-s3-demo-"'],
      ['abc-s3alias', 'suffix "-s3alias"'],
      ['abc--ol-s3', 'suffix "--ol-s3"'],
      ['abc.mrap', 'suffix ".mrap"'],
      ['abc--x-s3', 'suffix "--x-s3"'],
      ['abc--table-s3', 'suffix "--table-s3"'],
      ['abc-an', 'suffix "-an"'],
      // An account regional namespace bucket: valid to use, not to create.
      ['my-bucket-111122223333-us-west-2-an', 'suffix "-an"'],
    ])('refuses to create the S3-reserved name %s', (name, part) => {
      expect(() => validateNewBucketName(CloudType.AWS, name)).toThrow(
        `Invalid bucket name '${name}': S3 reserves the ${part} for new buckets.`,
      );
      expect(() => validateBucketName(CloudType.AWS, name)).not.toThrow();
      expect(() => validateNewBucketName(CloudType.GCP, name)).not.toThrow();
    });

    it('rejects IP-address names on S3 and GCS', () => {
      for (const cloud of [CloudType.AWS, CloudType.GCP]) {
        expect(() => validateBucketName(cloud, '192.168.5.4')).toThrow(
          /must not be formatted as an IP address/,
        );
        expect(() => validateBucketName(cloud, '1.2.3.4.5')).not.toThrow();
        expect(() => validateBucketName(cloud, 'a.b.c')).not.toThrow();
      }
    });

    it('does not validate Lambda names but keeps Local inside its bucket root', () => {
      expect(() =>
        validateBucketName(CloudType.Lambda, 'INVALID_BUCKET'),
      ).not.toThrow();
      expect(() =>
        validateBucketName(CloudType.Local, 'local-bucket'),
      ).not.toThrow();
      expect(() => validateBucketName(CloudType.Local, '/some/path')).toThrow(
        /Local harness bucket names/,
      );
    });
  });

  describe('resolveZone', () => {
    it('returns a valid zone suffix for GCP', () => {
      const zone = resolveZone('us-east1', CloudType.GCP);
      expect(zone).toMatch(/^[a-z]$/);
      // us-east1 has zones b, c, d — no 'a'
      expect(zone).toMatch(/^[bcd]$/);
    });

    it('returns undefined for AWS', () => {
      expect(resolveZone('us-east-1', CloudType.AWS)).toBeUndefined();
    });

    it('returns undefined for Azure', () => {
      expect(resolveZone('eastus', CloudType.Azure)).toBeUndefined();
    });
  });
});
