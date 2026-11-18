import {
  CloudType,
  type AWSCredentials,
} from '../../../../../src/shared/cloud.js';
import {
  cleanupAWSOnboardingUser,
  createAWSImportFixture,
  type BootstrapAWSContext,
} from '../../../credentials-onboarding/aws/admin.js';

import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import { isRecord } from '../types.js';
import type { ProbeRetryPolicy } from '../wait.js';
import {
  JobPrivateCommandFailure,
  JobPrivateCommands,
  privateJobJson,
} from './job-command.js';

interface AwsUserIdentity {
  readonly UserName: string;
  readonly UserId: string;
  readonly Arn: string;
}

// IAM cleanup mutations (delete/detach) can stall past the 30 s private-command
// cap (round 3 job 108437108280: `iam delete-user` after every dependent delete
// succeeded); like the synchronous host deletes, they get a longer budget.
export const SYNCHRONOUS_IAM_MUTATION_MS = 2 * 60_000;

const IAM_COLLECTIONS = {
  'list-users': 'Users',
  'list-user-tags': 'Tags',
  'list-access-keys': 'AccessKeyMetadata',
  'list-user-policies': 'PolicyNames',
  'list-attached-user-policies': 'AttachedPolicies',
} as const;
type IamCollection = keyof typeof IAM_COLLECTIONS;

/** IAM can answer a cleanup call late or throttled; every other failure is final. */
const retryIamCleanup: ProbeRetryPolicy = {
  retry: (error) =>
    error instanceof JobPrivateCommandFailure &&
    (error.timedOut ||
      ['Throttling', 'RequestLimitExceeded'].includes(
        String(error.nativeCode),
      )),
};

/** Adds immutable Job ownership around the existing onboarding create/delete owner. */
export class AwsJobImportFixture {
  readonly #name: string;
  readonly #bootstrap: Readonly<AWSCredentials>;
  readonly #commands: JobPrivateCommands;
  readonly #cleanupCommands: JobPrivateCommands;
  readonly #files: Pick<FixtureFiles, 'directory'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #redactor: Pick<Redactor, 'add'>;
  readonly #restrictedBuckets: readonly string[] | undefined;
  #accountId: string | undefined;
  #bootstrapArn: string | undefined;
  #root: string | undefined;
  #creationStarted = false;
  #identity: AwsUserIdentity | undefined;
  #observations = 0;

  constructor(dependencies: {
    readonly name: string;
    readonly bootstrap: AWSCredentials;
    readonly commands: JobPrivateCommands;
    readonly cleanupCommands: JobPrivateCommands;
    readonly files: Pick<FixtureFiles, 'directory'>;
    readonly artifacts: Pick<ArtifactStore, 'json'>;
    readonly redactor: Pick<Redactor, 'add'>;
    /** Creates the RFC 0047 pilot-shaped user scoped to these buckets. */
    readonly restrictedBuckets?: readonly string[];
  }) {
    if (!/^bkt-[0-9]{1,24}$/u.test(dependencies.name))
      throw new Error('AWS Job import name is outside its native namespace');
    this.#name = dependencies.name;
    this.#bootstrap = Object.freeze({ ...dependencies.bootstrap });
    this.#commands = dependencies.commands;
    this.#cleanupCommands = dependencies.cleanupCommands;
    this.#files = dependencies.files;
    this.#artifacts = dependencies.artifacts;
    this.#redactor = dependencies.redactor;
    this.#restrictedBuckets = dependencies.restrictedBuckets
      ? Object.freeze([...dependencies.restrictedBuckets])
      : undefined;
  }

  async create(deadlineAt: number): Promise<Readonly<AWSCredentials>> {
    if (this.#root)
      throw new Error('AWS Job credential creation is single use');
    this.#root = await this.#files.directory(`job-auth-${this.#name}`, {
      private: true,
    });
    const caller = privateJobJson(
      await this.#raw(
        this.#commands,
        ['sts', 'get-caller-identity', '--output', 'json'],
        this.#bootstrapEnvironment(),
        deadlineAt,
      ),
    );
    if (
      !isRecord(caller) ||
      typeof caller.Account !== 'string' ||
      !/^[0-9]{12}$/u.test(caller.Account) ||
      typeof caller.Arn !== 'string' ||
      !caller.Arn.startsWith(`arn:aws:`) ||
      caller.Arn.split(':')[4] !== caller.Account
    )
      throw new Error('AWS Job bootstrap caller identity is invalid');
    // Provider errors name it in IAM ARNs; keep it out of every artifact.
    this.#redactor.add(caller.Account);
    this.#accountId = caller.Account;
    this.#bootstrapArn = caller.Arn;
    if (await this.#readUser(this.#commands, deadlineAt))
      throw new Error('AWS Job native credential name already exists');
    const fixture = await createAWSImportFixture(
      this.#context(this.#commands, deadlineAt),
      this.#name,
      'bucket',
      { restrictedBuckets: this.#restrictedBuckets },
    );
    if (!this.#identity)
      throw new Error('AWS Job creation did not retain its immutable user ID');
    return Object.freeze({
      cloudProvider: CloudType.AWS,
      accessKeyId: fixture.accessKeyId,
      secretAccessKey: fixture.secretAccessKey,
    });
  }

  async remove(deadlineAt: number): Promise<void> {
    if (!this.#creationStarted) return;
    if (!this.#identity)
      throw new Error(
        'AWS Job creation reply is unresolved; retain native credential intent',
      );
    const current = await this.#readUser(this.#cleanupCommands, deadlineAt);
    if (!current) {
      await this.#requireAbsentInInventory(deadlineAt);
      await this.#record('absent');
      return;
    }
    if (current.UserId !== this.#identity.UserId)
      throw new Error('AWS Job native credential changed identity');
    await cleanupAWSOnboardingUser(
      this.#context(this.#cleanupCommands, deadlineAt),
      this.#identity.UserName,
      'bucket',
    );
    const remaining = await this.#readUser(this.#cleanupCommands, deadlineAt);
    if (remaining) {
      await this.#record('present');
      throw new Error('AWS Job native credential remains after cleanup');
    }
    await this.#requireAbsentInInventory(deadlineAt);
    await this.#record('absent');
  }

  #context(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): BootstrapAWSContext {
    if (!this.#bootstrapArn || !this.#root)
      throw new Error('AWS Job bootstrap identity is missing');
    return {
      bootstrapArn: this.#bootstrapArn,
      rootDir: this.#root,
      environment: this.#bootstrapEnvironment(),
      run: (args, environment) =>
        this.#run(commands, args, environment, deadlineAt),
      wait: (milliseconds) => commands.wait(milliseconds, deadlineAt),
      cleanupCall: (run) =>
        commands.waitFor(
          'AWS Job IAM cleanup call',
          run,
          { probeError: retryIamCleanup, unmet: () => undefined },
          deadlineAt,
        ),
    };
  }

  #bootstrapEnvironment(): NodeJS.ProcessEnv {
    return {
      AWS_ACCESS_KEY_ID: this.#bootstrap.accessKeyId,
      AWS_SECRET_ACCESS_KEY: this.#bootstrap.secretAccessKey,
      AWS_SESSION_TOKEN: this.#bootstrap.sessionToken,
    };
  }

  async #raw(
    commands: JobPrivateCommands,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    deadlineAt: number,
  ): Promise<string> {
    const endpoint = {
      iam: 'https://iam.amazonaws.com',
      sts: 'https://sts.us-east-1.amazonaws.com',
      s3api: 'https://s3.us-east-1.amazonaws.com',
      // Readiness of the restricted pilot key only.
      ec2: 'https://ec2.us-east-1.amazonaws.com',
    }[args[0]];
    if (!endpoint)
      throw new Error('AWS Job fixture requested an unowned service');
    const cleanupMutation =
      args[0] === 'iam' && /^(?:delete-|detach-)/u.test(args[1] ?? '');
    return commands.run(
      'aws',
      [...args, '--region', 'us-east-1', '--endpoint-url', endpoint],
      {
        AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: environment.AWS_SESSION_TOKEN,
      },
      deadlineAt,
      cleanupMutation ? SYNCHRONOUS_IAM_MUTATION_MS : undefined,
    );
  }

  async #run(
    commands: JobPrivateCommands,
    args: string[],
    environment: NodeJS.ProcessEnv,
    deadlineAt: number,
  ): Promise<string> {
    const operation = args[1];
    if (args[0] === 'iam' && operation === 'create-user') {
      if (this.#creationStarted)
        throw new Error('AWS Job native creation cannot be replayed');
      this.#creationStarted = true;
    } else if (
      args[0] === 'iam' &&
      /^(?:attach-|detach-|delete-|create-|put-)/u.test(operation)
    ) {
      await this.#assertOriginalUser(commands, deadlineAt);
    }
    if (args[0] === 'iam') {
      switch (operation) {
        case 'list-users':
        case 'list-user-tags':
        case 'list-access-keys':
        case 'list-user-policies':
        case 'list-attached-user-policies':
          return this.#completeCollection(commands, operation, deadlineAt);
      }
    }
    const output = await this.#raw(commands, args, environment, deadlineAt);
    if (args[0] === 'iam' && operation === 'create-user') {
      const response = privateJobJson(output);
      this.#identity = this.#user(
        isRecord(response) ? response.User : undefined,
      );
      await this.#record('created');
    }
    if (args[0] === 'iam' && operation === 'create-access-key') {
      const response = privateJobJson(output);
      const key = isRecord(response) ? response.AccessKey : undefined;
      if (
        !isRecord(key) ||
        key.UserName !== `anycloud-${this.#name}` ||
        typeof key.AccessKeyId !== 'string' ||
        !/^[A-Z0-9]{16,128}$/u.test(key.AccessKeyId) ||
        typeof key.SecretAccessKey !== 'string' ||
        !key.SecretAccessKey ||
        /[\r\n]/u.test(key.SecretAccessKey)
      )
        throw new Error(
          'AWS Job import key belongs to a missing or foreign user',
        );
      this.#redactor.add(key.AccessKeyId);
      this.#redactor.add(key.SecretAccessKey);
    }
    if (args[0] === 'iam' && operation === 'get-user' && this.#identity) {
      const response = privateJobJson(output);
      const user = this.#user(isRecord(response) ? response.User : undefined);
      if (user.UserId !== this.#identity.UserId)
        throw new Error(
          'AWS Job readiness resolved a replacement user identity',
        );
    }
    if (
      args[0] === 'sts' &&
      operation === 'get-caller-identity' &&
      this.#identity &&
      environment.AWS_ACCESS_KEY_ID !== this.#bootstrap.accessKeyId
    ) {
      const caller = privateJobJson(output);
      if (
        !isRecord(caller) ||
        caller.UserId !== this.#identity.UserId ||
        caller.Arn !== this.#identity.Arn ||
        caller.Account !== this.#accountId
      )
        throw new Error(
          'AWS Job imported key did not resolve its original user ID',
        );
    }
    return output;
  }

  async #completeCollection(
    commands: JobPrivateCommands,
    operation: IamCollection,
    deadlineAt: number,
  ): Promise<string> {
    const field = IAM_COLLECTIONS[operation];
    const rows: unknown[] = [];
    const identities = new Set<string>();
    const markers = new Set<string>();
    let marker: string | undefined;
    let pages = 0;
    let complete = false;
    try {
      do {
        if (++pages > 100)
          throw new Error('AWS Job IAM inventory exceeded its page bound');
        const response = privateJobJson(
          await this.#raw(
            commands,
            [
              'iam',
              operation,
              ...(operation === 'list-users'
                ? []
                : ['--user-name', `anycloud-${this.#name}`]),
              '--no-paginate',
              '--output',
              'json',
              ...(marker ? ['--marker', marker] : []),
            ],
            this.#bootstrapEnvironment(),
            deadlineAt,
          ),
        );
        if (
          !isRecord(response) ||
          !Array.isArray(response[field]) ||
          typeof response.IsTruncated !== 'boolean' ||
          response.NextToken !== undefined
        )
          throw new Error('AWS Job IAM inventory is incomplete');
        const values = response[field];
        if (!Array.isArray(values))
          throw new Error('AWS Job IAM inventory has no rows');
        for (const row of values) {
          const identity = this.#inventoryRowIdentity(operation, row);
          if (identities.has(identity))
            throw new Error('AWS Job IAM inventory repeats an identity');
          if (
            operation === 'list-users' &&
            isRecord(row) &&
            rows.some(
              (prior) => isRecord(prior) && prior.UserName === row.UserName,
            )
          )
            throw new Error('AWS Job IAM inventory repeats a user name');
          identities.add(identity);
          rows.push(row);
        }
        if (!response.IsTruncated) {
          if (response.Marker !== undefined && response.Marker !== '')
            throw new Error('AWS Job IAM inventory ended with a continuation');
          complete = true;
          break;
        }
        if (
          values.length === 0 ||
          typeof response.Marker !== 'string' ||
          !response.Marker ||
          markers.has(response.Marker)
        )
          throw new Error(
            'AWS Job native user inventory has an invalid continuation',
          );
        marker = response.Marker;
        markers.add(marker);
      } while (marker);
    } catch (error) {
      try {
        await this.#inventoryRecord(operation, rows, pages, false);
      } catch (artifactError) {
        throw new AggregateError(
          [error, artifactError],
          'AWS Job IAM inventory and retained prefix both failed',
        );
      }
      throw error;
    }
    await this.#inventoryRecord(operation, rows, pages, complete);
    return JSON.stringify({ [field]: rows, IsTruncated: false });
  }

  #inventoryRowIdentity(operation: IamCollection, row: unknown): string {
    if (operation === 'list-user-policies') {
      if (typeof row !== 'string' || !/^[\w+=,.@-]{1,128}$/u.test(row))
        throw new Error('AWS Job inline policy inventory is malformed');
      return row;
    }
    if (!isRecord(row))
      throw new Error('AWS Job IAM inventory row is malformed');
    if (operation === 'list-users') {
      if (
        typeof row.UserName !== 'string' ||
        !/^[\w+=,.@-]{1,64}$/u.test(row.UserName) ||
        typeof row.UserId !== 'string' ||
        !/^[A-Z0-9]{16,128}$/u.test(row.UserId) ||
        typeof row.Arn !== 'string' ||
        !row.Arn.startsWith(`arn:aws:iam::${this.#accountId}:user/`) ||
        !row.Arn.endsWith(`/${row.UserName}`)
      )
        throw new Error(
          'AWS Job native user inventory contains invalid identities',
        );
      return row.UserId;
    }
    if (operation === 'list-user-tags') {
      if (
        typeof row.Key !== 'string' ||
        !row.Key ||
        typeof row.Value !== 'string'
      )
        throw new Error('AWS Job user tag inventory is malformed');
      return row.Key;
    }
    if (operation === 'list-access-keys') {
      if (
        row.UserName !== `anycloud-${this.#name}` ||
        typeof row.AccessKeyId !== 'string' ||
        !/^[A-Z0-9]{16,128}$/u.test(row.AccessKeyId) ||
        !['Active', 'Inactive'].includes(String(row.Status))
      )
        throw new Error(
          'AWS Job key inventory contains a foreign or malformed identity',
        );
      return row.AccessKeyId;
    }
    if (
      typeof row.PolicyArn !== 'string' ||
      !/^arn:aws:iam::(?:aws|[0-9]{12}):policy\/[A-Za-z0-9+=,.@_/-]+$/u.test(
        row.PolicyArn,
      ) ||
      typeof row.PolicyName !== 'string' ||
      !row.PolicyName
    )
      throw new Error('AWS Job managed policy inventory is malformed');
    return row.PolicyArn;
  }

  async #requireAbsentInInventory(deadlineAt: number): Promise<void> {
    const inventory = privateJobJson(
      await this.#completeCollection(
        this.#cleanupCommands,
        'list-users',
        deadlineAt,
      ),
    );
    if (
      !isRecord(inventory) ||
      !Array.isArray(inventory.Users) ||
      inventory.Users.some(
        (row) =>
          isRecord(row) &&
          (row.UserId === this.#identity?.UserId ||
            row.UserName === `anycloud-${this.#name}`),
      )
    )
      throw new Error(
        'AWS Job original native user remains, possibly under another name',
      );
  }

  async #inventoryRecord(
    operation: IamCollection,
    rows: readonly unknown[],
    pages: number,
    complete: boolean,
  ): Promise<void> {
    await this.#artifacts.json(
      `job-native-authorization-${this.#name}-${++this.#observations}`,
      {
        state: 'inventory',
        operation,
        pages,
        complete,
        validatedRows: rows.length,
        originalUser: this.#identity,
        accountId: this.#accountId,
        matchingUsers:
          operation === 'list-users'
            ? rows
                .filter(
                  (row) =>
                    isRecord(row) &&
                    (row.UserId === this.#identity?.UserId ||
                      row.UserName === `anycloud-${this.#name}`),
                )
                .map((row) =>
                  isRecord(row)
                    ? {
                        UserId: row.UserId,
                        UserName: row.UserName,
                        Arn: row.Arn,
                      }
                    : undefined,
                )
            : [],
      },
    );
  }

  async #readUser(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<AwsUserIdentity | undefined> {
    try {
      const response = privateJobJson(
        await this.#raw(
          commands,
          [
            'iam',
            'get-user',
            '--user-name',
            `anycloud-${this.#name}`,
            '--output',
            'json',
          ],
          this.#bootstrapEnvironment(),
          deadlineAt,
        ),
      );
      return this.#user(isRecord(response) ? response.User : undefined);
    } catch (error) {
      if (
        error instanceof JobPrivateCommandFailure &&
        error.nativeCode === 'NoSuchEntity'
      )
        return undefined;
      throw error;
    }
  }

  #user(value: unknown): AwsUserIdentity {
    if (
      !this.#accountId ||
      !isRecord(value) ||
      value.UserName !== `anycloud-${this.#name}` ||
      value.Arn !==
        `arn:aws:iam::${this.#accountId}:user/anycloud-${this.#name}` ||
      typeof value.UserId !== 'string' ||
      !/^[A-Z0-9]{16,128}$/u.test(value.UserId)
    )
      throw new Error(
        'AWS Job native user has a missing or foreign immutable identity',
      );
    return Object.freeze({
      UserName: value.UserName,
      UserId: value.UserId,
      Arn: value.Arn,
    });
  }

  async #assertOriginalUser(
    commands: JobPrivateCommands,
    deadlineAt: number,
  ): Promise<void> {
    if (!this.#identity)
      throw new Error('AWS Job creation identity is unresolved');
    const current = await this.#readUser(commands, deadlineAt);
    if (!current || current.UserId !== this.#identity.UserId)
      throw new Error('AWS Job native credential changed identity');
  }

  async #record(state: 'created' | 'present' | 'absent'): Promise<void> {
    this.#observations += 1;
    await this.#artifacts.json(
      `job-native-authorization-${this.#name}-${this.#observations}`,
      {
        state,
        accountId: this.#accountId,
        user: this.#identity,
      },
    );
  }
}
