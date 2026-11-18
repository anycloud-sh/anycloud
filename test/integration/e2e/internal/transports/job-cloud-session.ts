import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitWithSignal } from '../../../../../src/api/services/request-budget.js';
import { retryAfterMs } from '../../../../../src/shared/retry-after.js';

import type { CloudCredential } from '../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../src/shared/cloud.js';
import type { Redactor } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import { isRecord } from '../types.js';
import type { WaitOptions } from '../wait.js';
import { JobPrivateCommands, privateJobJson } from './job-command.js';

// E2E profiles hold keys.
type NativeCredential = Extract<
  CloudCredential,
  { cloudProvider: CloudType.AWS | CloudType.Azure | CloudType.GCP }
>;

/** A native read whose response never completed; it proves neither presence nor absence. */
export class JobNativeReadIncomplete extends Error {
  constructor() {
    super('Job native read did not return a complete private response');
  }
}

/** Original explicit authorization shared by native storage and recovery observations. */
export class JobCloudSession {
  readonly credential: Readonly<NativeCredential>;
  readonly #commands: JobPrivateCommands;
  readonly #cleanupCommands: JobPrivateCommands;
  readonly #files: Pick<FixtureFiles, 'directory' | 'privateText'>;
  readonly #redactor: Pick<Redactor, 'add'>;
  readonly #name: string;
  #root: string | undefined;
  #initialization: Promise<void> | undefined;
  #accountId: string | undefined;
  #projectNumber: string | undefined;

  constructor(dependencies: {
    readonly name: string;
    readonly credential: NativeCredential;
    readonly commands: JobPrivateCommands;
    readonly cleanupCommands: JobPrivateCommands;
    readonly files: Pick<FixtureFiles, 'directory' | 'privateText'>;
    readonly redactor: Pick<Redactor, 'add'>;
  }) {
    if (!/^[a-z0-9-]{1,80}$/u.test(dependencies.name))
      throw new Error('Job native session name is invalid');
    const credential = dependencies.credential;
    this.credential = Object.freeze(
      credential.cloudProvider === CloudType.GCP
        ? {
            ...credential,
            privateKey: credential.privateKey.replaceAll('\\n', '\n'),
          }
        : { ...credential },
    );
    this.#name = dependencies.name;
    this.#commands = dependencies.commands;
    this.#cleanupCommands = dependencies.cleanupCommands;
    this.#files = dependencies.files;
    this.#redactor = dependencies.redactor;
    for (const [key, value] of Object.entries(this.credential))
      if (/key|secret|token/iu.test(key) && typeof value === 'string')
        this.#redactor.add(value);
  }

  initialize(deadlineAt: number): Promise<void> {
    this.#initialization ??= this.#initialize(deadlineAt);
    return this.#initialization;
  }

  pause(
    milliseconds: number,
    deadlineAt: number,
    cleanup = false,
  ): Promise<void> {
    return this.#runner(cleanup).wait(milliseconds, deadlineAt);
  }

  /** Waits until `deadlineAt`, pausing through this session. */
  waitFor<T>(
    label: string,
    probe: () => Promise<T>,
    options: Omit<WaitOptions<T>, 'timeoutMs'>,
    deadlineAt: number,
    ...cleanup: [] | [boolean]
  ): Promise<T> {
    return this.#runner(cleanup[0] === true).waitFor(
      label,
      probe,
      options,
      deadlineAt,
      (milliseconds) => this.pause(milliseconds, deadlineAt, ...cleanup),
    );
  }

  get accountId(): string {
    if (!this.#accountId)
      throw new Error('Job native AWS account has not been captured');
    return this.#accountId;
  }

  get projectNumber(): string {
    if (!this.#projectNumber)
      throw new Error('Job native GCP project has not been captured');
    return this.#projectNumber;
  }

  async #initialize(deadlineAt: number): Promise<void> {
    this.#root = await this.#files.directory(`job-native-${this.#name}`, {
      private: true,
    });
    const credential = this.credential;
    switch (credential.cloudProvider) {
      case CloudType.AWS: {
        const caller = privateJobJson(
          await this.aws(
            ['sts', 'get-caller-identity'],
            'us-east-1',
            deadlineAt,
          ),
        );
        if (
          !isRecord(caller) ||
          typeof caller.Account !== 'string' ||
          !/^[0-9]{12}$/u.test(caller.Account) ||
          typeof caller.Arn !== 'string' ||
          (!caller.Arn.startsWith(`arn:aws:iam::${caller.Account}:`) &&
            !caller.Arn.startsWith(`arn:aws:sts::${caller.Account}:`))
        )
          throw new Error('Job native AWS account identity is invalid');
        this.#accountId = caller.Account;
        return;
      }
      case CloudType.GCP: {
        const key = await this.#files.privateText(
          `job-native-${this.#name}/key.json`,
          JSON.stringify({
            type: 'service_account',
            project_id: credential.projectId,
            client_email: credential.clientEmail,
            private_key: credential.privateKey,
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
          }),
        );
        await this.gcp(
          [
            'auth',
            'activate-service-account',
            credential.clientEmail,
            `--key-file=${key}`,
          ],
          deadlineAt,
        );
        const project = privateJobJson(
          await this.gcp(
            ['projects', 'describe', credential.projectId, '--format=json'],
            deadlineAt,
          ),
        );
        if (
          !isRecord(project) ||
          project.projectId !== credential.projectId ||
          typeof project.projectNumber !== 'string' ||
          !/^[1-9][0-9]*$/u.test(project.projectNumber)
        )
          throw new Error('Job native GCP project identity is invalid');
        this.#projectNumber = project.projectNumber;
        return;
      }
      case CloudType.Azure: {
        await this.#commands.run(
          'az',
          [
            'login',
            '--service-principal',
            '--username',
            credential.applicationId,
            `--password=${credential.secret}`,
            '--tenant',
            credential.directoryId,
            '--output',
            'none',
          ],
          this.#azureEnvironment(),
          deadlineAt,
        );
        const account = privateJobJson(
          await this.azure(['account', 'show', '--output', 'json'], deadlineAt),
        );
        if (
          !isRecord(account) ||
          account.id !== credential.subscriptionId ||
          account.tenantId !== credential.directoryId
        )
          throw new Error('Job native Azure tenant or subscription changed');
      }
    }
  }

  aws(
    args: readonly string[],
    region: string,
    deadlineAt: number,
    cleanup = false,
  ): Promise<string> {
    const credential = this.credential;
    if (
      credential.cloudProvider !== CloudType.AWS ||
      !/^[a-z]{2}-[a-z]+-[1-9]$/u.test(region) ||
      !['sts', 's3api', 'ec2'].includes(args[0])
    )
      throw new Error('Job native AWS request changed its protocol or region');
    const service = args[0] === 's3api' ? 's3' : args[0];
    return this.#runner(cleanup).run(
      'aws',
      [
        ...args,
        '--region',
        region,
        '--endpoint-url',
        `https://${service}.${region}.amazonaws.com`,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      {
        AWS_ACCESS_KEY_ID: credential.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
        AWS_SESSION_TOKEN: credential.sessionToken,
      },
      deadlineAt,
    );
  }

  /** `maximumMs` raises the 30 s per-command default for calls that block on the provider. */
  gcp(
    args: readonly string[],
    deadlineAt: number,
    cleanup = false,
    maximumMs?: number,
  ): Promise<string> {
    const credential = this.credential;
    if (credential.cloudProvider !== CloudType.GCP || !this.#root)
      throw new Error('Job native GCP session is unavailable');
    return this.#runner(cleanup).run(
      'gcloud',
      [
        ...args,
        `--project=${credential.projectId}`,
        `--account=${credential.clientEmail}`,
        '--quiet',
      ],
      {
        CLOUDSDK_CONFIG: path.join(this.#root, 'gcloud'),
      },
      deadlineAt,
      maximumMs,
    );
  }

  async copyHydrationInput(
    bucket: string,
    region: string,
    seedFile: string,
    deadlineAt: number,
  ): Promise<string> {
    const credential = this.credential;
    if (
      credential.cloudProvider !== CloudType.AWS ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket) ||
      !/^[a-z]{2}-[a-z]+-[1-9]$/u.test(region)
    )
      throw new Error('Job hydration fixture changed its original AWS scope');
    await this.initialize(deadlineAt);
    return this.#commands.run(
      'node',
      [
        fileURLToPath(
          new URL(
            '../../../fixtures/job-input-hydration-copy.mjs',
            import.meta.url,
          ),
        ),
      ],
      {
        AWS_ACCESS_KEY_ID: credential.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
        AWS_SESSION_TOKEN: credential.sessionToken,
        AWS_FIXTURE_ACCOUNT: this.accountId,
        AWS_FIXTURE_BUCKET: bucket,
        AWS_FIXTURE_REGION: region,
        AWS_FIXTURE_SEED_FILE: seedFile,
        AWS_FIXTURE_SHARDS: '2048',
        AWS_FIXTURE_SHARD_BYTES: String(128 * 1024 * 1024),
      },
      deadlineAt,
      1_200_000,
    );
  }

  azure(
    args: readonly string[],
    deadlineAt: number,
    cleanup = false,
    maximumMs?: number,
  ): Promise<string> {
    const credential = this.credential;
    if (credential.cloudProvider !== CloudType.Azure)
      throw new Error('Job native Azure session is unavailable');
    return this.#runner(cleanup).run(
      'az',
      args[0] === 'ad'
        ? args
        : [...args, '--subscription', credential.subscriptionId],
      this.#azureEnvironment(),
      deadlineAt,
      maximumMs,
    );
  }

  async get(
    url: URL,
    deadlineAt: number,
    cleanup = false,
  ): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly retryAfterMs?: number;
  }> {
    if (url.username || url.password || url.hash)
      throw new Error('Job native read changed its authorized URL');
    const credential = this.credential;
    let token: string;
    if (
      credential.cloudProvider === CloudType.GCP &&
      url.origin === 'https://storage.googleapis.com' &&
      url.pathname.startsWith('/storage/v1/b/')
    )
      token = (
        await this.gcp(['auth', 'print-access-token'], deadlineAt, cleanup)
      ).trim();
    else if (
      credential.cloudProvider === CloudType.Azure &&
      url.origin === 'https://management.azure.com' &&
      url.pathname.startsWith(`/subscriptions/${credential.subscriptionId}/`)
    ) {
      const identity = privateJobJson(
        await this.azure(
          [
            'account',
            'get-access-token',
            '--resource',
            'https://management.azure.com/',
            '--output',
            'json',
          ],
          deadlineAt,
          cleanup,
        ),
      );
      if (
        !isRecord(identity) ||
        identity.subscription !== credential.subscriptionId ||
        identity.tenant !== credential.directoryId ||
        typeof identity.accessToken !== 'string'
      )
        throw new Error(
          'Job native Azure token changed tenant or subscription',
        );
      token = identity.accessToken;
    } else
      throw new Error('Job native read changed its authorized origin or scope');
    if (!token || /\s/u.test(token))
      throw new Error('Job native read token is malformed');
    this.#redactor.add(token);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.#runner(cleanup).signal(deadlineAt),
    ]);
    try {
      const response = await awaitWithSignal(
        fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal,
        }),
        signal,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new Error('redirect rejected');
      const body = privateJobJson(
        await awaitWithSignal(response.text(), signal),
      );
      if (Date.now() >= deadlineAt) throw new Error('deadline expired');
      return {
        status: response.status,
        body,
        retryAfterMs: retryAfterMs(response.headers, Date.now()),
      };
    } catch {
      throw new JobNativeReadIncomplete();
    } finally {
      controller.abort();
    }
  }

  #runner(cleanup: boolean): JobPrivateCommands {
    return cleanup ? this.#cleanupCommands : this.#commands;
  }
  #azureEnvironment(): NodeJS.ProcessEnv {
    if (!this.#root)
      throw new Error('Job native Azure private session is unavailable');
    return {
      AZURE_CONFIG_DIR: path.join(this.#root, 'azure'),
      AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
      // A detached telemetry uploader would write here after az returns.
      AZURE_CORE_COLLECT_TELEMETRY: 'false',
    };
  }
}
