import { CloudType } from '../../../../../src/shared/cloud.js';
import type { ArtifactStore } from '../artifacts.js';
import type {
  JobNativeAttempt,
  JobRecoveryIdentity,
  JobDiskTierObservation,
  JobHydrationDisk,
} from '../targets/job-types.js';
import { isRecord } from '../types.js';
import { JobCloudSession } from './job-cloud-session.js';
import { JobPrivateCommandFailure, privateJobJson } from './job-command.js';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
/**
 * Budget for a provider command that returns only once the host is deleted:
 * GCE deletes take 30–120 s, Azure VM deletes one to three minutes. The
 * 30 s per-command default is for reads and asynchronous acknowledgements
 * (AWS `terminate-instances`, `gcloud … stop --async`, `az … --no-wait`).
 */
export const SYNCHRONOUS_HOST_DELETE_MS = 4 * 60_000;

/** Provider-native faults and immutable VM/boot-disk observations; the family owns recovery policy. */
export class JobRecoveryTransport {
  readonly #session: JobCloudSession;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  #observations = 0;
  constructor(
    session: JobCloudSession,
    artifacts: Pick<ArtifactStore, 'json'>,
  ) {
    this.#session = session;
    this.#artifacts = artifacts;
  }

  async identity(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobRecoveryIdentity> {
    if (
      attempt.cloudProvider !== this.#session.credential.cloudProvider ||
      attempt.endedAt !== null
    )
      throw new Error(
        'Job recovery requires its live original provider attempt',
      );
    await this.#session.initialize(deadlineAt);
    let identity: JobRecoveryIdentity;
    switch (this.#session.credential.cloudProvider) {
      case CloudType.AWS:
        identity = await this.#awsIdentity(attempt, deadlineAt);
        break;
      case CloudType.GCP:
        identity = await this.#gcpIdentity(attempt, deadlineAt);
        break;
      case CloudType.Azure:
        identity = await this.#azureIdentity(attempt, deadlineAt);
        break;
    }
    await this.#artifacts.json(
      `job-${attempt.ref.id}-recovery-native-${++this.#observations}`,
      {
        workloadId: attempt.ref.id,
        rowId: attempt.rowId,
        credentialId: attempt.credentialId,
        observedAt: Date.now(),
        identity,
      },
    );
    return Object.freeze(identity);
  }

  async stop(
    attempt: JobNativeAttempt,
    expected: JobRecoveryIdentity,
  ): Promise<void> {
    const deadlineAt = Date.now() + 300_000;
    const current = await this.identity(attempt, deadlineAt);
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error(
        'Job recovery fault no longer names the original native VM and disk',
      );
    switch (this.#session.credential.cloudProvider) {
      case CloudType.AWS: {
        const stopped = privateJobJson(
          await this.#session.aws(
            ['ec2', 'stop-instances', '--instance-ids', attempt.cloudId],
            attempt.region,
            deadlineAt,
          ),
        );
        if (
          !isRecord(stopped) ||
          !Array.isArray(stopped.StoppingInstances) ||
          stopped.StoppingInstances.length !== 1 ||
          !isRecord(stopped.StoppingInstances[0]) ||
          stopped.StoppingInstances[0].InstanceId !== attempt.cloudId ||
          !isRecord(stopped.StoppingInstances[0].CurrentState) ||
          !['stopping', 'stopped'].includes(
            String(stopped.StoppingInstances[0].CurrentState.Name),
          )
        )
          throw new Error(
            'Job AWS stop returned an incomplete or foreign acknowledgement',
          );
        break;
      }
      case CloudType.GCP: {
        const zone = this.#gcpZone(attempt);
        const stopped = privateJobJson(
          await this.#session.gcp(
            [
              'compute',
              'instances',
              'stop',
              attempt.cloudId,
              `--zone=${zone}`,
              '--async',
              '--format=json',
            ],
            deadlineAt,
          ),
        );
        const operation: unknown =
          Array.isArray(stopped) && stopped.length === 1 ? stopped[0] : stopped;
        if (
          !isRecord(operation) ||
          operation.operationType !== 'stop' ||
          operation.targetLink !== this.#gcpInstanceUrl(attempt)
        )
          throw new Error(
            'Job GCP stop returned an incomplete or foreign acknowledgement',
          );
        break;
      }
      case CloudType.Azure:
        await this.#evictAzure(attempt, deadlineAt);
        break;
    }
    await this.#artifacts.json(`job-${attempt.ref.id}-recovery-fault`, {
      workloadId: attempt.ref.id,
      rowId: attempt.rowId,
      credentialId: attempt.credentialId,
      identity: expected,
      acknowledgedAt: Date.now(),
      kind: 'in-place-stop',
    });
  }

  async deleteHost(
    attempt: JobNativeAttempt,
    expected: JobRecoveryIdentity,
  ): Promise<void> {
    const deadlineAt = Date.now() + 300_000;
    const current = await this.identity(attempt, deadlineAt);
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error(
        'Job deletion no longer names the original native VM and disk',
      );
    const requestedAt = Date.now();
    switch (this.#session.credential.cloudProvider) {
      case CloudType.AWS: {
        const deleted = privateJobJson(
          await this.#session.aws(
            ['ec2', 'terminate-instances', '--instance-ids', attempt.cloudId],
            attempt.region,
            deadlineAt,
          ),
        );
        if (
          !isRecord(deleted) ||
          !Array.isArray(deleted.TerminatingInstances) ||
          deleted.TerminatingInstances.length !== 1 ||
          !isRecord(deleted.TerminatingInstances[0]) ||
          deleted.TerminatingInstances[0].InstanceId !== attempt.cloudId ||
          !isRecord(deleted.TerminatingInstances[0].CurrentState) ||
          !['shutting-down', 'terminated'].includes(
            String(deleted.TerminatingInstances[0].CurrentState.Name),
          )
        )
          throw new Error(
            'Job AWS deletion returned an incomplete or foreign acknowledgement',
          );
        break;
      }
      case CloudType.GCP:
        // `instances delete` has no `--async` (gcloud exits 2 on the unknown
        // flag) and returns only once the instance is gone, so exit 0 is the
        // acknowledgement; the API's host-loss observation follows.
        await this.#session.gcp(
          [
            'compute',
            'instances',
            'delete',
            attempt.cloudId,
            `--zone=${this.#gcpZone(attempt)}`,
            '--quiet',
          ],
          deadlineAt,
          false,
          SYNCHRONOUS_HOST_DELETE_MS,
        );
        break;
      case CloudType.Azure:
        // `az vm delete` blocks until the VM is gone as well.
        await this.#session.azure(
          [
            'vm',
            'delete',
            ...this.#azureArgs(attempt),
            '--yes',
            '--force-deletion',
            'true',
            '--output',
            'json',
          ],
          deadlineAt,
          false,
          SYNCHRONOUS_HOST_DELETE_MS,
        );
        break;
    }
    await this.#artifacts.json(`job-${attempt.ref.id}-recovery-fault`, {
      workloadId: attempt.ref.id,
      rowId: attempt.rowId,
      credentialId: attempt.credentialId,
      identity: expected,
      requestedAt,
      acknowledgedAt: Date.now(),
      kind: 'host-delete',
    });
  }

  async #awsIdentity(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobRecoveryIdentity> {
    if (!/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u.test(attempt.cloudId))
      throw new Error('Job AWS recovery lacks a concrete instance ID');
    const body = privateJobJson(
      await this.#session.aws(
        [
          'ec2',
          'describe-instances',
          '--instance-ids',
          attempt.cloudId,
          '--no-paginate',
        ],
        attempt.region,
        deadlineAt,
      ),
    );
    if (
      !isRecord(body) ||
      !Array.isArray(body.Reservations) ||
      body.Reservations.length !== 1 ||
      body.NextToken !== undefined ||
      !isRecord(body.Reservations[0]) ||
      body.Reservations[0].OwnerId !== this.#session.accountId ||
      !Array.isArray(body.Reservations[0].Instances) ||
      body.Reservations[0].Instances.length !== 1
    )
      throw new Error(
        'Job AWS recovery inventory is incomplete or belongs to another account',
      );
    const vm: unknown = body.Reservations[0].Instances[0];
    const originalZone =
      attempt.availabilityZone === null
        ? null
        : /^[a-z]$/u.test(attempt.availabilityZone)
          ? `${attempt.region}${attempt.availabilityZone}`
          : /^[0-9]+[a-z]$/u.test(attempt.availabilityZone)
            ? `${attempt.region.slice(0, attempt.region.lastIndexOf('-') + 1)}${attempt.availabilityZone}`
            : attempt.availabilityZone;
    if (
      !isRecord(vm) ||
      vm.InstanceId !== attempt.cloudId ||
      vm.InstanceType !== attempt.vmType ||
      !isRecord(vm.State) ||
      vm.State.Name !== 'running' ||
      !isRecord(vm.Placement) ||
      typeof vm.Placement.AvailabilityZone !== 'string' ||
      !vm.Placement.AvailabilityZone.startsWith(attempt.region) ||
      (originalZone !== null &&
        vm.Placement.AvailabilityZone !== originalZone) ||
      typeof vm.RootDeviceName !== 'string' ||
      !Array.isArray(vm.BlockDeviceMappings)
    )
      throw new Error('Job AWS recovery VM changed its original placement');
    const disks = vm.BlockDeviceMappings.filter(
      (disk: unknown) =>
        isRecord(disk) && disk.DeviceName === vm.RootDeviceName,
    );
    if (
      disks.length !== 1 ||
      !isRecord(disks[0]) ||
      !isRecord(disks[0].Ebs) ||
      typeof disks[0].Ebs.VolumeId !== 'string' ||
      !/^vol-[a-f0-9]+$/u.test(disks[0].Ebs.VolumeId)
    )
      throw new Error('Job AWS recovery requires exactly one native boot disk');
    return {
      cloudId: attempt.cloudId,
      vmId: attempt.cloudId,
      osDiskId: disks[0].Ebs.VolumeId,
      region: attempt.region,
      zone: vm.Placement.AvailabilityZone,
      vmType: attempt.vmType,
    };
  }

  #gcpZone(attempt: JobNativeAttempt): string {
    if (
      !/^[a-z]+-[a-z]+[1-9][0-9]*$/u.test(attempt.region) ||
      !/^[a-z]$/u.test(attempt.availabilityZone ?? '') ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(attempt.cloudId)
    )
      throw new Error('Job GCP recovery lacks its exact original zone');
    return `${attempt.region}-${attempt.availabilityZone}`;
  }
  #gcpInstanceUrl(attempt: JobNativeAttempt): string {
    const credential = this.#session.credential;
    if (credential.cloudProvider !== CloudType.GCP)
      throw new Error('Job GCP recovery authorization is mismatched');
    return `https://www.googleapis.com/compute/v1/projects/${credential.projectId}/zones/${this.#gcpZone(attempt)}/instances/${attempt.cloudId}`;
  }
  async #gcpIdentity(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobRecoveryIdentity> {
    return (await this.#gcpDisk(attempt, deadlineAt)).identity;
  }

  /** The name of the VPC (AWS) or network (GCP) the live original VM is in. */
  async network(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<string> {
    if (
      attempt.cloudProvider !== this.#session.credential.cloudProvider ||
      attempt.endedAt !== null
    )
      throw new Error(
        'Network observation requires its live original provider attempt',
      );
    await this.#session.initialize(deadlineAt);
    if (this.#session.credential.cloudProvider === CloudType.AWS) {
      // Pins the live original VM in this account before reading its VPC.
      await this.#awsIdentity(attempt, deadlineAt);
      const read = async (args: string[]) =>
        privateJobJson(
          await this.#session.aws(args, attempt.region, deadlineAt),
        ) as any;
      const vpcId = (
        await read([
          'ec2',
          'describe-instances',
          '--instance-ids',
          attempt.cloudId,
        ])
      )?.Reservations?.[0]?.Instances?.[0]?.VpcId;
      if (typeof vpcId !== 'string' || !/^vpc-[a-f0-9]+$/u.test(vpcId))
        throw new Error('Network observation found no VPC');
      const vpc = (await read(['ec2', 'describe-vpcs', '--vpc-ids', vpcId]))
        ?.Vpcs?.[0];
      const name =
        vpc?.VpcId === vpcId
          ? vpc.Tags?.find((tag: any) => tag.Key === 'Name')?.Value
          : undefined;
      return typeof name === 'string' ? name : `${vpcId} (unnamed)`;
    }
    const vm = privateJobJson(
      await this.#session.gcp(
        [
          'compute',
          'instances',
          'describe',
          attempt.cloudId,
          `--zone=${this.#gcpZone(attempt)}`,
          '--format=json(networkInterfaces)',
        ],
        deadlineAt,
      ),
    );
    const network =
      isRecord(vm) && Array.isArray(vm.networkInterfaces)
        ? (vm.networkInterfaces[0] as Record<string, unknown> | undefined)
            ?.network
        : undefined;
    if (typeof network !== 'string')
      throw new Error('Network observation found no network interface');
    return network.slice(network.lastIndexOf('/') + 1);
  }

  async diskTier(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobDiskTierObservation> {
    if (
      attempt.cloudProvider !== this.#session.credential.cloudProvider ||
      attempt.endedAt !== null
    )
      throw new Error(
        'Disk-tier observation requires its live original provider attempt',
      );
    await this.#session.initialize(deadlineAt);
    if (this.#session.credential.cloudProvider === CloudType.AWS) {
      const identity = await this.#awsIdentity(attempt, deadlineAt);
      const root = await awsRootDisk(this.#session, identity, deadlineAt);
      return Object.freeze({
        ref: attempt.ref,
        rowId: attempt.rowId,
        identity: Object.freeze(identity),
        diskType: root.type,
        sizeGb: root.sizeGb,
        provisionedIops: root.iops,
        provisionedThroughput: root.throughput,
      });
    }
    const { identity, disk } = await this.#gcpDisk(attempt, deadlineAt);
    const prefix = `${this.#gcpInstanceUrl(attempt).split('/instances/')[0]}/diskTypes/`;
    if (
      typeof disk.type !== 'string' ||
      !disk.type.startsWith(prefix) ||
      !/^[a-z][a-z0-9-]+$/u.test(disk.type.slice(prefix.length))
    )
      throw new Error(
        'Disk-tier observation has a missing or foreign disk type',
      );
    const integer = (value: unknown): number => {
      if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        !/^[1-9][0-9]*$/u.test(String(value)) ||
        !Number.isSafeInteger(Number(value))
      )
        throw new Error(
          'Disk-tier observation has an invalid native size or performance value',
        );
      return Number(value);
    };
    return Object.freeze({
      ref: attempt.ref,
      rowId: attempt.rowId,
      identity: Object.freeze(identity),
      diskType: disk.type.slice(prefix.length),
      sizeGb: integer(disk.sizeGb),
      ...(disk.provisionedIops === undefined
        ? {}
        : { provisionedIops: integer(disk.provisionedIops) }),
      ...(disk.provisionedThroughput === undefined
        ? {}
        : { provisionedThroughput: integer(disk.provisionedThroughput) }),
    });
  }

  async #gcpDisk(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<{ identity: JobRecoveryIdentity; disk: Record<string, unknown> }> {
    const zone = this.#gcpZone(attempt);
    const vm = privateJobJson(
      await this.#session.gcp(
        [
          'compute',
          'instances',
          'describe',
          attempt.cloudId,
          `--zone=${zone}`,
          '--format=json',
        ],
        deadlineAt,
      ),
    );
    const zoneUrl = this.#gcpInstanceUrl(attempt).split('/instances/')[0];
    if (
      !isRecord(vm) ||
      vm.name !== attempt.cloudId ||
      vm.selfLink !== this.#gcpInstanceUrl(attempt) ||
      vm.zone !== zoneUrl ||
      typeof vm.id !== 'string' ||
      !/^[1-9][0-9]*$/u.test(vm.id) ||
      vm.status !== 'RUNNING' ||
      vm.machineType !== `${zoneUrl}/machineTypes/${attempt.vmType}` ||
      !Array.isArray(vm.disks)
    )
      throw new Error(
        'Job GCP recovery VM changed its original identity or placement',
      );
    const boot = vm.disks.filter(
      (disk: unknown) => isRecord(disk) && disk.boot === true,
    );
    if (
      boot.length !== 1 ||
      !isRecord(boot[0]) ||
      typeof boot[0].source !== 'string' ||
      !boot[0].source.startsWith(`${zoneUrl}/disks/`) ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(boot[0].source.split('/').at(-1) ?? '')
    )
      throw new Error(
        'Job GCP recovery requires exactly one original-zone boot disk',
      );
    const disk = privateJobJson(
      await this.#session.gcp(
        [
          'compute',
          'disks',
          'describe',
          boot[0].source.split('/').at(-1)!,
          `--zone=${zone}`,
          '--format=json',
        ],
        deadlineAt,
      ),
    );
    if (
      !isRecord(disk) ||
      disk.selfLink !== boot[0].source ||
      disk.zone !== zoneUrl ||
      typeof disk.id !== 'string' ||
      !/^[1-9][0-9]*$/u.test(disk.id)
    )
      throw new Error(
        'Job GCP recovery boot disk identity is missing or foreign',
      );
    return {
      identity: {
        cloudId: attempt.cloudId,
        vmId: vm.id,
        osDiskId: disk.id,
        region: attempt.region,
        zone,
        vmType: attempt.vmType,
      },
      disk,
    };
  }

  #azureVmId(attempt: JobNativeAttempt): string {
    const credential = this.#session.credential;
    if (
      credential.cloudProvider !== CloudType.Azure ||
      !/^[a-z0-9]+$/u.test(attempt.region) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(attempt.cloudId)
    )
      throw new Error('Job Azure recovery lacks its original resource group');
    return `/subscriptions/${credential.subscriptionId}/resourceGroups/anycloud-${attempt.region}/providers/Microsoft.Compute/virtualMachines/${attempt.cloudId}`;
  }
  #azureArgs(attempt: JobNativeAttempt): string[] {
    this.#azureVmId(attempt);
    return [
      '--resource-group',
      `anycloud-${attempt.region}`,
      '--name',
      attempt.cloudId,
    ];
  }
  async #azureIdentity(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobRecoveryIdentity> {
    const body = privateJobJson(
      await this.#session.azure(
        ['vm', 'show', ...this.#azureArgs(attempt), '--output', 'json'],
        deadlineAt,
      ),
    );
    const id = this.#azureVmId(attempt);
    if (
      !isRecord(body) ||
      body.name !== attempt.cloudId ||
      typeof body.id !== 'string' ||
      body.id.toLowerCase() !== id.toLowerCase() ||
      typeof body.vmId !== 'string' ||
      !GUID.test(body.vmId) ||
      typeof body.location !== 'string' ||
      body.location.toLowerCase() !== attempt.region ||
      !isRecord(body.hardwareProfile) ||
      body.hardwareProfile.vmSize !== attempt.vmType ||
      !isRecord(body.storageProfile) ||
      !isRecord(body.storageProfile.osDisk) ||
      !isRecord(body.storageProfile.osDisk.managedDisk) ||
      typeof body.storageProfile.osDisk.managedDisk.id !== 'string'
    )
      throw new Error('Job Azure recovery VM or boot-disk identity is invalid');
    const diskId = body.storageProfile.osDisk.managedDisk.id.toLowerCase();
    const prefix = id.split('/virtualMachines/')[0].toLowerCase();
    if (
      !diskId.startsWith(`${prefix}/disks/`) ||
      diskId.split('/').length !== 9
    )
      throw new Error(
        'Job Azure recovery disk is outside its original resource group',
      );
    return {
      cloudId: attempt.cloudId,
      vmId: body.vmId.toLowerCase(),
      osDiskId: diskId,
      region: attempt.region,
      zone: attempt.availabilityZone,
      vmType: attempt.vmType,
    };
  }

  async #evictAzure(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<void> {
    const evictionDeadline = Math.min(deadlineAt, Date.now() + 90_000);
    // eslint-disable-next-line local/no-hand-written-retry-loops -- each round re-issues the eviction, then samples power state; expiry falls back to a plain stop
    while (Date.now() < evictionDeadline) {
      try {
        await this.#session.azure(
          [
            'vm',
            'simulate-eviction',
            ...this.#azureArgs(attempt),
            '--output',
            'json',
          ],
          deadlineAt,
        );
      } catch (error) {
        if (
          !(error instanceof JobPrivateCommandFailure) ||
          ![
            'OperationNotAllowed',
            'Conflict',
            'AnotherOperationInProgress',
          ].includes(error.nativeCode ?? '')
        )
          throw error;
      }
      // eslint-disable-next-line local/no-hand-written-retry-loops -- samples power state after an eviction; the outer round decides when to give up
      for (let poll = 0; poll < 3 && Date.now() < evictionDeadline; poll++) {
        await this.#session.pause(5_000, deadlineAt);
        if (await this.#azureStopped(attempt, deadlineAt)) return;
      }
    }
    await this.#session.azure(
      [
        'vm',
        'stop',
        ...this.#azureArgs(attempt),
        '--no-wait',
        '--output',
        'json',
      ],
      deadlineAt,
    );
    await this.#session.waitFor(
      'Job Azure VM stop',
      () => this.#azureStopped(attempt, deadlineAt),
      {
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (stopped) => (stopped ? undefined : 'VM is still running'),
      },
      deadlineAt,
    );
  }
  async #azureStopped(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<boolean> {
    const body = privateJobJson(
      await this.#session.azure(
        [
          'vm',
          'get-instance-view',
          ...this.#azureArgs(attempt),
          '--output',
          'json',
        ],
        deadlineAt,
      ),
    );
    if (
      !isRecord(body) ||
      typeof body.id !== 'string' ||
      body.id.toLowerCase() !== this.#azureVmId(attempt).toLowerCase() ||
      !isRecord(body.instanceView) ||
      !Array.isArray(body.instanceView.statuses)
    )
      throw new Error(
        'Job Azure eviction power observation is incomplete or foreign',
      );
    const power = body.instanceView.statuses.filter(
      (row: unknown) =>
        isRecord(row) &&
        typeof row.code === 'string' &&
        row.code.startsWith('PowerState/'),
    );
    if (
      power.length !== 1 ||
      !isRecord(power[0]) ||
      ![
        'PowerState/running',
        'PowerState/stopping',
        'PowerState/stopped',
        'PowerState/deallocating',
        'PowerState/deallocated',
        'PowerState/starting',
      ].includes(String(power[0].code))
    )
      throw new Error('Job Azure eviction power state is unknown');
    return [
      'PowerState/stopping',
      'PowerState/stopped',
      'PowerState/deallocating',
      'PowerState/deallocated',
    ].includes(String(power[0].code));
  }
}

/** Each region's GCP quota limits whose metric names `pattern` (e.g. A100). */
export async function gcpQuotaLimits(
  session: Pick<JobCloudSession, 'gcp' | 'initialize'>,
  regions: readonly string[],
  pattern: RegExp,
  deadlineAt: number,
): Promise<Record<string, Record<string, number>>> {
  await session.initialize(deadlineAt);
  const limits: Record<string, Record<string, number>> = {};
  for (const region of regions) {
    const body = privateJobJson(
      await session.gcp(
        ['compute', 'regions', 'describe', region, '--format=json'],
        deadlineAt,
      ),
    );
    if (!isRecord(body) || !Array.isArray(body.quotas))
      throw new Error(`GCP region ${region} lists no quotas`);
    limits[region] = Object.fromEntries(
      body.quotas
        .filter(
          (quota): quota is { metric: string; limit: number } =>
            isRecord(quota) &&
            typeof quota.metric === 'string' &&
            typeof quota.limit === 'number' &&
            pattern.test(quota.metric),
        )
        .map(({ metric, limit }) => [metric, limit]),
    );
  }
  return limits;
}

/** The exact original root EBS volume of a live AWS VM. */
export async function awsRootDisk(
  session: Pick<JobCloudSession, 'aws'>,
  identity: JobRecoveryIdentity,
  deadlineAt: number,
): Promise<JobHydrationDisk> {
  const body = privateJobJson(
    await session.aws(
      [
        'ec2',
        'describe-volumes',
        '--volume-ids',
        identity.osDiskId,
        '--no-paginate',
      ],
      identity.region,
      deadlineAt,
    ),
  );
  if (
    !isRecord(body) ||
    body.NextToken !== undefined ||
    !Array.isArray(body.Volumes) ||
    body.Volumes.length !== 1
  )
    throw new Error('Job AWS root-disk inventory is incomplete');
  const disk: unknown = body.Volumes[0];
  if (
    !isRecord(disk) ||
    disk.VolumeId !== identity.osDiskId ||
    disk.AvailabilityZone !== identity.zone ||
    typeof disk.VolumeType !== 'string' ||
    !Number.isSafeInteger(disk.Iops) ||
    !Number.isSafeInteger(disk.Throughput) ||
    !Number.isSafeInteger(disk.Size) ||
    !Array.isArray(disk.Attachments) ||
    disk.Attachments.length !== 1 ||
    !isRecord(disk.Attachments[0]) ||
    disk.Attachments[0].InstanceId !== identity.cloudId ||
    disk.Attachments[0].State !== 'attached'
  )
    throw new Error('Job AWS root disk identity or profile is malformed');
  return {
    id: identity.osDiskId,
    type: disk.VolumeType,
    iops: Number(disk.Iops),
    throughput: Number(disk.Throughput),
    sizeGb: Number(disk.Size),
  };
}
