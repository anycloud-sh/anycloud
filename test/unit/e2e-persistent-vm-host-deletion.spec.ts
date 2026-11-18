import { describe, expect, test } from 'vitest';

import type { CloudCredential } from '../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import type { PersistentVmRunningContext } from '../integration/e2e/internal/targets/persistent-vm-types.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';
import { deleteLocalSmolvmHost } from '../integration/e2e/internal/transports/local-smolvm.js';
import {
  type CloudVmHostDeletionContext,
  lambdaAcceptedHostDeletion,
  PublicCloudVmHostDeleter,
} from '../integration/e2e/internal/transports/public-cloud-vm-host-deletion.js';
import type { TargetHttpResponse } from '../integration/e2e/internal/transports/http.js';
import type {
  VmProfile,
  VmProvider,
} from '../integration/e2e/internal/profiles.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';

const cloudContext: CloudVmHostDeletionContext = {
  availabilityZone: 'a',
  cloudId: 'cloud-vm-1',
  fixtureId: 'vm-host-loss-run',
  region: 'us-east-2',
};

const persistentContext: PersistentVmRunningContext = {
  ...cloudContext,
  baseImageId: '',
  ref: trackedWorkloadRefForTest(cloudContext.fixtureId),
  sshHost: '192.0.2.10',
  sshPort: 22,
  sshUsername: 'root',
};

const azurePrefix =
  '/subscriptions/subscription-id/resourceGroups/anycloud-east-us/providers/Microsoft.Compute';
const azureVmId = `${azurePrefix}/virtualMachines/cloud-vm-1`;
const azureDiskId = `${azurePrefix}/disks/os-disk-1`;
const azureOwner = {
  anycloud_deployment: 'workload-owned',
  anycloud_user: 'user-owned',
  anycloud_owner_api: 'api-owned',
};
const azureProfile = () =>
  vmProfile('azure', {
    cloudProvider: CloudType.Azure,
    applicationId: 'application-id',
    secret: 'client-secret',
    directoryId: 'directory-id',
    subscriptionId: 'subscription-id',
  });

interface CommandCall {
  readonly args: readonly string[];
  readonly executable: string;
  readonly options: CommandOptions;
}

class FakeCommands {
  readonly calls: CommandCall[] = [];
  failureLabel: string | undefined;
  readonly responses = new Map<string, unknown>([
    [
      'azure-read-vm-host',
      {
        id: azureVmId,
        tags: azureOwner,
        storageProfile: {
          osDisk: { name: 'os-disk-1', managedDisk: { id: azureDiskId } },
        },
      },
    ],
    [
      'azure-read-vm-host-disk',
      { id: azureDiskId, managedBy: azureVmId, tags: { custom: 'retain' } },
    ],
    [
      'azure-verify-vm-host-disk-owner',
      {
        id: azureDiskId,
        managedBy: azureVmId,
        tags: { custom: 'retain', ...azureOwner },
      },
    ],
  ]);

  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ args, executable, options });
    const failed = options.label === this.failureLabel;
    return {
      executable,
      args,
      exitCode: failed ? 1 : 0,
      signal: null,
      stdout: this.responses.has(options.label ?? '')
        ? JSON.stringify(this.responses.get(options.label ?? ''))
        : '',
      stderr: '',
      combined: '',
      durationMs: 1,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    };
  }
}

interface FileWrite {
  readonly contents: string;
  readonly name: string;
}

class FakeFiles {
  readonly directories: string[] = [];
  readonly writes: FileWrite[] = [];

  async directory(name: string): Promise<string> {
    this.directories.push(name);
    return `/tmp/${name}`;
  }

  async privateText(name: string, contents: string): Promise<string> {
    this.writes.push({ contents, name });
    return `/tmp/${name}`;
  }
}

interface HttpCall {
  readonly body?: unknown;
  readonly label: string;
  readonly url: string;
}

class FakeHttp {
  readonly calls: HttpCall[] = [];
  deleteResponse: TargetHttpResponse = { body: null, status: 204 };
  postResponse: TargetHttpResponse = {
    body: { data: { terminated_instances: [{ id: 'cloud-vm-1' }] } },
    status: 200,
  };

  async delete(label: string, url: URL): Promise<TargetHttpResponse> {
    this.calls.push({ label, url: url.toString() });
    return this.deleteResponse;
  }

  async post(
    label: string,
    url: URL,
    body: unknown,
  ): Promise<TargetHttpResponse> {
    this.calls.push({ body, label, url: url.toString() });
    return this.postResponse;
  }
}

function vmProfile(
  provider: VmProvider,
  credential: Exclude<CloudCredential, { cloudProvider: CloudType.Cloudflare }>,
): VmProfile {
  return {
    slug: provider,
    provider: credential.cloudProvider,
    credentialName: `${provider}-test`,
    credential,
    vmTypes: ['test-vm'],
  };
}

function deleter(profile: VmProfile): {
  readonly commands: FakeCommands;
  readonly files: FakeFiles;
  readonly http: FakeHttp;
  readonly subject: PublicCloudVmHostDeleter;
} {
  const commands = new FakeCommands();
  const files = new FakeFiles();
  const http = new FakeHttp();
  return {
    commands,
    files,
    http,
    subject: new PublicCloudVmHostDeleter(profile, commands, files, http),
  };
}

describe('persistent VM host deletion adapters', () => {
  test('terminates the exact AWS instance in its persisted region', async () => {
    const harness = deleter(
      vmProfile('aws', {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'access-id',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-token',
      }),
    );

    await harness.subject.deleteHost(cloudContext);

    expect(harness.commands.calls).toHaveLength(1);
    expect(harness.commands.calls[0]).toMatchObject({
      executable: 'aws',
      args: [
        'ec2',
        'terminate-instances',
        '--instance-ids',
        'cloud-vm-1',
        '--region',
        'us-east-2',
        '--no-cli-pager',
      ],
      options: {
        env: {
          AWS_ACCESS_KEY_ID: 'access-id',
          AWS_PAGER: '',
          AWS_SECRET_ACCESS_KEY: 'secret-key',
          AWS_SESSION_TOKEN: 'session-token',
        },
      },
    });
  });

  test('propagates a provider command failure', async () => {
    const harness = deleter(
      vmProfile('aws', {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'access-id',
        secretAccessKey: 'secret-key',
      }),
    );
    harness.commands.failureLabel = 'aws-delete-vm-host';

    await expect(harness.subject.deleteHost(cloudContext)).rejects.toThrow(
      'aws-delete-vm-host failed',
    );
  });

  test('deletes the Azure VM and its directly attached resources', async () => {
    const harness = deleter(azureProfile());

    await harness.subject.deleteHost({
      ...cloudContext,
      region: 'East US',
    });

    expect(harness.commands.calls.map((call) => call.options.label)).toEqual([
      'azure-host-loss-login',
      'azure-host-loss-subscription',
      'azure-read-vm-host',
      'azure-read-vm-host-disk',
      'azure-preserve-vm-host-disk-owner',
      'azure-verify-vm-host-disk-owner',
      'azure-delete-vm-host',
      'azure-delete-vm-host-disk',
      'azure-delete-vm-host-nic',
      'azure-delete-vm-host-public-ip',
    ]);
    expect(harness.files.directories).toEqual(['azure/vm-host-loss-run']);
    expect(
      harness.commands.calls.every(
        (call) =>
          call.options.env?.AZURE_CONFIG_DIR ===
            '/tmp/azure/vm-host-loss-run' &&
          call.options.env?.AZURE_CORE_COLLECT_TELEMETRY === 'false',
      ),
    ).toBe(true);
    expect(harness.commands.calls[2]?.args).toContain('anycloud-east-us');
    expect(harness.commands.calls[4]?.args).toEqual([
      'tag',
      'update',
      '--resource-id',
      azureDiskId,
      '--operation',
      'Merge',
      '--tags',
      ...Object.entries(azureOwner).map(([key, value]) => `${key}=${value}`),
      '--only-show-errors',
      '--output',
      'none',
    ]);
    expect(harness.commands.calls[6]?.args).toContain(azureVmId);
    expect(harness.commands.calls[7]?.args).toContain(azureDiskId);
  });

  test.each([
    'azure-read-vm-host',
    'azure-read-vm-host-disk',
    'azure-preserve-vm-host-disk-owner',
    'azure-verify-vm-host-disk-owner',
  ])('does not delete resources after %s fails', async (label) => {
    const harness = deleter(azureProfile());
    harness.commands.failureLabel = label;
    await expect(
      harness.subject.deleteHost({ ...cloudContext, region: 'East US' }),
    ).rejects.toThrow(`${label} failed`);
    expect(
      harness.commands.calls.some((call) => call.args.includes('delete')),
    ).toBe(false);
  });

  test.each([
    {
      name: 'foreign disk ID',
      disk: { id: `${azureDiskId}-neighbor`, managedBy: azureVmId },
    },
    {
      name: 'foreign attachment',
      disk: { id: azureDiskId, managedBy: `${azureVmId}-neighbor` },
    },
    { name: 'missing attachment', disk: { id: azureDiskId } },
    {
      name: 'foreign API owner',
      disk: {
        id: azureDiskId,
        managedBy: azureVmId,
        tags: { anycloud_owner_api: 'neighbor' },
      },
    },
    {
      name: 'foreign workload',
      disk: {
        id: azureDiskId,
        managedBy: azureVmId,
        tags: { anycloud_deployment: 'neighbor' },
      },
    },
  ])(
    'refuses $name before tagging or deleting the Azure host',
    async ({ disk }) => {
      const harness = deleter(azureProfile());
      harness.commands.responses.set('azure-read-vm-host-disk', disk);
      await expect(
        harness.subject.deleteHost({ ...cloudContext, region: 'East US' }),
      ).rejects.toThrow(/attached|ownership/);
      expect(
        harness.commands.calls.some(
          (call) => call.args.includes('delete') || call.args[0] === 'tag',
        ),
      ).toBe(false);
    },
  );

  test.each([
    { id: `${azureVmId}-neighbor`, tags: azureOwner, diskId: azureDiskId },
    { id: azureVmId, tags: {}, diskId: azureDiskId },
    { id: azureVmId, tags: azureOwner, diskId: `${azureDiskId}-neighbor` },
  ])(
    'refuses invalid VM ownership or OS disk references',
    async ({ id, tags, diskId }) => {
      const harness = deleter(azureProfile());
      harness.commands.responses.set('azure-read-vm-host', {
        id,
        tags,
        storageProfile: {
          osDisk: { name: 'os-disk-1', managedDisk: { id: diskId } },
        },
      });
      await expect(
        harness.subject.deleteHost({ ...cloudContext, region: 'East US' }),
      ).rejects.toThrow(/identity|owner/);
      expect(
        harness.commands.calls.some(
          (call) => call.args.includes('delete') || call.args[0] === 'tag',
        ),
      ).toBe(false);
    },
  );

  test('retains the Azure VM when the tag write did not persist all disk ownership', async () => {
    const harness = deleter(azureProfile());
    harness.commands.responses.set('azure-verify-vm-host-disk-owner', {
      id: azureDiskId,
      managedBy: azureVmId,
      tags: { ...azureOwner },
    });
    await expect(
      harness.subject.deleteHost({ ...cloudContext, region: 'East US' }),
    ).rejects.toThrow('ownership was not persisted');
    expect(
      harness.commands.calls.some((call) => call.args.includes('delete')),
    ).toBe(false);
  });

  test('isolates GCP authentication and deletes in the recorded zone', async () => {
    const harness = deleter(
      vmProfile('gcp', {
        cloudProvider: CloudType.GCP,
        projectId: 'project-id',
        privateKey: 'private-key',
        clientEmail: 'service@example.com',
      }),
    );

    await harness.subject.deleteHost({
      ...cloudContext,
      availabilityZone: 'b',
      region: 'us-central1',
    });

    expect(harness.files.directories).toEqual(['gcloud/vm-host-loss-run']);
    expect(harness.files.writes).toHaveLength(1);
    const key = harness.files.writes[0];
    if (!key) throw new Error('GCP key file was not written');
    expect(JSON.parse(key.contents)).toMatchObject({
      project_id: 'project-id',
      private_key: 'private-key',
      client_email: 'service@example.com',
    });
    expect(harness.commands.calls[0]?.options.env).toEqual({
      CLOUDSDK_CONFIG: '/tmp/gcloud/vm-host-loss-run',
    });
    expect(harness.commands.calls[1]?.args).toContain('--zone=us-central1-b');
  });

  test('requires Lambda to acknowledge the exact terminated instance', async () => {
    const harness = deleter(
      vmProfile('lambda', {
        cloudProvider: CloudType.Lambda,
        apiKey: 'lambda-key',
      }),
    );

    await harness.subject.deleteHost(cloudContext);

    expect(harness.http.calls).toEqual([
      {
        body: { instance_ids: ['cloud-vm-1'] },
        label: 'lambda-delete-vm-host',
        url: 'https://cloud.lambda.ai/api/v1/instance-operations/terminate',
      },
    ]);
    harness.http.postResponse = {
      body: { data: { terminated_instances: [{ id: 'different-vm' }] } },
      status: 200,
    };
    await expect(harness.subject.deleteHost(cloudContext)).rejects.toThrow(
      'Lambda rejected cloud-vm-1',
    );
  });

  test('deletes the exact local smolvm machine with force enabled', async () => {
    const http = new FakeHttp();

    await deleteLocalSmolvmHost(
      http,
      new URL('http://127.0.0.1:18089'),
      persistentContext,
    );

    expect(http.calls).toEqual([
      {
        label: 'local-delete-vm-host',
        url: 'http://127.0.0.1:18089/api/v1/machines/cloud-vm-1?force=true',
      },
    ]);

    http.deleteResponse = { body: null, status: 409 };
    await expect(
      deleteLocalSmolvmHost(
        http,
        new URL('http://127.0.0.1:18089'),
        persistentContext,
      ),
    ).rejects.toThrow('Local host deletion returned HTTP 409');
  });

  test('parses both Lambda termination acknowledgement envelopes', () => {
    expect(
      lambdaAcceptedHostDeletion(
        { data: { terminated_instances: [{ id: 'cloud-vm-1' }] } },
        'cloud-vm-1',
      ),
    ).toBe(true);
    expect(
      lambdaAcceptedHostDeletion(
        { terminated_instances: [{ id: 'cloud-vm-1' }] },
        'cloud-vm-1',
      ),
    ).toBe(true);
    expect(lambdaAcceptedHostDeletion({}, 'cloud-vm-1')).toBe(false);
  });
});
