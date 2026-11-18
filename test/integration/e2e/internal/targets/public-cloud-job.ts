import { cliArgs } from '../cli-surface.js';
import {
  HOST_DOCKER_PEER_HOLD_SECONDS,
  HOST_DOCKER_PEER_IMAGE,
  HOST_DOCKER_PEER_PROBE,
  HOST_DOCKER_PROBE,
} from './host-docker-probe.js';
import {
  JOB_EVICTION_PAYLOAD_MIB,
  JOB_SPOT_EXIT_SECONDS,
} from './job-profiles.js';
import {
  submittedVmTypes,
  type CloudJobTransport,
  type CloudJobFixture,
} from './job-types.js';

/** Five concrete provider registrations share the same public dedicated-Job submission. */
export class PublicCloudJobAdapter {
  readonly #transport: CloudJobTransport;
  constructor(transport: CloudJobTransport) {
    this.#transport = transport;
  }

  prepare(
    ...args: Parameters<CloudJobTransport['prepare']>
  ): ReturnType<CloudJobTransport['prepare']> {
    return this.#transport.prepare(...args);
  }

  submitAdmission(...args: Parameters<CloudJobTransport['submitAdmission']>) {
    return this.#transport.submitAdmission(...args);
  }
  admissionStatus(...args: Parameters<CloudJobTransport['admissionStatus']>) {
    return this.#transport.admissionStatus(...args);
  }
  admissionOutcome(...args: Parameters<CloudJobTransport['admissionOutcome']>) {
    return this.#transport.admissionOutcome(...args);
  }
  releaseUncreated(...args: Parameters<CloudJobTransport['releaseUncreated']>) {
    return this.#transport.releaseUncreated(...args);
  }

  /** `peer`: the host-docker prober's listener, at its private IP. */
  submit(fixture: CloudJobFixture, peer?: string): Promise<void> {
    const { profile } = fixture;
    if (
      ![
        'bucket-sync',
        'concurrent-output',
        'host-recovery',
        'input-hydration-recovery',
        'spot-request-cleanup',
        'spot-eviction',
        'gpu-spot-eviction',
        'gpu-probe-rerun',
        'runtime-secrets',
        'restricted-credential',
        'disk-tier',
        'host-docker',
        'mace-full-pull',
        'ghcr-probe',
      ].includes(profile.member.kind)
    )
      throw new Error('Cloud Job adapter received an unsupported member');
    if (profile.explicitCheckpoint && !fixture.checkpointBucket)
      throw new Error('Host recovery lacks its original explicit checkpoint');
    const kind = profile.member.kind;
    const diskTier = fixture.diskTierCase
      ? fixture.diskTierCase.tier
      : profile.diskTier;
    const env: string[] = [];
    const passthrough: string[] = [];
    let gpus: string | undefined;
    if (kind === 'bucket-sync') {
      env.push(`ANYCLOUD_TEST_ENV=${fixture.runLabel}`);
      passthrough.push(
        'python3',
        'run.py',
        '--save-dir',
        '/mnt/checkpoint',
        '--input-file',
        '/mnt/input/molecules.json',
        '--output-dir',
        '/mnt/output',
        '--pause',
        '75',
      );
    }
    // The second child only exits cleanly with no retries left,
    // after its sibling's baseline read.
    const spotExit = kind === 'spot-eviction' && fixture.concurrentIndex === 1;
    if (spotExit) passthrough.push('sleep', String(JOB_SPOT_EXIT_SECONDS));
    // Flushed before exit, so the eviction tests the restart, not page cache.
    else if (kind === 'spot-eviction')
      passthrough.push(
        'sh',
        '-c',
        `set -e; dd if=/dev/urandom of=/mnt/output/payload.bin bs=1M count=${JOB_EVICTION_PAYLOAD_MIB}; printf %s spot-eviction-${fixture.ref.id} > /mnt/output/marker.txt; sync`,
      );
    // The same GPU check runs on every start; the first start checkpoints and
    // waits for its eviction, and the resumed one records its check and exits.
    if (kind === 'gpu-spot-eviction') {
      gpus = 'all';
      passthrough.push(
        'python3',
        '-c',
        `import json, os, subprocess, sys, time, torch
subprocess.run(["nvidia-smi", "-L"], check=True)
free, total = torch.cuda.mem_get_info()
checksum = torch.arange(1024, device="cuda", dtype=torch.float64).sum().item()
if checksum != 523776:
    sys.exit(f"CUDA checksum {checksum} is not 523776")
gpu = {"device": torch.cuda.get_device_name(0), "free": free, "total": total}
print("gpu-check-ok", json.dumps(gpu), flush=True)
resumed = os.path.exists("/mnt/checkpoint/results.json")
path = "/mnt/output/results.json" if resumed else "/mnt/checkpoint/results.json"
with open(path, "w") as file:
    json.dump({"resumed" if resumed else "started": "${fixture.ref.id}", "gpu": gpu}, file)
if not resumed:
    time.sleep(3600)
    sys.exit("no eviction arrived within an hour")`,
      );
    }
    if (kind === 'runtime-secrets' && fixture.concurrentIndex === 1)
      env.push('K=from-env');
    if (kind === 'input-hydration-recovery') {
      if (
        !fixture.hydration ||
        !/^[a-f0-9]{64}$/u.test(fixture.hydration.seedSha256)
      )
        throw new Error('Hydration Job lacks its original real-data fixture');
      env.push(
        'EXPECTED_SHARD_COUNT=2048',
        `EXPECTED_INPUT_BYTES=${2048 * 128 * 1024 * 1024}`,
        `EXPECTED_SEED_SHA256=${fixture.hydration.seedSha256}`,
      );
    }
    if (fixture.hydration)
      passthrough.push('sh', '-c', fixture.hydration.command);
    if (kind === 'mace-full-pull') {
      if (!profile.mace || !fixture.maceCommand)
        throw new Error('MACE Job lacks its original inference payload');
      gpus = 'all';
      env.push(
        `AC_TIMING_RUN_ID=${fixture.ref.id}-run`,
        'AC_TIMING_HOLD_SECONDS=0',
      );
    }
    if (kind === 'ghcr-probe') gpus = 'all';
    // A healthy GPU under a Job that reports none. A non-zero exit
    // before the Starting step's health poll (every 5 s from `docker run`)
    // reads Running is a startup failure, retried on the same target without
    // the probe (run 40825826952); 30 s outlasts several polls, and the
    // harness's 5 s status reads see the Job Running.
    if (kind === 'gpu-probe-rerun') {
      gpus = 'all';
      passthrough.push(
        'sh',
        '-c',
        'sleep 30; echo "No CUDA GPUs are available"; exit 1',
      );
    }
    if (kind === 'disk-tier') {
      if (!fixture.diskTierCase)
        throw new Error('Disk-tier Job lost its original case');
      passthrough.push('sleep', '7200');
    }
    if (kind === 'ghcr-probe') passthrough.push('sleep', '7200');
    // Running long enough for the family to read each baseline, then exit 0.
    if (kind === 'restricted-credential')
      passthrough.push(
        'sh',
        '-c',
        `${fixture.outputBucket ? `printf '{"marker":"${fixture.runLabel}"}' > /mnt/output/results.json; ` : ''}echo ok; sleep 300`,
      );
    if (fixture.maceCommand)
      passthrough.push('python3', '-c', fixture.maceCommand);
    // The listener runs the probe; the prober, a plain Job, tries its ports.
    const hostDocker = kind === 'host-docker' && fixture.concurrentIndex === 0;
    const prober = kind === 'host-docker' && !hostDocker;
    if (prober !== (peer !== undefined))
      throw new Error('Only the host-docker prober takes its peer');
    if (hostDocker) {
      // Without a prober, long enough for 5 s status reads to see it Running.
      env.push(
        `HOLD_SECONDS=${profile.hostDockerPeer ? HOST_DOCKER_PEER_HOLD_SECONDS : 30}`,
      );
      passthrough.push('bash', '-c', HOST_DOCKER_PROBE);
    }
    if (prober) {
      env.push(`PEER=${peer}`);
      passthrough.push('python3', '-c', HOST_DOCKER_PEER_PROBE);
    }
    const args = cliArgs(
      'job',
      {
        id: fixture.ref.id,
        credentials: fixture.credentialName,
        'vm-type': submittedVmTypes(fixture),
        'disk-size':
          profile.diskSizeGb === undefined
            ? undefined
            : String(profile.diskSizeGb),
        'disk-tier': diskTier ?? undefined,
        'disk-iops': profile.diskIops?.toString(),
        'disk-throughput': profile.diskThroughputMibps?.toString(),
        'output-bucket': fixture.outputBucket ?? undefined,
        'input-bucket': fixture.inputBucket ?? undefined,
        region: fixture.restrictedCredentialCase
          ? fixture.restrictedCredentialCase.region
          : (profile.computeRegion ?? undefined),
        regions: profile.computeRegions?.join(','),
        zone: profile.computeZone ?? undefined,
        spot: profile.spot === true,
        'max-retries': spotExit ? '0' : undefined,
        // The Job terminated at launch shares its sibling's group,
        // whose one automatic checkpoint bucket is the sibling's.
        'no-checkpoint':
          spotExit ||
          (kind === 'spot-request-cleanup' && fixture.concurrentIndex === 1),
        secret: fixture.runtimeSecretNames ?? [],
        ...(profile.crossCloudStorageCredential
          ? {
              'input-storage-credentials': fixture.storageCredentialName,
              'output-storage-credentials': fixture.storageCredentialName,
            }
          : {}),
        ...(!profile.storageFollowsCompute && fixture.outputBucket
          ? {
              'input-storage-region': profile.storageRegion,
              'output-storage-region': profile.storageRegion,
            }
          : {}),
        ...(profile.explicitCheckpoint && fixture.checkpointBucket
          ? {
              'checkpoint-bucket': fixture.checkpointBucket,
              'checkpoint-storage-region': profile.storageRegion,
              ...(profile.crossCloudStorageCredential
                ? {
                    'checkpoint-storage-credentials':
                      fixture.storageCredentialName,
                  }
                : {}),
            }
          : {}),
        env,
        gpus,
        // The runner's own settings, as a CI Job passes them.
        'host-docker': hostDocker,
        'require-nested-virtualization': hostDocker,
        'shm-size': hostDocker ? '2g' : undefined,
        ulimit: hostDocker ? ['nofile=1048576:1048576'] : [],
      },
      [prober ? HOST_DOCKER_PEER_IMAGE : profile.image],
      passthrough,
    );
    return this.#transport.submit(fixture, args);
  }

  ghcr(...args: Parameters<CloudJobTransport['ghcr']>) {
    return this.#transport.ghcr(...args);
  }

  mace(...args: Parameters<CloudJobTransport['mace']>) {
    return this.#transport.mace(...args);
  }

  diskTier(...args: Parameters<CloudJobTransport['diskTier']>) {
    return this.#transport.diskTier(...args);
  }

  hydration(
    ...args: Parameters<CloudJobTransport['hydration']>
  ): ReturnType<CloudJobTransport['hydration']> {
    return this.#transport.hydration(...args);
  }

  spot(
    ...args: Parameters<CloudJobTransport['spot']>
  ): ReturnType<CloudJobTransport['spot']> {
    return this.#transport.spot(...args);
  }

  runtimeSecretFacts(
    ...args: Parameters<CloudJobTransport['runtimeSecretFacts']>
  ): ReturnType<CloudJobTransport['runtimeSecretFacts']> {
    return this.#transport.runtimeSecretFacts(...args);
  }

  runtimeSecretFile(
    ...args: Parameters<CloudJobTransport['runtimeSecretFile']>
  ): ReturnType<CloudJobTransport['runtimeSecretFile']> {
    return this.#transport.runtimeSecretFile(...args);
  }

  updateRuntimeSecret(
    ...args: Parameters<CloudJobTransport['updateRuntimeSecret']>
  ): ReturnType<CloudJobTransport['updateRuntimeSecret']> {
    return this.#transport.updateRuntimeSecret(...args);
  }

  clearRuntimeSecretFiles(
    ...args: Parameters<CloudJobTransport['clearRuntimeSecretFiles']>
  ): ReturnType<CloudJobTransport['clearRuntimeSecretFiles']> {
    return this.#transport.clearRuntimeSecretFiles(...args);
  }

  forceDeleteRuntimeSecret(
    ...args: Parameters<CloudJobTransport['forceDeleteRuntimeSecret']>
  ): ReturnType<CloudJobTransport['forceDeleteRuntimeSecret']> {
    return this.#transport.forceDeleteRuntimeSecret(...args);
  }

  attempts(
    ...args: Parameters<CloudJobTransport['attempts']>
  ): ReturnType<CloudJobTransport['attempts']> {
    return this.#transport.attempts(...args);
  }
  transfers(
    ...args: Parameters<CloudJobTransport['transfers']>
  ): ReturnType<CloudJobTransport['transfers']> {
    return this.#transport.transfers(...args);
  }
  imageConfigDigest(
    ...args: Parameters<CloudJobTransport['imageConfigDigest']>
  ): ReturnType<CloudJobTransport['imageConfigDigest']> {
    return this.#transport.imageConfigDigest(...args);
  }
  bucketReady(
    ...args: Parameters<CloudJobTransport['bucketReady']>
  ): ReturnType<CloudJobTransport['bucketReady']> {
    return this.#transport.bucketReady(...args);
  }
  results(
    ...args: Parameters<CloudJobTransport['results']>
  ): ReturnType<CloudJobTransport['results']> {
    return this.#transport.results(...args);
  }
  runtime(
    ...args: Parameters<CloudJobTransport['runtime']>
  ): ReturnType<CloudJobTransport['runtime']> {
    return this.#transport.runtime(...args);
  }
  logs(
    ...args: Parameters<CloudJobTransport['logs']>
  ): ReturnType<CloudJobTransport['logs']> {
    return this.#transport.logs(...args);
  }
  statusCheckpoint(
    ...args: Parameters<CloudJobTransport['statusCheckpoint']>
  ): ReturnType<CloudJobTransport['statusCheckpoint']> {
    return this.#transport.statusCheckpoint(...args);
  }
  logsStopWithTheirReader(
    ...args: Parameters<CloudJobTransport['logsStopWithTheirReader']>
  ): ReturnType<CloudJobTransport['logsStopWithTheirReader']> {
    return this.#transport.logsStopWithTheirReader(...args);
  }
  completedByCli(
    ...args: Parameters<CloudJobTransport['completedByCli']>
  ): ReturnType<CloudJobTransport['completedByCli']> {
    return this.#transport.completedByCli(...args);
  }
  writeConcurrent(
    ...args: Parameters<CloudJobTransport['writeConcurrent']>
  ): ReturnType<CloudJobTransport['writeConcurrent']> {
    return this.#transport.writeConcurrent(...args);
  }
  concurrentContents(
    ...args: Parameters<CloudJobTransport['concurrentContents']>
  ): ReturnType<CloudJobTransport['concurrentContents']> {
    return this.#transport.concurrentContents(...args);
  }
  evictionOutput(
    ...args: Parameters<CloudJobTransport['evictionOutput']>
  ): ReturnType<CloudJobTransport['evictionOutput']> {
    return this.#transport.evictionOutput(...args);
  }
  syncCycle(): Promise<void> {
    return this.#transport.syncCycle();
  }
  verificationRetry(): Promise<void> {
    return this.#transport.verificationRetry();
  }
  recoveryIdentity(
    ...args: Parameters<CloudJobTransport['recoveryIdentity']>
  ): ReturnType<CloudJobTransport['recoveryIdentity']> {
    return this.#transport.recoveryIdentity(...args);
  }
  stop(
    ...args: Parameters<CloudJobTransport['stop']>
  ): ReturnType<CloudJobTransport['stop']> {
    return this.#transport.stop(...args);
  }
  deleteHost(
    ...args: Parameters<CloudJobTransport['deleteHost']>
  ): ReturnType<CloudJobTransport['deleteHost']> {
    return this.#transport.deleteHost(...args);
  }
  writeHostCheckpoint(
    ...args: Parameters<CloudJobTransport['writeHostCheckpoint']>
  ): ReturnType<CloudJobTransport['writeHostCheckpoint']> {
    return this.#transport.writeHostCheckpoint(...args);
  }
  hostCheckpoint(
    ...args: Parameters<CloudJobTransport['hostCheckpoint']>
  ): ReturnType<CloudJobTransport['hostCheckpoint']> {
    return this.#transport.hostCheckpoint(...args);
  }
  nativeAbsence(
    ...args: Parameters<CloudJobTransport['nativeAbsence']>
  ): ReturnType<CloudJobTransport['nativeAbsence']> {
    return this.#transport.nativeAbsence(...args);
  }
  automaticCheckpointAbsence(
    ...args: Parameters<CloudJobTransport['automaticCheckpointAbsence']>
  ): ReturnType<CloudJobTransport['automaticCheckpointAbsence']> {
    return this.#transport.automaticCheckpointAbsence(...args);
  }
  releaseResources(
    ...args: Parameters<CloudJobTransport['releaseResources']>
  ): ReturnType<CloudJobTransport['releaseResources']> {
    return this.#transport.releaseResources(...args);
  }
}
