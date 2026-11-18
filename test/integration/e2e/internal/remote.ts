import { unlink } from 'node:fs/promises';

import type { ApiClient } from './api.js';
import type { Redactor } from './artifacts.js';
import type { FixtureFiles } from './files.js';
import type { ProcessRunner } from './process.js';
import type {
  CommandResult,
  CommandOptions,
  SshAccessMaterial,
  SshAccessMode,
} from './types.js';

function requireAccess(material: SshAccessMaterial): {
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshPrivateKey: string;
  readonly sshUsername: string;
} {
  const host = material.sshHost ?? material.vmIp;
  const port = material.sshPort ?? 22;
  const username = material.sshUsername ?? 'root';
  if (
    !host ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    !material.sshPrivateKey ||
    !username
  ) {
    throw new Error(
      'SSH access response did not contain usable connection material',
    );
  }
  return {
    sshHost: host,
    sshPort: port,
    sshPrivateKey: material.sshPrivateKey,
    sshUsername: username,
  };
}

export interface PinnedRemoteHost {
  run(
    command: string,
    options?: Pick<
      CommandOptions,
      'timeoutMs' | 'signal' | 'recordArtifact' | 'env'
    >,
  ): Promise<CommandResult>;
  close(): Promise<void>;
}

export class RemoteExecutor {
  readonly #api: Pick<ApiClient, 'sshAccess'>;
  readonly #files: Pick<FixtureFiles, 'privateText'>;
  readonly #runner: Pick<ProcessRunner, 'run'>;
  readonly #redactor: Pick<Redactor, 'add'>;
  #keyCounter = 0;

  constructor(
    api: Pick<ApiClient, 'sshAccess'>,
    files: Pick<FixtureFiles, 'privateText'>,
    runner: Pick<ProcessRunner, 'run'>,
    redactor: Pick<Redactor, 'add'>,
  ) {
    this.#api = api;
    this.#files = files;
    this.#runner = runner;
    this.#redactor = redactor;
  }

  /** Capture one endpoint/key once; subsequent fault cleanup cannot follow a replacement VM. */
  async pinHost(
    workloadId: string,
    options: {
      readonly expectedHost?: string;
      readonly env?: CommandOptions['env'];
      readonly recordArtifact?: boolean;
    } = {},
  ): Promise<PinnedRemoteHost> {
    const material = await this.#api.sshAccess(workloadId, 'vm');
    const access = requireAccess(material);
    if (
      material.workloadId !== workloadId ||
      (options.expectedHost !== undefined &&
        access.sshHost !== options.expectedHost)
    )
      throw new Error(
        'Pinned SSH access does not identify the original Workload host',
      );
    this.#redactor.add(access.sshPrivateKey);
    const suffix = ++this.#keyCounter;
    const keyPath = await this.#files.privateText(
      `ssh/pinned-key-${suffix}`,
      `${access.sshPrivateKey}\n`,
    );
    let hostsPath: string;
    try {
      hostsPath = await this.#files.privateText(
        `ssh/pinned-hosts-${suffix}`,
        '',
      );
    } catch (error) {
      await unlink(keyPath);
      throw error;
    }
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.all([unlink(keyPath), unlink(hostsPath)]);
    };
    const run = (
      command: string,
      initial = false,
      commandOptions: Parameters<PinnedRemoteHost['run']>[1] = {},
    ): Promise<CommandResult> => {
      if (closed) throw new Error('Pinned SSH host was already released');
      return this.#runner.run(
        'ssh',
        [
          '-i',
          keyPath,
          '-p',
          String(access.sshPort),
          '-o',
          `StrictHostKeyChecking=${initial ? 'accept-new' : 'yes'}`,
          '-o',
          `UserKnownHostsFile=${hostsPath}`,
          '-o',
          'BatchMode=yes',
          '-o',
          'LogLevel=ERROR',
          '-o',
          'ConnectTimeout=15',
          '-o',
          'ServerAliveInterval=5',
          '-o',
          'ServerAliveCountMax=3',
          `${access.sshUsername}@${access.sshHost}`,
          command,
        ],
        {
          timeoutMs: 45_000,
          label: `ssh-pinned-${workloadId}`,
          ...(options.env ? { env: options.env } : {}),
          ...(options.recordArtifact !== undefined
            ? { recordArtifact: options.recordArtifact }
            : {}),
          ...commandOptions,
        },
      );
    };
    try {
      const connected = await run('true', true);
      if (
        connected.exitCode !== 0 ||
        connected.timedOut ||
        connected.aborted ||
        connected.spawnError
      ) {
        throw new Error(
          'Could not pin the original Workload SSH host identity',
        );
      }
      return {
        run: (command, commandOptions) => run(command, false, commandOptions),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async run(
    workloadId: string,
    mode: Exclude<SshAccessMode, 'snapshot'>,
    command: string,
    options: {
      readonly recordArtifact?: boolean;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<CommandResult> {
    const access = requireAccess(await this.#api.sshAccess(workloadId, mode));
    this.#redactor.add(access.sshPrivateKey);
    this.#keyCounter += 1;
    const keyPath = await this.#files.privateText(
      `ssh/key-${this.#keyCounter}`,
      `${access.sshPrivateKey}\n`,
    );

    try {
      return await this.#runner.run(
        'ssh',
        [
          '-i',
          keyPath,
          '-p',
          String(access.sshPort),
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'LogLevel=ERROR',
          '-o',
          'ConnectTimeout=30',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=3',
          `${access.sshUsername}@${access.sshHost}`,
          command,
        ],
        {
          timeoutMs: options.timeoutMs ?? 90_000,
          label: `ssh-${mode}-${workloadId}`,
          recordArtifact: options.recordArtifact ?? true,
        },
      );
    } finally {
      await unlink(keyPath).catch(() => undefined);
    }
  }
}
