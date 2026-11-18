import { describe, it, expect } from 'vitest';
import {
  CloudConfig,
  CloudType,
  AWSCreds,
  GCPCreds,
  AzureCreds,
} from '../../../src/shared/cloud.js';
import {
  WorkloadType,
  WorkloadState,
  DEPLOY_STEPS,
  ACTIVE_STATES,
  PREEMPTIBLE_STATES,
  isTerminalState,
  isResubmittable,
} from '../../../src/shared/workload.js';
import {
  ContainerState,
  isContainerHealthy,
} from '../../../src/shared/runtime.js';

describe('shared value owners', () => {
  describe('WorkloadType Enum', () => {
    it('uses the canonical Service wire value', () => {
      expect(WorkloadType.Service).toBe('service');
      expect(WorkloadType).not.toHaveProperty('Server');
    });
  });

  describe('CloudConfig', () => {
    it('should create AWS CloudConfig correctly', () => {
      const awsCreds = new AWSCreds();
      awsCreds.accessKeyId = 'test-key';
      awsCreds.secretAccessKey = 'test-secret';

      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't2.micro',
        credentials: awsCreds,
      };

      expect(config.cloudProvider).toBe(CloudType.AWS);
      expect(config.region).toBe('us-east-1');
      expect(config.credentials).toBe(awsCreds);
    });

    it('should create GCP CloudConfig correctly', () => {
      const gcpCreds = new GCPCreds();
      gcpCreds.projectId = 'test-project';
      gcpCreds.privateKey = 'test-key';
      gcpCreds.clientEmail = 'test@example.com';

      const config: CloudConfig = {
        cloudProvider: CloudType.GCP,
        region: 'us-east4-a',
        vmType: 'f1-micro',
        credentials: gcpCreds,
      };

      expect(config.cloudProvider).toBe(CloudType.GCP);
      expect(config.region).toBe('us-east4-a');
      expect(config.credentials).toBe(gcpCreds);
    });
  });

  describe('CloudType Enum', () => {
    it('should have consistent values across CLI and API usage', () => {
      expect(CloudType.AWS).toBe('AWS');
      expect(CloudType.GCP).toBe('GCP');
      expect(CloudType.Azure).toBe('Azure');
    });

    it('should be usable in both CLI and API contexts', () => {
      const configs: CloudConfig[] = [
        {
          cloudProvider: CloudType.AWS,
          credentials: new AWSCreds(),
        },
        {
          cloudProvider: CloudType.GCP,
          credentials: new GCPCreds(),
        },
        {
          cloudProvider: CloudType.Azure,
          credentials: new AzureCreds(),
        },
      ];

      expect(configs[0].cloudProvider).toBe('AWS');
      expect(configs[1].cloudProvider).toBe('GCP');
      expect(configs[2].cloudProvider).toBe('Azure');
    });
  });

  describe('Credential Classes', () => {
    it('should create AWS credentials correctly', () => {
      const creds = new AWSCreds();
      creds.accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
      creds.secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

      expect(creds.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(creds.secretAccessKey).toBe(
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      );
    });

    it('should create GCP credentials correctly', () => {
      const creds = new GCPCreds();
      creds.projectId = 'my-project-123';
      creds.privateKey =
        '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';
      creds.clientEmail = 'service-account@my-project.iam.gserviceaccount.com';

      expect(creds.projectId).toBe('my-project-123');
      expect(creds.privateKey).toContain('BEGIN PRIVATE KEY');
      expect(creds.clientEmail).toContain(
        '@my-project.iam.gserviceaccount.com',
      );
    });

    it('should create Azure credentials correctly', () => {
      const creds = new AzureCreds();
      creds.applicationId = 'app-id-123';
      creds.secret = 'super-secret-value';
      creds.directoryId = 'directory-id-456';
      creds.subscriptionId = 'subscription-id-789';

      expect(creds.applicationId).toBe('app-id-123');
      expect(creds.secret).toBe('super-secret-value');
      expect(creds.directoryId).toBe('directory-id-456');
      expect(creds.subscriptionId).toBe('subscription-id-789');
    });

    it('should work with CloudConfig credentials union type', () => {
      const awsConfig: CloudConfig = {
        cloudProvider: CloudType.AWS,
        credentials: Object.assign(new AWSCreds(), {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        }),
      };

      const gcpConfig: CloudConfig = {
        cloudProvider: CloudType.GCP,
        credentials: Object.assign(new GCPCreds(), {
          projectId: 'test',
          privateKey: 'test',
          clientEmail: 'test@test.com',
        }),
      };

      const azureConfig: CloudConfig = {
        cloudProvider: CloudType.Azure,
        credentials: Object.assign(new AzureCreds(), {
          applicationId: 'test',
          secret: 'test',
          directoryId: 'test',
          subscriptionId: 'test',
        }),
      };

      expect(awsConfig.credentials).toBeInstanceOf(AWSCreds);
      expect(gcpConfig.credentials).toBeInstanceOf(GCPCreds);
      expect(azureConfig.credentials).toBeInstanceOf(AzureCreds);
    });
  });

  describe('Config Construction', () => {
    it('should create a valid CloudConfig for AWS', () => {
      const creds = new AWSCreds();
      creds.accessKeyId = 'test-key';
      creds.secretAccessKey = 'test-secret';

      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        region: 'us-west-2',
        vmType: 't3.medium',
        credentials: creds,
      };

      expect(config.cloudProvider).toBe(CloudType.AWS);
      expect(config.region).toBe('us-west-2');
      expect(config.vmType).toBe('t3.medium');
      expect(config.credentials).toBeInstanceOf(AWSCreds);
    });

    it('should create a valid CloudConfig for GCP', () => {
      const creds = new GCPCreds();
      creds.projectId = 'my-gcp-project';
      creds.privateKey = 'private-key-content';
      creds.clientEmail = 'test@my-project.iam.gserviceaccount.com';

      const config: CloudConfig = {
        cloudProvider: CloudType.GCP,
        region: 'us-central1-a',
        vmType: 'e2-medium',
        credentials: creds,
      };

      expect(config.cloudProvider).toBe(CloudType.GCP);
      expect(config.region).toBe('us-central1-a');
      expect(config.vmType).toBe('e2-medium');
      expect(config.credentials).toBeInstanceOf(GCPCreds);
    });

    it('should create a valid CloudConfig for Azure', () => {
      const creds = new AzureCreds();
      creds.applicationId = 'azure-app-id';
      creds.secret = 'azure-secret';
      creds.directoryId = 'azure-directory-id';
      creds.subscriptionId = 'azure-subscription-id';

      const config: CloudConfig = {
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B2s',
        credentials: creds,
      };

      expect(config.cloudProvider).toBe(CloudType.Azure);
      expect(config.region).toBe('eastus');
      expect(config.vmType).toBe('Standard_B2s');
      expect(config.credentials).toBeInstanceOf(AzureCreds);
    });
  });

  describe('API Payload Compatibility', () => {
    it('should serialize CloudConfig to JSON and deserialize correctly', () => {
      const creds = new AWSCreds();
      creds.accessKeyId = 'test-key';
      creds.secretAccessKey = 'test-secret';

      const config: CloudConfig = {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't2.micro',
        credentials: creds,
      };

      // Simulate what happens when CLI sends to API
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json);

      expect(parsed.cloudProvider).toBe('AWS');
      expect(parsed.region).toBe('us-east-1');
      expect(parsed.vmType).toBe('t2.micro');
      expect(parsed.credentials.accessKeyId).toBe('test-key');
      expect(parsed.credentials.secretAccessKey).toBe('test-secret');
    });

    it('should handle single cloudConfig (deploy payload)', () => {
      const awsCreds = new AWSCreds();
      awsCreds.accessKeyId = 'AKIATEST';
      awsCreds.secretAccessKey = 'aws-secret';

      const cloudConfig: CloudConfig = {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't2.micro',
        credentials: awsCreds,
      };

      // Simulate CLI sending single cloudConfig to API
      const json = JSON.stringify({ cloudConfig });
      const parsed = JSON.parse(json);

      expect(parsed.cloudConfig.cloudProvider).toBe('AWS');
      expect(parsed.cloudConfig.region).toBe('us-east-1');
      expect(parsed.cloudConfig.credentials.accessKeyId).toBe('AKIATEST');
    });
  });

  describe('Workload State Helpers', () => {
    describe('isTerminalState', () => {
      it('returns true for terminal states', () => {
        expect(isTerminalState(WorkloadState.Completed)).toBe(true);
        expect(isTerminalState(WorkloadState.Failed)).toBe(true);
        expect(isTerminalState(WorkloadState.Errored)).toBe(true);
        expect(isTerminalState(WorkloadState.Invalid)).toBe(true);
        expect(isTerminalState(WorkloadState.Terminated)).toBe(true);
      });

      it('returns false for active states', () => {
        expect(isTerminalState(WorkloadState.Provisioning)).toBe(false);
        expect(isTerminalState(WorkloadState.Starting)).toBe(false);
        expect(isTerminalState(WorkloadState.Retrying)).toBe(false);
        expect(isTerminalState(WorkloadState.Recovering)).toBe(false);
        expect(isTerminalState(WorkloadState.Running)).toBe(false);
        expect(isTerminalState(WorkloadState.Finalizing)).toBe(false);
      });

      it('orders deploy steps and tracks live-VM states', () => {
        expect(DEPLOY_STEPS).toEqual([
          WorkloadState.Provisioning,
          WorkloadState.Initializing,
          WorkloadState.Downloading,
          WorkloadState.Syncing,
          WorkloadState.Starting,
        ]);
        expect(ACTIVE_STATES).toContain(WorkloadState.Downloading);
        expect(PREEMPTIBLE_STATES).toContain(WorkloadState.Downloading);
      });

      it('treats finalizing as active but not a deploy or preemption-recovery state', () => {
        expect(ACTIVE_STATES).toContain(WorkloadState.Finalizing);
        expect(DEPLOY_STEPS).not.toContain(WorkloadState.Finalizing);
        expect(PREEMPTIBLE_STATES).not.toContain(WorkloadState.Finalizing);
      });
    });

    describe('isResubmittable', () => {
      it('returns true for terminal states that did not succeed', () => {
        expect(isResubmittable(WorkloadState.Failed)).toBe(true);
        expect(isResubmittable(WorkloadState.Errored)).toBe(true);
        expect(isResubmittable(WorkloadState.Invalid)).toBe(true);
        expect(isResubmittable(WorkloadState.Terminated)).toBe(true);
      });

      it('returns false for Completed (re-run with a fresh submit)', () => {
        expect(isResubmittable(WorkloadState.Completed)).toBe(false);
      });

      it('returns false for active states', () => {
        expect(isResubmittable(WorkloadState.Provisioning)).toBe(false);
        expect(isResubmittable(WorkloadState.Running)).toBe(false);
        expect(isResubmittable(WorkloadState.Finalizing)).toBe(false);
        expect(isResubmittable(WorkloadState.Retrying)).toBe(false);
      });
    });

    describe('isContainerHealthy', () => {
      it('returns true only for Running state', () => {
        expect(isContainerHealthy({ state: ContainerState.Running })).toBe(
          true,
        );
      });

      it('returns false for all non-running states', () => {
        expect(isContainerHealthy({ state: ContainerState.Created })).toBe(
          false,
        );
        expect(isContainerHealthy({ state: ContainerState.Paused })).toBe(
          false,
        );
        expect(isContainerHealthy({ state: ContainerState.Restarting })).toBe(
          false,
        );
        expect(isContainerHealthy({ state: ContainerState.Exited })).toBe(
          false,
        );
        expect(isContainerHealthy({ state: ContainerState.Dead })).toBe(false);
        expect(isContainerHealthy({ state: ContainerState.NotFound })).toBe(
          false,
        );
      });
    });
  });
});
