import { DeleteStackCommand } from '@aws-sdk/client-cloudformation';
import { createAwsInstanceCloudFormationClient } from '../provider-clients/aws.js';
import {
  createAzureInstanceCredential,
  createAzureResourceManagementClient,
} from '../provider-clients/azure.js';
import { createGcpInstanceComputeClients } from '../provider-clients/gcp.js';

/**
 * What deletes the installation the API runs on, last (RFC 0049 C26, seed
 * design). The seed writes it into the release values as `selfDelete`; the
 * VM's own identity holds exactly these rights.
 */
export type SelfDeleteTarget =
  | {
      readonly cloud: 'aws';
      readonly stackName: string;
      readonly roleArn: string;
    }
  | { readonly cloud: 'azure'; readonly resourceGroup: string }
  | {
      readonly cloud: 'gcp';
      readonly instanceName: string;
      readonly zone: string;
    };

/** The instance metadata service: the VM's region, subscription or project. */
export interface InstanceMetadata {
  awsRegion(): Promise<string>;
  azureSubscription(): Promise<string>;
  gcpProject(): Promise<string>;
}

const METADATA = 'http://169.254.169.254';

async function text(url: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`instance metadata ${url} answered ${response.status}`);
  }
  return (await response.text()).trim();
}

const instanceMetadata: InstanceMetadata = {
  // IMDSv2: a session token first.
  async awsRegion() {
    const token = await text(`${METADATA}/latest/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    });
    return text(`${METADATA}/latest/meta-data/placement/region`, {
      headers: { 'X-aws-ec2-metadata-token': token },
    });
  },
  azureSubscription: () =>
    text(
      `${METADATA}/metadata/instance/compute/subscriptionId?api-version=2021-02-01&format=text`,
      { headers: { Metadata: 'true' } },
    ),
  gcpProject: () =>
    text(
      'http://metadata.google.internal/computeMetadata/v1/project/project-id',
      { headers: { 'Metadata-Flavor': 'Google' } },
    ),
};

/**
 * Ask the cloud to delete the API's installation. It returns once the cloud
 * accepted the delete; the VM, and this process, go with it.
 */
export async function removeInstallation(
  target: SelfDeleteTarget,
  metadata: InstanceMetadata = instanceMetadata,
): Promise<void> {
  switch (target.cloud) {
    case 'aws': {
      // The service role outlives the stack's own delete (S2); the CLI
      // removes it once the stack is gone.
      const client = createAwsInstanceCloudFormationClient(
        await metadata.awsRegion(),
      );
      await client.send(
        new DeleteStackCommand({
          StackName: target.stackName,
          RoleARN: target.roleArn,
        }),
      );
      return;
    }
    case 'azure': {
      const client = createAzureResourceManagementClient(
        createAzureInstanceCredential(),
        await metadata.azureSubscription(),
      );
      // Accepted is enough: the group's delete takes this VM.
      await client.resourceGroups.beginDelete(target.resourceGroup);
      return;
    }
    case 'gcp': {
      // Only its own instance: firewall deletes need a network right IAM
      // can't scope, so the CLI deletes the rules afterwards (S4).
      const { instances } = createGcpInstanceComputeClients();
      await instances.delete({
        project: await metadata.gcpProject(),
        zone: target.zone,
        instance: target.instanceName,
      });
      return;
    }
  }
}

/** `ANYCLOUD_SELF_DELETE`, the release values' `selfDelete`; null when absent. */
export function parseSelfDeleteTarget(
  raw: string | undefined,
): SelfDeleteTarget | null {
  if (!raw?.trim()) return null;
  const value = JSON.parse(raw) as Partial<Record<string, unknown>>;
  const strings = (...keys: string[]) =>
    keys.every((key) => typeof value[key] === 'string' && value[key] !== '');
  if (
    (value.cloud === 'aws' && strings('stackName', 'roleArn')) ||
    (value.cloud === 'azure' && strings('resourceGroup')) ||
    (value.cloud === 'gcp' && strings('instanceName', 'zone'))
  ) {
    return value as unknown as SelfDeleteTarget;
  }
  throw new Error(
    'ANYCLOUD_SELF_DELETE does not name a stack, group or instance',
  );
}
