import { CloudType } from '../../../../../src/shared/cloud.js';

import type { ArtifactStore } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import type { ProcessRunner } from '../process.js';
import type { VmProfile } from '../profiles.js';
import type {
  AwsRunningObservation,
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTargetTransport,
  PersistentVmTerminatedObservationAttempt,
  ProviderTerminatedObservation,
} from '../targets/persistent-vm-types.js';
import { isRecord, scalarString } from '../types.js';
import type { TargetHttpClient } from './http.js';
import { PublicCloudVmHostDeleter } from './public-cloud-vm-host-deletion.js';
import {
  PublicCloudVmHostPresenceProbe,
  VmHostPresenceProtocolError,
  type VmHostPresence,
} from './public-cloud-vm-host-presence.js';

type TerminationProbe = ProviderTerminatedObservation['outcome'];

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integerField(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return 0;
}

function arrayField(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function awsRootVolumeId(
  value: unknown,
  expectedInstanceId: string,
): string {
  if (!isRecord(value)) return '';
  for (const reservation of arrayField(value.Reservations).filter(isRecord)) {
    for (const instance of arrayField(reservation.Instances).filter(isRecord)) {
      if (scalarString(instance.InstanceId) !== expectedInstanceId) continue;
      const rootDeviceName = stringField(instance.RootDeviceName);
      for (const mapping of arrayField(instance.BlockDeviceMappings).filter(
        isRecord,
      )) {
        if (stringField(mapping.DeviceName) !== rootDeviceName) continue;
        const ebs = isRecord(mapping.Ebs) ? mapping.Ebs : {};
        return stringField(ebs.VolumeId);
      }
    }
  }
  return '';
}

export function parseAwsRootVolume(
  value: unknown,
  expectedVolumeId: string,
): AwsRunningObservation | undefined {
  if (!isRecord(value)) return undefined;
  const volume = arrayField(value.Volumes)
    .filter(isRecord)
    .find((candidate) => stringField(candidate.VolumeId) === expectedVolumeId);
  if (!volume) return undefined;
  return {
    kind: 'aws',
    rootVolumeIops: integerField(volume.Iops),
    rootVolumeThroughput: integerField(volume.Throughput),
    rootVolumeType: stringField(volume.VolumeType),
  };
}

export function terminationOutcomeForPresence(
  presence: VmHostPresence,
): TerminationProbe {
  if (presence === 'absent') return 'terminated';
  return presence === 'present' ? 'present' : 'inconclusive';
}

export class PublicCloudPersistentVmTransportFactory {
  readonly #artifacts: ArtifactStore;
  readonly #files: FixtureFiles;
  readonly #http: TargetHttpClient;
  readonly #runner: ProcessRunner;

  constructor(
    artifacts: ArtifactStore,
    files: FixtureFiles,
    http: TargetHttpClient,
    runner: ProcessRunner,
  ) {
    this.#artifacts = artifacts;
    this.#files = files;
    this.#http = http;
    this.#runner = runner;
  }

  create(profile: VmProfile): PersistentVmTargetTransport {
    return new PublicCloudPersistentVmTransport(
      profile,
      this.#artifacts,
      this.#files,
      this.#http,
      this.#runner,
    );
  }
}

export class PublicCloudPersistentVmTransport
  implements PersistentVmTargetTransport
{
  readonly #artifacts: ArtifactStore;
  readonly #hostDeleter: PublicCloudVmHostDeleter;
  readonly #presence: PublicCloudVmHostPresenceProbe;
  readonly #profile: VmProfile;
  readonly #runner: ProcessRunner;

  constructor(
    profile: VmProfile,
    artifacts: ArtifactStore,
    files: FixtureFiles,
    http: TargetHttpClient,
    runner: ProcessRunner,
  ) {
    this.#artifacts = artifacts;
    this.#hostDeleter = new PublicCloudVmHostDeleter(
      profile,
      runner,
      files,
      http,
    );
    this.#presence = new PublicCloudVmHostPresenceProbe(
      profile,
      runner,
      files,
      http,
      artifacts,
    );
    this.#profile = profile;
    this.#runner = runner;
  }

  async observeRunning(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    if (this.#profile.provider === CloudType.AWS) {
      return {
        kind: 'observed',
        observation: await this.#observeAwsRunning(context),
      };
    }
    return { kind: 'not-required' };
  }

  async observeTerminated(
    context: PersistentVmRunningContext,
    deadlineAt?: number,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    let outcome: TerminationProbe;
    try {
      const presence = await this.#presence.observe(context, { deadlineAt });
      outcome = terminationOutcomeForPresence(presence.presence);
    } catch (error) {
      if (!(error instanceof VmHostPresenceProtocolError)) throw error;
      outcome = 'invalid';
    }
    const observation: ProviderTerminatedObservation = {
      kind: 'provider-api',
      outcome,
      provider: this.#profile.provider,
    };
    await this.#artifacts.json(
      `${this.#profile.slug}-terminated-observation-attempt`,
      observation,
    );
    return { kind: 'observed', observation };
  }

  deleteHost(context: PersistentVmRunningContext): Promise<void> {
    return this.#hostDeleter.deleteHost({
      availabilityZone: context.availabilityZone,
      cloudId: context.cloudId,
      fixtureId: context.ref.id,
      region: context.region,
    });
  }

  async #observeAwsRunning(
    context: PersistentVmRunningContext,
  ): Promise<AwsRunningObservation> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.AWS) {
      throw new Error(
        'AWS running observation received mismatched credentials',
      );
    }
    if (!context.region) {
      throw new Error('AWS running observation requires the persisted region');
    }
    const environment = {
      AWS_ACCESS_KEY_ID: credential.accessKeyId,
      AWS_PAGER: '',
      AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
      AWS_SESSION_TOKEN: credential.sessionToken,
    };
    const describeInstance = await this.#runner.run(
      'aws',
      [
        'ec2',
        'describe-instances',
        '--instance-ids',
        context.cloudId,
        '--region',
        context.region,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      {
        env: environment,
        label: 'aws-observe-vm-root-device',
        timeoutMs: 180_000,
      },
    );
    if (
      describeInstance.exitCode !== 0 ||
      describeInstance.timedOut ||
      describeInstance.aborted
    ) {
      throw new Error('AWS instance observation failed');
    }
    const volumeId = awsRootVolumeId(
      JSON.parse(describeInstance.stdout) as unknown,
      context.cloudId,
    );
    if (!volumeId) throw new Error('AWS root EBS volume ID is missing');

    const describeVolume = await this.#runner.run(
      'aws',
      [
        'ec2',
        'describe-volumes',
        '--volume-ids',
        volumeId,
        '--region',
        context.region,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      {
        env: environment,
        label: 'aws-observe-vm-root-volume',
        timeoutMs: 180_000,
      },
    );
    if (
      describeVolume.exitCode !== 0 ||
      describeVolume.timedOut ||
      describeVolume.aborted
    ) {
      throw new Error('AWS root EBS volume observation failed');
    }
    const observation = parseAwsRootVolume(
      JSON.parse(describeVolume.stdout) as unknown,
      volumeId,
    );
    if (!observation) throw new Error('AWS root EBS volume is missing');
    await this.#artifacts.json('aws-running-observation', observation);
    return observation;
  }
}
