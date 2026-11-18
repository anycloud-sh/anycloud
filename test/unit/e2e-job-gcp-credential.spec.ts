import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';

import anycloudRole from '../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { CloudType } from '../../src/shared/cloud.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import { publishedRoleId } from '../integration/credentials-onboarding/gcp/admin.js';
import { GcpJobImportFixture } from '../integration/e2e/internal/transports/job-gcp-credential.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';

afterEach(() => vi.unstubAllGlobals());

const projectId = 'job-project';
const name = 'bkt-12345';
const email = `anycloud-${name}@${projectId}.iam.gserviceaccount.com`;
const uniqueId = '123456789012345678901';
const original = {
  projectId,
  email,
  uniqueId,
  name: `projects/${projectId}/serviceAccounts/${email}`,
  displayName: `Anycloud Service Account - ${name}`,
};
const material = {
  cloudProvider: CloudType.GCP,
  projectId,
  clientEmail: email,
  privateKey: 'generated-private-key',
} as const;

async function withFixture(
  use: (world: {
    fixture: GcpJobImportFixture;
    controller: AbortController;
    redactor: Redactor;
    calls: Array<{ args: readonly string[]; options: CommandOptions }>;
    records: unknown[];
    state: {
      account: typeof original | undefined;
      loseCreation: boolean;
      truncateInventory: boolean;
      staleListReads: number;
      role: { id: string; permissions: string[]; deleted: boolean } | undefined;
      /** Another run's concurrent create wins; ours sees it this many reads late. */
      raceCreate: number | undefined;
      /** Our create is refused and no run's role ever appears. */
      refuseCreate: boolean;
      describeRefusal: string | undefined;
      policy: {
        etag: string;
        bindings: Array<{ role: string; members: string[] }>;
      };
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'job-gcp-fixture-'));
  try {
    const controller = new AbortController();
    const calls: Array<{ args: readonly string[]; options: CommandOptions }> =
      [];
    const records: unknown[] = [];
    const state = {
      account: undefined as typeof original | undefined,
      loseCreation: false,
      truncateInventory: false,
      staleListReads: 0,
      role: undefined as
        | { id: string; permissions: string[]; deleted: boolean }
        | undefined,
      raceCreate: undefined as number | undefined,
      refuseCreate: false,
      describeRefusal: undefined as string | undefined,
      policy: {
        etag: 'original-policy',
        bindings: [
          {
            role: 'roles/storage.admin',
            members: [
              `serviceAccount:${email}`,
              `deleted:serviceAccount:anycloud-bkt-777@${projectId}.iam.gserviceaccount.com?uid=777`,
            ],
          },
        ],
      },
    };
    const run = async (
      executable: string,
      args: readonly string[],
      options: CommandOptions = {},
    ): Promise<CommandResult> => {
      calls.push({ args, options });
      options.signal?.throwIfAborted();
      let stdout = '';
      let stderr = '';
      const operation = args.slice(0, 3).join(' ');
      if (operation === 'iam service-accounts create') {
        state.account = { ...original };
        if (state.loseCreation) throw new Error('native-create-reply-lost');
        stdout = JSON.stringify(state.account);
      } else if (operation === 'iam service-accounts list') {
        // The eventually consistent list keeps a deleted account for a while.
        const stale = !state.account && state.staleListReads > 0;
        if (stale) state.staleListReads -= 1;
        stdout = JSON.stringify(
          state.account || stale ? [state.account ?? original] : [],
        );
      } else if (operation === 'iam service-accounts delete')
        state.account = undefined;
      else if (operation === 'iam roles create') {
        if (state.refuseCreate) {
          stderr =
            'ERROR: (gcloud.iam.roles.create) ABORTED: concurrent modification.';
        } else if (state.raceCreate !== undefined) {
          stderr =
            'ERROR: (gcloud.iam.roles.create) ABORTED: concurrent modification.';
          state.role = {
            id: args[3],
            permissions: anycloudRole.includedPermissions,
            deleted: false,
          };
        } else if (state.role) {
          stderr = `ERROR: (gcloud.iam.roles.create) ALREADY_EXISTS: Role ${args[3]} exists.`;
        } else {
          const file = args.find((arg) => arg.startsWith('--file='))!;
          const role = JSON.parse(await readFile(file.slice(7), 'utf8')) as {
            includedPermissions: string[];
          };
          state.role = {
            id: args[3],
            permissions: role.includedPermissions,
            deleted: false,
          };
        }
      } else if (operation === 'iam roles describe' && state.refuseCreate)
        stderr = `ERROR: (gcloud.iam.roles.describe) ${state.describeRefusal ?? 'NOT_FOUND'}: Role ${args[3]}.`;
      else if (
        operation === 'iam roles describe' &&
        state.raceCreate !== undefined &&
        state.raceCreate-- > 0
      )
        stderr = `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role ${args[3]} not found.`;
      else if (operation === 'iam roles describe')
        stdout = JSON.stringify({
          includedPermissions: state.role?.permissions,
          deleted: state.role?.deleted,
        });
      else if (
        args.slice(0, 4).join(' ') === 'iam service-accounts keys create'
      ) {
        await writeFile(
          args[4],
          JSON.stringify({
            project_id: projectId,
            client_email: email,
            private_key: material.privateKey,
            private_key_id: 'original-key-id',
          }),
          { mode: 0o600 },
        );
      } else if (args.includes('get-iam-policy'))
        stdout = JSON.stringify(state.policy);
      else if (args.includes('set-iam-policy')) {
        state.policy = JSON.parse(
          await readFile(args[args.indexOf('set-iam-policy') + 2], 'utf8'),
        ) as typeof state.policy;
      } else if (args[0] === 'projects' && args[1] === 'describe') {
        stdout = args.includes('--format=value(projectNumber)')
          ? '123456789012'
          : args.includes('--format=value(projectId)')
            ? projectId
            : JSON.stringify({ projectId, projectNumber: '123456789012' });
      } else if (args[0] === 'auth' && args[1] === 'list') stdout = email;
      return {
        executable,
        args: [...args],
        exitCode: stderr ? 1 : 0,
        signal: null,
        stdout,
        stderr,
        combined: stdout + stderr,
        durationMs: 1,
        aborted: false,
        timedOut: false,
        outputTruncated:
          state.truncateInventory && operation === 'iam service-accounts list',
      };
    };
    // Import readiness makes no direct HTTP request.
    vi.stubGlobal('fetch', vi.fn());
    const redactor = new Redactor();
    const fixture = new GcpJobImportFixture({
      name,
      bootstrap: {
        cloudProvider: CloudType.GCP,
        projectId,
        clientEmail: `bootstrap@${projectId}.iam.gserviceaccount.com`,
        privateKey: 'bootstrap-private-key',
      },
      commands: new JobPrivateCommands({ run }, controller.signal),
      cleanupCommands: new JobPrivateCommands(
        { run },
        new AbortController().signal,
      ),
      files: new FixtureFiles(root),
      artifacts: {
        json: async (_name, body) => {
          records.push(body);
          return '';
        },
      },
      redactor,
    });
    await use({ fixture, controller, redactor, calls, records, state });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('Job GCP import credential ownership', () => {
  test('uses the existing onboarding flow, retains its creation ID and independently reads back account and policy absence', async () => {
    await withFixture(async ({ fixture, calls, records, state, redactor }) => {
      expect(await fixture.create(Date.now() + 30_000)).toEqual(material);
      expect(redactor.text(material.privateKey)).toBe('[REDACTED]');
      expect(
        calls.every(({ options }) => options.recordArtifact === false),
      ).toBe(true);
      expect(
        calls.some(
          ({ args, options }) =>
            args[0] === 'auth' &&
            args[1] === 'list' &&
            options.env?.CLOUDSDK_CONFIG?.endsWith('/import-validation'),
        ),
      ).toBe(true);
      await fixture.remove(Date.now() + 30_000);
      expect(state.account).toBeUndefined();
      expect(state.policy.bindings[0].members).toEqual([
        `deleted:serviceAccount:anycloud-bkt-777@${projectId}.iam.gserviceaccount.com?uid=777`,
      ]);
      expect(records.at(-1)).toMatchObject({
        state: 'absent',
        identity: { uniqueId },
      });
      expect(JSON.stringify(records)).not.toContain(material.privateKey);
    });
  });

  test('0047/S8 imports a credential with no grant on the default Compute service account', async () => {
    await withFixture(async ({ fixture, calls }) => {
      await fixture.create(Date.now() + 30_000);
      expect(
        calls.filter(({ args }) =>
          args
            .join(' ')
            .startsWith('iam service-accounts add-iam-policy-binding'),
        ),
      ).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  test('0047/S11 binds the shared published role and never deletes it', async () => {
    await withFixture(async ({ fixture, calls, state }) => {
      const roleId = publishedRoleId(anycloudRole);
      expect(roleId).toMatch(/^anycloud_e2e_[0-9a-f]{8}$/);
      await fixture.create(Date.now() + 30_000);
      expect(state.role).toEqual({
        id: roleId,
        permissions: anycloudRole.includedPermissions,
        deleted: false,
      });
      expect(
        calls
          .filter(({ args }) => args.includes('add-iam-policy-binding'))
          .map(({ args }) => args.find((arg) => arg.startsWith('--role='))),
      ).toEqual([`--role=projects/${projectId}/roles/${roleId}`]);
      await fixture.remove(Date.now() + 30_000);
      expect(state.role?.deleted).toBe(false);
      expect(
        calls.filter(({ args }) => args.slice(0, 2).join(' ') === 'iam roles'),
      ).toHaveLength(1);
    });
  });

  test('reuses the shared role when a concurrent run creates it first', async () => {
    await withFixture(async ({ fixture, state }) => {
      state.raceCreate = 1;
      await expect(fixture.create(Date.now() + 30_000)).resolves.toEqual(
        material,
      );
    });
  }, 20_000);

  test.each([
    // Read-back retries NOT_FOUND until the Job's own deadline ends it.
    ['never appears', undefined, 2_500, /deadline expired/],
    ['cannot be read', 'PERMISSION_DENIED', 30_000, /PERMISSION_DENIED/],
  ])(
    'reports why the role behind a refused create %s',
    async (_, describeRefusal, budgetMs, reason) => {
      await withFixture(async ({ fixture, state }) => {
        state.refuseCreate = true;
        state.describeRefusal = describeRefusal;
        const failure = await fixture
          .create(Date.now() + budgetMs)
          .catch((error: unknown) => error);
        expect(String((failure as AggregateError).errors[0])).toMatch(reason);
      });
    },
    20_000,
  );

  test('reuses a matching shared role and fails closed on a drifted one', async () => {
    await withFixture(async ({ fixture, state }) => {
      state.role = {
        id: publishedRoleId(anycloudRole),
        permissions: [...anycloudRole.includedPermissions].reverse(),
        deleted: false,
      };
      await expect(fixture.create(Date.now() + 30_000)).resolves.toEqual(
        material,
      );
    });
    await withFixture(async ({ fixture, state }) => {
      state.role = {
        id: publishedRoleId(anycloudRole),
        permissions: ['compute.instances.list'],
        deleted: false,
      };
      const failure = await fixture
        .create(Date.now() + 30_000)
        .catch((error: unknown) => error);
      // Creation fails closed first; the Job owner's remove() cleans up.
      expect(String((failure as AggregateError).errors[0])).toContain(
        'differs from src/shared/cloud-policies/gcp-anycloud-role.json',
      );
    });
  });

  test('waits out an eventually consistent account list before declaring absence', async () => {
    await withFixture(async ({ fixture, state, calls, records }) => {
      await fixture.create(Date.now() + 30_000);
      state.staleListReads = 2;
      const before = calls.length;
      await fixture.remove(Date.now() + 30_000);
      const lists = calls
        .slice(before)
        .filter(
          ({ args }) =>
            args.slice(0, 3).join(' ') === 'iam service-accounts list',
        );
      // one read per stale answer, then the settled one
      expect(lists.length).toBeGreaterThanOrEqual(3);
      expect(state.staleListReads).toBe(0);
      expect(records.at(-1)).toMatchObject({ state: 'absent' });
    });
  }, 20_000);

  test('fails closed when the deleted account never leaves the list', async () => {
    await withFixture(async ({ fixture, state, records }) => {
      await fixture.create(Date.now() + 30_000);
      state.staleListReads = Number.MAX_SAFE_INTEGER;
      // A near cleanup deadline bounds the backoff instead of the full ≈ 75 s.
      await expect(fixture.remove(Date.now() + 1_500)).rejects.toThrow();
      expect(
        records.some(
          (record) => (record as { state: string }).state === 'absent',
        ),
      ).toBe(false);
    });
  }, 20_000);

  test('does not adopt a same-name account after a lost creation reply', async () => {
    await withFixture(async ({ fixture, state, calls }) => {
      state.loseCreation = true;
      await expect(fixture.create(Date.now() + 30_000)).rejects.toThrow();
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'creation reply is unresolved',
      );
      expect(state.account).toMatchObject({ uniqueId });
      expect(
        calls.some(
          ({ args }) =>
            args.slice(0, 3).join(' ') === 'iam service-accounts delete',
        ),
      ).toBe(false);
    });
  });

  test('refuses mutation of a recreated same-name service account', async () => {
    await withFixture(async ({ fixture, state, calls }) => {
      await fixture.create(Date.now() + 30_000);
      state.account = { ...original, uniqueId: '999999999999999999999' };
      const before = calls.length;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'changed identity',
      );
      expect(
        calls
          .slice(before)
          .some(
            ({ args }) =>
              args.includes('delete') || args.includes('set-iam-policy'),
          ),
      ).toBe(false);
    });
  });

  test('retains native ownership on a truncated cleanup inventory', async () => {
    await withFixture(async ({ fixture, state, records }) => {
      await fixture.create(Date.now() + 30_000);
      state.truncateInventory = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'truncated=true',
      );
      expect(
        records.some(
          (record) =>
            typeof record === 'object' &&
            record !== null &&
            'state' in record &&
            record.state === 'absent',
        ),
      ).toBe(false);
      expect(state.account?.uniqueId).toBe(uniqueId);
    });
  });

  test('uses independent cleanup cancellation after foreground abort', async () => {
    await withFixture(async ({ fixture, controller, state }) => {
      await fixture.create(Date.now() + 30_000);
      controller.abort();
      await fixture.remove(Date.now() + 30_000);
      expect(state.account).toBeUndefined();
    });
  });
});
