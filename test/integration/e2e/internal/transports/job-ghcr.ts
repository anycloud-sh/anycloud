import { readFile } from 'node:fs/promises';

import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../cleanup.js';
import type { PinnedRemoteHost, RemoteExecutor } from '../remote.js';
import type {
  CloudJobFixture,
  JobGhcrImageFacts,
  JobGhcrPoll,
  JobGhcrProbe,
  JobNativeAttempt,
} from '../targets/job-types.js';
import { isRecord, type CommandResult } from '../types.js';
import type { TargetHttpClient } from './http.js';
import {
  jobOperationTimeout,
  isolatedJobEnvironment,
  privateJobOutput,
  type JobPrivateCommands,
  quote,
} from './job-command.js';

interface Dependencies {
  readonly fixture: CloudJobFixture;
  readonly cleanupRemote: Pick<RemoteExecutor, 'pinHost'>;
  readonly commands: JobPrivateCommands;
  readonly cleanupCommands: JobPrivateCommands;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly artifacts: Pick<ArtifactStore, 'json' | 'text'>;
  readonly redactor: Pick<Redactor, 'add'>;
  readonly http: Pick<TargetHttpClient, 'get'>;
  readonly assertController: () => void;
  readonly assertAttempt: (attempt: JobNativeAttempt) => Promise<void>;
}

/** The existing payloads run on one original host; Workload cleanup owns its deletion. */
export class JobGhcrTransport implements JobGhcrProbe {
  readonly #d: Dependencies;
  readonly #unit: string;
  readonly #directory: string;
  #host?: PinnedRemoteHost;
  #attempt?: JobNativeAttempt;
  #facts?: JobGhcrImageFacts;
  #registration?: CleanupRegistration;
  #throughputStarted = false;
  #pullStarted = false;
  #pullDone = false;
  #finished = false;

  constructor(dependencies: Dependencies) {
    this.#d = dependencies;
    this.#unit = `${dependencies.fixture.ref.id}-containerd-pull`;
    this.#directory = `/var/tmp/${this.#unit}`;
  }

  async prepare(): Promise<JobGhcrImageFacts> {
    if (this.#facts) throw new Error('GHCR image preparation cannot be reused');
    this.#facts = await this.#imageFacts();
    return this.#facts;
  }

  async bind(attempt: JobNativeAttempt): Promise<void> {
    const d = this.#d;
    if (
      this.#attempt ||
      !this.#facts ||
      !d.fixture.profile.ghcr ||
      attempt.ref !== d.fixture.ref ||
      attempt.endedAt !== null ||
      !attempt.ip
    )
      throw new Error('GHCR probe requires its original live Job attempt');
    d.assertController();
    await d.assertAttempt(attempt);
    this.#attempt = Object.freeze({ ...attempt });
    this.#host = await d.cleanupRemote.pinHost(d.fixture.ref.id, {
      expectedHost: attempt.ip,
      env: isolatedJobEnvironment(),
      recordArtifact: false,
    });
    // Only SSH material and diagnostics live here. The already-armed Workload
    // registration owns the VM, detached unit and all probe-created daemons.
    this.#registration = d.cleanup.defer(
      `job-${d.fixture.ref.id}-ghcr-ssh-material`,
      async () => {
        const errors: unknown[] = [];
        const deadline = Date.now() + 180_000;
        if (this.#pullStarted) {
          if (!this.#pullDone) {
            try {
              privateJobOutput(
                await this.#remote(
                  `load=$(systemctl show ${quote(this.#unit)} --property=LoadState --value) && if [ "$load" != not-found ]; then systemctl stop --no-block ${quote(this.#unit)}; fi`,
                  deadline,
                  true,
                ),
              );
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await this.#capture(deadline, true);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await this.#host!.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            'GHCR diagnostics or SSH material cleanup failed',
          );
      },
    );
    await d.assertAttempt(attempt);
  }

  async throughput(deadlineAt: number): Promise<string> {
    if (!this.#facts || this.#throughputStarted)
      throw new Error('GHCR throughput preparation is missing or reused');
    this.#throughputStarted = true;
    const profile = this.#d.fixture.profile.ghcr!;
    const payload = (
      await readFile(
        new URL('../../../probe-ghcr-throughput.sh', import.meta.url),
      )
    ).toString('base64');
    const result = await this.#remote(
      `printf '%s' ${quote(payload)} | base64 -d > /tmp/ghcr-probe.sh && bash /tmp/ghcr-probe.sh ${quote(profile.image)} ${quote(this.#facts.layerDigest)} ${profile.sampleBytes} ${quote(profile.ladder.join(' '))}`,
      deadlineAt,
      false,
      jobOperationTimeout(deadlineAt, 7_200_000),
    );
    await this.#d.artifacts.text(
      `job-${this.#d.fixture.ref.id}-ghcr-probe`,
      result.combined,
    );
    privateJobOutput(result);
    return result.combined;
  }

  async startPull(): Promise<void> {
    if (!this.#facts || !this.#throughputStarted || this.#pullStarted)
      throw new Error('GHCR detached pull is early or reused');
    const profile = this.#d.fixture.profile.ghcr!;
    const script = `${this.#directory}/probe.sh`;
    const launcher = `${this.#directory}/run.sh`;
    const output = `${this.#directory}/output.log`;
    const status = `${this.#directory}/exit-code`;
    const payload = (
      await readFile(
        new URL('../../../probe-containerd-parallel-pull.sh', import.meta.url),
      )
    ).toString('base64');
    const launch = Buffer.from(
      [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        `output=${quote(output)}`,
        `status=${quote(status)}`,
        'finish() { local exit_code=$?; trap - EXIT; printf "%s\\n" "$exit_code" > "${status}.tmp"; mv -f "${status}.tmp" "$status"; exit "$exit_code"; }',
        'trap finish EXIT',
        `${quote(script)} ${quote(profile.image)} ${this.#facts.imageBytes} ${profile.pullConcurrency} ${profile.pullChunkBytes} ${profile.measureBaseline ? 1 : 0} > "$output" 2>&1`,
      ].join('\n'),
    ).toString('base64');
    // Set intent before the send: a lost SSH reply must retain the unit scope.
    this.#pullStarted = true;
    const result = await this.#remote(
      `mkdir -p -- ${quote(this.#directory)} && test ! -e ${quote(status)} && printf '%s' ${quote(payload)} | base64 -d > ${quote(script)} && printf '%s' ${quote(launch)} | base64 -d > ${quote(launcher)} && chmod 0755 -- ${quote(script)} ${quote(launcher)} && systemd-run --quiet --collect --no-block --property=Type=exec --property=RuntimeMaxSec=${profile.pullTimeoutMs / 1000} --unit=${quote(this.#unit)} ${quote(launcher)}`,
      Date.now() + 90_000,
    );
    privateJobOutput(result);
  }

  async poll(deadlineAt: number): Promise<JobGhcrPoll> {
    if (!this.#pullStarted) throw new Error('GHCR pull was not started');
    const status = `${this.#directory}/exit-code`;
    const result = await this.#remote(
      `if [ -s ${quote(status)} ]; then printf 'AC_PROBE_STATUS done:' && cat ${quote(status)}; else unit_state=$(systemctl is-active ${quote(this.#unit)} 2>/dev/null || true); printf 'AC_PROBE_STATUS %s\\n' "\${unit_state:-unknown}"; fi`,
      deadlineAt,
    );
    await this.#d.artifacts.json(`job-${this.#d.fixture.ref.id}-ghcr-poll`, {
      workloadId: this.#d.fixture.ref.id,
      generation: 1,
      attempt: this.#attempt,
      unit: this.#unit,
      result,
    });
    if (
      result.timedOut ||
      result.aborted ||
      result.outputTruncated ||
      result.spawnError
    )
      privateJobOutput(result);
    if (result.exitCode !== 0 || result.signal !== null)
      return { state: 'transport-failure' };
    const line = result.stdout.trim();
    const done = /^AC_PROBE_STATUS done:([0-9]{1,3})$/u.exec(line);
    if (done && Number(done[1]) <= 255) {
      this.#pullDone = true;
      return { state: 'done', exitCode: Number(done[1]) };
    }
    const state =
      /^AC_PROBE_STATUS (active|activating|deactivating|inactive|failed|unknown)$/u.exec(
        line,
      )?.[1];
    if (!state)
      throw new Error('GHCR detached pull returned a malformed status');
    return { state: state as JobGhcrPoll['state'] };
  }

  capture(): Promise<string> {
    return this.#capture(Date.now() + 90_000, false);
  }

  async finish(deadlineAt: number): Promise<void> {
    if (!this.#host || !this.#pullDone || this.#finished)
      throw new Error('GHCR SSH release precedes pull completion or is reused');
    jobOperationTimeout(deadlineAt);
    this.#d.assertController();
    await this.#host.close();
    this.#registration!.complete();
    this.#finished = true;
  }

  async #capture(deadlineAt: number, cleanup: boolean): Promise<string> {
    if (!this.#pullStarted)
      throw new Error('GHCR capture precedes pull intent');
    const result = await this.#remote(
      `cat ${quote(`${this.#directory}/output.log`)} 2>/dev/null || true; printf '%s\\n' ${quote(`PARALLEL_PULL harness execution=detached unit=${this.#unit}`)}; systemctl status ${quote(this.#unit)} --no-pager --full 2>&1 || true; journalctl -u ${quote(this.#unit)} --no-pager -n 200 2>&1 || true`,
      deadlineAt,
      cleanup,
    );
    await this.#d.artifacts.text(
      `job-${this.#d.fixture.ref.id}-containerd-pull${cleanup ? '-cleanup' : ''}`,
      result.combined,
    );
    privateJobOutput(result);
    return result.combined;
  }

  async #remote(
    command: string,
    deadlineAt: number,
    cleanup = false,
    maximumMs = 90_000,
  ): Promise<CommandResult> {
    if (!this.#host || !this.#attempt || this.#finished)
      throw new Error('GHCR probe has no original pinned host');
    this.#d.assertController();
    const commands = cleanup ? this.#d.cleanupCommands : this.#d.commands;
    const signal = commands.signal(deadlineAt, maximumMs);
    if (!cleanup) await this.#d.assertAttempt(this.#attempt);
    const result = await this.#host.run(command, {
      timeoutMs: jobOperationTimeout(deadlineAt, maximumMs),
      signal,
      recordArtifact: false,
      env: isolatedJobEnvironment(),
    });
    this.#d.assertController();
    if (!cleanup) await this.#d.assertAttempt(this.#attempt);
    return result;
  }

  async #imageFacts(): Promise<JobGhcrImageFacts> {
    const d = this.#d;
    const image = d.fixture.profile.ghcr!.image;
    const repo = image.slice('ghcr.io/'.length).split('@')[0].split(':')[0];
    const reference = image.split('@')[1];
    const deadlineAt = Date.now() + 120_000;
    let facts: JobGhcrImageFacts;
    try {
      const tokenUrl = new URL('https://ghcr.io/token');
      tokenUrl.searchParams.set('scope', `repository:${repo}:pull`);
      tokenUrl.searchParams.set('service', 'ghcr.io');
      const options = () => ({
        deadlineAt,
        signal: d.commands.signal(deadlineAt),
        redirect: 'error' as const,
      });
      const token = await d.http.get('job-ghcr-token', tokenUrl, options());
      if (
        token.status !== 200 ||
        !isRecord(token.body) ||
        typeof token.body.token !== 'string' ||
        !token.body.token
      )
        throw new Error('GHCR did not return an anonymous pull token');
      d.redactor.add(token.body.token);
      const headers = {
        Authorization: `Bearer ${token.body.token}`,
        Accept:
          'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json',
      };
      const manifest = async (digest: string) => {
        const reply = await d.http.get(
          'job-ghcr-manifest',
          new URL(`https://ghcr.io/v2/${repo}/manifests/${digest}`),
          { ...options(), headers },
        );
        if (reply.status !== 200 || !isRecord(reply.body))
          throw new Error('GHCR manifest is unavailable or malformed');
        return reply.body;
      };
      let body = await manifest(reference);
      if (body.manifests !== undefined) {
        if (!Array.isArray(body.manifests))
          throw new Error('GHCR index is malformed');
        const amd64: unknown = body.manifests.find(
          (entry: unknown) =>
            isRecord(entry) &&
            isRecord(entry.platform) &&
            entry.platform.architecture === 'amd64' &&
            entry.platform.os === 'linux',
        );
        if (
          !isRecord(amd64) ||
          typeof amd64.digest !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/u.test(amd64.digest)
        )
          throw new Error('GHCR index has no pinned linux/amd64 manifest');
        body = await manifest(amd64.digest);
      }
      if (!Array.isArray(body.layers) || body.layers.length === 0)
        throw new Error('GHCR manifest has no layers');
      let size = 0;
      let largest = { digest: '', size: -1 };
      for (const layer of body.layers as unknown[]) {
        if (
          !isRecord(layer) ||
          typeof layer.digest !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/u.test(layer.digest) ||
          typeof layer.size !== 'number' ||
          !Number.isSafeInteger(layer.size) ||
          layer.size < 0
        )
          throw new Error('GHCR layer facts are malformed');
        size += layer.size;
        if (!Number.isSafeInteger(size))
          throw new Error(
            'GHCR layer byte count exceeds the safe integer range',
          );
        if (layer.size > largest.size)
          largest = { digest: layer.digest, size: layer.size };
      }
      facts = {
        image,
        layerDigest: largest.digest,
        imageBytes: size,
        resolution: 'runner',
      };
    } catch (error) {
      // Preserve the legacy VM auto-resolution fallback and its unknown byte
      // count. A requested baseline still has to prove comparable throughput.
      facts = {
        image,
        layerDigest: 'auto',
        imageBytes: 0,
        resolution: 'vm-auto',
      };
      await d.artifacts.json(
        `job-${d.fixture.ref.id}-ghcr-resolution-failure`,
        {
          workloadId: d.fixture.ref.id,
          generation: 1,
          error: error instanceof Error ? error.message : String(error),
          ...facts,
        },
      );
    }
    await d.artifacts.json(`job-${d.fixture.ref.id}-ghcr-image-facts`, {
      workloadId: d.fixture.ref.id,
      generation: 1,
      attempt: this.#attempt,
      ...facts,
    });
    return Object.freeze(facts);
  }
}
