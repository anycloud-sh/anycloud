import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

import { CloudType } from '../../../../../src/shared/cloud.js';
import { LOCAL_SMOLVM_CONTRACT } from '../../../../../src/api/services/gateways/local-smolvm-contract.js';
import type { ApiClient } from '../api.js';
import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { CleanupStack } from '../cleanup.js';
import type { CliClient } from '../cli.js';
import { completedJobByCli } from '../cli-observations.js';
import type { FixtureFiles } from '../files.js';
import type {
  JobGenerationAbsence,
  JobNativeCleanup,
} from '../job-native-cleanup.js';
import { LocalJobStorage } from '../job-local-storage.js';
import {
  assertJobController,
  jobControllerBinding,
  type JobControllerBinding,
} from '../job-controller.js';
import { resubmitJob, submitJob } from '../job-submission.js';
import type { RemoteExecutor } from '../remote.js';
import type { SecretManager } from '../secrets.js';
import type {
  JobFixture,
  JobMemberProfile,
  LocalJobConfiguration,
  LocalJobFixture,
  LocalJobTransport,
} from '../targets/job-types.js';
import { isRecord, type CommandResult } from '../types.js';
import type { WorkloadMutationTransport } from '../workload-mutations.js';
import type {
  TrackedWorkloadKernel,
  TrackedWorkloadRef,
} from '../workloads.js';
import type { Waiter } from '../wait.js';
import type { TargetHttpClient } from './http.js';
import type { LocalApiRestarter } from './local-api-restart.js';
import { cliArgs } from '../cli-surface.js';
import { observeLocalSmolvmHost, ownedSmolvmMachines } from './local-smolvm.js';

interface OwnedLocalJob {
  readonly controller: JobControllerBinding;
  readonly startedAt: number;
  readonly resources?: {
    readonly storage: LocalJobStorage;
    readonly secretName: string;
  };
  readonly nativeState: { absent: boolean };
  generation: number;
  firstGeneration?: JobGenerationAbsence;
}

export interface LocalSmolvmJobDependencies {
  readonly api: Pick<ApiClient, 'controller'>;
  readonly kernel: Pick<
    TrackedWorkloadKernel,
    'reserveWithCleanupVerification' | 'assertActive' | 'recordSubstrateAbsence'
  >;
  readonly native: Pick<
    JobNativeCleanup,
    'register' | 'capture' | 'creationStarted' | 'generationAbsence' | 'verify'
  >;
  readonly mutations: Pick<
    WorkloadMutationTransport,
    'runCliCreate' | 'runCliResubmit'
  >;
  readonly cli: Pick<CliClient, 'run'>;
  readonly remote: Pick<RemoteExecutor, 'run'>;
  readonly files: Pick<FixtureFiles, 'privateText'>;
  readonly secrets: Pick<SecretManager, 'create' | 'delete'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly redactor: Pick<Redactor, 'add'>;
  readonly http: Pick<TargetHttpClient, 'post'>;
  readonly cleanupHttp: Pick<TargetHttpClient, 'get'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly cleanupWait: Pick<Waiter, 'for'>;
  readonly signal: AbortSignal;
  readonly cleanupSignal: AbortSignal;
  readonly apiRestarter: Pick<LocalApiRestarter, 'restart'>;
}

function complete(result: CommandResult): void {
  if (
    result.signal ||
    result.aborted ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode !== 0
  )
    throw new Error(
      'Local Job observation command did not complete successfully',
    );
}

/** Owns fixed Local resources, native verification, and a fresh fence for every send. */
export class LocalSmolvmJobTransport implements LocalJobTransport {
  readonly #dependencies: LocalSmolvmJobDependencies;
  readonly #owned = new WeakMap<JobFixture, OwnedLocalJob>();
  readonly #smolvmUrl = new URL(LOCAL_SMOLVM_CONTRACT.baseUrl);

  constructor(dependencies: LocalSmolvmJobDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<LocalJobFixture> {
    const startedAt = Date.now();
    const controller = jobControllerBinding(this.#dependencies.api);
    if (!/^[a-z0-9-]{1,48}$/u.test(id))
      throw new Error('Local Job identity is outside its namespace');
    const { cleanup, artifacts, files, secrets, redactor } = this.#dependencies;
    const nativeState = { absent: true };
    const storage = new LocalJobStorage({
      root: LOCAL_SMOLVM_CONTRACT.bucketHostPath,
      host: this.#smolvmUrl.origin,
      cleanup,
      artifacts,
      childrenAbsent: () => {
        if (!nativeState.absent)
          throw new Error(
            'Local Job storage still has an unresolved native child',
          );
      },
    });
    const inputBucket = `j-input-${id}`;
    const outputBucket = `j-output-${id}`;
    const checkpointBucket = `j-checkpoint-${id}`;
    await storage.create(inputBucket, `input-${id}`);
    await storage.create(outputBucket);
    await storage.create(checkpointBucket, `checkpoint-seed-${id}`);
    const secretName = `job-secret-${id}`;
    const secretValue = `job-secret-value-${id}`;
    redactor.add(secretValue);
    assertJobController(this.#dependencies.api, controller);
    // The bundle's GITHUB_TOKEN must reach the container as given: Anycloud
    // passes no sign-in token of its own into workloads.
    await secrets.create(secretName, {
      LOCAL_SECRET_VALUE: secretValue,
      GITHUB_TOKEN: secretValue,
    });
    const fileValue = `file-${id}`;
    const overrideValue = `override-${id}`;
    const environmentFile = await files.privateText(
      `job-${id}.env`,
      `LOCAL_FILE_VAR=${fileValue}\nLOCAL_OVERRIDE_VAR=file-default\n`,
    );
    const ref = await this.#reserve(id, cleanupMs, nativeState, controller);
    const fixture: LocalJobFixture = Object.freeze({
      ref,
      profile,
      inputBucket,
      outputBucket,
      checkpointBucket,
      secretName,
      secretDigest: createHash('sha256').update(secretValue).digest('hex'),
      environmentFile,
      fileValue,
      overrideValue,
      stdoutMarker: `job-stdout-${id}`,
      stderrMarker: `job-stderr-${id}`,
    });
    const owned: OwnedLocalJob = {
      controller,
      resources: { storage, secretName },
      nativeState,
      startedAt,
      generation: 1,
    };
    this.#owned.set(fixture, owned);
    await artifacts.json(`job-${id}-profile`, {
      controller,
      member: profile.member,
      profile,
      workloadId: id,
      generation: 1,
      startedAt,
    });
    return fixture;
  }

  async prepareTerminal(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<JobFixture> {
    if (
      !/^[a-z0-9-]{1,48}$/u.test(id) ||
      profile.member.target !== 'local-smolvm' ||
      !['local-completed', 'local-resubmitted'].includes(profile.member.kind)
    )
      throw new Error('Local terminal Job identity or member is invalid');
    const startedAt = Date.now();
    const controller = jobControllerBinding(this.#dependencies.api);
    const nativeState = { absent: true };
    const ref = await this.#reserve(id, cleanupMs, nativeState, controller);
    const fixture: JobFixture = Object.freeze({ ref, profile });
    this.#owned.set(fixture, {
      controller,
      nativeState,
      startedAt,
      generation: 1,
    });
    await this.#dependencies.artifacts.json(`job-${id}-profile`, {
      controller,
      member: profile.member,
      profile,
      workloadId: id,
      generation: 1,
      startedAt,
    });
    return fixture;
  }

  async submit(fixture: JobFixture, args: readonly string[]): Promise<void> {
    const owned = this.#require(fixture);
    const { native, mutations } = this.#dependencies;
    owned.nativeState.absent = false;
    await submitJob(fixture.ref, args, {
      native,
      mutations: {
        runCliCreate: (ref, command, options) => {
          this.#require(fixture);
          return mutations.runCliCreate(ref, command, options);
        },
      },
    });
  }

  async firstGenerationAbsence(
    fixture: JobFixture,
    timeoutMs: number,
  ): Promise<void> {
    const owned = this.#require(fixture);
    if (
      fixture.profile.member.kind !== 'local-resubmitted' ||
      owned.generation !== 1 ||
      owned.firstGeneration
    )
      throw new Error('Local Job first-generation cleanup is single use');
    const deadlineAt = Date.now() + timeoutMs;
    const receipt = await this.#dependencies.native.generationAbsence(
      fixture.ref,
      1,
      timeoutMs,
    );
    await this.#verifyLocalInventory(fixture.ref, deadlineAt, 1);
    owned.nativeState.absent = true;
    owned.firstGeneration = receipt;
  }

  async resubmit(fixture: JobFixture): Promise<void> {
    const owned = this.#require(fixture);
    if (
      fixture.profile.member.kind !== 'local-resubmitted' ||
      owned.generation !== 1 ||
      !owned.firstGeneration ||
      !owned.nativeState.absent
    )
      throw new Error(
        'Local Job resubmission lacks original generation absence',
      );
    const receipt = owned.firstGeneration;
    owned.firstGeneration = undefined;
    owned.generation = 2;
    owned.nativeState.absent = false;
    await resubmitJob(fixture.ref, receipt, {
      native: this.#dependencies.native,
      mutations: {
        runCliResubmit: (ref, command, options) => {
          this.#require(fixture);
          return this.#dependencies.mutations.runCliResubmit(
            ref,
            command,
            options,
          );
        },
      },
    });
  }

  attempts(
    fixture: JobFixture,
    deadlineAt = Date.now() + 60_000,
  ): ReturnType<LocalJobTransport['attempts']> {
    this.#require(fixture);
    return this.#dependencies.native.capture(fixture.ref, deadlineAt);
  }

  async configuration(
    fixture: LocalJobFixture,
  ): Promise<LocalJobConfiguration> {
    this.#require(fixture);
    const id = fixture.ref.id;
    const workload = await this.#cli([
      'exec',
      id,
      `printf 'job:%s\\n' "$WORKLOAD_ID"`,
    ]);
    const environment = await this.#cli([
      'exec',
      id,
      [
        'set -e',
        `test "$(printf %s "$LOCAL_SECRET_VALUE" | sha256sum | cut -d ' ' -f1)" = '${fixture.secretDigest}'`,
        `test "$(printf %s "$GITHUB_TOKEN" | sha256sum | cut -d ' ' -f1)" = '${fixture.secretDigest}'`,
        'test -z "${GITHUB_USER+set}"',
        `test "$LOCAL_FILE_VAR" = '${fixture.fileValue}'`,
        `test "$LOCAL_OVERRIDE_VAR" = '${fixture.overrideValue}'`,
        "printf 'environment-ok\\n'",
      ].join('; '),
    ]);
    const permissions = await this.#guest(fixture, [
      'sh',
      '-c',
      "stat -c '%a %u' /run/anycloud-secrets/env; grep -q '^GITHUB_TOKEN=' /run/anycloud-secrets/env",
    ]);
    const inspection = await this.#guest(fixture, [
      'docker',
      'inspect',
      '--format',
      '{"name":{{json .Name}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"shm":{{.HostConfig.ShmSize}},"memory":{{.HostConfig.Memory}},"cpus":{{.HostConfig.NanoCpus}},"ulimits":{{json .HostConfig.Ulimits}}}',
      id,
    ]);
    const parsed: unknown = JSON.parse(inspection.stdout);
    if (
      inspection.exitCode !== 0 ||
      !isRecord(parsed) ||
      typeof parsed.imageId !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/u.test(parsed.imageId) ||
      !isRecord(parsed.labels) ||
      !Array.isArray(parsed.ulimits)
    )
      throw new Error('Local Job Docker inspection was malformed');
    await this.#dependencies.artifacts.json(`job-${id}-container-image`, {
      workloadId: id,
      generation: 1,
      requestedImage: fixture.profile.image,
      imageConfigDigest: parsed.imageId,
      observedAt: Date.now(),
    });
    const logs = await this.#cli(['logs', id]);
    const host = await this.#dependencies.remote.run(
      id,
      'vm',
      "test -S /var/run/docker.sock && printf 'job-host-ok\\n'",
      { timeoutMs: 90_000, recordArtifact: false },
    );
    complete(host);
    const liveSecretFile = await this.#liveSecretFile(fixture);
    const facts = {
      workloadExec: workload.stdout.includes(`job:${id}`),
      environment: environment.stdout.trim() === 'environment-ok',
      runtimeSecretFile:
        permissions.exitCode === 0 && permissions.stdout.trim() === '600 0',
      labels:
        parsed.name === `/${id}` &&
        parsed.labels['sh.anycloud.managed'] === 'true' &&
        parsed.labels['sh.anycloud.role'] === 'workload' &&
        parsed.labels['sh.anycloud.deployment-id'] === id,
      dockerOptions:
        parsed.shm === 134217728 &&
        parsed.memory === 268435456 &&
        parsed.cpus === 500000000 &&
        parsed.ulimits.filter(
          (limit: unknown) =>
            isRecord(limit) &&
            limit.Name === 'nofile' &&
            limit.Soft === 2048 &&
            limit.Hard === 2048,
        ).length === 1,
      stdoutLogs: logs.stdout.includes(fixture.stdoutMarker),
      stderrLogs: logs.stderr.includes(fixture.stderrMarker),
      hostExec: host.stdout.trim() === 'job-host-ok',
      liveSecretFile,
    };
    await this.#dependencies.artifacts.json(`job-${id}-configuration`, facts);
    return facts;
  }

  async storage(
    fixture: LocalJobFixture,
  ): ReturnType<LocalJobTransport['storage']> {
    const storage = this.#storage(fixture);
    return {
      output: await storage.read(fixture.outputBucket, 'from-workload.txt'),
      checkpoint: await storage.read(
        fixture.checkpointBucket,
        'from-workload.txt',
      ),
    };
  }

  async completedByCli(
    fixture: JobFixture,
  ): ReturnType<LocalJobTransport['completedByCli']> {
    const facts = await completedJobByCli(
      this.#dependencies.cli,
      fixture.ref.id,
    );
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-cli-completion`,
      facts,
    );
    await this.#localOwnerSurvives(fixture.ref.id);
    return facts;
  }

  /**
   * The Job a signed-out CLI submitted is owned by the local API, and
   * stays so, and visible, across an API restart and a later GitHub sign-in.
   */
  async #localOwnerSurvives(id: string): Promise<void> {
    const before = await this.#localOwner(id);
    if (!/^local:[0-9a-f]{32}$/u.test(before))
      throw new Error(`Local Job owner ${before} is not the local API's`);
    await this.#dependencies.apiRestarter.restart();
    const signedIn = {
      env: { GITHUB_TOKEN: 'dummy-token-for-test' },
      timeoutMs: 90_000,
      recordArtifact: false,
    };
    complete(
      await this.#dependencies.cli.run(
        cliArgs('status', { json: true }, [id]),
        { ...signedIn, label: 'local-job-status-signed-in' },
      ),
    );
    const list = await this.#dependencies.cli.run(
      cliArgs('list', { json: true, filter: id }),
      { ...signedIn, label: 'local-job-list-signed-in' },
    );
    complete(list);
    const listed: unknown = JSON.parse(list.stdout);
    if (
      !Array.isArray(listed) ||
      !listed.some((row) => isRecord(row) && row.id === id)
    )
      throw new Error(`Signed-in list does not show local Job ${id}`);
    const after = await this.#localOwner(id);
    if (after !== before)
      throw new Error(`Local Job owner changed from ${before} to ${after}`);
    await this.#dependencies.artifacts.json(`job-${id}-local-owner`, {
      owner: before,
      survivesRestartAndSignIn: true,
    });
  }

  async #localOwner(id: string): Promise<string> {
    const result = await this.#cli([
      'db',
      'query',
      `SELECT owner_user_id FROM workloads WHERE id = '${id}'`,
      '--json',
    ]);
    const body: unknown = JSON.parse(result.stdout);
    const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows : [];
    const owner: unknown = isRecord(rows[0])
      ? rows[0].owner_user_id
      : undefined;
    if (rows.length !== 1 || typeof owner !== 'string')
      throw new Error(`Local Job ${id} has no single recorded owner`);
    return owner;
  }

  async lateInputRemainsAbsent(fixture: LocalJobFixture): Promise<boolean> {
    await this.#storage(fixture).write(
      fixture.inputBucket,
      'late.txt',
      `late-${fixture.ref.id}`,
    );
    await pause(5_000, undefined, { signal: this.#dependencies.signal });
    const result = await this.#guest(fixture, [
      'test',
      '-e',
      '/mnt/input/late.txt',
    ]);
    return result.exitCode === 1;
  }

  async nativeAbsence(
    fixture: JobFixture,
    timeoutMs: number,
  ): ReturnType<LocalJobTransport['nativeAbsence']> {
    const owned = this.#require(fixture);
    await this.#verifyNative(fixture.ref, timeoutMs);
    owned.nativeState.absent = true;
    return this.#dependencies.kernel.recordSubstrateAbsence(fixture.ref);
  }

  async releaseResources(fixture: JobFixture): Promise<void> {
    const owned = this.#require(fixture, false);
    if (!owned.nativeState.absent)
      throw new Error('Job resources still have an unresolved native child');
    if (owned.resources) {
      await owned.resources.storage.release();
      await this.#dependencies.secrets.delete(owned.resources.secretName);
    }
    const completedAt = Date.now();
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-resources-released`,
      {
        workloadId: fixture.ref.id,
        generation: owned.generation,
        startedAt: owned.startedAt,
        completedAt,
        durationMs: completedAt - owned.startedAt,
      },
    );
  }

  async #verifyNative(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<void> {
    const deadlineAt = Date.now() + timeoutMs;
    await this.#dependencies.native.verify(ref, timeoutMs);
    await this.#verifyLocalInventory(ref, deadlineAt);
  }

  async #verifyLocalInventory(
    ref: TrackedWorkloadRef,
    deadlineAt: number,
    generation?: number,
  ): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0)
      throw new Error(
        'Local Job cleanup deadline expired before full inventory',
      );
    const inventory = await this.#dependencies.cleanupWait.for(
      'Local Job complete owned-machine inventory',
      () =>
        ownedSmolvmMachines(
          this.#dependencies.cleanupHttp,
          this.#smolvmUrl,
          ref.id,
          { deadlineAt, signal: this.#dependencies.cleanupSignal },
        ),
      {
        timeoutMs: remaining,
        intervalMs: Math.min(2_000, remaining),
        probeError: 'fail',
        unmet: (machines) =>
          machines.length === 0 ? undefined : 'owned Local Job machines remain',
      },
    );
    await this.#dependencies.artifacts.json(
      `job-${ref.id}-${generation ? `generation-${generation}-` : ''}local-inventory`,
      {
        workloadId: ref.id,
        generation,
        host: this.#smolvmUrl.origin,
        inventoryComplete: true,
        ownedMachines: inventory,
        absent: true,
        observedAt: Date.now(),
      },
    );
  }

  async #reserve(
    id: string,
    cleanupMs: number,
    nativeState: { absent: boolean },
    controller: JobControllerBinding,
  ): Promise<TrackedWorkloadRef> {
    assertJobController(this.#dependencies.api, controller);
    const ref = await this.#dependencies.kernel.reserveWithCleanupVerification(
      id,
      cleanupMs,
      async (registered, timeoutMs) => {
        await this.#verifyNative(registered, timeoutMs);
        nativeState.absent = true;
      },
      controller,
    );
    this.#dependencies.native.register(
      ref,
      { provider: CloudType.Local, credentialId: null, controller },
      {
        observe: (attempt, timeoutMs, deadlineAt) =>
          observeLocalSmolvmHost(
            this.#dependencies.cleanupHttp,
            this.#smolvmUrl,
            attempt.cloudId,
            {
              deadlineAt: Math.min(deadlineAt, Date.now() + timeoutMs),
              signal: this.#dependencies.cleanupSignal,
            },
          ),
      },
    );
    return ref;
  }

  #storage(fixture: LocalJobFixture): LocalJobStorage {
    const storage = this.#require(fixture).resources?.storage;
    if (!storage) throw new Error('Local Job has no storage extension');
    return storage;
  }

  /**
   * The Secret's file is root-owned 0444; a save reaches the running
   * container, and the poll restores files a reboot's empty /run would lose,
   * while the environment keeps its start value. Only digests leave.
   */
  async #liveSecretFile(fixture: LocalJobFixture): Promise<boolean> {
    const name = fixture.secretName;
    const path = `/run/anycloud-secrets/${name}/LOCAL_SECRET_VALUE`;
    const read = async () =>
      (
        await this.#cli([
          'exec',
          fixture.ref.id,
          `sha256sum < ${path} 2>/dev/null | cut -d' ' -f1; stat -c '%a %u' ${path} 2>/dev/null; printf '%s' "$LOCAL_SECRET_VALUE" | sha256sum | cut -d' ' -f1`,
        ])
      ).stdout
        .trim()
        .split('\n');
    // The file holds the new value, while the environment keeps its own.
    const arrives = async (label: string, digest: string) => {
      const [, , environment] = await this.#dependencies.wait.for(label, read, {
        timeoutMs: 60_000,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: ([observed]) =>
          observed === digest ? undefined : 'file lacks the saved value',
      });
      return environment === fixture.secretDigest;
    };
    const [file, stat] = await read();
    const value = `job-secret-updated-${fixture.ref.id}`;
    this.#dependencies.redactor.add(value);
    await this.#dependencies.secrets.create(name, {
      LOCAL_SECRET_VALUE: value,
    });
    const updated = createHash('sha256').update(value).digest('hex');
    const delivered = await arrives('Saved Secret reaching the Job', updated);
    const cleared = await this.#guest(fixture, [
      'sh',
      '-c',
      `rm -rf /run/anycloud-secrets/files/${name} /run/anycloud-secrets/files/.${name}.*`,
    ]);
    return (
      file === fixture.secretDigest &&
      stat === '444 0' &&
      delivered &&
      cleared.exitCode === 0 &&
      (await arrives('Secret files restored after /run clears', updated))
    );
  }

  async #cli(args: readonly string[]): Promise<CommandResult> {
    const result = await this.#dependencies.cli.run(args, {
      timeoutMs: 90_000,
      recordArtifact: false,
      label: 'local-job-observation',
    });
    complete(result);
    return result;
  }

  async #guest(
    fixture: LocalJobFixture,
    command: readonly string[],
  ): Promise<{ readonly stdout: string; readonly exitCode: number }> {
    const response = await this.#dependencies.http.post(
      'local-job-guest',
      new URL(
        `/api/v1/machines/ac-local-${fixture.ref.id}-0/exec`,
        this.#smolvmUrl,
      ),
      { command, timeoutSecs: 30 },
      { headers: { 'Content-Type': 'application/json' }, redirect: 'error' },
    );
    if (
      response.status !== 200 ||
      !isRecord(response.body) ||
      typeof response.body.stdout !== 'string' ||
      !Number.isSafeInteger(response.body.exitCode)
    )
      throw new Error(
        'Local Job guest execution returned a malformed response',
      );
    const exitCode = response.body.exitCode;
    if (typeof exitCode !== 'number' || exitCode < 0 || exitCode > 255)
      throw new Error(
        'Local Job guest execution returned an invalid exit status',
      );
    return { stdout: response.body.stdout, exitCode };
  }

  #require(fixture: JobFixture, active = true): OwnedLocalJob {
    const owned = this.#owned.get(fixture);
    if (!owned)
      throw new Error('Local Job fixture is forged or belongs to another run');
    assertJobController(this.#dependencies.api, owned.controller);
    if (active) this.#dependencies.kernel.assertActive(fixture.ref);
    return owned;
  }
}
