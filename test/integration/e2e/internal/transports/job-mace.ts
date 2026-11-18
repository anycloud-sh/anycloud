import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildMaceReport } from '../../../helpers/mace-report.js';
import { getAnycloudVersion } from '../../../../../src/shared/services/api-client/runtime.js';
import type { ArtifactStore } from '../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../cleanup.js';
import type { FixtureFiles } from '../files.js';
import type { ProcessRunner } from '../process.js';
import type {
  JobMaceObservation,
  JobMaceProbe,
  JobMemberProfile,
} from '../targets/job-types.js';
import { isRecord, type CommandResult, type StatusResponse } from '../types.js';
import {
  isolatedJobEnvironment,
  privateJobOutput,
  type JobPrivateCommands,
} from './job-command.js';

interface Dependencies {
  readonly id: string;
  readonly profile: JobMemberProfile;
  readonly apiUrl: string;
  /** The bearer for a controller URL, read at start (an upgrade replaces it). */
  readonly bearer: (url: string) => string;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly files: Pick<FixtureFiles, 'directory' | 'remove'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly commands: Pick<JobPrivateCommands, 'run'>;
  readonly assertController: () => void;
}

/** Reuse the Bash observer and its receipt, with an owned, joined child process. */
export class JobMaceTransport implements JobMaceProbe {
  readonly #d: Dependencies;
  readonly #stop = new AbortController();
  #execution?: Promise<void>;
  #result?: CommandResult;
  #executionError?: Error;
  #registration?: CleanupRegistration;
  #output?: string;
  #startedAt?: number;
  #apiContainer?: string;
  #finished = false;

  constructor(dependencies: Dependencies) {
    this.#d = dependencies;
  }

  async start(timeoutMs: number): Promise<void> {
    if (this.#startedAt !== undefined)
      throw new Error('MACE observer cannot be started twice');
    const d = this.#d;
    d.assertController();
    this.#startedAt = Date.now();
    this.#apiContainer = (
      await d.commands.run(
        'docker',
        ['inspect', '--format', '{{.Id}}', 'anycloud-api'],
        {},
        Date.now() + 60_000,
        60_000,
      )
    ).trim();
    if (!/^[a-f0-9]{64}$/u.test(this.#apiContainer))
      throw new Error('MACE observer lacks its original API container');
    const directory = await d.files.directory(`job-mace-${d.id}`, {
      private: true,
    });
    this.#output = `${directory}/observer.json`;
    if ((await this.#read()) !== undefined)
      throw new Error('MACE observer refused a reused receipt path');
    // Register before spawning, and join even after foreground cancellation.
    // The shared ProcessRunner drains and reaps the child before resolving.
    this.#registration = d.cleanup.defer(
      `job-${d.id}-mace-observer`,
      async () => {
        this.#stop.abort();
        await this.#execution;
        await this.#retain();
        await d.files.remove(`job-mace-${d.id}`);
      },
    );
    d.assertController();
    this.#execution = d.runner
      .run(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../helpers/observe-ac-timing.mjs', import.meta.url),
          ),
          '--api-url',
          d.apiUrl,
          '--workload-id',
          d.id,
          '--run-id',
          `${d.id}-run`,
          '--output',
          this.#output,
          '--timeout-ms',
          String(timeoutMs),
        ],
        {
          timeoutMs,
          signal: this.#stop.signal,
          env: isolatedJobEnvironment({
            ANYCLOUD_OBSERVER_ACCESS_TOKEN: d.bearer(d.apiUrl),
            ANYCLOUD_OBSERVER_VERSION: getAnycloudVersion(),
          }),
          recordArtifact: false,
        },
      )
      .then(
        (result) => {
          this.#result = result;
        },
        () => {
          this.#executionError = new Error(
            'MACE observer returned no process receipt',
          );
        },
      );
  }

  async observation(): Promise<JobMaceObservation | undefined> {
    if (!this.#execution) throw new Error('MACE observer was not started');
    this.#d.assertController();
    const value = await this.#read();
    if (this.#executionError) throw this.#executionError;
    if (this.#result) privateJobOutput(this.#result);
    if (value === undefined) return undefined;
    if (
      !isRecord(value) ||
      value.schemaVersion !== 2 ||
      value.observationSource !== 'ci-api-log-stream' ||
      value.deliveryLatencyIncluded !== true ||
      value.workloadId !== this.#d.id ||
      value.runId !== `${this.#d.id}-run` ||
      !['armed', 'attached', 'observed', 'failed'].includes(
        String(value.phase),
      ) ||
      typeof value.observerArmedAtMs !== 'number' ||
      !Number.isSafeInteger(value.observerArmedAtMs) ||
      value.observerArmedAtMs < this.#startedAt! ||
      value.observerArmedAtMs > Date.now() ||
      !(
        value.firstInferenceLogObservedAtMs === null ||
        (typeof value.firstInferenceLogObservedAtMs === 'number' &&
          Number.isSafeInteger(value.firstInferenceLogObservedAtMs))
      ) ||
      !(
        value.marker === null ||
        (isRecord(value.marker) && isRecord(value.marker.payload))
      )
    )
      throw new Error('MACE observer receipt is malformed, stale or foreign');
    return structuredClone(value) as JobMaceObservation;
  }

  async finish(): Promise<void> {
    if (!this.#execution || this.#finished)
      throw new Error('MACE observer completion is missing or reused');
    await this.#execution;
    await this.#retain();
    if (this.#executionError) throw this.#executionError;
    if (!this.#result) throw new Error('MACE observer has no exit receipt');
    privateJobOutput(this.#result);
    this.#d.assertController();
    await this.#d.files.remove(`job-mace-${this.#d.id}`);
    this.#registration!.complete();
    this.#finished = true;
  }

  async pullLogMessages(): Promise<readonly string[]> {
    if (!this.#apiContainer || !this.#finished)
      throw new Error('MACE delivery path precedes its successful observation');
    this.#d.assertController();
    const raw = await this.#d.commands.run(
      'docker',
      ['logs', this.#apiContainer],
      {},
      Date.now() + 60_000,
      60_000,
      'combined',
    );
    this.#d.assertController();
    const messages: string[] = [];
    for (const line of raw.split('\n')) {
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (
        isRecord(entry) &&
        entry.id === this.#d.id &&
        typeof entry.message === 'string'
      )
        messages.push(entry.message);
    }
    await this.#d.artifacts.json(`job-${this.#d.id}-mace-pull-logs`, {
      workloadId: this.#d.id,
      generation: 1,
      apiContainerId: this.#apiContainer,
      messages,
    });
    return Object.freeze(messages);
  }

  async writeReport(
    status: StatusResponse | undefined,
    observer: JobMaceObservation | undefined,
    deliveryPath: string,
  ): Promise<void> {
    const { id, profile, artifacts } = this.#d;
    if (
      (status && status.workload.id !== id) ||
      (observer && observer.workloadId !== id)
    )
      throw new Error('MACE report cannot use another Job observation');
    await artifacts.json(
      `job-${id}-mace-report`,
      buildMaceReport(status ?? null, observer ?? null, {
        generatedAt: new Date().toISOString(),
        cloud: profile.member.target,
        workloadId: id,
        image: profile.image,
        vmType: profile.vmTypes[0],
        requestedRegion: profile.computeRegion,
        requestedZone: profile.computeZone,
        diskSizeGb: profile.diskSizeGb,
        diskTier: profile.diskTier,
        deliveryPath,
      }),
    );
  }

  async #read(): Promise<unknown> {
    if (!this.#output) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.#output, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      await this.#d.artifacts.json(`job-${this.#d.id}-mace-invalid-observer`, {
        raw,
      });
      throw new Error('MACE observer returned malformed JSON');
    }
  }

  async #retain(): Promise<void> {
    const observer = await this.#read();
    if (observer !== undefined)
      await this.#d.artifacts.json(`job-${this.#d.id}-mace-observer`, observer);
    const result = this.#result;
    await this.#d.artifacts.json(`job-${this.#d.id}-mace-observer-process`, {
      workloadId: this.#d.id,
      generation: 1,
      startedAt: this.#startedAt,
      completedAt: Date.now(),
      ...(result
        ? {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            aborted: result.aborted,
            outputTruncated: result.outputTruncated,
            durationMs: result.durationMs,
            spawnFailed: Boolean(result.spawnError),
          }
        : { processReceiptMissing: true }),
    });
  }
}
