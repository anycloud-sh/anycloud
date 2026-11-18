import { cliArgs } from './cli-surface.js';
import assert from 'node:assert/strict';
import path from 'node:path';

import Database from 'better-sqlite3';
import { ORPCError } from '@orpc/client';

import { apiAccessUsersResponseSchema } from '../../../../src/shared/api-contract/api-access-schemas.js';
import {
  listSecretsResponseSchema,
  secretInUseDataSchema,
} from '../../../../src/shared/api-contract/secrets-schemas.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../../src/shared/api-version.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { completedCommand, rejectedCommand } from './api-assertions.js';
import { declaredApiError } from './api.js';
import { databaseInteger } from './database.js';
import { githubToken } from './fake-github.js';
import {
  LocalApiProcess,
  unscopedCliEnvironment,
  type ApiFixtureRuntime,
} from './local-api-process.js';
import type { FixtureNames } from './names.js';
import { SecretManager } from './secrets.js';
import { isRecord } from './types.js';

/** The hosted fixtures' owner, signed in through `anycloud login`. */
const OWNER = githubToken('anycloud-test');
const API_TOKEN_PATTERN = /^acapi_[A-Za-z0-9_-]{43}$/u;

export interface ApiAuthResult {
  readonly scenario: 'hosted-api-access-policy' | 'secret-crud-privacy';
  readonly satisfied: true;
}

/** The raw list must be inspected before a client can strip unexpected fields. */
export function assertSecretListPrivacy(
  body: unknown,
  name: string,
  value: string,
): void {
  assert.ok(
    !JSON.stringify(body).includes(value),
    'Secret value leaked in its list response',
  );
  const secrets = listSecretsResponseSchema.parse(body);
  assert.equal(
    secrets.filter((secret) => secret.name === name).length,
    1,
    'Secret list lost or duplicated the saved name',
  );
}

export class ApiAuthScenarios {
  readonly #runtime: ApiFixtureRuntime;
  readonly #names: FixtureNames;
  readonly #version: string;

  constructor(
    runtime: ApiFixtureRuntime,
    names: FixtureNames,
    version: string,
  ) {
    this.#runtime = runtime;
    this.#names = names;
    this.#version = version;
  }

  async accessPolicy(): Promise<ApiAuthResult> {
    const rejected = await LocalApiProcess.create(
      this.#runtime,
      'username-only',
    );
    rejectedCommand(
      await this.#runtime.runner.run(
        process.execPath,
        [
          path.join(this.#runtime.projectRoot, 'dist/api/server.js'),
          '--hosted-api-owner',
          'anycloud-test',
        ],
        {
          env: rejected.environment(),
          timeoutMs: 10_000,
          label: 'username-only-hosted-startup',
        },
      ),
      'must be provided together',
    );
    rejectedCommand(
      await this.#runtime.runner.run(
        process.execPath,
        [
          path.join(this.#runtime.projectRoot, 'dist/api/server.js'),
          '--hosted-api-owner',
          'anycloud-test',
          '--hosted-api-owner-id',
          '1',
        ],
        {
          env: {
            ...rejected.environment(),
            WORKLOAD_ID: 'hosted-test-mode',
            ANYCLOUD_WORKLOAD_API_URL: 'https://api.example.com',
          },
          timeoutMs: 10_000,
          label: 'hosted-startup-in-test-mode',
        },
      ),
      'refuses IS_TEST',
    );

    const original = await this.#hosted('owner', 'anycloud-test', '1');
    await this.#apiTokens(original);
    await this.#staleSignIn(original);
    assert.deepEqual(await this.#policy(original), {
      owner_user: 'anycloud-test',
      owner_user_id: '1',
    });
    const restored = await LocalApiProcess.create(
      this.#runtime,
      'restored-owner',
    );
    await restored.restoreFrom(original);
    await restored.start({ username: 'renamed-owner', id: '1' });
    assert.deepEqual(
      await this.#policy(restored),
      { owner_user: 'anycloud-test', owner_user_id: '1' },
      'Authentication must refresh a renamed owner while preserving the durable account ID',
    );

    await restored.stop();
    await this.#seed(
      restored,
      'legacy-current-handle',
      'anycloud-test',
      undefined,
      WorkloadState.Completed,
    );
    await this.#seed(
      restored,
      'legacy-previous-handle',
      'previous-handle',
      undefined,
      WorkloadState.Completed,
    );
    this.#edit(restored, (db) =>
      db
        .prepare(
          'UPDATE api_access_policy SET owner_user = ?, owner_user_id = NULL WHERE id = 1',
        )
        .run('previous-handle'),
    );
    await restored.start({ username: 'anycloud-test', id: '1' });
    assert.equal((await this.#policy(restored)).owner_user_id, '1');
    const [legacy] = await restored
      .client()
      .database.queryComplete(
        "SELECT COUNT(*) AS n FROM workloads WHERE id LIKE 'legacy-%' AND owner_user_id IS NOT NULL",
        'legacy-ownership-not-rewritten',
      );
    assert.equal(databaseInteger(legacy?.n, 'Legacy rewritten count'), 0);
    const legacyIds = await this.#workloadIds(restored);
    assert.ok(legacyIds.includes('legacy-current-handle'));
    assert.ok(legacyIds.includes('legacy-previous-handle'));
    await this.#noProvision(restored);
    await restored.stop();

    const otherOwner = await this.#hosted('other-owner', 'anycloud-test', '2');
    await this.#denied(otherOwner, OWNER);
    await otherOwner.stop();
    this.#allow(otherOwner, '1', 'anycloud-test');
    await otherOwner.start({ username: 'hosted-owner', id: '2' });
    assert.equal((await this.#allowed(otherOwner))[0]?.user_id, '1');
    await otherOwner.stop();
    await otherOwner.start({ username: 'hosted-owner', id: '2' });
    assert.equal(
      (await this.#allowed(otherOwner))[0]?.user_id,
      '1',
      'Allowlisted immutable account ID did not survive restart',
    );
    await this.#cli(
      otherOwner,
      ['api', 'access', 'remove', '1'],
      githubToken('hosted-owner'),
    );
    // Removal deletes the member's API token: the next request is refused.
    rejectedCommand(
      await otherOwner
        .client(OWNER)
        .cli.run(['api', 'access', 'list'], { env: unscopedCliEnvironment }),
      'rotated or removed',
    );
    rejectedCommand(
      await otherOwner
        .client(OWNER)
        .cli.run(['login', otherOwner.url], { env: unscopedCliEnvironment }),
      'API access denied',
    );
    await otherOwner.stop();

    const sharing = await this.#hosted('sharing', 'anycloud-test', '1');
    await this.#cli(sharing, ['api', 'access', 'add', 'member-user']);
    const list = await this.#access(sharing);
    assert.equal(list.owner.userId, '1');
    assert.equal(list.users.length, 1);
    assert.equal(list.users[0]?.username, 'member-user');
    assert.match(list.users[0]?.userId ?? '', /^[1-9][0-9]*$/u);
    await this.#noProvision(sharing);
    await sharing.stop();

    const departed = await this.#hosted('departed', 'hosted-owner', '2');
    this.#allow(departed, '1', 'anycloud-test');
    this.#allow(departed, '500', 'departing-member');
    await this.#seed(departed, 'member-workload', 'departing-member', '500');
    assert.ok((await this.#workloadIds(departed)).includes('member-workload'));
    await this.#cli(
      departed,
      ['api', 'access', 'remove', '500'],
      githubToken('hosted-owner'),
    );
    await this.#terminate(departed, 'member-workload');
    await this.#noProvision(departed);
    await departed.stop();

    const local = await LocalApiProcess.create(
      this.#runtime,
      'local-ownership',
    );
    await local.start();
    // A local API has one owner, the holder of its token, who keeps reaching
    // the rows earlier releases keyed by a GitHub account or only by a
    // username, signed in or not.
    await this.#seed(local, 'github-id-workload', 'someone-else', '900');
    await this.#seed(local, 'test-account-workload', 'anycloud-test', '1');
    await this.#seed(local, 'username-only-workload', 'previous-handle');
    for (const signIn of ['dummy-token-for-test', null]) {
      const localIds = await this.#workloadIds(local, signIn);
      for (const id of [
        'github-id-workload',
        'test-account-workload',
        'username-only-workload',
      ])
        assert.ok(localIds.includes(id), `${id} is not visible`);
    }
    await this.#terminate(local, 'username-only-workload', null);
    await this.#noProvision(local);
    await local.stop();

    const peers = await this.#hosted('real-callers', 'anycloud-test', '1');
    await this.#seed(peers, 'owner-workload', 'anycloud-test', '1');
    await this.#cli(peers, ['api', 'access', 'add', 'teammate']);
    assert.equal(
      (await this.#access(peers, githubToken('teammate'))).users[0]?.username,
      'teammate',
    );
    for (const args of [
      ['api', 'access', 'add', 'third-user'],
      ['api', 'access', 'remove', 'teammate'],
    ])
      rejectedCommand(
        await peers.client(githubToken('teammate')).cli.run(args, {
          env: unscopedCliEnvironment,
        }),
        'Only the owner of this hosted API, anycloud-test, can grant or remove access',
      );
    assert.deepEqual(
      (await this.#access(peers)).users.map((user) => user.username),
      ['teammate'],
    );
    await this.#terminate(peers, 'owner-workload', githubToken('teammate'));
    await this.#denied(peers, githubToken('stranger'));
    await this.#noProvision(peers);
    await peers.stop();
    await this.#runtime.artifacts.json('hosted-api-access-policy-completion', {
      scenario: 'hosted-api-access-policy',
      restoredAccountId: '1',
      realCallerAuthorization: true,
      externalResources: false,
      cleanup: 'Not applicable',
      satisfied: true,
    });
    return { scenario: 'hosted-api-access-policy', satisfied: true };
  }

  async secretCrudPrivacy(): Promise<ApiAuthResult> {
    const fixture = await LocalApiProcess.create(
      this.#runtime,
      'secret-crud-privacy',
    );
    await fixture.start();
    const name = this.#names.secret('privacy');
    const value = `secret-value-${this.#names.secret('private')}`;
    const secrets = new SecretManager(
      fixture.client().api,
      this.#runtime.cleanup,
      fixture.client('dummy-token-for-test', true).api,
    );
    await secrets.create(name, { HF_TOKEN: value });
    const headers = {
      Authorization: `Bearer ${fixture.bearer()}`,
      [ANYCLOUD_CLIENT_VERSION_HEADER]: this.#version,
    };
    const list = await this.#runtime.http.get(
      'secret-list-privacy',
      new URL('/v1/secrets', fixture.url),
      { headers, redirect: 'error' },
    );
    assert.equal(list.status, 200);
    assertSecretListPrivacy(list.body, name, value);
    const route = new URL(
      `/v1/secrets/${encodeURIComponent(name)}`,
      fixture.url,
    );
    assert.equal(
      (
        await this.#runtime.http.get('no-secret-material-route', route, {
          headers,
          redirect: 'error',
        })
      ).status,
      404,
      'Single-secret GET must not expose material',
    );
    for (const label of ['delete-secret', 'delete-secret-again']) {
      assert.equal(
        (
          await this.#runtime.http.delete(label, route, {
            headers,
            redirect: 'error',
          })
        ).status,
        204,
        'Secret deletion must be idempotent',
      );
    }
    await secrets.delete(name);
    const after = await this.#runtime.http.get(
      'secret-list-after-delete',
      new URL('/v1/secrets', fixture.url),
      { headers, redirect: 'error' },
    );
    assert.equal(after.status, 200);
    assert.ok(
      listSecretsResponseSchema
        .parse(after.body)
        .every((secret) => secret.name !== name),
    );
    await secrets.create(name, { HF_TOKEN: value });
    const blockingId = this.#names.workload('secret-reference');
    await this.#seed(fixture, blockingId, 'anycloud-test', '1');
    this.#edit(fixture, (db) =>
      db
        .prepare('UPDATE workloads SET secret_names = ? WHERE id = ?')
        .run(JSON.stringify([name]), blockingId),
    );
    await assert.rejects(
      fixture.client().api.deleteSecret(name, undefined, { force: false }),
      (error: unknown) => {
        assert.ok(error instanceof ORPCError);
        const declared = declaredApiError(error);
        assert.equal(declared?.code, 'SECRET_IN_USE');
        assert.equal(declared?.status, 409);
        assert.deepEqual(secretInUseDataSchema.parse(error.data), {
          name,
          workloadIds: [blockingId],
        });
        return true;
      },
      'non-force delete of an in-use secret was not rejected',
    );
    const retained = await this.#runtime.http.get(
      'secret-list-after-blocked-delete',
      new URL('/v1/secrets', fixture.url),
      { headers, redirect: 'error' },
    );
    assert.equal(retained.status, 200);
    assertSecretListPrivacy(retained.body, name, value);
    await secrets.delete(name);
    await this.#missingSecretAdmission(fixture, [
      ['deleted', name],
      ['missing', this.#names.secret('never-created')],
    ]);
    await this.#terminate(fixture, blockingId);
    await this.#noProvision(fixture);
    await fixture.stop();
    await this.#runtime.artifacts.json('secret-crud-privacy-completion', {
      scenario: 'secret-crud-privacy',
      externalResources: false,
      cleanup: 'Not applicable',
      satisfied: true,
    });
    return { scenario: 'secret-crud-privacy', satisfied: true };
  }

  /**
   * A hosted API takes only the API tokens it issues. On main any
   * GitHub token that can read `/user` was a bearer, whatever app issued it.
   */
  async #apiTokens(fixture: LocalApiProcess): Promise<void> {
    const githubBearers = [
      ['personal-access-token', githubToken('anycloud-test', 'pat')],
      ['foreign-app-token', githubToken('anycloud-test', 'foreign')],
    ] as const;
    for (const [label, bearer] of [
      ...githubBearers,
      ['anycloud-login-token', OWNER],
    ] as const) {
      assert.equal(
        (await this.#request(fixture, `github-bearer-${label}`, bearer)).status,
        401,
        `The hosted API accepted a ${label} as its bearer`,
      );
    }
    for (const [label, bearer] of githubBearers) {
      const refused = await this.#exchange(fixture, label, bearer);
      assert.equal(refused.status, 401, `A ${label} was exchanged`);
      assert.match(JSON.stringify(refused.body), /anycloud login/u);
    }

    const token = await this.#exchangedToken(fixture, 'first-login', OWNER);
    assert.equal(
      (await this.#request(fixture, 'api-token-bearer', token)).status,
      200,
    );
    assert.equal(
      await this.#exchangedToken(fixture, 'second-machine', OWNER),
      token,
      'A second login must return the same API token',
    );
    assert.equal(
      (await this.#cli(fixture, ['api', 'token'])).trim(),
      token,
      '`api token` must print the stored API token',
    );

    // Two first logins at once agree on one token.
    await this.#cli(fixture, ['api', 'access', 'add', 'concurrent-member']);
    const member = githubToken('concurrent-member');
    const [left, right] = await Promise.all([
      this.#exchangedToken(fixture, 'concurrent-left', member),
      this.#exchangedToken(fixture, 'concurrent-right', member),
    ]);
    assert.equal(left, right, 'Concurrent first logins minted two tokens');

    // Only the exchange and rotate return a token: never a read.
    const stored = JSON.stringify(
      await fixture
        .client()
        .database.queryComplete(
          'SELECT * FROM api_tokens',
          'api-tokens-at-rest',
        ),
    );
    for (const secret of [token, left, OWNER, member])
      assert.ok(!stored.includes(secret), 'A token is stored in plaintext');

    const rotated = (await this.#cli(fixture, ['api', 'token', 'rotate']))
      .trim()
      .split('\n')
      .at(-1);
    assert.ok(rotated && API_TOKEN_PATTERN.test(rotated));
    this.#runtime.redactor.add(rotated);
    assert.notEqual(rotated, token);
    const stale = await this.#request(fixture, 'rotated-api-token', token);
    assert.equal(stale.status, 401, 'A rotated token still authenticates');
    assert.match(JSON.stringify(stale.body), /rotated or removed/u);
    assert.equal(
      (await this.#request(fixture, 'current-api-token', rotated)).status,
      200,
    );
    // The CLI stored the rotated token and keeps working.
    await this.#access(fixture);

    // ANYCLOUD_API_TOKEN overrides the store only beside API_URL.
    rejectedCommand(
      await fixture.client().cli.run(['api', 'access', 'list'], {
        env: { ...unscopedCliEnvironment, ANYCLOUD_API_TOKEN: token },
      }),
      'rotated or removed',
    );
    await this.#cli(fixture, ['api', 'use', fixture.url]);
    await this.#cli(fixture, ['api', 'access', 'list'], undefined, {
      API_URL: undefined,
      ANYCLOUD_API_TOKEN: token,
    });
  }

  /**
   * GitHub can drop the sign-in a hosted API stored at the exchange (a revoked
   * grant, the 10-token cap, a year unused). The CLI keeps its API token, so
   * the API must get a fresh sign-in from the CLI rather than leave the caller
   * stuck on GITHUB_SIGN_IN_REQUIRED.
   */
  async #staleSignIn(fixture: LocalApiProcess): Promise<void> {
    const { github } = fixture;
    const unattended = {
      IS_TEST: 'true',
      ANYCLOUD_GITHUB_URL: github.url,
      CLAUDECODE: '1',
    };
    github.revoke(OWNER);
    // The local sign-in is the revoked one too: relay a new one, once.
    const relayed = await fixture
      .client(OWNER)
      .cli.run(['api', 'access', 'add', 'stale-sign-in'], {
        env: { ...unscopedCliEnvironment, ...unattended },
        timeoutMs: 60_000,
      });
    rejectedCommand(relayed, '"actionRequired"');
    assert.equal(
      relayed.combined.split('"actionRequired"').length,
      2,
      'The sign-in was relayed more than once',
    );

    // `anycloud login <api-url>` gives the API the current sign-in.
    const renewed = githubToken('anycloud-test', 'anycloud', 2);
    await this.#cli(fixture, ['login', fixture.url], OWNER, {
      ...unattended,
      GITHUB_TOKEN: renewed,
    });
    // The API now holds the renewed sign-in: the stale local one is not asked.
    await this.#cli(fixture, ['api', 'access', 'add', 'stale-sign-in'], OWNER, {
      ...unattended,
      GITHUB_TOKEN: OWNER,
    });

    // A command that meets a stale sign-in exchanges the current one and retries.
    github.revoke(renewed);
    await this.#cli(fixture, ['api', 'access', 'add', 'stale-again'], OWNER, {
      ...unattended,
      GITHUB_TOKEN: githubToken('anycloud-test', 'anycloud', 3),
    });
  }

  #request(fixture: LocalApiProcess, label: string, bearer: string) {
    return this.#runtime.http.get(
      label,
      new URL('/v1/api-access/users', fixture.url),
      {
        headers: {
          Authorization: `Bearer ${bearer}`,
          [ANYCLOUD_CLIENT_VERSION_HEADER]: this.#version,
        },
        redirect: 'error',
      },
    );
  }

  #exchange(fixture: LocalApiProcess, label: string, githubBearer: string) {
    return this.#runtime.http.post(
      `api-token-exchange-${label}`,
      new URL('/v1/api-token', fixture.url),
      undefined,
      {
        headers: {
          Authorization: `Bearer ${githubBearer}`,
          [ANYCLOUD_CLIENT_VERSION_HEADER]: this.#version,
        },
        redirect: 'error',
      },
    );
  }

  async #exchangedToken(
    fixture: LocalApiProcess,
    label: string,
    githubBearer: string,
  ): Promise<string> {
    const response = await this.#exchange(fixture, label, githubBearer);
    assert.equal(response.status, 200, `${label} exchange failed`);
    assert.ok(isRecord(response.body));
    const { token } = response.body;
    assert.ok(typeof token === 'string' && API_TOKEN_PATTERN.test(token));
    this.#runtime.redactor.add(token);
    return token;
  }

  async #hosted(
    label: string,
    username: string,
    id: string,
  ): Promise<LocalApiProcess> {
    const fixture = await LocalApiProcess.create(this.#runtime, label);
    await fixture.start({ username, id });
    return fixture;
  }

  async #policy(fixture: LocalApiProcess): Promise<Record<string, unknown>> {
    const rows = await fixture
      .client()
      .database.queryComplete(
        'SELECT owner_user, owner_user_id FROM api_access_policy WHERE id = 1',
        'hosted-access-owner',
      );
    assert.equal(rows.length, 1);
    return rows[0];
  }

  #allowed(
    fixture: LocalApiProcess,
  ): Promise<readonly Record<string, unknown>[]> {
    return fixture
      .client()
      .database.queryComplete(
        "SELECT user_id FROM api_access_users WHERE user_id = '1'",
        'persisted-access-user',
      );
  }

  async #cli(
    fixture: LocalApiProcess,
    args: readonly string[],
    token: string | null = fixture.defaultGithubToken,
    env: Readonly<Record<string, string | undefined>> = {},
  ): Promise<string> {
    return completedCommand(
      await fixture.client(token).cli.run(args, {
        env: { ...unscopedCliEnvironment, ...env },
        timeoutMs: 60_000,
      }),
      `Access-policy CLI ${args[0]}`,
    );
  }

  async #access(fixture: LocalApiProcess, token?: string) {
    return apiAccessUsersResponseSchema.parse(
      JSON.parse(
        await this.#cli(fixture, ['api', 'access', 'list', '--json'], token),
      ),
    );
  }

  async #workloadIds(
    fixture: LocalApiProcess,
    token: string | null = fixture.defaultGithubToken,
  ): Promise<readonly string[]> {
    // CLI JSON intentionally omits the API's request-relative ownership field.
    const rows: unknown = JSON.parse(
      await this.#cli(fixture, ['list', '--json'], token),
    );
    assert.ok(
      Array.isArray(rows) && rows.every(isRecord),
      'CLI Workload list was not an array of records',
    );
    const ids = rows.map((row) => {
      assert.ok(typeof row.id === 'string' && row.id.length > 0);
      return row.id;
    });
    assert.equal(
      new Set(ids).size,
      ids.length,
      'CLI Workload list duplicated identities',
    );
    return ids;
  }

  async #denied(fixture: LocalApiProcess, token: string): Promise<void> {
    rejectedCommand(
      await fixture
        .client(token)
        .cli.run(cliArgs('api access list', { json: true }), {
          env: unscopedCliEnvironment,
        }),
      'API access denied',
    );
  }

  async #terminate(
    fixture: LocalApiProcess,
    id: string,
    token?: string | null,
  ): Promise<void> {
    const output = await this.#cli(fixture, ['terminate', id], token);
    assert.ok(!output.includes('Workload not found'));
    this.#edit(fixture, (db) =>
      assert.deepEqual(
        db.prepare('SELECT state FROM workloads WHERE id = ?').get(id),
        { state: 'terminated' },
      ),
    );
  }

  async #seed(
    fixture: LocalApiProcess,
    id: string,
    userId: string,
    ownerUserId?: string,
    state = WorkloadState.Running,
  ): Promise<void> {
    completedCommand(
      await this.#runtime.runner.run(
        process.execPath,
        ['--import', 'tsx', 'test/integration/helpers/workload-fixture-cli.ts'],
        {
          env: fixture.environment(),
          stdin: JSON.stringify({ id, userId, ownerUserId, state }),
          timeoutMs: 30_000,
          label: `access-policy-seed-${id}`,
        },
      ),
      'Seed local ownership fixture',
    );
  }

  #edit(
    fixture: LocalApiProcess,
    edit: (database: Database.Database) => unknown,
  ): void {
    const database = new Database(fixture.dbPath);
    try {
      edit(database);
    } finally {
      database.close();
    }
  }

  #allow(fixture: LocalApiProcess, id: string, username: string): void {
    this.#edit(fixture, (db) =>
      db
        .prepare(
          'INSERT INTO api_access_users (user_id, username) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username',
        )
        .run(id, username),
    );
  }

  /**
   * A submission naming a secret that was never created, or that was just
   * deleted, is rejected at admission with the declared
   * `WORKLOAD_ADMISSION_REJECTED` (400) and the product's exact
   * `Secret "<name>" not found` message, and persists no Workload row. The
   * explicit Local target needs no credentials or catalog download; secret
   * preflight runs before image inspection or host capability checks.
   */
  async #missingSecretAdmission(
    fixture: LocalApiProcess,
    cases: readonly (readonly [label: string, secretName: string])[],
  ): Promise<void> {
    for (const [label, secretName] of cases) {
      const id = this.#names.workload(`secret-${label}`);
      await assert.rejects(
        fixture.client().api.createWorkload({
          id,
          image: 'alpine:3.20',
          secrets: [secretName],
          cloudConfig: { cloudProvider: CloudType.Local },
        }),
        (error: unknown) => {
          const declared = declaredApiError(error);
          assert.ok(declared, `Unexpected admission error: ${String(error)}`);
          assert.equal(declared.code, 'WORKLOAD_ADMISSION_REJECTED');
          assert.equal(declared.status, 400);
          assert.equal(declared.message, `Secret "${secretName}" not found`);
          return true;
        },
        `submission naming the ${label} secret ${secretName} was admitted`,
      );
      const [row] = await fixture
        .client()
        .database.queryComplete(
          `SELECT COUNT(*) AS n FROM workloads WHERE id = '${id}'`,
          `secret-${label}-admission-rows`,
        );
      assert.equal(
        databaseInteger(row?.n, `Workload rows for ${id}`),
        0,
        `rejected ${label}-secret admission persisted a Workload row`,
      );
    }
  }

  async #noProvision(fixture: LocalApiProcess): Promise<void> {
    const [row] = await fixture
      .client()
      .database.queryComplete(
        'SELECT COUNT(*) AS n FROM vms',
        'auth-no-native-provisioning',
      );
    assert.equal(databaseInteger(row?.n, 'Native VM row count'), 0);
  }
}
