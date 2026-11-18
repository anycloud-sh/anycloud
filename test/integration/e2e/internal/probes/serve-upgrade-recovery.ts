import { z } from 'zod';

import { bucketEntryPageSchema } from '../../../../../src/shared/api-contract/bucket-metadata-schemas.js';

import type { ApiClient } from '../api.js';
import { cliArgs } from '../cli-surface.js';
import type { CleanupStack } from '../cleanup.js';
import type { CliClient } from '../cli.js';
import type { CredentialManager } from '../credentials.js';
import { CliDatabase, escapedSql } from '../database.js';
import type { FixtureNames } from '../names.js';
import type { ProviderProfiles, VmProvider } from '../profiles.js';
import type { RemoteExecutor } from '../remote.js';
import type { ReadyServe } from '../contracts/serve.js';
import type { CommandResult } from '../types.js';

export const SERVICE_CHECKPOINT_MARKER_FILE = 'rfc0036-checkpoint-marker';

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function successful(result: CommandResult, operation: string): void {
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.spawnError
  ) {
    throw new Error(`Service upgrade recovery: ${operation} failed`);
  }
}

export interface ServiceCheckpointHold {
  readonly vmId: number;
  readonly cloudId: string;
  readonly checkpointHostPath: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface ServiceUpgradeRecoveryFixture {
  readonly bucketName: string;
  readonly region: string;
  readonly marker: string;
  hold(
    service: Pick<ReadyServe, 'ref' | 'hosts'>,
  ): Promise<ServiceCheckpointHold>;
  releaseBucket(): Promise<void>;
}

/** Faults affect only the AWS Service and bucket created by this fixture. */
export class ServiceUpgradeRecoveryProbe {
  constructor(
    private readonly dependencies: {
      cleanup: Pick<CleanupStack, 'defer'>;
      cleanupApi: Pick<ApiClient, 'lookupStatus'>;
      cleanupCli: Pick<CliClient, 'run'>;
      cleanupRemote: Pick<RemoteExecutor, 'pinHost'>;
      cli: Pick<CliClient, 'run'>;
      credentials: Pick<CredentialManager, 'save'>;
      names: Pick<FixtureNames, 'workload'>;
      profiles: Pick<ProviderProfiles, 'serve'>;
    },
  ) {}

  async create(
    target: VmProvider,
    scope: string,
  ): Promise<ServiceUpgradeRecoveryFixture> {
    if (target !== 'aws')
      throw new Error(
        'Service restart qualification currently requires AWS/systemd',
      );
    const {
      cleanup,
      cleanupApi,
      cleanupCli,
      cleanupRemote,
      cli,
      credentials,
      names,
      profiles,
    } = this.dependencies;
    const profile = profiles.serve(target);
    await credentials.save(profile.credentialName, profile.credential);
    const bucketName = names.workload(`${scope}-checkpoint`);
    const region = profile.region ?? 'us-east-1';
    const marker = `checkpoint-${bucketName}`;
    const bucketArgs = { credentials: profile.credentialName, region };
    const exists = await cli.run(
      cliArgs('bucket exists', bucketArgs, [bucketName]),
    );
    if (
      exists.exitCode !== 1 ||
      exists.timedOut ||
      exists.aborted ||
      exists.spawnError
    ) {
      throw new Error(
        'Service recovery requires a demonstrably absent fixture bucket',
      );
    }
    const workloadId = names.workload(scope);
    let released = false;
    const releaseBucket = async (): Promise<void> => {
      if (released) return;
      const current = await cleanupApi.lookupStatus(workloadId);
      if (
        current.kind === 'found' &&
        (current.status.workload.cleanedAt === null ||
          current.status.workload.cleanedAt === undefined ||
          (current.status.vms ?? []).some((vm) => vm.endedAt === null))
      )
        throw new Error(
          'Refusing to delete checkpoint bucket before Service cleanup',
        );
      successful(
        await cleanupCli.run(
          cliArgs('bucket delete', bucketArgs, [bucketName]),
          {
            timeoutMs: 300_000,
            label: 'serve-recovery-bucket-delete',
          },
        ),
        'checkpoint bucket cleanup',
      );
      released = true;
      bucketCleanup.complete();
    };
    // Registered before Service reservation: the workload must clean up first.
    const bucketCleanup = cleanup.defer(
      `Service checkpoint ${bucketName}`,
      releaseBucket,
    );
    successful(
      await cli.run(cliArgs('bucket create', bucketArgs, [bucketName]), {
        timeoutMs: 300_000,
        label: 'serve-recovery-bucket-create',
      }),
      'checkpoint bucket creation',
    );

    return {
      bucketName,
      region,
      marker,
      releaseBucket,
      hold: async (service) => {
        if (service.ref.id !== workloadId)
          throw new Error('Checkpoint fixture belongs to another Service');
        const oldHost = service.hosts[0];
        if (
          service.hosts.length !== 1 ||
          !oldHost ||
          !/^[a-zA-Z0-9._-]+$/u.test(workloadId)
        ) {
          throw new Error(
            'Service checkpoint hold requires exactly one original host',
          );
        }
        const readAttempt = () =>
          new CliDatabase(cli).query(
            `SELECT id, cloud_id, checkpoint_host_path FROM vms WHERE workload_id = '${escapedSql(workloadId)}' AND ended_at IS NULL`,
            'serve-recovery-original-checkpoint',
          );
        const rows = await readAttempt();
        const vmId = rows[0]?.id;
        const path = rows[0]?.checkpoint_host_path;
        if (
          rows.length !== 1 ||
          typeof vmId !== 'number' ||
          !Number.isSafeInteger(vmId) ||
          vmId <= 0 ||
          rows[0]?.cloud_id !== oldHost.cloudId ||
          typeof path !== 'string' ||
          !path.startsWith('/')
        ) {
          throw new Error(
            'Service checkpoint ledger no longer identifies the original host',
          );
        }
        // Pin once using the independent teardown scope. Unmasking must keep
        // this exact endpoint/key even after cancellation or host replacement.
        const host = await cleanupRemote.pinHost(workloadId);
        const unit = `ac-final-checkpoint-${workloadId}.service`;
        const mask = `/run/systemd/system/${unit}`;
        const markerPath = `${path}/${SERVICE_CHECKPOINT_MARKER_FILE}`;
        let holdReleased = false;
        try {
          successful(
            await host.run(
              [
                'set -eu',
                'test "$(ps -p 1 -o comm=)" = systemd',
                `test ! -e ${quote(mask)} && test ! -L ${quote(mask)}`,
                `test -d ${quote(path)}`,
              ].join('\n'),
            ),
            'systemd/original checkpoint prerequisites',
          );
        } catch (error) {
          await host.close();
          throw error;
        }
        const release = async (): Promise<void> => {
          if (holdReleased) return;
          successful(
            await host.run(
              `set -eu\nsystemctl unmask --runtime ${quote(unit)}\ntest ! -L ${quote(mask)}`,
            ),
            'original-host checkpoint unmask',
          );
          holdReleased = true;
          holdCleanup.complete();
          await host.close();
        };
        // Registered after reservation and released before the contract exits.
        const holdCleanup = cleanup.defer(
          `Service checkpoint hold ${workloadId}`,
          release,
        );
        try {
          successful(
            await host.run(
              [
                'set -eu',
                'systemctl stop rclone-checkpoint',
                `systemctl mask --runtime ${quote(unit)}`,
                `test "$(readlink ${quote(mask)})" = /dev/null`,
                `printf '%s\\n' ${quote(marker)} > ${quote(markerPath)}`,
              ].join('\n'),
            ),
            'hold final checkpoint and write unsynced marker',
          );
          const assertHeld = async (): Promise<void> => {
            const currentRows = await readAttempt();
            if (
              currentRows.length !== 1 ||
              currentRows[0]?.id !== vmId ||
              currentRows[0]?.cloud_id !== oldHost.cloudId ||
              currentRows[0]?.checkpoint_host_path !== path
            ) {
              throw new Error(
                'Checkpoint hold lost the exact original live VM attempt',
              );
            }
            successful(
              await host.run(
                [
                  'set -eu',
                  `test "$(readlink ${quote(mask)})" = /dev/null`,
                  `test "$(cat ${quote(markerPath)})" = ${quote(marker)}`,
                  '! systemctl is-active --quiet rclone-checkpoint',
                ].join('\n'),
              ),
              'original host checkpoint hold',
            );
            const listed = await cli.run(
              cliArgs('bucket list', { ...bucketArgs, json: true, all: true }, [
                bucketName,
              ]),
            );
            successful(listed, 'unsynced checkpoint bucket inspection');
            const objects = z
              .object({
                entries: bucketEntryPageSchema.shape.entries,
                truncated: z.literal(false),
                nextCursor: z.null(),
              })
              .safeParse(JSON.parse(listed.stdout));
            // Checkpoint startup probes storage with this empty remote sentinel.
            // No workload content, including our unsynced marker, may be present.
            if (
              !objects.success ||
              objects.data.entries.some(
                (entry) =>
                  entry.kind !== 'object' ||
                  entry.key !== '.rclone-keep' ||
                  entry.sizeBytes !== 0,
              )
            ) {
              throw new Error(
                'Checkpoint bucket contains content beyond its connectivity sentinel while the final flush is held',
              );
            }
          };
          await assertHeld();
          return {
            vmId,
            cloudId: oldHost.cloudId,
            checkpointHostPath: path,
            assertHeld,
            release,
          };
        } catch (error) {
          try {
            await release();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Service checkpoint hold setup and release failed',
            );
          }
          throw error;
        }
      },
    };
  }
}
