import { CloudType } from '../../../../../src/shared/cloud.js';

import type { FixtureFiles } from '../files.js';
import type { ProcessRunner } from '../process.js';
import type { VmProfile } from '../profiles.js';
import { isRecord, scalarString } from '../types.js';
import type { TargetHttpClient, TargetHttpResponse } from './http.js';

type CommandRunner = Pick<ProcessRunner, 'run'>;
type HostLossFiles = Pick<FixtureFiles, 'directory' | 'privateText'>;
type HostLossHttp = Pick<TargetHttpClient, 'post'>;

export interface CloudVmHostDeletionContext {
  readonly availabilityZone: string | null;
  readonly cloudId: string;
  readonly fixtureId: string;
  readonly region: string | null;
}

function required(value: string | null, message: string): string {
  if (!value) throw new Error(`Cloud VM host deletion: ${message}`);
  return value;
}

function responseSucceeded(response: TargetHttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function azureTags(value: unknown): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error('Cloud VM host deletion: Azure resource tags are invalid');
  }
  const tags: Record<string, string> = {};
  for (const [key, tag] of Object.entries(value)) {
    if (typeof tag !== 'string') {
      throw new Error(
        'Cloud VM host deletion: Azure resource tags are invalid',
      );
    }
    tags[key] = tag;
  }
  return tags;
}

function attachedAzureDiskTags(
  disk: unknown,
  diskId: string,
  vmId: string,
  vmTags: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (
    !isRecord(disk) ||
    typeof disk.id !== 'string' ||
    disk.id.toLowerCase() !== diskId.toLowerCase() ||
    typeof disk.managedBy !== 'string' ||
    disk.managedBy.toLowerCase() !== vmId.toLowerCase()
  ) {
    throw new Error(
      'Cloud VM host deletion: Azure OS disk is not the exact attached disk',
    );
  }
  const tags = azureTags(disk.tags);
  for (const key of [
    'anycloud_resource',
    'anycloud_deployment',
    'anycloud_user',
    'anycloud_owner_api',
  ]) {
    if (tags[key] !== undefined && tags[key] !== vmTags[key]) {
      throw new Error(
        `Cloud VM host deletion: Azure OS disk has conflicting ${key} ownership`,
      );
    }
  }
  return tags;
}

export function lambdaAcceptedHostDeletion(
  value: unknown,
  expectedCloudId: string,
): boolean {
  if (!isRecord(value)) return false;
  const data = isRecord(value.data) ? value.data : value;
  const terminated = data.terminated_instances;
  return (
    Array.isArray(terminated) &&
    terminated.some(
      (candidate) =>
        isRecord(candidate) && scalarString(candidate.id) === expectedCloudId,
    )
  );
}

export class PublicCloudVmHostDeleter {
  readonly #commands: CommandRunner;
  readonly #files: HostLossFiles;
  readonly #http: HostLossHttp;
  readonly #profile: VmProfile;

  constructor(
    profile: VmProfile,
    commands: CommandRunner,
    files: HostLossFiles,
    http: HostLossHttp,
  ) {
    this.#profile = profile;
    this.#commands = commands;
    this.#files = files;
    this.#http = http;
  }

  async deleteHost(context: CloudVmHostDeletionContext): Promise<void> {
    switch (this.#profile.provider) {
      case CloudType.AWS:
        await this.#deleteAws(context);
        return;
      case CloudType.Azure:
        await this.#deleteAzure(context);
        return;
      case CloudType.GCP:
        await this.#deleteGcp(context);
        return;
      case CloudType.Lambda:
        await this.#deleteLambda(context);
    }
  }

  async #run(
    executable: string,
    args: readonly string[],
    label: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<string> {
    const result = await this.#commands.run(executable, args, {
      ...(environment ? { env: environment } : {}),
      label,
      timeoutMs: 180_000,
    });
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw new Error(
        `Cloud VM host deletion: ${label} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}, aborted ${String(result.aborted)})`,
      );
    }
    return result.stdout.trim();
  }

  async #deleteAws(context: CloudVmHostDeletionContext): Promise<void> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.AWS) {
      throw new Error('Cloud VM host deletion: AWS credential mismatch');
    }
    await this.#run(
      'aws',
      [
        'ec2',
        'terminate-instances',
        '--instance-ids',
        context.cloudId,
        '--region',
        required(context.region, 'AWS region is missing'),
        '--no-cli-pager',
      ],
      'aws-delete-vm-host',
      {
        AWS_ACCESS_KEY_ID: credential.accessKeyId,
        AWS_PAGER: '',
        AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
        AWS_SESSION_TOKEN: credential.sessionToken,
      },
    );
  }

  async #deleteAzure(context: CloudVmHostDeletionContext): Promise<void> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.Azure) {
      throw new Error('Cloud VM host deletion: Azure credential mismatch');
    }
    const region = required(context.region, 'Azure region is missing');
    const resourceGroup = `anycloud-${region
      .toLowerCase()
      .replaceAll(' ', '-')}`;
    const configDirectory = await this.#files.directory(
      `azure/${context.fixtureId}`,
    );
    const environment = {
      AZURE_CONFIG_DIR: configDirectory,
      // A detached telemetry uploader would write here after az returns.
      AZURE_CORE_COLLECT_TELEMETRY: 'false',
    };
    await this.#run(
      'az',
      [
        'login',
        '--service-principal',
        '--username',
        credential.applicationId,
        '--password',
        credential.secret,
        '--tenant',
        credential.directoryId,
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-host-loss-login',
      environment,
    );
    await this.#run(
      'az',
      ['account', 'set', '--subscription', credential.subscriptionId],
      'azure-host-loss-subscription',
      environment,
    );
    const resourceArgs = [
      '--resource-group',
      resourceGroup,
      '--name',
      context.cloudId,
    ];
    const prefix = `/subscriptions/${credential.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute`;
    const vmId = `${prefix}/virtualMachines/${context.cloudId}`;
    const vm: unknown = JSON.parse(
      await this.#run(
        'az',
        [
          'vm',
          'show',
          ...resourceArgs,
          '--output',
          'json',
          '--only-show-errors',
        ],
        'azure-read-vm-host',
        environment,
      ),
    );
    if (
      context.cloudId.includes('/') ||
      !isRecord(vm) ||
      typeof vm.id !== 'string' ||
      vm.id.toLowerCase() !== vmId.toLowerCase() ||
      !isRecord(vm.storageProfile) ||
      !isRecord(vm.storageProfile.osDisk)
    ) {
      throw new Error('Cloud VM host deletion: Azure VM identity is invalid');
    }
    const osDisk = vm.storageProfile.osDisk;
    const diskId = `${prefix}/disks/${scalarString(osDisk.name)}`;
    if (
      typeof osDisk.name !== 'string' ||
      !osDisk.name ||
      osDisk.name.includes('/') ||
      !isRecord(osDisk.managedDisk) ||
      typeof osDisk.managedDisk.id !== 'string' ||
      osDisk.managedDisk.id.toLowerCase() !== diskId.toLowerCase()
    ) {
      throw new Error(
        'Cloud VM host deletion: Azure OS disk identity is invalid',
      );
    }
    const vmTags = azureTags(vm.tags);
    if (!vmTags.anycloud_resource && !vmTags.anycloud_deployment) {
      throw new Error(
        'Cloud VM host deletion: Azure VM has no durable cleanup owner',
      );
    }
    const diskArgs = [
      'disk',
      'show',
      '--ids',
      diskId,
      '--output',
      'json',
      '--only-show-errors',
    ];
    const diskTags = attachedAzureDiskTags(
      JSON.parse(
        await this.#run('az', diskArgs, 'azure-read-vm-host-disk', environment),
      ),
      diskId,
      vmId,
      vmTags,
    );
    const ownerTags = Object.entries(vmTags).filter(([key]) =>
      key.startsWith('anycloud_'),
    );
    // The VM's disk reference is the ownership proof until deletion. Persist
    // that owner on the Disk resource before the VM association is destroyed.
    await this.#run(
      'az',
      [
        'tag',
        'update',
        '--resource-id',
        diskId,
        '--operation',
        'Merge',
        '--tags',
        ...ownerTags.map(([key, value]) => `${key}=${value}`),
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-preserve-vm-host-disk-owner',
      environment,
    );
    const persistedTags = attachedAzureDiskTags(
      JSON.parse(
        await this.#run(
          'az',
          diskArgs,
          'azure-verify-vm-host-disk-owner',
          environment,
        ),
      ),
      diskId,
      vmId,
      vmTags,
    );
    const expectedTags = { ...diskTags, ...Object.fromEntries(ownerTags) };
    if (
      Object.entries(expectedTags).some(
        ([key, value]) => persistedTags[key] !== value,
      )
    ) {
      throw new Error(
        'Cloud VM host deletion: Azure OS disk cleanup ownership was not persisted',
      );
    }
    await this.#run(
      'az',
      [
        'vm',
        'delete',
        '--ids',
        vmId,
        '--yes',
        '--force-deletion',
        'true',
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-delete-vm-host',
      environment,
    );
    await this.#run(
      'az',
      [
        'disk',
        'delete',
        '--ids',
        diskId,
        '--yes',
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-delete-vm-host-disk',
      environment,
    );
    await this.#run(
      'az',
      [
        'network',
        'nic',
        'delete',
        ...resourceArgs,
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-delete-vm-host-nic',
      environment,
    );
    await this.#run(
      'az',
      [
        'network',
        'public-ip',
        'delete',
        ...resourceArgs,
        '--only-show-errors',
        '--output',
        'none',
      ],
      'azure-delete-vm-host-public-ip',
      environment,
    );
  }

  async #deleteGcp(context: CloudVmHostDeletionContext): Promise<void> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.GCP) {
      throw new Error('Cloud VM host deletion: GCP credential mismatch');
    }
    const region = required(context.region, 'GCP region is missing');
    const availabilityZone = required(
      context.availabilityZone,
      'GCP availability zone is missing',
    );
    const configDirectory = await this.#files.directory(
      `gcloud/${context.fixtureId}`,
    );
    const keyPath = await this.#files.privateText(
      `gcloud/${context.fixtureId}/key.json`,
      JSON.stringify({
        type: 'service_account',
        project_id: credential.projectId,
        private_key: credential.privateKey,
        client_email: credential.clientEmail,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    const environment = { CLOUDSDK_CONFIG: configDirectory };
    await this.#run(
      'gcloud',
      [
        'auth',
        'activate-service-account',
        credential.clientEmail,
        `--key-file=${keyPath}`,
        `--project=${credential.projectId}`,
        '--quiet',
      ],
      'gcp-host-loss-auth',
      environment,
    );
    await this.#run(
      'gcloud',
      [
        'compute',
        'instances',
        'delete',
        context.cloudId,
        `--project=${credential.projectId}`,
        `--zone=${region}-${availabilityZone}`,
        '--quiet',
      ],
      'gcp-delete-vm-host',
      environment,
    );
  }

  async #deleteLambda(context: CloudVmHostDeletionContext): Promise<void> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.Lambda) {
      throw new Error('Cloud VM host deletion: Lambda credential mismatch');
    }
    const response = await this.#http.post(
      'lambda-delete-vm-host',
      new URL('https://cloud.lambda.ai/api/v1/instance-operations/terminate'),
      { instance_ids: [context.cloudId] },
      {
        headers: {
          Authorization: `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (
      !responseSucceeded(response) ||
      !lambdaAcceptedHostDeletion(response.body, context.cloudId)
    ) {
      throw new Error(
        `Cloud VM host deletion: Lambda rejected ${context.cloudId} with HTTP ${String(response.status)}`,
      );
    }
  }
}
