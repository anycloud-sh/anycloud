import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import {
  AzureJobGeneratedFixture,
  ownedGraphDeleteKind,
} from '../integration/e2e/internal/transports/job-azure-credential.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';
import { commandResultForTest } from './helpers/e2e.js';

const subscriptionId = '11111111-1111-4111-8111-111111111111';
const directoryId = '22222222-2222-4222-8222-222222222222';
const bootstrapId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const objectId = '66666666-6666-4666-8666-666666666666';
const operationId = '77777777-7777-4777-8777-777777777777';
const name = 'bkt-12345';
const scope = `/subscriptions/${subscriptionId}`;
const material = {
  cloudProvider: CloudType.Azure,
  applicationId,
  directoryId,
  subscriptionId,
  secret: 'newly-generated-private-azure-secret',
} as const;
/** What the API returns for the generated credential: never its secret. */
const generated = {
  name,
  cloudProvider: CloudType.Azure,
  applicationId,
  subscriptionId,
} as const;
const directoryObject = (id: string) => ({
  id,
  appId: applicationId,
  displayName: `anycloud-${name}`,
  tags: [
    'AnycloudManaged',
    `AnycloudCredentialName:${name}`,
    `AnycloudOperation:${operationId}`,
  ],
});
const assignments = [
  [
    'b24988ac-6180-42a0-ab88-20f7382dd24c',
    '1cbf5042-707a-55fc-959e-02226d46ab98',
  ],
].map(([role, id]) => ({
  id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${id}`,
  roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
  principalId,
  scope,
}));

afterEach(() => vi.restoreAllMocks());

async function withFixture(
  use: (world: {
    fixture: AzureJobGeneratedFixture;
    controller: AbortController;
    commands: JobPrivateCommands;
    calls: Array<{ args: readonly string[]; options: CommandOptions }>;
    records: unknown[];
    generate: () => void;
    state: {
      app: ReturnType<typeof directoryObject> | undefined;
      sp: ReturnType<typeof directoryObject> | undefined;
      roles: typeof assignments;
      hideDirectory: boolean;
      malformedTail: boolean;
      truncateInventory: boolean;
      denyDirectoryDelete: boolean;
      denyApplicationDelete: boolean;
      rejectApplicationDeleteOnce: boolean;
      delayedPrincipalReads: number;
      staleDirectoryReads: number;
      postCleanupPrincipalReads: number;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'job-azure-fixture-'));
  try {
    const controller = new AbortController();
    const calls: Array<{ args: readonly string[]; options: CommandOptions }> =
      [];
    const records: unknown[] = [];
    const state = {
      app: undefined as ReturnType<typeof directoryObject> | undefined,
      sp: undefined as ReturnType<typeof directoryObject> | undefined,
      roles: [] as typeof assignments,
      hideDirectory: false,
      malformedTail: false,
      truncateInventory: false,
      denyDirectoryDelete: false,
      denyApplicationDelete: false,
      rejectApplicationDeleteOnce: false,
      delayedPrincipalReads: 0,
      staleDirectoryReads: 0,
      postCleanupPrincipalReads: 0,
    };
    let deleted: ReturnType<typeof directoryObject> | undefined;
    let principalCleanupConfirmed = false;
    const run = async (
      executable: string,
      args: readonly string[],
      options: CommandOptions = {},
    ): Promise<CommandResult> => {
      calls.push({ args, options });
      options.signal?.throwIfAborted();
      let body: unknown = [];
      if (args[0] === 'account' && args[1] === 'show')
        body = { id: subscriptionId, tenantId: directoryId };
      else if (args[0] === 'ad' && args[2] === 'list') {
        let object = args[1] === 'app' ? state.app : state.sp;
        const filter = args[args.indexOf('--filter') + 1];
        // Reproduce a stale fixture read after the admin cleanup has already
        // confirmed deletion and performed its final display-name inventory.
        if (!state.sp && deleted && args[1] === 'sp') {
          if (filter.startsWith('displayName eq '))
            principalCleanupConfirmed = true;
          else if (principalCleanupConfirmed) {
            state.postCleanupPrincipalReads++;
            if (state.staleDirectoryReads > 0) {
              state.staleDirectoryReads--;
              object = deleted;
            }
          }
        }
        const matches =
          object &&
          (filter.startsWith('displayName eq ')
            ? filter === `displayName eq '${object.displayName}'`
            : filter === `appId eq '${object.appId}'`);
        body =
          state.hideDirectory || !matches
            ? []
            : [
                object,
                ...(state.malformedTail
                  ? [{ id: 'unvalidated-private-row' }]
                  : []),
              ];
        if (args[1] === 'sp' && state.delayedPrincipalReads > 0) {
          state.delayedPrincipalReads--;
          body = [];
        }
      } else if (args[0] === 'rest' && args[2] === 'DELETE') {
        const kind = args[4].includes('/applications/') ? 'app' : 'sp';
        if (state.denyDirectoryDelete)
          return commandResultForTest({
            executable,
            args: [...args],
            exitCode: 2,
            stderr: `ERROR: unrecognized arguments: --subscription ${subscriptionId}`,
          });
        if (
          kind === 'app' &&
          (state.denyApplicationDelete || state.rejectApplicationDeleteOnce)
        ) {
          state.rejectApplicationDeleteOnce = false;
          return commandResultForTest({
            executable,
            args: [...args],
            exitCode: 1,
            // `az rest` prints the Graph response body after the HTTP reason.
            stderr: `ERROR: Forbidden(${JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.', innerError: { 'request-id': 'private-request' } } })})\n`,
          });
        }
        if (kind === 'app') state.app = undefined;
        else [deleted, state.sp] = [state.sp, undefined];
      } else if (args.slice(0, 3).join(' ') === 'role assignment list')
        body = state.roles;
      else if (args.slice(0, 3).join(' ') === 'role assignment delete')
        state.roles = state.roles.filter(
          (row) => row.id !== args[args.indexOf('--ids') + 1],
        );
      const stdout = JSON.stringify(body);
      return {
        executable,
        args: [...args],
        stdout,
        stderr: '',
        combined: stdout,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        aborted: false,
        timedOut: false,
        outputTruncated:
          state.truncateInventory && args[0] === 'ad' && args[2] === 'list',
      };
    };
    const bootstrap = {
      ...material,
      applicationId: bootstrapId,
      secret: 'bootstrap-private-azure-secret',
    };
    const commands = new JobPrivateCommands({ run }, controller.signal);
    const fixture = new AzureJobGeneratedFixture({
      name,
      bootstrap,
      commands,
      cleanupCommands: new JobPrivateCommands(
        { run },
        new AbortController().signal,
      ),
      files: new FixtureFiles(root),
      artifacts: {
        json: async (_label, value) => {
          records.push(value);
          return '';
        },
      },
    });
    bootstrap.applicationId = 'changed-after-registration';
    const generate = () => {
      fixture.generationStarted();
      state.app = directoryObject(objectId);
      state.sp = directoryObject(principalId);
      state.roles = assignments.map((row) => ({ ...row }));
    };
    await use({
      fixture,
      controller,
      commands,
      calls,
      records,
      state,
      generate,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('Job Azure generated credential ownership', () => {
  test('waits for the acknowledged principal while retaining exact partial directory observations', async () => {
    await withFixture(
      async ({ fixture, generate, commands, state, records, calls }) => {
        await fixture.prepare(Date.now() + 30_000);
        generate();
        state.delayedPrincipalReads = 2;
        const wait = vi.spyOn(commands, 'wait').mockResolvedValue();
        await fixture.capture(generated, Date.now() + 30_000);
        expect(wait).toHaveBeenCalledTimes(2);
        expect(records).toContainEqual(
          expect.objectContaining({
            state: 'inventory',
            kind: 'sp',
            complete: true,
            identities: [],
          }),
        );
        expect(records).toContainEqual(
          expect.objectContaining({
            state: 'inventory',
            kind: 'app',
            complete: true,
            identities: [
              {
                id: objectId,
                appId: applicationId,
                displayName: `anycloud-${name}`,
              },
            ],
          }),
        );
        expect(
          calls
            .filter(({ args }) => args[0] === 'ad' && args[2] === 'list')
            .slice(2)
            .every(({ args }) => args.includes(`appId eq '${applicationId}'`)),
        ).toBe(true);
        await fixture.remove(Date.now() + 30_000);
        expect(state).toMatchObject({
          app: undefined,
          sp: undefined,
          roles: [],
        });
        expect(JSON.stringify(records)).not.toContain(material.secret);
        // A detached telemetry uploader would write into the workspace after az returns.
        expect(
          calls.every(
            ({ options }) =>
              options.env?.AZURE_CORE_COLLECT_TELEMETRY === 'false',
          ),
        ).toBe(true);
      },
    );
  });

  test('rejects a changed partially observed identity without retrying the mismatch', async () => {
    await withFixture(async ({ fixture, generate, commands, state, calls }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      state.delayedPrincipalReads = 1;
      const wait = vi
        .spyOn(commands, 'wait')
        .mockRejectedValue(new Error('Unapproved retry after identity change'))
        .mockImplementationOnce(async () => {
          state.app = directoryObject('88888888-8888-4888-8888-888888888888');
        });
      await expect(
        fixture.capture(generated, Date.now() + 30_000),
      ).rejects.toThrow('identity changed');
      expect(wait).toHaveBeenCalledOnce();
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'identity changed',
      );
      expect(
        calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
      ).toBe(false);
    });
  });

  test('bounds missing-directory reads and retains intent when the principal never becomes visible', async () => {
    await withFixture(
      async ({ fixture, generate, commands, state, records, calls }) => {
        await fixture.prepare(Date.now() + 30_000);
        generate();
        state.sp = undefined;
        const startedAt = Date.now();
        let now = startedAt;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        vi.spyOn(commands, 'wait').mockImplementation(async (milliseconds) => {
          now += milliseconds;
        });
        await expect(
          fixture.capture(generated, now + 1_200_000),
        ).rejects.toThrow('deadline');
        expect(now - startedAt).toBe(60_000);
        expect(records).not.toContainEqual(
          expect.objectContaining({ state: 'created' }),
        );
        expect(records).not.toContainEqual(
          expect.objectContaining({ state: 'absent' }),
        );
        expect(
          calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
        ).toBe(false);
      },
    );
  });

  test('finishes binding an acknowledged identity during independent cleanup after foreground cancellation', async () => {
    await withFixture(
      async ({ fixture, generate, commands, controller, state, records }) => {
        await fixture.prepare(Date.now() + 30_000);
        generate();
        state.delayedPrincipalReads = 1;
        vi.spyOn(commands, 'wait').mockImplementation(async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        });
        await expect(
          fixture.capture(generated, Date.now() + 30_000),
        ).rejects.toThrow();
        await fixture.remove(Date.now() + 30_000);
        expect(state).toMatchObject({
          app: undefined,
          sp: undefined,
          roles: [],
        });
        expect(records.at(-1)).toMatchObject({ state: 'absent' });
        await expect(
          fixture.capture(generated, Date.now() + 30_000),
        ).rejects.toThrow('foreign credential');
      },
    );
  });

  test.each(['malformedTail', 'truncateInventory'] as const)(
    'does not treat %s as directory propagation',
    async (failure) => {
      await withFixture(async ({ fixture, generate, commands, state }) => {
        await fixture.prepare(Date.now() + 30_000);
        generate();
        state[failure] = true;
        const wait = vi
          .spyOn(commands, 'wait')
          .mockRejectedValue(new Error('Unapproved propagation retry'));
        await expect(
          fixture.capture(generated, Date.now() + 30_000),
        ).rejects.toThrow();
        expect(wait).not.toHaveBeenCalled();
      });
    },
  );

  test('does not discharge captured identities through a renamed display-name index', async () => {
    await withFixture(async ({ fixture, generate, calls, state, records }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.app = {
        ...directoryObject(objectId),
        displayName: 'renamed-original',
      };
      state.sp = {
        ...directoryObject(principalId),
        displayName: 'renamed-original',
      };
      state.denyDirectoryDelete = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow();
      expect(state.app.id).toBe(objectId);
      expect(state.sp.id).toBe(principalId);
      expect(
        calls.some(({ args }) => args.includes(`appId eq '${applicationId}'`)),
      ).toBe(true);
      expect(records).not.toContainEqual(
        expect.objectContaining({ state: 'absent' }),
      );
    });
  });
  test('uses original tenant and subscription, and removes roles before exact directory objects', async () => {
    await withFixture(async ({ fixture, generate, calls, state, records }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      await fixture.remove(Date.now() + 30_000);
      expect(state).toMatchObject({ app: undefined, sp: undefined, roles: [] });
      const deletes = calls.filter(({ args }) =>
        args.some((arg) => /^delete$/iu.test(arg)),
      );
      expect(deletes.map(({ args }) => args.slice(0, 3))).toEqual([
        ['role', 'assignment', 'delete'],
        ['rest', '--method', 'DELETE'],
        ['rest', '--method', 'DELETE'],
      ]);
      expect(deletes.slice(1).map(({ args }) => args[4])).toEqual([
        `https://graph.microsoft.com/v1.0/servicePrincipals/${principalId}`,
        `https://graph.microsoft.com/v1.0/applications/${objectId}`,
      ]);
      // Entra directory commands use the private tenant session; Azure CLI
      // rejects the subscription argument accepted by ARM role operations.
      expect(
        deletes.slice(1).every(({ args }) => !args.includes('--subscription')),
      ).toBe(true);
      expect(
        deletes
          .slice(0, 1)
          .map(({ args }) => args[args.indexOf('--subscription') + 1]),
      ).toEqual([subscriptionId]);
      expect(calls[0].args).toContain(bootstrapId);
      expect(
        calls.every(({ options }) => options.recordArtifact === false),
      ).toBe(true);
      expect(records.at(-1)).toMatchObject({
        state: 'absent',
        binding: { servicePrincipal: { id: principalId } },
      });
      expect(JSON.stringify(records)).not.toContain(material.secret);
    });
  });

  test('waits out an eventually consistent principal list after admin cleanup', async () => {
    await withFixture(async ({ fixture, generate, state, records }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.staleDirectoryReads = 2;
      let now = Date.now();
      const waits: number[] = [];
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.spyOn(JobPrivateCommands.prototype, 'wait').mockImplementation(
        async (milliseconds) => {
          if (state.postCleanupPrincipalReads > 0) waits.push(milliseconds);
          now += milliseconds;
        },
      );
      await fixture.remove(now + 120_000);
      expect(waits).toEqual([1_000, 2_000]);
      expect(state.postCleanupPrincipalReads).toBe(3);
      expect(state.staleDirectoryReads).toBe(0);
      expect(records.at(-1)).toMatchObject({ state: 'absent' });
    });
  });

  test('fails closed when the deleted principal never leaves the fixture inventory', async () => {
    await withFixture(async ({ fixture, generate, state, records }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.staleDirectoryReads = Number.MAX_SAFE_INTEGER;
      let now = Date.now();
      const waits: number[] = [];
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.spyOn(JobPrivateCommands.prototype, 'wait').mockImplementation(
        async (milliseconds) => {
          if (state.postCleanupPrincipalReads > 0) waits.push(milliseconds);
          now += milliseconds;
        },
      );
      await expect(fixture.remove(now + 120_000)).rejects.toThrow(
        'Azure Job native credential remains after cleanup',
      );
      expect(waits).toEqual([
        1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
      ]);
      expect(state.postCleanupPrincipalReads).toBe(9);
      expect(records).not.toContainEqual(
        expect.objectContaining({ state: 'absent' }),
      );
    });
  });

  test('retains original principal and role identities when both directory indexes disappear', async () => {
    await withFixture(async ({ fixture, generate, calls, state }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.hideDirectory = true;
      await fixture.remove(Date.now() + 30_000);
      expect(state.roles).toEqual([]);
      expect(
        calls
          .filter(
            ({ args }) => args.slice(0, 3).join(' ') === 'role assignment list',
          )
          .every(
            ({ args }) =>
              args[args.indexOf('--assignee-object-id') + 1] === principalId,
          ),
      ).toBe(true);
      expect(
        calls.some(
          ({ args }) =>
            args[4] ===
            `https://graph.microsoft.com/v1.0/servicePrincipals/${principalId}`,
        ),
      ).toBe(true);
    });
  });

  test('retains exact directory identities after complete Azure CLI argument-error receipts', async () => {
    await withFixture(async ({ fixture, generate, state, records, calls }) => {
      vi.spyOn(JobPrivateCommands.prototype, 'wait').mockResolvedValue();
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.denyDirectoryDelete = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toMatchObject({
        errors: [
          { message: expect.stringContaining('exit=2') },
          {
            message:
              'Azure dependent absence could not be confirmed; identity retained.',
          },
        ],
      });
      expect(state).toMatchObject({
        app: { id: objectId, appId: applicationId },
        sp: { id: principalId, appId: applicationId },
        roles: [],
      });
      expect(records.at(-1)).toMatchObject({
        state: 'inventory',
        kind: 'sp',
        complete: true,
        identities: [{ id: principalId, appId: applicationId }],
      });
      expect(records).not.toContainEqual(
        expect.objectContaining({ state: 'absent' }),
      );
      expect(
        calls.filter(({ args }) => args[4]?.includes('/applications/')),
      ).toHaveLength(0);
    });
  });

  test('retains an unbound generated identity after a lost import reply', async () => {
    await withFixture(async ({ fixture, generate, calls }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'reply is unresolved',
      );
      expect(
        calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
      ).toBe(false);
    });
  });

  test('allows only an exact Graph DELETE of a bound directory object', () => {
    const displayName = 'anycloud-bound';
    const binding = {
      application: { id: objectId, appId: applicationId, displayName },
      servicePrincipal: { id: principalId, appId: applicationId, displayName },
    };
    const graph = 'https://graph.microsoft.com/v1.0';
    const remove = (url: string, method = 'DELETE') => [
      'rest',
      '--method',
      method,
      '--url',
      url,
      '--output',
      'none',
    ];
    expect(
      ownedGraphDeleteKind(
        remove(`${graph}/applications/${objectId}`),
        binding,
      ),
    ).toBe('app');
    expect(
      ownedGraphDeleteKind(
        remove(`${graph}/servicePrincipals/${principalId}`),
        binding,
      ),
    ).toBe('sp');
    for (const args of [
      remove(`${graph}/applications/${principalId}`),
      remove(`${graph}/servicePrincipals/${objectId}`),
      remove(`${graph}/applications/${objectId}`, 'GET'),
      remove(`${graph}/applications/${objectId}/owners`),
      [...remove(`${graph}/applications/${objectId}`), '--debug'],
      [
        ...remove(`${graph}/applications/${objectId}`).slice(0, 4),
        `${graph}/applications/${objectId} --output`,
        'none',
      ],
      ['ad', 'app', 'delete', '--id', objectId, '--output', 'none'],
    ])
      expect(ownedGraphDeleteKind(args, binding)).toBeUndefined();
  });

  // Run 37730658284: the app delete failed once after principal cleanup, and
  // a later identical delete succeeded.
  test('re-issues a rejected application delete once and confirms absence', async () => {
    await withFixture(async ({ fixture, generate, state, records, calls }) => {
      vi.spyOn(JobPrivateCommands.prototype, 'wait').mockResolvedValue();
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.rejectApplicationDeleteOnce = true;
      await fixture.remove(Date.now() + 30_000);
      expect(state).toMatchObject({ app: undefined, sp: undefined, roles: [] });
      expect(
        calls.filter(({ args }) => args[4]?.includes('/applications/')),
      ).toHaveLength(2);
      expect(records.at(-1)).toMatchObject({ state: 'absent' });
    });
  });

  test('preserves the original application and safe denial after principal cleanup succeeds', async () => {
    await withFixture(async ({ fixture, generate, state, records, calls }) => {
      vi.spyOn(JobPrivateCommands.prototype, 'wait').mockResolvedValue();
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.denyApplicationDelete = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toMatchObject({
        errors: [
          {
            nativeCode: 'Authorization_RequestDenied',
            message: expect.stringContaining('Authorization_RequestDenied'),
          },
          {
            message:
              'Azure dependent absence could not be confirmed; identity retained.',
          },
        ],
      });
      expect(state).toMatchObject({
        app: { id: objectId, appId: applicationId },
        sp: undefined,
        roles: [],
      });
      expect(records.at(-1)).toMatchObject({
        state: 'inventory',
        kind: 'app',
        complete: true,
        identities: [{ id: objectId, appId: applicationId }],
      });
      expect(records).not.toContainEqual(
        expect.objectContaining({ state: 'absent' }),
      );
      // The original delete, its re-issue, and one per still-listed read
      // across the 15-wait absence window and its final read.
      expect(
        calls.filter(({ args }) => args[4]?.includes('/applications/')),
      ).toHaveLength(2 + 16);
      expect(JSON.stringify(records)).not.toContain(material.secret);
    });
  });

  test('rejects a replacement directory object before any cleanup mutation', async () => {
    await withFixture(async ({ fixture, generate, calls, state }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.sp = directoryObject('88888888-8888-4888-8888-888888888888');
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'identity changed',
      );
      expect(
        calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
      ).toBe(false);
    });
  });

  test('does not delete unowned role assignments or their principal', async () => {
    await withFixture(async ({ fixture, generate, calls, state }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.roles[0].roleDefinitionId = `${scope}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7`;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'Unexpected Azure run role assignment',
      );
      expect(
        calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
      ).toBe(false);
    });
  });

  test('retains a validated inventory prefix when a later row is malformed', async () => {
    await withFixture(async ({ fixture, generate, state, records, calls }) => {
      await fixture.prepare(Date.now() + 30_000);
      generate();
      await fixture.capture(generated, Date.now() + 30_000);
      state.malformedTail = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'malformed identity',
      );
      expect(records.at(-1)).toMatchObject({
        state: 'inventory',
        complete: false,
        identities: [{ appId: applicationId }],
      });
      expect(JSON.stringify(records)).not.toContain('unvalidated-private-row');
      expect(
        calls.some(({ args }) => args.some((arg) => /^delete$/iu.test(arg))),
      ).toBe(false);
    });
  });

  test('rejects truncated inventories and keeps cleanup independent of foreground cancellation', async () => {
    await withFixture(
      async ({ fixture, generate, state, controller, records }) => {
        await fixture.prepare(Date.now() + 30_000);
        generate();
        await fixture.capture(generated, Date.now() + 30_000);
        controller.abort();
        state.truncateInventory = true;
        await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow();
        expect(records.at(-1)).not.toMatchObject({ state: 'absent' });
        state.truncateInventory = false;
        await fixture.remove(Date.now() + 30_000);
        expect(records.at(-1)).toMatchObject({ state: 'absent' });
      },
    );
  });
});
