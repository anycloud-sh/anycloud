import { createHash, randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactStore } from '../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../cleanup.js';
import type { FixtureFiles } from '../files.js';
import type { JobBucketRef, JobCloudStorage } from '../job-cloud-storage.js';
import type { RemoteExecutor } from '../remote.js';
import type {
  CloudJobFixture,
  JobHydrationActivity,
  JobHydrationApiLogs,
  JobHydrationDisk,
  JobHydrationProbe,
  JobHydrationWorker,
  JobRecoveryIdentity,
} from '../targets/job-types.js';
import { isRecord } from '../types.js';
import { retryTransientProbeError, type Waiter } from '../wait.js';
import type { TargetHttpClient } from './http.js';
import type { JobCloudSession } from './job-cloud-session.js';
import {
  JobPrivateCommands,
  jobOperationTimeout,
  privateJobJson,
  privateJobOutput,
} from './job-command.js';
import { awsRootDisk } from './job-recovery.js';
import type { LocalApiRestarter } from './local-api-restart.js';

const SHARD_BYTES = 128 * 1024 * 1024;
const SHARD_COUNT = 2048;

interface HydrationDependencies {
  readonly id: string;
  readonly region: string;
  readonly apiUrl: string;
  readonly assertController: () => void;
  readonly input: JobBucketRef;
  readonly output: JobBucketRef;
  readonly storage: Pick<JobCloudStorage, 'observe' | 'readText'>;
  readonly session: Pick<JobCloudSession, 'copyHydrationInput' | 'aws'>;
  readonly commands: JobPrivateCommands;
  readonly cleanupCommands: JobPrivateCommands;
  readonly apiRestarter: Pick<LocalApiRestarter, 'restart'>;
  readonly cleanupHttp: Pick<TargetHttpClient, 'get'>;
  readonly cleanupWait: Pick<Waiter, 'for'>;
  readonly remote: Pick<RemoteExecutor, 'run'>;
  readonly files: Pick<FixtureFiles, 'directory'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
}

function integer(value: string): number {
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Job hydration observation contains an invalid integer');
  return Number(value);
}

/** Fixed native I/O for the real 256 GiB member; policy and clocks are observed by the family. */
export class JobHydrationTransport implements JobHydrationProbe {
  readonly #d: HydrationDependencies;
  readonly #unit: string;
  readonly #log: string;
  readonly #stalled: string;
  #prepared = false;
  #restarted = false;
  #hidden = false;
  #apiIdentity: string | undefined;
  #cleanup: CleanupRegistration | undefined;

  constructor(dependencies: HydrationDependencies) {
    if (!/^[a-z0-9-]{1,48}$/u.test(dependencies.id))
      throw new Error('Job hydration identity is invalid');
    this.#d = dependencies;
    this.#unit = `ac-input-${dependencies.id}`;
    this.#log = `/tmp/${this.#unit}.log`;
    this.#stalled = `${this.#log}.e2e-stalled`;
  }

  async prepareInput(
    deadlineAt: number,
  ): Promise<NonNullable<CloudJobFixture['hydration']>> {
    if (this.#prepared)
      throw new Error('Job hydration preparation cannot be replayed');
    this.#prepared = true;
    const d = this.#d;
    d.assertController();
    this.#apiIdentity = await this.#containerId(d.commands, deadlineAt);
    const directory = await d.files.directory(`job-hydration-${d.id}`, {
      private: true,
    });
    const seed = path.join(directory, 'seed.bin');
    const handle = await open(seed, 'wx', 0o600);
    const hash = createHash('sha256');
    const signal = d.commands.signal(deadlineAt, 60_000);
    try {
      for (let chunk = 0; chunk < 128; chunk++) {
        signal.throwIfAborted();
        const bytes = randomBytes(1024 * 1024);
        hash.update(bytes);
        await handle.writeFile(bytes);
      }
    } finally {
      await handle.close();
    }
    if ((await d.storage.observe(d.input, deadlineAt)).presence !== 'present')
      throw new Error('Job hydration fixture lost its owned input bucket');
    const output = await d.session.copyHydrationInput(
      d.input.name,
      d.region,
      seed,
      deadlineAt,
    );
    const receipt = privateJobJson(output.trim().split('\n').at(-1) ?? '');
    if (
      !isRecord(receipt) ||
      Object.keys(receipt).sort().join(',') !==
        'bucket,bytes,objects,region,shardBytes,shardCount' ||
      receipt.bucket !== d.input.name ||
      receipt.region !== d.region ||
      receipt.objects !== SHARD_COUNT + 1 ||
      receipt.bytes !== (SHARD_COUNT + 1) * SHARD_BYTES ||
      receipt.shardCount !== SHARD_COUNT ||
      receipt.shardBytes !== SHARD_BYTES
    )
      throw new Error(
        'Job hydration fixture did not confirm all real 256 GiB and its seed',
      );
    const seedSha256 = hash.digest('hex');
    await d.artifacts.json(`job-${d.id}-input-fixture`, {
      workloadId: d.id,
      generation: 1,
      seedSha256,
      ...receipt,
    });
    return Object.freeze({
      seedSha256,
      apiContainerId: this.#apiIdentity,
      objects: receipt.objects,
      bytes: receipt.bytes,
      command: await readFile(
        new URL(
          '../../../fixtures/job-input-hydration-manifest.sh',
          import.meta.url,
        ),
        'utf8',
      ),
    });
  }

  /** Armed after the Workload cleanup registration, before submission/restart. */
  armApiRescue(cleanup: Pick<CleanupStack, 'defer'>, timeoutMs: number): void {
    if (!this.#apiIdentity || this.#cleanup)
      throw new Error('Job hydration API rescue is unavailable or reused');
    this.#cleanup = cleanup.defer(`job-${this.#d.id}-hydration-api`, () =>
      this.#restoreApi(Date.now() + timeoutMs),
    );
  }

  async finish(deadlineAt: number): Promise<void> {
    await this.#restoreApi(deadlineAt);
    this.#cleanup?.complete();
  }

  async snapshot(deadlineAt: number): Promise<JobHydrationWorker> {
    const fields = (
      await this.#remote(
        `unit='${this.#unit}'; active=$(systemctl is-active "$unit" 2>/dev/null || true); invocation=$(systemctl show "$unit" --property=InvocationID --value 2>/dev/null || true); pid=$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true); identity=$(cat /tmp/${this.#unit}.identity 2>/dev/null || true); bytes=$(wc -c < '${this.#log}' 2>/dev/null | tr -d ' ' || printf 0); printf '%s|%s|%s|%s|%s' "$active" "$invocation" "${'${pid:-0}'}" "$identity" "$bytes"`,
        deadlineAt,
      )
    )
      .trim()
      .split('|');
    if (
      fields.length !== 5 ||
      ![
        'active',
        'inactive',
        'failed',
        'activating',
        'deactivating',
        'unknown',
      ].includes(fields[0]) ||
      (fields[1] !== '' && !/^[a-f0-9]{32}$/u.test(fields[1])) ||
      (fields[3] !== '' && !/^[a-f0-9]{64}$/u.test(fields[3]))
    )
      throw new Error('Job hydration worker observation is malformed');
    return {
      observedAt: Date.now(),
      active: fields[0] === 'active',
      invocation: fields[1],
      pid: integer(fields[2]),
      identity: fields[3],
      logBytes: integer(fields[4]),
    };
  }

  async apiLogs(deadlineAt: number): Promise<JobHydrationApiLogs> {
    const id = this.#apiIdentity;
    if (!id) throw new Error('Job hydration API identity was not captured');
    const output = await this.#d.commands.run(
      'docker',
      ['logs', id],
      {},
      deadlineAt,
      60_000,
      'combined',
    );
    const lines = output
      .split('\n')
      .filter((line) => line.includes(this.#d.id));
    return {
      launched: lines.filter((line) =>
        line.includes('Launched detached VM command'),
      ).length,
      adopted: lines.filter((line) =>
        line.includes('Adopted detached VM command'),
      ).length,
    };
  }

  async restart(): ReturnType<JobHydrationProbe['restart']> {
    if (
      this.#restarted ||
      !this.#cleanup ||
      (await this.#containerId(this.#d.commands, Date.now() + 60_000)) !==
        this.#apiIdentity
    )
      throw new Error(
        'Job hydration restart lost its original armed controller',
      );
    this.#restarted = true;
    const receipt = await this.#d.apiRestarter.restart();
    if (
      receipt.identityBefore !== this.#apiIdentity ||
      receipt.identityAfter !== this.#apiIdentity
    )
      throw new Error('Job hydration restart replaced its original controller');
    return receipt;
  }

  async disk(
    identity: JobRecoveryIdentity,
    deadlineAt: number,
  ): Promise<JobHydrationDisk> {
    if (
      identity.region !== this.#d.region ||
      !/^vol-[a-f0-9]+$/u.test(identity.osDiskId)
    )
      throw new Error('Job hydration root disk lost its original placement');
    return awsRootDisk(this.#d.session, identity, deadlineAt);
  }

  async hideActivity(): Promise<JobHydrationActivity> {
    if (this.#hidden)
      throw new Error('Job hydration activity fault cannot be replayed');
    this.#hidden = true;
    return this.#activity(
      await this.#remote(
        `rm -f '${this.#stalled}'; mv '${this.#log}' '${this.#stalled}'; : > '${this.#log}'; chmod 600 '${this.#log}'; printf '%s|%s' "$(wc -c < '${this.#log}' | tr -d ' ')" "$(wc -c < '${this.#stalled}' | tr -d ' ')"`,
        Date.now() + 90_000,
      ),
    );
  }

  async activity(deadlineAt: number): Promise<JobHydrationActivity> {
    return this.#activity(
      await this.#remote(
        `printf '%s|%s' "$(wc -c < '${this.#log}' 2>/dev/null | tr -d ' ' || printf 0)" "$(wc -c < '${this.#stalled}' 2>/dev/null | tr -d ' ' || printf 0)"`,
        deadlineAt,
      ),
    );
  }

  pause(milliseconds: number): Promise<void> {
    return this.#d.commands.wait(
      milliseconds,
      Date.now() + milliseconds + 5_000,
    );
  }

  async manifest(deadlineAt: number): Promise<string | undefined> {
    if (
      (await this.#d.storage.observe(this.#d.output, deadlineAt)).presence !==
      'present'
    )
      return undefined;
    return this.#d.storage.readText(this.#d.output, 'manifest.txt', deadlineAt);
  }

  #activity(output: string): JobHydrationActivity {
    const fields = output.trim().split('|');
    if (fields.length !== 2)
      throw new Error('Job hydration activity observation is malformed');
    return {
      observedAt: Date.now(),
      visibleBytes: integer(fields[0]),
      hiddenBytes: integer(fields[1]),
    };
  }

  async #remote(command: string, deadlineAt: number): Promise<string> {
    return privateJobOutput(
      await this.#d.remote.run(this.#d.id, 'vm', command, {
        recordArtifact: false,
        timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
      }),
    );
  }

  async #containerId(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<string> {
    const id = (
      await commands.run(
        'docker',
        ['inspect', '--format', '{{.Id}}', 'anycloud-api'],
        {},
        deadlineAt,
        60_000,
      )
    ).trim();
    if (!/^[a-f0-9]{64}$/u.test(id))
      throw new Error(
        'Job hydration controller container identity is malformed',
      );
    return id;
  }

  async #restoreApi(deadlineAt: number): Promise<void> {
    const d = this.#d;
    d.assertController();
    const id = await this.#containerId(d.cleanupCommands, deadlineAt);
    if (id !== this.#apiIdentity)
      throw new Error('Job hydration cleanup refused a replacement controller');
    const running = (
      await d.cleanupCommands.run(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', id],
        {},
        deadlineAt,
        60_000,
      )
    ).trim();
    if (!['true', 'false'].includes(running))
      throw new Error('Job hydration cleanup controller state is unknown');
    if (running === 'false')
      await d.cleanupCommands.run(
        'docker',
        ['start', id],
        {},
        deadlineAt,
        60_000,
      );
    await d.cleanupWait.for(
      'Job original API ready for cleanup',
      (probeDeadline) =>
        d.cleanupHttp.get(
          'job-hydration-api-cleanup',
          new URL('/health', d.apiUrl),
          {
            deadlineAt: Math.min(deadlineAt, probeDeadline),
            timeoutMs: 30_000,
            signal: d.cleanupCommands.signal(deadlineAt, 30_000),
            redirect: 'error',
          },
        ),
      {
        timeoutMs: jobOperationTimeout(deadlineAt, 120_000),
        intervalMs: 500,
        probeError: retryTransientProbeError,
        unmet: (reply) =>
          reply.status === 200 ? undefined : `health returned ${reply.status}`,
        reject: (reply) =>
          reply.status >= 400 && reply.status < 500
            ? 'original API health rejected cleanup'
            : undefined,
      },
    );
    if ((await this.#containerId(d.cleanupCommands, deadlineAt)) !== id)
      throw new Error(
        'Job hydration cleanup controller changed during readback',
      );
    d.assertController();
    await d.artifacts.json(`job-${d.id}-hydration-api-cleanup`, {
      workloadId: d.id,
      generation: 1,
      identity: id,
      restartedForCleanup: running === 'false',
      ready: true,
      observedAt: Date.now(),
    });
  }
}
