import { CloudType } from '../../../../src/shared/cloud.js';
import type { CloudCredential } from '../../../../src/shared/api-contract/credentials-schemas.js';

import type { Environment } from './environment.js';

export type VmProvider = 'aws' | 'azure' | 'gcp' | 'lambda';

export interface VmProfile {
  readonly slug: VmProvider;
  readonly provider:
    | CloudType.AWS
    | CloudType.Azure
    | CloudType.GCP
    | CloudType.Lambda;
  readonly credentialName: string;
  // E2E profiles hold keys.
  readonly credential: CloudCredential;
  readonly vmTypes: readonly string[];
  readonly region?: string;
  readonly diskSizeGb?: number;
}

export class ProviderProfiles {
  readonly #environment: Environment;

  constructor(environment: Environment) {
    this.#environment = environment;
  }

  vm(provider: VmProvider): VmProfile {
    if (provider === 'aws') {
      const sessionToken =
        this.#environment.optionalSecret('AWS_SESSION_TOKEN');
      return {
        slug: provider,
        provider: CloudType.AWS,
        credentialName: 'aws-test',
        credential: {
          cloudProvider: CloudType.AWS,
          accessKeyId: this.#environment.secret('AWS_ACCESS_KEY_ID'),
          secretAccessKey: this.#environment.secret('AWS_SECRET_ACCESS_KEY'),
          ...(sessionToken ? { sessionToken } : {}),
        },
        vmTypes: ['t3.small'],
        ...this.#optionalVmSettings(),
      };
    }
    if (provider === 'azure') {
      return {
        slug: provider,
        provider: CloudType.Azure,
        credentialName: 'azure-test',
        credential: {
          cloudProvider: CloudType.Azure,
          applicationId: this.#environment.secret('AZURE_CLIENT_ID'),
          secret: this.#environment.secret('AZURE_CLIENT_SECRET'),
          directoryId: this.#environment.secret('AZURE_TENANT_ID'),
          subscriptionId: this.#environment.secret('AZURE_SUBSCRIPTION_ID'),
        },
        vmTypes: ['Standard_D2s_v5'],
        ...this.#optionalVmSettings(),
      };
    }
    if (provider === 'gcp') {
      return {
        slug: provider,
        provider: CloudType.GCP,
        credentialName: 'gcp-test',
        credential: {
          cloudProvider: CloudType.GCP,
          projectId: this.#environment.secret('GCP_PROJECT_ID'),
          privateKey: this.#environment.secret('GCP_PRIVATE_KEY'),
          clientEmail: this.#environment.secret('GCP_CLIENT_EMAIL'),
        },
        vmTypes: ['e2-standard-2'],
        ...this.#optionalVmSettings(),
      };
    }
    return {
      slug: provider,
      provider: CloudType.Lambda,
      credentialName: 'lambda-test',
      credential: {
        cloudProvider: CloudType.Lambda,
        apiKey: this.#environment.secret('LAMBDA_API_KEY'),
      },
      vmTypes: ['cpu_4x_general', 'gpu_1x_a10', 'gpu_1x_a100_sxm4'],
      ...this.#optionalVmSettings(),
    };
  }

  /**
   * Serve placement reuses the VM credential and shapes but sizes its disk
   * from its own variable: the two suites run against the same accounts, so
   * one shared knob would silently retune whichever leg was not being changed.
   */
  serve(provider: VmProvider): VmProfile {
    const {
      credential,
      credentialName,
      provider: cloudProvider,
      slug,
      vmTypes,
    } = this.vm(provider);
    const disk = this.#environment.optional('SERVE_SMOKE_DISK_SIZE_GB', '50');
    if (!/^\d+$/u.test(disk) || !Number.isSafeInteger(Number(disk))) {
      throw new Error(
        'SERVE_SMOKE_DISK_SIZE_GB must be a non-negative integer',
      );
    }
    const region = this.#environment.optional('SERVE_SMOKE_REGION');
    return {
      credential,
      credentialName,
      diskSizeGb: Number(disk),
      provider: cloudProvider,
      slug,
      vmTypes,
      ...(region ? { region } : {}),
    };
  }

  /** Fixed qualification profiles; ordinary smoke overrides cannot retune them. */
  gpuServe(provider: VmProvider): VmProfile & {
    readonly gpus: 'all';
    readonly runtime?: 'nvidia';
  } {
    const {
      credential,
      credentialName,
      provider: cloudProvider,
      slug,
    } = this.vm(provider);
    const placements = {
      aws: { vmTypes: ['g6e.xlarge'], diskSizeGb: 100 },
      azure: { vmTypes: ['Standard_NC4as_T4_v3'], diskSizeGb: 50 },
      gcp: {
        vmTypes: ['g2-standard-4'],
        diskSizeGb: 50,
        region: 'us-east4',
        runtime: 'nvidia' as const,
      },
      lambda: { vmTypes: ['gpu_1x_a10'], diskSizeGb: 50 },
    } satisfies Record<
      VmProvider,
      Pick<VmProfile, 'vmTypes' | 'diskSizeGb' | 'region'> & {
        readonly runtime?: 'nvidia';
      }
    >;
    return {
      credential,
      credentialName,
      provider: cloudProvider,
      slug,
      gpus: 'all',
      ...placements[provider],
    };
  }

  #optionalVmSettings(): {
    readonly region?: string;
    readonly diskSizeGb?: number;
  } {
    const region = this.#environment.optional('VM_SMOKE_REGION');
    const disk = this.#environment.optional('VM_SMOKE_DISK_SIZE_GB');
    if (
      disk.length > 0 &&
      (!/^\d+$/u.test(disk) || !Number.isSafeInteger(Number(disk)))
    ) {
      throw new Error('VM_SMOKE_DISK_SIZE_GB must be a non-negative integer');
    }
    return {
      ...(region ? { region } : {}),
      ...(disk ? { diskSizeGb: Number(disk) } : {}),
    };
  }
}
