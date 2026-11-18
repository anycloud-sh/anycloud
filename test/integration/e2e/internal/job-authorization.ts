import { createHash } from 'node:crypto';

import { CloudType } from '../../../../src/shared/cloud.js';
import {
  cloudCredentialSchema,
  type CloudCredential,
} from '../../../../src/shared/api-contract/credentials-schemas.js';

import type { ApiClient } from './api.js';
import type { ArtifactStore, Redactor } from './artifacts.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';
import { cliArgs, type CliOptions } from './cli-surface.js';
import type { CliClient } from './cli.js';
import { escapedSql, type CliDatabase } from './database.js';
import type { FixtureFiles } from './files.js';
import type { VmProfile } from './profiles.js';
import type { JobMemberProfile } from './targets/job-types.js';
import type { CommandResult } from './types.js';
import { AwsJobImportFixture } from './transports/job-aws-credential.js';
import {
  AzureJobGeneratedFixture,
  AzureJobRestrictedFixture,
} from './transports/job-azure-credential.js';
import { GcpJobImportFixture } from './transports/job-gcp-credential.js';
import {
  isolatedJobEnvironment,
  jobOperationTimeout,
  JobPrivateCommands,
  privateJobOutput,
} from './transports/job-command.js';

const authorizationBrand: unique symbol = Symbol('JobAuthorization');
export interface JobAuthorizationRef {
  readonly name: string;
  readonly provider: VmProfile['provider'];
  readonly recordId: string;
  readonly [authorizationBrand]: true;
}

interface AuthorizationDependencies {
  readonly api: Pick<
    ApiClient,
    'controller' | 'readCredential' | 'saveCredential'
  >;
  readonly cleanupApi: Pick<
    ApiClient,
    'controller' | 'readCredential' | 'listCredentials' | 'deleteCredential'
  >;
  readonly cli: Pick<CliClient, 'run'>;
  readonly database: Pick<CliDatabase, 'queryComplete'>;
  readonly cleanupDatabase: Pick<CliDatabase, 'queryComplete'>;
  readonly commands: JobPrivateCommands;
  readonly cleanupCommands: JobPrivateCommands;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly files: Pick<FixtureFiles, 'directory' | 'privateText' | 'remove'>;
  readonly redactor: Pick<Redactor, 'add'>;
}

interface CredentialRow {
  readonly id: string;
  readonly name: string | null;
  readonly cloud_provider: VmProfile['provider'];
}

/** One API/native intent, armed before setup and kept until every dependent resource is absent. */
export class JobAuthorization {
  readonly #dependencies: AuthorizationDependencies;
  readonly #name: string;
  readonly #profile: VmProfile;
  readonly #mode: Exclude<JobMemberProfile['credentialMode'], 'credentialless'>;
  readonly #dependentsAbsent: () => void;
  readonly #cleanupMs: number;
  readonly #native:
    | AwsJobImportFixture
    | AzureJobGeneratedFixture
    | AzureJobRestrictedFixture
    | GcpJobImportFixture
    | undefined;
  readonly #apiRegistration: CleanupRegistration;
  readonly #nativeRegistration: CleanupRegistration | undefined;
  readonly #controller: ApiClient['controller'];
  #begun = false;
  #closed = false;
  #creation: Promise<JobAuthorizationRef> | undefined;
  #expectedRecordId: string | undefined;
  #apiSent = false;
  #apiConfirmed = false;
  #apiAbsent = false;
  #nativeAbsent = false;
  #material: Readonly<CloudCredential> | undefined;
  #binding: JobAuthorizationRef | undefined;
  #apiCleanup: Promise<void> | undefined;
  #nativeCleanup: Promise<void> | undefined;
  #observations = 0;
  #cleanupDeadlineAt: number | undefined;

  constructor(
    dependencies: AuthorizationDependencies,
    options: {
      readonly name: string;
      readonly profile: VmProfile;
      readonly mode: Exclude<
        JobMemberProfile['credentialMode'],
        'credentialless'
      >;
      readonly cleanupMs: number;
      readonly dependentsAbsent: () => void;
      /** `aws-restricted` only: the buckets its pilot-shaped policy reaches. */
      readonly restrictedBuckets?: readonly string[];
    },
  ) {
    if (
      !/^(?:bkt-[0-9]{1,17}|aws-storage|(?:aws|azure|gcp|lambda)-test)$/u.test(
        options.name,
      )
    )
      throw new Error('Job API credential name is outside its namespace');
    if (
      !Number.isSafeInteger(options.cleanupMs) ||
      options.cleanupMs <= 0 ||
      options.cleanupMs > 7_200_000
    )
      throw new Error('Job authorization cleanup budget is invalid');
    this.#dependencies = dependencies;
    this.#name = options.name;
    this.#profile = Object.freeze({
      ...options.profile,
      credential: Object.freeze({ ...options.profile.credential }),
      vmTypes: Object.freeze([...options.profile.vmTypes]),
    });
    this.#mode = options.mode;
    this.#cleanupMs = options.cleanupMs;
    this.#dependentsAbsent = options.dependentsAbsent;
    this.#controller = Object.freeze({ ...dependencies.api.controller });
    this.#assertController();
    if (options.profile.credential.cloudProvider !== options.profile.provider)
      throw new Error(
        'Job bootstrap profile has a mismatched credential provider',
      );
    const common = {
      name: options.name,
      commands: dependencies.commands,
      cleanupCommands: dependencies.cleanupCommands,
      files: dependencies.files,
      artifacts: dependencies.artifacts,
      redactor: dependencies.redactor,
    };
    const bootstrap = this.#profile.credential;
    switch (options.mode) {
      case 'aws-import':
        if (bootstrap.cloudProvider !== CloudType.AWS)
          throw new Error('AWS Job import profile is mismatched');
        this.#native = new AwsJobImportFixture({ ...common, bootstrap });
        break;
      case 'aws-restricted':
        if (
          bootstrap.cloudProvider !== CloudType.AWS ||
          !options.restrictedBuckets?.length
        )
          throw new Error('AWS restricted Job profile is mismatched');
        this.#native = new AwsJobImportFixture({
          ...common,
          bootstrap,
          restrictedBuckets: options.restrictedBuckets,
        });
        break;
      case 'gcp-import':
        if (bootstrap.cloudProvider !== CloudType.GCP)
          throw new Error('GCP Job import profile is mismatched');
        this.#native = new GcpJobImportFixture({ ...common, bootstrap });
        break;
      case 'azure-restricted':
        if (bootstrap.cloudProvider !== CloudType.Azure)
          throw new Error('Azure restricted Job profile is mismatched');
        this.#native = new AzureJobRestrictedFixture({ ...common, bootstrap });
        break;
      case 'azure-generate':
        if (bootstrap.cloudProvider !== CloudType.Azure)
          throw new Error('Azure Job generation profile is mismatched');
        this.#native = new AzureJobGeneratedFixture({ ...common, bootstrap });
        break;
      case 'public-token-import':
        if (bootstrap.cloudProvider !== CloudType.Lambda)
          throw new Error('Job token import lacks a public-token capability');
        break;
      case 'bootstrap':
        break;
    }
    // Reverse disposal attempts API cleanup first. The explicit gates below,
    // rather than registration order, retain native keys when any child is unknown.
    this.#nativeRegistration = this.#native
      ? dependencies.cleanup.defer(
          `job-native-authorization-${this.#name}`,
          () => this.#removeNative(Date.now() + this.#cleanupMs),
        )
      : undefined;
    this.#apiRegistration = dependencies.cleanup.defer(
      `job-api-authorization-${this.#name}`,
      () => this.#removeApi(Date.now() + this.#cleanupMs),
    );
  }

  create(deadlineAt: number): Promise<JobAuthorizationRef> {
    if (this.#begun)
      return Promise.reject(new Error('Job credential import is single use'));
    if (this.#closed)
      return Promise.reject(
        new Error('Job credential owner has begun cleanup'),
      );
    this.#begun = true;
    this.#creation = Promise.resolve().then(() => this.#create(deadlineAt));
    return this.#creation;
  }

  async #create(deadlineAt: number): Promise<JobAuthorizationRef> {
    this.#assertOpen();
    await this.#record('intent');
    if (
      (await this.#dependencies.api.readCredential(this.#name, deadlineAt)) ||
      (await this.#rows(this.#dependencies.database, deadlineAt)).length !== 0
    )
      throw new Error(
        'Job API credential name was already owned before import',
      );
    let environment: Readonly<NodeJS.ProcessEnv> = {};
    // How the import authenticates: the AWS profile or an Azure generated principal.
    let extra: Pick<
      CliOptions<'credentials new'>,
      'profile' | 'generate' | 'subscription-id'
    > = {};
    if (this.#native instanceof AwsJobImportFixture) {
      this.#material = await this.#native.create(deadlineAt);
      await this.#dependencies.files.directory(`job-auth-${this.#name}`, {
        private: true,
      });
      const material = this.#material;
      if (material.cloudProvider !== CloudType.AWS)
        throw new Error('AWS Job native import returned another provider');
      const credentials = await this.#dependencies.files.privateText(
        `job-auth-${this.#name}/credentials`,
        `[import]\naws_access_key_id = ${material.accessKeyId}\naws_secret_access_key = ${material.secretAccessKey}\n`,
      );
      const config = await this.#dependencies.files.privateText(
        `job-auth-${this.#name}/config`,
        '[profile import]\nregion = us-east-1\n',
      );
      environment = {
        AWS_SHARED_CREDENTIALS_FILE: credentials,
        AWS_CONFIG_FILE: config,
        AWS_PROFILE: 'import',
      };
      extra = { profile: 'import' };
    } else if (this.#native instanceof GcpJobImportFixture) {
      this.#material = await this.#native.create(deadlineAt);
      const material = this.#material;
      if (material.cloudProvider !== CloudType.GCP)
        throw new Error('GCP Job native import returned another provider');
      environment = {
        GCP_CLIENT_EMAIL: material.clientEmail,
        GCP_PROJECT_ID: material.projectId,
        GCP_PRIVATE_KEY: material.privateKey,
      };
    } else if (this.#native instanceof AzureJobRestrictedFixture) {
      this.#material = await this.#native.create();
      const material = this.#material;
      if (material.cloudProvider !== CloudType.Azure)
        throw new Error('Azure Job native import returned another provider');
      environment = {
        AZURE_APPLICATION_ID: material.applicationId,
        AZURE_SECRET: material.secret,
        AZURE_SUBSCRIPTION_ID: material.subscriptionId,
        AZURE_DIRECTORY_ID: material.directoryId,
      };
    } else if (this.#native instanceof AzureJobGeneratedFixture) {
      environment = await this.#native.prepare(deadlineAt);
      const bootstrap = this.#profile.credential;
      if (bootstrap.cloudProvider !== CloudType.Azure)
        throw new Error('Azure Job profile is mismatched');
      extra = { generate: true, 'subscription-id': bootstrap.subscriptionId };
    } else {
      this.#material = this.#profile.credential;
      if (this.#mode === 'public-token-import') {
        const material = this.#material;
        if (material.cloudProvider !== CloudType.Lambda)
          throw new Error('Job import lacks a public API token');
        environment = { LAMBDA_API_KEY: material.apiKey };
      }
    }
    // The API deduplicates by material, so an unused name alone cannot prove
    // ownership. Reject an existing material row before a create-only import
    // can rename it. Generated Azure material is new and is checked on readback.
    if (this.#material) {
      this.#expectedRecordId = this.#materialId(this.#material);
      if (
        (await this.#rows(this.#dependencies.database, deadlineAt)).length !== 0
      )
        throw new Error(
          'Job credential material was already owned before import',
        );
    }
    await this.#record('prepared');
    this.#assertOpen();
    await this.#record('import-sending');
    this.#assertOpen();
    if (this.#native instanceof AzureJobGeneratedFixture)
      this.#native.generationStarted();
    this.#apiSent = true;
    if (this.#mode === 'bootstrap') {
      if (!this.#material) throw new Error('Job bootstrap material is missing');
      await this.#dependencies.api.saveCredential(this.#name, this.#material, {
        overwrite: false,
        deadlineAt,
      });
    } else {
      let result: CommandResult;
      try {
        result = await this.#dependencies.cli.run(
          cliArgs(
            'credentials new',
            { provider: this.#profile.slug, ...extra },
            [this.#name],
          ),
          {
            env: isolatedJobEnvironment(environment),
            timeoutMs: jobOperationTimeout(deadlineAt, 600_000),
            recordArtifact: false,
          },
        );
      } catch {
        throw new Error(
          'Job credential import did not return a complete process receipt',
        );
      }
      privateJobOutput(result);
      if (
        !result.combined.includes(
          `Credentials "${this.#name}" saved successfully!`,
        )
      )
        throw new Error(
          'Job credential import did not confirm its exact API identity',
        );
    }
    this.#apiConfirmed = true;
    await this.#record('import-confirmed');
    this.#assertController();
    const full = await this.#dependencies.api.readCredential(
      this.#name,
      deadlineAt,
    );
    if (!full || full.cloudProvider !== this.#profile.provider)
      throw new Error('Job API credential readback is missing or foreign');
    if (this.#native instanceof AzureJobGeneratedFixture) {
      if (full.cloudProvider !== CloudType.Azure)
        throw new Error('Azure Job API identity is mismatched');
      await this.#native.capture(full, deadlineAt);
    }
    const rows = await this.#rows(this.#dependencies.database, deadlineAt);
    // Imported material is bound by its hash. The API never returns generated
    // material, so its record is bound by the name it was saved under.
    this.#expectedRecordId ??= rows[0]?.id;
    if (
      rows.length !== 1 ||
      rows[0].id !== this.#expectedRecordId ||
      rows[0].name !== this.#name ||
      rows[0].cloud_provider !== this.#profile.provider
    )
      throw new Error(
        'Job imported API credential lacks its exact database binding',
      );
    this.#binding = Object.freeze({
      name: this.#name,
      provider: this.#profile.provider,
      recordId: rows[0].id,
      [authorizationBrand]: true as const,
    });
    await this.#record('bound');
    this.#assertOpen();
    return this.#binding;
  }

  #materialId(material: CloudCredential): string {
    return createHash('sha256')
      .update(JSON.stringify(cloudCredentialSchema.parse(material)))
      .digest('hex');
  }

  #assertController(): void {
    for (const api of [this.#dependencies.api, this.#dependencies.cleanupApi]) {
      const actual = api.controller;
      if (
        actual.url !== this.#controller.url ||
        actual.generation !== this.#controller.generation
      )
        throw new Error(
          'Job authorization changed its original API endpoint or generation',
        );
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Job credential owner has begun cleanup');
    this.#assertController();
  }

  /**
   * The imported material, or for a generated credential the bootstrap one:
   * the API never returns what it generated.
   */
  material(binding: JobAuthorizationRef): Readonly<CloudCredential> {
    if (
      binding !== this.#binding ||
      this.#closed ||
      this.#apiAbsent ||
      this.#nativeAbsent
    )
      throw new Error('Job authorization is missing, copied or released');
    this.#assertController();
    return this.#material ?? this.#profile.credential;
  }

  async release(
    binding: JobAuthorizationRef,
    deadlineAt: number,
  ): Promise<void> {
    if (binding !== this.#binding)
      throw new Error('Job authorization release belongs to another import');
    await this.#removeApi(deadlineAt);
    await this.#removeNative(deadlineAt);
  }

  async #rows(
    database: Pick<CliDatabase, 'queryComplete'>,
    deadlineAt: number,
  ): Promise<readonly CredentialRow[]> {
    const rows = await database.queryComplete(
      `SELECT id, name, cloud_provider FROM credentials WHERE name = '${escapedSql(this.#name)}'` +
        (this.#expectedRecordId
          ? ` OR id = '${escapedSql(this.#expectedRecordId)}'`
          : ''),
      `job-${this.#name}-authorization`,
      deadlineAt,
    );
    const parsed: CredentialRow[] = [];
    for (const row of rows) {
      if (
        Object.keys(row).length !== 3 ||
        typeof row.id !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.id) ||
        !(
          row.name === null ||
          (typeof row.name === 'string' && row.name.length > 0)
        ) ||
        typeof row.cloud_provider !== 'string' ||
        row.cloud_provider !== String(this.#profile.provider) ||
        parsed.some((prior) => prior.id === row.id)
      )
        throw new Error(
          'Job API credential database inventory is malformed or foreign',
        );
      parsed.push({
        id: row.id,
        name: row.name,
        cloud_provider: this.#profile.provider,
      });
    }
    return parsed;
  }

  #removeApi(deadlineAt: number): Promise<void> {
    this.#closed = true;
    this.#cleanupDeadlineAt ??= deadlineAt;
    deadlineAt = Math.min(deadlineAt, this.#cleanupDeadlineAt);
    this.#apiCleanup ??= this.#observeCleanup('api', async () => {
      await this.#creation?.catch(() => undefined);
      this.#dependentsAbsent();
      if (this.#apiSent) {
        this.#assertController();
        // Foreground cancellation can interrupt readback after a positive import
        // acknowledgement. Cleanup may bind the preflighted material hash using
        // its own reads; an unacknowledged import still cannot be adopted.
        const originalId = this.#binding?.recordId ?? this.#expectedRecordId;
        if (!this.#apiConfirmed || !originalId)
          throw new Error(
            'Job API import reply or record binding is unresolved',
          );
        const full = await this.#dependencies.cleanupApi.readCredential(
          this.#name,
          deadlineAt,
        );
        const rows = await this.#rows(
          this.#dependencies.cleanupDatabase,
          deadlineAt,
        );
        if (rows.some((row) => row.id !== originalId))
          throw new Error('Job API credential name was reassigned');
        if (full) {
          if (rows.length !== 1 || rows[0].name !== this.#name)
            throw new Error(
              'Job API credential no longer matches its original record',
            );
          this.#assertController();
          await this.#dependencies.cleanupApi.deleteCredential(
            this.#name,
            deadlineAt,
          );
        } else if (
          (
            await this.#dependencies.cleanupApi.listCredentials(deadlineAt)
          ).some((row) => row.name === this.#name)
        )
          throw new Error(
            'Job API credential absence contradicts the complete inventory',
          );
        const remaining = await this.#rows(
          this.#dependencies.cleanupDatabase,
          deadlineAt,
        );
        if (remaining.some((row) => row.id !== originalId || row.name !== null))
          throw new Error('Job API credential name remains after deletion');
      }
      if (this.#apiSent) this.#assertController();
      this.#apiAbsent = true;
      await this.#record('api-absent');
      this.#apiRegistration.complete();
    });
    return this.#apiCleanup;
  }

  #removeNative(deadlineAt: number): Promise<void> {
    this.#closed = true;
    this.#cleanupDeadlineAt ??= deadlineAt;
    deadlineAt = Math.min(deadlineAt, this.#cleanupDeadlineAt);
    this.#nativeCleanup ??= this.#observeCleanup('native', async () => {
      await this.#creation?.catch(() => undefined);
      this.#dependentsAbsent();
      if (!this.#apiAbsent)
        throw new Error(
          'Job native credentials remain required by unresolved API ownership',
        );
      if (this.#apiSent) this.#assertController();
      if (this.#native) await this.#native.remove(deadlineAt);
      await this.#dependencies.files.remove(`job-auth-${this.#name}`);
      this.#nativeAbsent = true;
      await this.#record('native-absent');
      this.#nativeRegistration?.complete();
    });
    return this.#nativeCleanup;
  }

  async #observeCleanup(
    kind: 'api' | 'native',
    action: () => Promise<void>,
  ): Promise<void> {
    // Claim the cleanup promise before invoking an action or recording its result.
    await Promise.resolve();
    try {
      await action();
    } catch (error) {
      try {
        await this.#record(`${kind}-cleanup-incomplete`);
      } catch (recordError) {
        throw new AggregateError(
          [error, recordError],
          'Job authorization cleanup and failure recording failed',
        );
      }
      throw error;
    }
  }

  async #record(state: string): Promise<void> {
    await this.#dependencies.artifacts.json(
      `job-authorization-${this.#name}-${++this.#observations}`,
      {
        state,
        name: this.#name,
        provider: this.#profile.provider,
        mode: this.#mode,
        controller: this.#controller,
        closed: this.#closed,
        recordId: this.#binding?.recordId ?? null,
        apiSent: this.#apiSent,
        apiConfirmed: this.#apiConfirmed,
        apiAbsent: this.#apiAbsent,
        nativeOwnership: this.#native ? 'generated' : 'borrowed-retained',
        nativeAbsent: this.#native ? this.#nativeAbsent : null,
      },
    );
  }
}
