import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  bucketEntryPageSchema,
  bucketListPageSchema,
  type BucketEntry,
} from '../../../../src/shared/api-contract/bucket-metadata-schemas.js';
import type { ApiClient, BucketPresenceObservation } from './api.js';
import type { ArtifactStore } from './artifacts.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';
import type { CliClient } from './cli.js';
import { cliArgs, type CliOptions } from './cli-surface.js';
import type { FixtureFiles } from './files.js';
import type { Waiter } from './wait.js';
import type {
  JobBucketIdentity,
  JobBucketNativeReader,
  JobNativeBucketObservation,
} from './transports/job-bucket-native.js';
import {
  isolatedJobEnvironment,
  jobOperationTimeout,
  privateJobJson,
  privateJobOutput,
} from './transports/job-command.js';

const bucketBrand: unique symbol = Symbol('JobBucket');
export interface JobBucketRef {
  readonly name: string;
  readonly [bucketBrand]: true;
}
interface OwnedBucket {
  readonly ref: JobBucketRef;
  readonly mode: 'explicit' | 'automatic';
  readonly workloadIds: readonly string[];
  readonly registration: CleanupRegistration;
  closed: boolean;
  creation: Promise<void> | undefined;
  sent: boolean;
  confirmed: boolean;
  startedAt: number | undefined;
  scope: string | undefined;
  identity: JobBucketIdentity | undefined;
  absent: boolean;
  automaticCleanup: boolean | null;
  latestNative: JobNativeBucketObservation | undefined;
  latestApi: BucketPresenceObservation | undefined;
  removal: Promise<void> | undefined;
}

interface StorageDependencies {
  readonly cli: Pick<CliClient, 'run'>;
  readonly cleanupCli: Pick<CliClient, 'run'>;
  readonly api: Pick<ApiClient, 'bucketPresence' | 'controller'>;
  readonly cleanupApi: Pick<ApiClient, 'bucketPresence' | 'controller'>;
  readonly native: Pick<
    JobBucketNativeReader,
    'initialize' | 'observe' | 'prepareInput'
  >;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly files: Pick<FixtureFiles, 'text'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly cleanupWait: Pick<Waiter, 'for'>;
}

/** Public CLI behavior plus independent native/API ownership and cleanup readback. */
type JobBucketScope = Pick<
  CliOptions<'bucket create'>,
  'credentials' | 'region'
>;
/** Transfer flags the fixtures use; the bucket's credential and region are added by the storage. */
export type JobBucketTransferOptions = Pick<
  CliOptions<'bucket rm'>,
  'recursive' | 'concurrency' | 'yes'
>;

export class JobCloudStorage {
  readonly #dependencies: StorageDependencies;
  readonly #credentialName: string;
  readonly #region: string;
  readonly #ownerApi: string;
  readonly #storageFollowsCompute: boolean;
  readonly #childrenAbsent: () => void;
  readonly #cleanupMs: number;
  readonly #owned = new Map<JobBucketRef, OwnedBucket>();
  readonly #controller: BucketPresenceObservation['controller'];
  #observation = 0;
  #download = 0;
  #cleanupDeadlineAt: number | undefined;
  #released = false;

  constructor(
    dependencies: StorageDependencies,
    options: {
      readonly credentialName: string;
      readonly region: string;
      readonly ownerApi: string;
      readonly storageFollowsCompute?: boolean;
      readonly childrenAbsent: () => void;
      readonly cleanupMs: number;
    },
  ) {
    if (
      !/^[a-f0-9]{32}$/u.test(options.ownerApi) ||
      !Number.isSafeInteger(options.cleanupMs) ||
      options.cleanupMs <= 0 ||
      options.cleanupMs > 7_200_000
    )
      throw new Error('Job storage owner or cleanup budget is invalid');
    this.#dependencies = dependencies;
    this.#credentialName = options.credentialName;
    this.#region = options.region;
    this.#ownerApi = options.ownerApi;
    this.#storageFollowsCompute = options.storageFollowsCompute ?? false;
    this.#childrenAbsent = options.childrenAbsent;
    this.#cleanupMs = options.cleanupMs;
    this.#controller = Object.freeze({ ...dependencies.api.controller });
    this.#assertController();
  }

  async reserve(
    name: string,
    mode: OwnedBucket['mode'],
    workloadIds: readonly string[],
    deadlineAt: number,
  ): Promise<JobBucketRef> {
    if (this.#released) throw new Error('Job storage owner has begun cleanup');
    if (
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(name) ||
      [...this.#owned.keys()].some((ref) => ref.name === name) ||
      workloadIds.length === 0 ||
      workloadIds.some((id) => !/^[a-z0-9-]{1,48}$/u.test(id))
    )
      throw new Error('Job bucket intent is invalid or repeated');
    const ref: JobBucketRef = Object.freeze({
      name,
      [bucketBrand]: true as const,
    });
    const registration = this.#dependencies.cleanup.defer(
      `job-bucket-${name}`,
      () => this.remove(ref, Date.now() + this.#cleanupMs),
    );
    const owned: OwnedBucket = {
      ref,
      mode,
      workloadIds: Object.freeze([...workloadIds]),
      registration,
      closed: false,
      creation: undefined,
      sent: false,
      confirmed: false,
      startedAt: undefined,
      scope: undefined,
      identity: undefined,
      absent: false,
      automaticCleanup: null,
      latestNative: undefined,
      latestApi: undefined,
      removal: undefined,
    };
    this.#owned.set(ref, owned);
    await this.#record(owned, 'intent');
    await this.#dependencies.native.initialize(deadlineAt);
    await this.#assertUnowned(owned, deadlineAt);
    this.#assertOpen(owned);
    return ref;
  }

  async create(ref: JobBucketRef, deadlineAt: number): Promise<void> {
    const owned = this.#require(ref);
    this.#assertOpen(owned);
    if (owned.mode !== 'explicit' || owned.creation)
      throw new Error('Job explicit bucket creation cannot be replayed');
    owned.creation = Promise.resolve().then(() =>
      this.#create(owned, deadlineAt),
    );
    await owned.creation;
  }

  async #create(owned: OwnedBucket, deadlineAt: number): Promise<void> {
    const { ref } = owned;
    await this.#assertUnowned(owned, deadlineAt);
    this.#assertOpen(owned);
    await this.#record(owned, 'create-sending');
    this.#assertOpen(owned);
    owned.sent = true;
    owned.startedAt = Date.now();
    const output = await this.#command(
      ref,
      (scope) => cliArgs('bucket create', scope, [ref.name]),
      deadlineAt,
    );
    if (!output.includes(`Bucket ${ref.name} ready`))
      throw new Error('Job bucket creation did not acknowledge its exact name');
    owned.confirmed = true;
    await this.observe(ref, deadlineAt);
    if (!owned.identity)
      throw new Error('Job bucket creation has no native identity');
    await this.#dependencies.native.prepareInput(ref.name, deadlineAt);
    await this.#record(owned, 'created');
  }

  async beginAutomatic(ref: JobBucketRef, deadlineAt: number): Promise<void> {
    const owned = this.#require(ref);
    this.#assertOpen(owned);
    if (owned.mode !== 'automatic' || owned.creation)
      throw new Error('Job automatic bucket intent cannot be reused');
    owned.creation = Promise.resolve().then(async () => {
      await this.#assertUnowned(owned, deadlineAt);
      this.#assertOpen(owned);
      owned.sent = true;
      owned.confirmed = true;
      owned.startedAt = Date.now();
      await this.#record(owned, 'automatic-create-armed');
      this.#assertOpen(owned);
    });
    await owned.creation;
  }

  async #assertUnowned(owned: OwnedBucket, deadlineAt: number): Promise<void> {
    this.#assertOpen(owned);
    const native = await this.#dependencies.native.observe(
      owned.ref.name,
      deadlineAt,
    );
    owned.latestNative = native;
    const api = await this.#api(owned, deadlineAt, false);
    if (native.presence !== 'absent' || api.presence !== 'absent')
      throw new Error('Job bucket name was owned before creation');
    if (
      native.name !== owned.ref.name ||
      (owned.scope !== undefined && owned.scope !== native.scope)
    )
      throw new Error('Job bucket preflight changed its original native scope');
    owned.scope = native.scope;
    await this.#record(owned, 'pre-create-absent');
  }

  async observe(
    ref: JobBucketRef,
    deadlineAt: number,
    cleanup = false,
  ): Promise<JobNativeBucketObservation> {
    const owned = this.#require(ref);
    if (!cleanup) this.#assertOpen(owned);
    if (!owned.sent || !owned.confirmed)
      throw new Error('Job bucket creation reply is unresolved');
    try {
      for (let read = 0; read < 2; read++) {
        jobOperationTimeout(deadlineAt, 90_000);
        const native = await this.#dependencies.native.observe(
          ref.name,
          deadlineAt,
          cleanup,
          this.#storageFollowsCompute && owned.mode === 'automatic',
        );
        owned.latestNative = native;
        if (native.presence === 'present') {
          const identity = native.identity;
          if (
            identity.name !== ref.name ||
            identity.scope !== owned.scope ||
            identity.ownerApi !== this.#ownerApi ||
            owned.startedAt === undefined ||
            identity.createdAt < owned.startedAt - 60_000 ||
            identity.createdAt > Date.now() + 60_000 ||
            (owned.mode === 'automatic'
              ? !owned.workloadIds.includes(identity.workloadId)
              : !new RegExp(`^cli-${identity.ownerUser}-[0-9]+$`, 'u').test(
                  identity.workloadId,
                ))
          )
            throw new Error('Job bucket belongs to a foreign creation or API');
          if (
            owned.identity &&
            JSON.stringify(owned.identity) !== JSON.stringify(identity)
          )
            throw new Error('Job bucket changed its original native identity');
          owned.identity ??= Object.freeze({ ...identity });
        } else if (native.name !== ref.name || native.scope !== owned.scope)
          throw new Error(
            'Job native absence returned another bucket or scope',
          );
        const api = await this.#api(owned, deadlineAt, cleanup);
        if (native.presence === api.presence) {
          await this.#record(owned, 'observed');
          return native;
        }
        await this.#record(owned, 'readback-disagreement');
        // An automatic bucket can be created between these two ordered reads.
        // Reobserve one complete pair within the same deadline; never infer
        // ownership or absence from the first, contradictory observation.
        if (
          read !== 0 ||
          cleanup ||
          owned.mode !== 'automatic' ||
          owned.identity !== undefined ||
          native.presence !== 'absent' ||
          api.presence !== 'present'
        )
          throw new Error('Job native and API bucket presence disagree');
      }
      throw new Error('Job native and API bucket presence disagree');
    } catch (error) {
      return this.#recordFailure(owned, error);
    }
  }

  async buckets(deadlineAt: number): Promise<readonly string[]> {
    const ref = this.#owned.keys().next().value;
    if (!ref)
      throw new Error(
        'Job bucket discovery has no registered credential intent',
      );
    const parsed = z
      .object({
        entries: bucketListPageSchema.shape.buckets,
        truncated: z.literal(false),
        nextCursor: z.null(),
      })
      .safeParse(
        privateJobJson(
          await this.#command(
            ref,
            (scope) =>
              cliArgs('bucket list', { ...scope, all: true, json: true }),
            deadlineAt,
          ),
        ),
      );
    if (
      !parsed.success ||
      new Set(parsed.data.entries.map((b) => b.name)).size !==
        parsed.data.entries.length
    )
      throw new Error('Job public bucket inventory is malformed or duplicated');
    return parsed.data.entries.map((bucket) => bucket.name);
  }

  async entries(
    ref: JobBucketRef,
    prefix: string | undefined,
    recursive: boolean,
    deadlineAt: number,
  ): Promise<readonly BucketEntry[]> {
    this.#require(ref);
    const output = await this.#command(
      ref,
      (scope) =>
        cliArgs('bucket list', { ...scope, recursive, all: true, json: true }, [
          ref.name,
          ...(prefix === undefined ? [] : [prefix]),
        ]),
      deadlineAt,
    );
    const parsed = z
      .object({
        entries: bucketEntryPageSchema.shape.entries,
        truncated: z.literal(false),
        nextCursor: z.null(),
      })
      .safeParse(privateJobJson(output));
    if (
      !parsed.success ||
      new Set(parsed.data.entries.map((entry) => entry.key)).size !==
        parsed.data.entries.length ||
      parsed.data.entries.some(
        (entry) =>
          (prefix !== undefined && !entry.key.startsWith(prefix)) ||
          (recursive && entry.kind !== 'object'),
      )
    )
      throw new Error(
        'Job public object inventory is malformed, foreign or duplicated',
      );
    return parsed.data.entries;
  }

  async transfer(
    ref: JobBucketRef,
    operation: 'upload' | 'download' | 'rm',
    paths: readonly string[],
    deadlineAt: number,
    options: JobBucketTransferOptions = {},
  ): Promise<void> {
    if ((await this.observe(ref, deadlineAt)).presence !== 'present')
      throw new Error('Job bucket transfer has no original native resource');
    await this.#command(
      ref,
      (scope) =>
        cliArgs(`bucket ${operation}`, { ...scope, ...options }, [
          ref.name,
          ...paths,
        ]),
      deadlineAt,
    );
  }

  async readText(
    ref: JobBucketRef,
    key: string,
    deadlineAt: number,
  ): Promise<string | undefined> {
    const entries = await this.entries(ref, key, true, deadlineAt);
    if (!entries.some((entry) => entry.kind === 'object' && entry.key === key))
      return undefined;
    const target = await this.#dependencies.files.text(
      `job-bucket-download-${++this.#download}.txt`,
      '',
    );
    await this.#command(
      ref,
      (scope) => cliArgs('bucket download', scope, [ref.name, key, target]),
      deadlineAt,
    );
    return readFile(target, 'utf8');
  }

  async rejectsFileDirectoryCollision(
    ref: JobBucketRef,
    prefix: string,
    destination: string,
    deadlineAt: number,
  ): Promise<boolean> {
    const owned = this.#require(ref);
    this.#assertOpen(owned);
    if ((await this.observe(ref, deadlineAt)).presence !== 'present')
      throw new Error('Job collision probe has no original native bucket');
    this.#assertOpen(owned);
    let result;
    try {
      result = await this.#dependencies.cli.run(
        cliArgs(
          'bucket download',
          {
            recursive: true,
            concurrency: '2',
            credentials: this.#credentialName,
            region: this.#regionFor(owned),
          },
          [ref.name, prefix, destination],
        ),
        {
          env: isolatedJobEnvironment(),
          recordArtifact: false,
          timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
        },
      );
    } catch {
      throw new Error('Job collision probe has no complete command receipt');
    }
    if (
      result.signal ||
      result.aborted ||
      result.timedOut ||
      result.spawnError ||
      result.outputTruncated ||
      result.exitCode === null ||
      Date.now() >= deadlineAt
    )
      throw new Error('Job collision probe has no complete command receipt');
    return (
      result.exitCode !== 0 &&
      result.combined.includes(
        'Object keys create a file/directory collision at ',
      )
    );
  }

  async requireAutomaticAbsence(
    ref: JobBucketRef,
    timeoutMs: number,
  ): Promise<void> {
    const owned = this.#require(ref);
    if (owned.mode !== 'automatic' || owned.automaticCleanup !== null)
      throw new Error(
        'Job automatic cleanup assertion is unavailable or reused',
      );
    try {
      this.#childrenAbsent();
      await this.#dependencies.cleanupWait.for(
        `Job ${ref.name} automatic checkpoint absence`,
        (deadline) => this.observe(ref, deadline, true),
        {
          timeoutMs,
          intervalMs: Math.min(5_000, timeoutMs),
          probeError: 'fail',
          unmet: (observation) =>
            observation.presence === 'absent'
              ? undefined
              : 'automatic checkpoint bucket remains',
        },
      );
      owned.automaticCleanup = true;
      owned.absent = true;
      owned.closed = true;
      await this.#record(owned, 'automatic-cleanup-absent');
      owned.registration.complete();
    } catch (error) {
      owned.automaticCleanup = false;
      await this.#recordFailure(owned, error);
    }
  }

  remove(ref: JobBucketRef, deadlineAt: number): Promise<void> {
    const owned = this.#require(ref);
    owned.closed = true;
    this.#cleanupDeadlineAt ??= deadlineAt;
    const deadline = Math.min(deadlineAt, this.#cleanupDeadlineAt);
    owned.removal ??= Promise.resolve().then(async () => {
      try {
        await owned.creation?.catch(() => undefined);
        this.#childrenAbsent();
        if (owned.absent) return;
        if (owned.sent) {
          if (!owned.confirmed)
            throw new Error('Job bucket create reply remains unresolved');
          const current = await this.observe(ref, deadline, true);
          if (current.presence === 'present') {
            await this.#command(
              ref,
              (scope) => cliArgs('bucket delete', scope, [ref.name]),
              deadline,
              true,
            );
            await this.#dependencies.cleanupWait.for(
              `Job bucket ${ref.name} native and API absence`,
              (remainingDeadline) => this.observe(ref, remainingDeadline, true),
              {
                timeoutMs: jobOperationTimeout(deadline, this.#cleanupMs),
                intervalMs: Math.min(
                  2_000,
                  jobOperationTimeout(deadline, this.#cleanupMs),
                ),
                probeError: 'fail',
                unmet: (observation) =>
                  observation.presence === 'absent'
                    ? undefined
                    : 'bucket remains after deletion',
              },
            );
          }
        }
        owned.absent = true;
        await this.#record(
          owned,
          owned.sent ? 'cleanup-absent' : 'create-not-sent',
        );
        owned.registration.complete();
      } catch (error) {
        await this.#recordFailure(owned, error);
      }
    });
    return owned.removal;
  }

  async release(deadlineAt: number): Promise<void> {
    this.#released = true;
    for (const ref of this.#owned.keys()) await this.remove(ref, deadlineAt);
  }

  assertAbsent(): void {
    if ([...this.#owned.values()].some((owned) => !owned.absent))
      throw new Error('Job storage ownership remains unresolved');
  }

  #require(ref: JobBucketRef): OwnedBucket {
    const owned = this.#owned.get(ref);
    if (!owned) throw new Error('Job bucket reference is foreign or copied');
    return owned;
  }

  #assertOpen(owned: OwnedBucket): void {
    if (this.#released || owned.closed)
      throw new Error('Job bucket owner has begun cleanup');
    this.#assertController();
  }

  #assertController(): void {
    for (const api of [this.#dependencies.api, this.#dependencies.cleanupApi]) {
      if (
        api.controller.url !== this.#controller.url ||
        api.controller.generation !== this.#controller.generation
      )
        throw new Error(
          'Job bucket API observation changed its original controller',
        );
    }
  }

  #regionFor(owned: OwnedBucket): string {
    return owned.identity?.region ?? this.#region;
  }

  /** Runs one `bucket` command built for the bucket's own credential and region. */
  async #command(
    ref: JobBucketRef,
    build: (scope: JobBucketScope) => string[],
    deadlineAt: number,
    cleanup = false,
  ): Promise<string> {
    const owned = this.#require(ref);
    if (!cleanup) this.#assertOpen(owned);
    else this.#assertController();
    const client = cleanup
      ? this.#dependencies.cleanupCli
      : this.#dependencies.cli;
    const args = build({
      credentials: this.#credentialName,
      region: this.#regionFor(owned),
    });
    try {
      return privateJobOutput(
        await client.run(args, {
          env: isolatedJobEnvironment(),
          recordArtifact: false,
          timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
        }),
      );
    } catch {
      throw new Error(`Job bucket ${String(args[1])} command did not complete`);
    }
  }

  async #api(
    owned: OwnedBucket,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<BucketPresenceObservation> {
    const region = this.#regionFor(owned);
    const api = await (
      cleanup ? this.#dependencies.cleanupApi : this.#dependencies.api
    ).bucketPresence(owned.ref.name, this.#credentialName, region, deadlineAt);
    if (
      api.name !== owned.ref.name ||
      api.credentialName !== this.#credentialName ||
      api.region !== region
    )
      throw new Error(
        'Job bucket API observation changed its original identity',
      );
    this.#assertController();
    if (
      api.controller.url !== this.#controller.url ||
      api.controller.generation !== this.#controller.generation
    )
      throw new Error(
        'Job bucket API observation changed its original controller',
      );
    owned.latestApi = api;
    return api;
  }

  async #recordFailure(owned: OwnedBucket, error: unknown): Promise<never> {
    try {
      await this.#record(owned, 'incomplete');
    } catch (recordError) {
      throw new AggregateError(
        [error, recordError],
        'Job bucket operation and failure recording failed',
      );
    }
    throw error;
  }

  async #record(owned: OwnedBucket, state: string): Promise<void> {
    await this.#dependencies.artifacts.json(
      `job-bucket-${owned.ref.name}-${++this.#observation}`,
      {
        state,
        name: owned.ref.name,
        mode: owned.mode,
        workloadIds: owned.workloadIds,
        credentialName: this.#credentialName,
        region: this.#region,
        ownerApi: this.#ownerApi,
        sent: owned.sent,
        confirmed: owned.confirmed,
        startedAt: owned.startedAt,
        identity: owned.identity,
        native: owned.latestNative,
        api: owned.latestApi,
        absent: owned.absent,
        closed: owned.closed,
        automaticCleanup: owned.automaticCleanup,
        observedAt: Date.now(),
      },
    );
  }
}
