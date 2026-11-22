import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CloudType,
  type GCPCredentials,
} from '../../../../../src/shared/cloud.js';
import {
  cleanupGCPOnboardingAccount,
  createGCPImportFixture,
  type BootstrapGcloudContext,
} from '../../../credentials-onboarding/gcp/admin.js';

import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import { isRecord } from '../types.js';
import { WaitTimeoutError } from '../wait.js';

import {
  INVENTORY_SETTLE_MS,
  JobPrivateCommands,
  privateJobJson,
} from './job-command.js';

interface AccountIdentity {
  readonly email: string;
  readonly uniqueId: string;
  readonly name: string;
  readonly projectId: string;
  readonly displayName: string;
}

/** Keeps the onboarding owner, with the creation response as deletion authority. */
export class GcpJobImportFixture {
  readonly #name: string;
  readonly #bootstrap: Readonly<GCPCredentials>;
  readonly #commands: JobPrivateCommands;
  readonly #cleanupCommands: JobPrivateCommands;
  readonly #files: Pick<FixtureFiles, 'directory' | 'privateText'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #redactor: Pick<Redactor, 'add'>;
  #root: string | undefined;
  #keyPath: string | undefined;
  #projectNumber: string | undefined;
  #creationStarted = false;
  #identity: AccountIdentity | undefined;
  #observation = 0;
  readonly #policies = new Map<string, Record<string, unknown>>();

  constructor(dependencies: {
    readonly name: string;
    readonly bootstrap: GCPCredentials;
    readonly commands: JobPrivateCommands;
    readonly cleanupCommands: JobPrivateCommands;
    readonly files: Pick<FixtureFiles, 'directory' | 'privateText'>;
    readonly artifacts: Pick<ArtifactStore, 'json'>;
    readonly redactor: Pick<Redactor, 'add'>;
  }) {
    if (!/^bkt-[0-9]{1,17}$/u.test(dependencies.name))
      throw new Error('GCP Job import name is outside its native namespace');
    this.#name = dependencies.name;
    this.#bootstrap = Object.freeze({
      ...dependencies.bootstrap,
      privateKey: dependencies.bootstrap.privateKey.replace(/\\n/gu, '\n'),
    });
    this.#commands = dependencies.commands;
    this.#cleanupCommands = dependencies.cleanupCommands;
    this.#files = dependencies.files;
    this.#artifacts = dependencies.artifacts;
    this.#redactor = dependencies.redactor;
    this.#redactor.add(this.#bootstrap.privateKey);
  }

  async create(deadlineAt: number): Promise<Readonly<GCPCredentials>> {
    if (this.#root)
      throw new Error('GCP Job credential creation is single use');
    const directory = `job-auth-${this.#name}`;
    this.#root = await this.#files.directory(directory, { private: true });
    await this.#files.directory(`${directory}/gcloud`, { private: true });
    this.#keyPath = await this.#files.privateText(
      `${directory}/bootstrap.json`,
      JSON.stringify({
        type: 'service_account',
        project_id: this.#bootstrap.projectId,
        private_key: this.#bootstrap.privateKey,
        client_email: this.#bootstrap.clientEmail,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    const env = { CLOUDSDK_CONFIG: path.join(this.#root, 'gcloud') };
    await this.#commands.run(
      'gcloud',
      [
        'auth',
        'activate-service-account',
        this.#bootstrap.clientEmail,
        `--key-file=${this.#keyPath}`,
        `--project=${this.#bootstrap.projectId}`,
        '--quiet',
      ],
      env,
      deadlineAt,
    );
    const project = privateJobJson(
      await this.#commands.run(
        'gcloud',
        [
          'projects',
          'describe',
          this.#bootstrap.projectId,
          `--account=${this.#bootstrap.clientEmail}`,
          '--format=json',
        ],
        env,
        deadlineAt,
      ),
    );
    if (
      !isRecord(project) ||
      project.projectId !== this.#bootstrap.projectId ||
      typeof project.projectNumber !== 'string' ||
      !/^[1-9][0-9]+$/u.test(project.projectNumber)
    )
      throw new Error('GCP Job bootstrap project identity is invalid');
    this.#projectNumber = project.projectNumber;
    if (
      (await this.#accounts(this.#commands, deadlineAt)).some(
        (a) => a.email === this.#email(),
      )
    )
      throw new Error('GCP Job native credential name already exists');
    const fixture = await createGCPImportFixture(
      this.#context(this.#commands, deadlineAt),
      this.#name,
      path.join(this.#root, 'import.json'),
      'bucket',
    );
    if (!this.#identity)
      throw new Error(
        'GCP Job creation did not retain its immutable account ID',
      );
    return Object.freeze({
      cloudProvider: CloudType.GCP,
      projectId: fixture.projectId,
      clientEmail: fixture.clientEmail,
      privateKey: fixture.privateKey,
    });
  }

  async remove(deadlineAt: number): Promise<void> {
    if (!this.#creationStarted) return;
    if (!this.#identity)
      throw new Error(
        'GCP Job creation reply is unresolved; retain native credential intent',
      );
    await this.#assertIdentity(this.#cleanupCommands, deadlineAt, true);
    await cleanupGCPOnboardingAccount(
      this.#context(this.#cleanupCommands, deadlineAt),
      this.#email(),
      'bucket',
      this.#identity,
    );
    // `serviceAccounts.list` is eventually consistent (round 3 job 108437108338:
    // a just-deleted account stayed listed); read until absent, then fail closed.
    const remains = 'GCP Job native credential remains after cleanup';
    await this.#cleanupCommands
      .waitFor(
        remains,
        () => this.#accounts(this.#cleanupCommands, deadlineAt),
        {
          intervalMs: INVENTORY_SETTLE_MS,
          probeError: 'fail',
          unmet: (accounts) =>
            accounts.some(
              (a) =>
                a.email === this.#identity?.email ||
                a.uniqueId === this.#identity?.uniqueId,
            )
              ? 'still listed'
              : undefined,
        },
        deadlineAt,
        (milliseconds) => this.#cleanupCommands.wait(milliseconds, deadlineAt),
      )
      .catch((error: unknown) => {
        throw error instanceof WaitTimeoutError ? new Error(remains) : error;
      });
    for (const args of [
      [
        'projects',
        'get-iam-policy',
        this.#bootstrap.projectId,
        '--format=json',
      ],
      [
        'iam',
        'service-accounts',
        'get-iam-policy',
        this.#vmAccount(),
        `--project=${this.#bootstrap.projectId}`,
        '--format=json',
      ],
    ]) {
      const policy = this.#policy(
        privateJobJson(
          await this.#raw(
            this.#cleanupCommands,
            args,
            path.join(this.#requiredRoot(), 'gcloud'),
            deadlineAt,
          ),
        ),
      );
      if (
        this.#policyMembers(policy).some((member) => this.#ownedMember(member))
      )
        throw new Error(
          'GCP Job original IAM policy membership remains after cleanup',
        );
    }
    await this.#record('absent');
  }

  #email(): string {
    return `anycloud-${this.#name}@${this.#bootstrap.projectId}.iam.gserviceaccount.com`;
  }
  #vmAccount(): string {
    if (!this.#projectNumber)
      throw new Error('GCP Job original project number is missing');
    return `${this.#projectNumber}-compute@developer.gserviceaccount.com`;
  }
  #requiredRoot(): string {
    if (!this.#root) throw new Error('GCP Job private session is missing');
    return this.#root;
  }

  #context(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): BootstrapGcloudContext {
    if (!this.#keyPath)
      throw new Error('GCP Job bootstrap key binding is missing');
    const root = this.#requiredRoot();
    return {
      projectId: this.#bootstrap.projectId,
      bootstrapEmail: this.#bootstrap.clientEmail,
      configDir: path.join(root, 'gcloud'),
      keyPath: this.#keyPath,
      rootDir: root,
      run: (args, environment) =>
        this.#run(commands, args, environment, deadlineAt),
      wait: (milliseconds) => commands.wait(milliseconds, deadlineAt),
    };
  }

  async #raw(
    commands: JobPrivateCommands,
    args: readonly string[],
    configDir: string,
    deadlineAt: number,
  ): Promise<string> {
    const root = this.#requiredRoot();
    if (
      ![
        path.join(root, 'gcloud'),
        path.join(root, 'import-validation'),
      ].includes(configDir)
    )
      throw new Error('GCP Job command changed its private session');
    return commands.run(
      'gcloud',
      args,
      { CLOUDSDK_CONFIG: configDir },
      deadlineAt,
    );
  }

  async #run(
    commands: JobPrivateCommands,
    args: string[],
    environment: NodeJS.ProcessEnv,
    deadlineAt: number,
  ): Promise<string> {
    const config = environment.CLOUDSDK_CONFIG;
    if (!config) throw new Error('GCP Job command omitted its private session');
    const operation = args.slice(0, 3).join(' ');
    if (operation === 'iam service-accounts list')
      return JSON.stringify(await this.#accounts(commands, deadlineAt));
    if (operation === 'iam service-accounts create') {
      if (this.#creationStarted || args[3] !== `anycloud-${this.#name}`)
        throw new Error(
          'GCP Job native creation changed identity or was replayed',
        );
      this.#creationStarted = true;
      const output = await this.#raw(
        commands,
        [...args, '--format=json'],
        config,
        deadlineAt,
      );
      this.#identity = this.#account(privateJobJson(output));
      if (
        this.#identity.email !== this.#email() ||
        this.#identity.displayName !==
          `Anycloud Service Account - ${this.#name}`
      )
        throw new Error('GCP Job creation returned a foreign account');
      await this.#record('created');
      return output;
    }
    const mutation =
      args.some((arg) =>
        ['delete', 'add-iam-policy-binding', 'set-iam-policy'].includes(arg),
      ) || args.slice(0, 4).join(' ') === 'iam service-accounts keys create';
    if (mutation)
      await this.#assertIdentity(
        commands,
        deadlineAt,
        args.includes('set-iam-policy'),
      );
    const setIndex = args.indexOf('set-iam-policy');
    if (setIndex >= 0) {
      const target = args[setIndex + 1];
      const before = this.#policies.get(target);
      const after = this.#policy(
        privateJobJson(await readFile(args[setIndex + 2], 'utf8')),
      );
      if (
        !before ||
        JSON.stringify(this.#withoutOwnedMembers(before)) !==
          JSON.stringify(after)
      )
        throw new Error(
          'GCP Job cleanup attempted to change a foreign IAM binding',
        );
    }
    const output = await this.#raw(commands, args, config, deadlineAt);
    const getIndex = args.indexOf('get-iam-policy');
    if (getIndex >= 0)
      this.#policies.set(
        args[getIndex + 1],
        this.#policy(privateJobJson(output)),
      );
    if (args.slice(0, 4).join(' ') === 'iam service-accounts keys create') {
      const key = privateJobJson(await readFile(args[4], 'utf8'));
      if (
        !isRecord(key) ||
        key.project_id !== this.#bootstrap.projectId ||
        key.client_email !== this.#email() ||
        typeof key.private_key !== 'string' ||
        !key.private_key ||
        typeof key.private_key_id !== 'string' ||
        !key.private_key_id
      )
        throw new Error(
          'GCP Job native key is missing or belongs to another account',
        );
      this.#redactor.add(key.private_key);
    }
    if (
      args.includes('--format=value(projectNumber)') &&
      output.trim() !== this.#projectNumber
    )
      throw new Error('GCP Job original project number changed');
    if (
      args[0] === 'auth' &&
      args[1] === 'list' &&
      output.trim() !== this.#email()
    )
      throw new Error('GCP Job import readiness used another principal');
    return output;
  }

  async #accounts(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<readonly AccountIdentity[]> {
    const body = privateJobJson(
      await this.#raw(
        commands,
        [
          'iam',
          'service-accounts',
          'list',
          `--project=${this.#bootstrap.projectId}`,
          `--account=${this.#bootstrap.clientEmail}`,
          '--format=json',
          '--quiet',
        ],
        path.join(this.#requiredRoot(), 'gcloud'),
        deadlineAt,
      ),
    );
    if (!Array.isArray(body))
      throw new Error('GCP Job service-account inventory is incomplete');
    const rows: AccountIdentity[] = [];
    const record = (complete: boolean) =>
      this.#artifacts.json(
        `job-native-authorization-${this.#name}-${++this.#observation}`,
        {
          state: 'inventory',
          complete,
          projectId: this.#bootstrap.projectId,
          projectNumber: this.#projectNumber,
          identities: rows
            .filter(
              (row) =>
                row.email === this.#email() ||
                row.uniqueId === this.#identity?.uniqueId,
            )
            .map(({ displayName: _displayName, ...identity }) => identity),
        },
      );
    try {
      for (const value of body) {
        const row = this.#account(value);
        if (
          rows.some(
            (prior) =>
              prior.uniqueId === row.uniqueId || prior.email === row.email,
          )
        )
          throw new Error(
            'GCP Job service-account inventory repeats an identity',
          );
        rows.push(row);
      }
      await record(true);
    } catch (error) {
      try {
        await record(false);
      } catch (recordError) {
        throw new AggregateError(
          [error, recordError],
          'GCP Job inventory and partial observation recording failed',
        );
      }
      throw error;
    }
    return rows;
  }

  #account(value: unknown): AccountIdentity {
    if (
      !isRecord(value) ||
      value.projectId !== this.#bootstrap.projectId ||
      typeof value.email !== 'string' ||
      typeof value.uniqueId !== 'string' ||
      !/^[1-9][0-9]+$/u.test(value.uniqueId) ||
      value.name !==
        `projects/${this.#bootstrap.projectId}/serviceAccounts/${value.email}` ||
      (value.displayName !== undefined && typeof value.displayName !== 'string')
    )
      throw new Error(
        'GCP Job inventory contains a foreign or malformed account',
      );
    return Object.freeze({
      email: value.email,
      uniqueId: value.uniqueId,
      name: value.name,
      projectId: this.#bootstrap.projectId,
      displayName:
        typeof value.displayName === 'string' ? value.displayName : '',
    });
  }

  async #assertIdentity(
    commands: JobPrivateCommands,
    deadlineAt: number,
    absentAllowed: boolean,
  ): Promise<void> {
    if (!this.#identity)
      throw new Error('GCP Job creation identity is unresolved');
    const current = (await this.#accounts(commands, deadlineAt)).find(
      (a) => a.email === this.#email(),
    );
    if (!current && !absentAllowed)
      throw new Error('GCP Job original service account not found');
    if (current && current.uniqueId !== this.#identity.uniqueId)
      throw new Error('GCP Job native credential changed identity');
  }

  #policy(value: unknown): Record<string, unknown> {
    if (
      !isRecord(value) ||
      (value.bindings !== undefined &&
        (!Array.isArray(value.bindings) ||
          value.bindings.some(
            (b) =>
              !isRecord(b) ||
              typeof b.role !== 'string' ||
              !Array.isArray(b.members) ||
              b.members.some((member) => typeof member !== 'string'),
          )))
    )
      throw new Error('GCP Job IAM policy inventory is malformed');
    return value;
  }

  #policyMembers(policy: Record<string, unknown>): string[] {
    return (Array.isArray(policy.bindings) ? policy.bindings : []).flatMap(
      (b: unknown) =>
        isRecord(b) && Array.isArray(b.members)
          ? b.members.filter((m): m is string => typeof m === 'string')
          : [],
    );
  }

  #ownedMember(member: string): boolean {
    return (
      member === `serviceAccount:${this.#email()}` ||
      (this.#identity !== undefined &&
        member ===
          `deleted:serviceAccount:${this.#email()}?uid=${this.#identity.uniqueId}`)
    );
  }

  #withoutOwnedMembers(
    policy: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...policy,
      bindings: (Array.isArray(policy.bindings) ? policy.bindings : []).flatMap(
        (b: unknown) => {
          if (!isRecord(b) || !Array.isArray(b.members))
            throw new Error('GCP Job policy binding is malformed');
          const members = b.members.filter(
            (member: unknown) =>
              typeof member === 'string' && !this.#ownedMember(member),
          );
          return b.members.length > 0 && members.length === 0
            ? []
            : [{ ...b, members }];
        },
      ),
    };
  }

  async #record(state: 'created' | 'absent'): Promise<void> {
    await this.#artifacts.json(
      `job-native-authorization-${this.#name}-${++this.#observation}`,
      {
        state,
        projectId: this.#bootstrap.projectId,
        projectNumber: this.#projectNumber,
        identity: this.#identity,
      },
    );
  }
}
