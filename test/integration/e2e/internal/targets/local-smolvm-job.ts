import { cliArgs } from '../cli-surface.js';
import type {
  JobFixture,
  JobMemberProfile,
  LocalJobFixture,
  LocalJobTransport,
} from './job-types.js';

/** Public CLI arguments for the fixed Local member; the transport owns raw I/O. */
export class LocalSmolvmJobAdapter {
  readonly #transport: LocalJobTransport;

  constructor(transport: LocalJobTransport) {
    this.#transport = transport;
  }

  prepare(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<LocalJobFixture> {
    if (
      profile.member.kind !== 'local-held' ||
      profile.member.target !== 'local-smolvm'
    )
      throw new Error('Local held Job adapter received another member');
    return this.#transport.prepare(id, profile, cleanupMs);
  }

  prepareTerminal(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<JobFixture> {
    return this.#transport.prepareTerminal(id, profile, cleanupMs);
  }

  async submitTerminal(fixture: JobFixture): Promise<void> {
    const kind = fixture.profile.member.kind;
    if (kind !== 'local-completed' && kind !== 'local-resubmitted')
      throw new Error('Local terminal Job adapter received another member');
    await this.#transport.submit(
      fixture,
      cliArgs(
        'job',
        { id: fixture.ref.id },
        [fixture.profile.image],
        [
          'sh',
          '-c',
          // A Job without `--secret` gets no GitHub identity from its submitter.
          `test -z "\${GITHUB_TOKEN+set}\${GITHUB_USER+set}" || exit 42; ${
            kind === 'local-completed'
              ? 'sleep 10; echo done; exit 0'
              : 'sleep 10; exit 3'
          }`,
        ],
      ),
    );
  }

  completedByCli(
    fixture: JobFixture,
  ): ReturnType<LocalJobTransport['completedByCli']> {
    if (fixture.profile.member.kind !== 'local-completed')
      throw new Error('CLI completion applies only to the completed Local Job');
    return this.#transport.completedByCli(fixture);
  }

  firstGenerationAbsence(
    ...args: Parameters<LocalJobTransport['firstGenerationAbsence']>
  ): ReturnType<LocalJobTransport['firstGenerationAbsence']> {
    return this.#transport.firstGenerationAbsence(...args);
  }

  resubmit(fixture: JobFixture): Promise<void> {
    return this.#transport.resubmit(fixture);
  }

  async submit(fixture: LocalJobFixture): Promise<void> {
    const id = fixture.ref.id;
    const command = [
      'set -e',
      `test "$(cat /mnt/input/seed.txt)" = "input-${id}"`,
      `test "$(cat /mnt/checkpoint/seed.txt)" = "checkpoint-seed-${id}"`,
      `printf '%s\\n' 'output-${id}' > /mnt/output/from-workload.txt`,
      `printf '%s\\n' 'checkpoint-${id}' > /mnt/checkpoint/from-workload.txt`,
      `printf '%s\\n' '${fixture.stdoutMarker}'`,
      `printf '%s\\n' '${fixture.stderrMarker}' >&2`,
      'while true; do sleep 30; done',
    ].join('; ');
    await this.#transport.submit(
      fixture,
      cliArgs(
        'job',
        {
          id,
          'env-file': fixture.environmentFile,
          env: `LOCAL_OVERRIDE_VAR=${fixture.overrideValue}`,
          secret: fixture.secretName,
          'shm-size': '128m',
          memory: '256m',
          cpus: '0.5',
          ulimit: 'nofile=2048:2048',
          'input-bucket': fixture.inputBucket,
          'output-bucket': fixture.outputBucket,
          'checkpoint-bucket': fixture.checkpointBucket,
        },
        [fixture.profile.image],
        ['sh', '-c', command],
      ),
    );
  }

  attempts(
    ...args: Parameters<LocalJobTransport['attempts']>
  ): ReturnType<LocalJobTransport['attempts']> {
    return this.#transport.attempts(...args);
  }
  configuration(
    ...args: Parameters<LocalJobTransport['configuration']>
  ): ReturnType<LocalJobTransport['configuration']> {
    return this.#transport.configuration(...args);
  }
  storage(
    ...args: Parameters<LocalJobTransport['storage']>
  ): ReturnType<LocalJobTransport['storage']> {
    return this.#transport.storage(...args);
  }
  lateInputRemainsAbsent(
    ...args: Parameters<LocalJobTransport['lateInputRemainsAbsent']>
  ): ReturnType<LocalJobTransport['lateInputRemainsAbsent']> {
    return this.#transport.lateInputRemainsAbsent(...args);
  }
  nativeAbsence(
    ...args: Parameters<LocalJobTransport['nativeAbsence']>
  ): ReturnType<LocalJobTransport['nativeAbsence']> {
    return this.#transport.nativeAbsence(...args);
  }
  releaseResources(
    ...args: Parameters<LocalJobTransport['releaseResources']>
  ): ReturnType<LocalJobTransport['releaseResources']> {
    return this.#transport.releaseResources(...args);
  }
}
