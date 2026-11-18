import path from 'node:path';

import {
  CloudType,
  type AzureCredentials,
} from '../../../../../src/shared/cloud.js';
import {
  AzureTestPrincipal,
  cleanupAzureOnboardingIdentity,
  type AzureOnboardingIdentityBinding,
  type BootstrapAzureContext,
  azureGraphObjectUrl,
} from '../../../credentials-onboarding/azure/admin.js';
import type { RedactedCredential } from '../../../../../src/shared/api-contract/credentials-schemas.js';
import { retryUntilDeadline } from '../../../credentials-onboarding/common/deadline-retry.js';
import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import { isRecord } from '../types.js';
import { WaitTimeoutError } from '../wait.js';
import {
  INVENTORY_SETTLE_MS,
  JobPrivateCommands,
  privateJobJson,
} from './job-command.js';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
type DirectoryObject = AzureOnboardingIdentityBinding['application'];

/** The bound directory object an exact `az rest` Graph DELETE targets, if any. */
export function ownedGraphDeleteKind(
  args: readonly string[],
  binding: AzureOnboardingIdentityBinding,
): 'app' | 'sp' | undefined {
  return (['app', 'sp'] as const).find((kind) => {
    const expected = [
      'rest',
      '--method',
      'DELETE',
      '--url',
      azureGraphObjectUrl(
        kind,
        (kind === 'app' ? binding.application : binding.servicePrincipal).id,
      ),
      '--output',
      'none',
    ];
    return (
      args.length === expected.length &&
      expected.every((value, index) => args[index] === value)
    );
  });
}

/**
 * RFC 0047 S4 and S11: a per-run service principal holding only the Anycloud
 * role the docs publish, created for it and deleted with it.
 */
export class AzureJobRestrictedFixture {
  readonly #principal: AzureTestPrincipal;
  readonly #redactor: Pick<Redactor, 'add'>;

  constructor(dependencies: {
    readonly name: string;
    readonly bootstrap: AzureCredentials;
    readonly redactor: Pick<Redactor, 'add'>;
  }) {
    if (!/^bkt-[0-9]{1,24}$/u.test(dependencies.name))
      throw new Error(
        'Azure restricted credential name is outside its native namespace',
      );
    const { bootstrap } = dependencies;
    this.#principal = new AzureTestPrincipal(
      {
        subscriptionId: bootstrap.subscriptionId,
        tenantId: bootstrap.directoryId,
        applicationId: bootstrap.applicationId,
        secret: bootstrap.secret,
      },
      dependencies.name,
      { publishedRole: true },
    );
    this.#redactor = dependencies.redactor;
  }

  async create(): Promise<Readonly<AzureCredentials>> {
    const principal = await this.#principal.create();
    this.#redactor.add(principal.secret);
    this.#redactor.add(principal.applicationId);
    return Object.freeze({
      cloudProvider: CloudType.Azure,
      applicationId: principal.applicationId,
      secret: principal.secret,
      directoryId: principal.tenantId,
      subscriptionId: principal.subscriptionId,
    });
  }

  remove(deadlineAt: number): Promise<void> {
    return this.#principal.remove(deadlineAt);
  }
}

/** The public CLI generates the identity; cleanup retains its exact directory IDs. */
export class AzureJobGeneratedFixture {
  readonly #name: string;
  readonly #bootstrap: Readonly<AzureCredentials>;
  readonly #commands: JobPrivateCommands;
  readonly #cleanupCommands: JobPrivateCommands;
  readonly #files: Pick<FixtureFiles, 'directory'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  #root: string | undefined;
  #started = false;
  #binding: AzureOnboardingIdentityBinding | undefined;
  #acknowledgedApplicationId: string | undefined;
  readonly #observed: Partial<Record<'app' | 'sp', DirectoryObject>> = {};
  #operationTag: string | undefined;
  #observation = 0;
  readonly #assignmentIds = new Set<string>();

  constructor(dependencies: {
    readonly name: string;
    readonly bootstrap: AzureCredentials;
    readonly commands: JobPrivateCommands;
    readonly cleanupCommands: JobPrivateCommands;
    readonly files: Pick<FixtureFiles, 'directory'>;
    readonly artifacts: Pick<ArtifactStore, 'json'>;
  }) {
    if (!/^bkt-[0-9]{1,24}$/u.test(dependencies.name))
      throw new Error(
        'Azure Job credential name is outside its native namespace',
      );
    if (
      ![
        dependencies.bootstrap.applicationId,
        dependencies.bootstrap.directoryId,
        dependencies.bootstrap.subscriptionId,
      ].every((value) => GUID.test(value))
    )
      throw new Error('Azure Job bootstrap identity is malformed');
    this.#name = dependencies.name;
    this.#bootstrap = Object.freeze({ ...dependencies.bootstrap });
    this.#commands = dependencies.commands;
    this.#cleanupCommands = dependencies.cleanupCommands;
    this.#files = dependencies.files;
    this.#artifacts = dependencies.artifacts;
  }

  async prepare(deadlineAt: number): Promise<Readonly<NodeJS.ProcessEnv>> {
    if (this.#root)
      throw new Error('Azure Job generation preparation is single use');
    this.#root = await this.#files.directory(`job-auth-${this.#name}`, {
      private: true,
    });
    await this.#files.directory(`job-auth-${this.#name}/azure`, {
      private: true,
    });
    const env = this.#environment();
    await this.#commands.run(
      'az',
      [
        'login',
        '--service-principal',
        '--username',
        this.#bootstrap.applicationId,
        `--password=${this.#bootstrap.secret}`,
        '--tenant',
        this.#bootstrap.directoryId,
        '--output',
        'none',
      ],
      env,
      deadlineAt,
    );
    await this.#commands.run(
      'az',
      ['account', 'set', '--subscription', this.#bootstrap.subscriptionId],
      env,
      deadlineAt,
    );
    const account = privateJobJson(
      await this.#commands.run(
        'az',
        [
          'account',
          'show',
          '--subscription',
          this.#bootstrap.subscriptionId,
          '--output',
          'json',
        ],
        env,
        deadlineAt,
      ),
    );
    if (
      !isRecord(account) ||
      account.id !== this.#bootstrap.subscriptionId ||
      account.tenantId !== this.#bootstrap.directoryId
    )
      throw new Error(
        'Azure Job session selected another tenant or subscription',
      );
    for (const kind of ['app', 'sp'] as const) {
      if (
        (await this.#inventory(this.#commands, kind, deadlineAt)).length !== 0
      )
        throw new Error('Azure Job generation name already exists');
    }
    return Object.freeze(env);
  }

  generationStarted(): void {
    if (!this.#root || this.#started)
      throw new Error('Azure Job native generation cannot be replayed');
    this.#started = true;
  }

  async capture(
    /** The redacted record: the API never returns the generated secret. */
    credential: Readonly<
      Extract<RedactedCredential, { cloudProvider: CloudType.Azure }>
    >,
    deadlineAt: number,
  ): Promise<void> {
    if (
      !this.#started ||
      this.#acknowledgedApplicationId ||
      credential.subscriptionId !== this.#bootstrap.subscriptionId ||
      !credential.applicationId ||
      !GUID.test(credential.applicationId) ||
      credential.applicationId === this.#bootstrap.applicationId
    )
      throw new Error(
        'Azure Job generation returned a foreign credential identity',
      );
    this.#acknowledgedApplicationId = credential.applicationId;
    await this.#captureBinding(this.#commands, deadlineAt);
  }

  async #captureBinding(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<void> {
    // The CLI reply identifies the generated application; directory indexes may
    // lag it. Retry only complete missing observations, retaining every known ID.
    const deadline = Math.min(deadlineAt, Date.now() + 60_000);
    const pending = new Error(
      'Azure Job generated directory identity is not visible',
    );
    await retryUntilDeadline(
      async () => {
        const applications = await this.#inventory(commands, 'app', deadline);
        const principals = await this.#inventory(commands, 'sp', deadline);
        if (applications.length === 0 || principals.length === 0) throw pending;
        if (
          applications.length !== 1 ||
          principals.length !== 1 ||
          applications[0].id === principals[0].id
        )
          throw new Error(
            'Azure Job generated directory identity is ambiguous',
          );
        this.#binding = Object.freeze({
          application: applications[0],
          servicePrincipal: principals[0],
        });
      },
      {
        deadline,
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        wait: (milliseconds) => commands.wait(milliseconds, deadline),
        shouldRetry: (error) => error === pending,
      },
    );
    await this.#record('created');
  }

  async remove(deadlineAt: number): Promise<void> {
    if (!this.#started) return;
    if (!this.#binding && this.#acknowledgedApplicationId)
      await this.#captureBinding(this.#cleanupCommands, deadlineAt);
    if (!this.#binding)
      throw new Error(
        'Azure Job generation reply is unresolved; retain native credential intent',
      );
    await cleanupAzureOnboardingIdentity(
      this.#context(deadlineAt),
      `anycloud-${this.#name}`,
      'bucket',
      undefined,
      this.#binding,
    );
    // Entra and ARM inventories are eventually consistent (round 5 job
    // 108507111350: a just-deleted principal stayed listed); read until absent
    // within the cleanup deadline, then fail closed.
    for (const kind of ['sp', 'app'] as const)
      await this.#requireAbsent(
        () => this.#inventory(this.#cleanupCommands, kind, deadlineAt),
        deadlineAt,
        'Azure Job native credential remains after cleanup',
      );
    await this.#requireAbsent(
      () => this.#assignments(this.#cleanupCommands, deadlineAt),
      deadlineAt,
      'Azure Job generated role assignments remain after cleanup',
    );
    await this.#record('absent');
  }

  async #requireAbsent(
    read: () => Promise<readonly unknown[]>,
    deadlineAt: number,
    message: string,
  ): Promise<void> {
    await this.#cleanupCommands
      .waitFor(
        message,
        read,
        {
          intervalMs: INVENTORY_SETTLE_MS,
          probeError: 'fail',
          unmet: (remaining) =>
            remaining.length === 0 ? undefined : 'still listed',
        },
        deadlineAt,
        (milliseconds) => this.#cleanupCommands.wait(milliseconds, deadlineAt),
      )
      .catch((error: unknown) => {
        throw error instanceof WaitTimeoutError ? new Error(message) : error;
      });
  }

  #environment(): NodeJS.ProcessEnv {
    if (!this.#root) throw new Error('Azure Job private session is missing');
    return {
      AZURE_CONFIG_DIR: path.join(this.#root, 'azure'),
      AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
      // A detached telemetry uploader would write here after az returns.
      AZURE_CORE_COLLECT_TELEMETRY: 'false',
    };
  }

  #context(deadlineAt: number): BootstrapAzureContext {
    if (!this.#root) throw new Error('Azure Job private session is missing');
    return {
      bootstrapAppId: this.#bootstrap.applicationId,
      subscriptionId: this.#bootstrap.subscriptionId,
      configDir: path.join(this.#root, 'azure'),
      rootDir: this.#root,
      wait: (milliseconds) =>
        this.#cleanupCommands.wait(milliseconds, deadlineAt),
      run: (args) => this.#cleanupRun(args, deadlineAt),
    };
  }

  async #cleanupRun(args: string[], deadlineAt: number): Promise<string> {
    if (!this.#binding)
      throw new Error('Azure Job creation identity is unresolved');
    if (args[0] === 'ad' && ['app', 'sp'].includes(args[1])) {
      if (args[2] !== 'list')
        throw new Error(
          'Azure Job cleanup requested an unowned directory operation',
        );
      return JSON.stringify(
        await this.#inventory(
          this.#cleanupCommands,
          args[1] as 'app' | 'sp',
          deadlineAt,
          args[args.indexOf('--filter') + 1],
        ),
      );
    } else if (args[0] === 'rest') {
      const kind = ownedGraphDeleteKind(args, this.#binding);
      if (!kind)
        throw new Error(
          'Azure Job deletion changed its original directory object ID',
        );
      await this.#inventory(this.#cleanupCommands, kind, deadlineAt);
      if (
        (await this.#assignments(this.#cleanupCommands, deadlineAt)).length !==
        0
      )
        throw new Error('Azure Job directory deletion preceded role cleanup');
    } else if (args.slice(0, 3).join(' ') === 'role assignment list')
      return JSON.stringify(
        await this.#assignments(this.#cleanupCommands, deadlineAt),
      );
    else if (args.slice(0, 3).join(' ') === 'role assignment delete') {
      if (!this.#assignmentIds.has(args[args.indexOf('--ids') + 1]))
        throw new Error(
          'Azure Job role deletion has no original inventory identity',
        );
    } else
      throw new Error(
        'Azure Job cleanup requested an unowned native operation',
      );
    return this.#cleanupCommands.run(
      'az',
      args[0] === 'role'
        ? [...args, '--subscription', this.#bootstrap.subscriptionId]
        : args,
      this.#environment(),
      deadlineAt,
    );
  }

  async #inventory(
    commands: JobPrivateCommands,
    kind: 'app' | 'sp',
    deadlineAt: number,
    requestedFilter?: string,
  ): Promise<readonly DirectoryObject[]> {
    const nameFilter = `displayName eq 'anycloud-${this.#name}'`;
    const originalFilter = this.#acknowledgedApplicationId
      ? `appId eq '${this.#acknowledgedApplicationId}'`
      : undefined;
    const filter = requestedFilter ?? originalFilter ?? nameFilter;
    if (filter !== nameFilter && filter !== originalFilter)
      throw new Error(
        'Azure Job inventory changed its original directory query',
      );
    const body = privateJobJson(
      await commands.run(
        'az',
        ['ad', kind, 'list', '--all', '--filter', filter, '--output', 'json'],
        this.#environment(),
        deadlineAt,
      ),
    );
    if (!Array.isArray(body))
      throw new Error('Azure Job directory inventory is incomplete');
    const rows: DirectoryObject[] = [];
    const record = (complete: boolean) =>
      this.#artifacts.json(
        `job-native-authorization-${this.#name}-${++this.#observation}`,
        {
          state: 'inventory',
          kind,
          filter,
          complete,
          subscriptionId: this.#bootstrap.subscriptionId,
          tenantId: this.#bootstrap.directoryId,
          identities: rows.map(({ id, appId, displayName }) => ({
            id,
            appId,
            displayName,
          })),
        },
      );
    try {
      for (const raw of body) {
        if (
          !isRecord(raw) ||
          typeof raw.id !== 'string' ||
          !GUID.test(raw.id) ||
          typeof raw.appId !== 'string' ||
          !GUID.test(raw.appId) ||
          raw.appId === this.#bootstrap.applicationId ||
          raw.displayName !== `anycloud-${this.#name}` ||
          !Array.isArray(raw.tags) ||
          raw.tags.some((value) => typeof value !== 'string')
        )
          throw new Error(
            'Azure Job directory inventory contains a foreign or malformed identity',
          );
        const tags = raw.tags.filter(
          (value): value is string => typeof value === 'string',
        );
        const row = Object.freeze({
          id: raw.id,
          appId: raw.appId,
          displayName: raw.displayName,
          tags,
        });
        if (
          rows.some((prior) => prior.id === row.id || prior.appId === row.appId)
        )
          throw new Error('Azure Job directory inventory repeats an identity');
        if (this.#acknowledgedApplicationId) {
          const original = this.#observed[kind];
          const marker = this.#marker(row);
          if (
            row.appId !== this.#acknowledgedApplicationId ||
            (original && row.id !== original.id) ||
            (this.#operationTag && marker !== this.#operationTag)
          )
            throw new Error(
              'Azure Job directory identity changed after generation',
            );
          this.#observed[kind] = row;
          this.#operationTag = marker;
        }
        rows.push(row);
      }
      await record(true);
    } catch (error) {
      try {
        await record(false);
      } catch (recordError) {
        throw new AggregateError(
          [error, recordError],
          'Azure Job inventory and partial observation recording failed',
        );
      }
      throw error;
    }
    return rows;
  }

  #marker(row: DirectoryObject): string {
    const tags = row.tags ?? [];
    const operations = tags.filter((tag) =>
      tag.startsWith('AnycloudOperation:'),
    );
    if (
      tags.filter((tag) => tag === 'AnycloudManaged').length !== 1 ||
      tags.filter((tag) => tag.startsWith('AnycloudCredentialName:')).length !==
        1 ||
      !tags.includes(`AnycloudCredentialName:${this.#name}`) ||
      operations.length !== 1 ||
      !GUID.test(operations[0].slice('AnycloudOperation:'.length))
    )
      throw new Error(
        'Azure Job generated identity lacks its exact ownership markers',
      );
    return operations[0];
  }

  async #assignments(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<readonly Record<string, unknown>[]> {
    if (!this.#binding)
      throw new Error('Azure Job role inventory has no original principal ID');
    const principalId = this.#binding.servicePrincipal.id;
    const body = privateJobJson(
      await commands.run(
        'az',
        [
          'role',
          'assignment',
          'list',
          '--assignee-object-id',
          principalId,
          '--all',
          '--subscription',
          this.#bootstrap.subscriptionId,
          '--fill-principal-name',
          'false',
          '--fill-role-definition-name',
          'false',
          '--output',
          'json',
        ],
        this.#environment(),
        deadlineAt,
      ),
    );
    if (!Array.isArray(body))
      throw new Error('Azure Job role inventory is incomplete');
    const ids = new Set<string>();
    const scope = `/subscriptions/${this.#bootstrap.subscriptionId}`;
    const rows: Record<string, unknown>[] = [];
    for (const row of body) {
      if (
        !isRecord(row) ||
        typeof row.id !== 'string' ||
        !row.id
          .toLowerCase()
          .startsWith(
            `${scope.toLowerCase()}/providers/microsoft.authorization/roleassignments/`,
          ) ||
        !GUID.test(row.id.split('/').at(-1) ?? '') ||
        row.principalId !== principalId ||
        typeof row.scope !== 'string' ||
        row.scope.toLowerCase() !== scope.toLowerCase() ||
        ids.has(row.id.toLowerCase())
      )
        throw new Error(
          'Azure Job role inventory contains a foreign or duplicate assignment',
        );
      ids.add(row.id.toLowerCase());
      this.#assignmentIds.add(row.id);
      rows.push(row);
    }
    await this.#artifacts.json(
      `job-native-authorization-${this.#name}-${++this.#observation}`,
      { state: 'roles', complete: true, principalId, assignmentIds: [...ids] },
    );
    return rows;
  }

  async #record(state: 'created' | 'absent'): Promise<void> {
    await this.#artifacts.json(
      `job-native-authorization-${this.#name}-${++this.#observation}`,
      {
        state,
        subscriptionId: this.#bootstrap.subscriptionId,
        tenantId: this.#bootstrap.directoryId,
        binding: this.#binding
          ? {
              application: {
                id: this.#binding.application.id,
                appId: this.#binding.application.appId,
              },
              servicePrincipal: {
                id: this.#binding.servicePrincipal.id,
                appId: this.#binding.servicePrincipal.appId,
              },
            }
          : null,
        operation: this.#operationTag,
      },
    );
  }
}
