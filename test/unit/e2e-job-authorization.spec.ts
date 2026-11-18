import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import type { CloudCredential } from '../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { JobAuthorization } from '../integration/e2e/internal/job-authorization.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import type { CliRunOptions } from '../integration/e2e/internal/cli.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';

const name = 'lambda-test';
const material = {
  cloudProvider: CloudType.Lambda,
  apiKey: 'private-borrowed-token',
} as const;
const recordId = createHash('sha256')
  .update(JSON.stringify(material))
  .digest('hex');

function fixture(mode: 'bootstrap' | 'public-token-import' = 'bootstrap') {
  const cleanup = new CleanupStack();
  const records: unknown[] = [];
  const calls: string[] = [];
  const cliCalls: Array<{ args: readonly string[]; options?: CliRunOptions }> =
    [];
  const state = {
    dependentPresent: false,
    credential: undefined as Readonly<CloudCredential> | undefined,
    databaseId: recordId,
    rowName: undefined as string | null | undefined,
    loseImport: false,
    deletionFailed: false,
    recordFailure: false,
    abortAfterAcknowledgement: false,
    beforeImport: undefined as (() => void) | undefined,
  };
  const foreground = new AbortController();
  const guard = () => {
    if (state.dependentPresent)
      throw new Error('dependent native or storage absence unresolved');
  };
  const save = () => {
    state.credential = material;
    state.rowName = name;
  };
  const api = {
    controller: { url: 'http://original-controller.invalid', generation: 1 },
    readCredential: async () => {
      calls.push('read');
      foreground.signal.throwIfAborted();
      if (!cleanup.observations().some((entry) => !entry.completed))
        throw new Error('import preceded its cleanup intent');
      return state.credential ? { ...state.credential, name } : undefined;
    },
    saveCredential: async (
      _name: string,
      _material: CloudCredential,
      options?: { overwrite?: boolean; deadlineAt?: number },
    ) => {
      calls.push('save');
      expect(options).toMatchObject({ overwrite: false });
      save();
      if (state.loseImport) throw new Error('original-lost-reply');
      if (state.abortAfterAcknowledgement)
        foreground.abort(new Error('foreground readback cancelled'));
    },
    listCredentials: async () =>
      state.credential
        ? [{ name, cloudProvider: CloudType.Lambda as const }]
        : [],
    deleteCredential: async () => {
      calls.push('delete');
      if (state.deletionFailed) throw new Error('original-delete-failed');
      state.credential = undefined;
      state.rowName = null;
    },
  };
  const database = {
    queryComplete: async () =>
      state.rowName === undefined
        ? []
        : [
            {
              id: state.databaseId,
              name: state.rowName,
              cloud_provider: CloudType.Lambda,
            },
          ],
  };
  const commands = new JobPrivateCommands(
    {
      run: async () => {
        throw new Error(
          'borrowed token must never create or delete a native credential',
        );
      },
    },
    new AbortController().signal,
  );
  const authorization = new JobAuthorization(
    {
      api,
      cleanupApi: {
        ...api,
        get controller() {
          return api.controller;
        },
        readCredential: async () => {
          if (!foreground.signal.aborted) return api.readCredential();
          calls.push('cleanup-read');
          return state.credential ? { ...state.credential, name } : undefined;
        },
      },
      database,
      cleanupDatabase: database,
      cleanup,
      commands,
      cleanupCommands: commands,
      cli: {
        run: async (args, options): Promise<CommandResult> => {
          calls.push('cli-import');
          cliCalls.push({ args, options });
          save();
          const stdout = `Credentials "${name}" saved successfully!`;
          if (state.loseImport) throw new Error('private-native-error');
          return {
            executable: 'anycloud',
            args: [...args],
            exitCode: 0,
            signal: null,
            stdout,
            stderr: '',
            combined: stdout,
            durationMs: 1,
            timedOut: false,
            aborted: false,
            outputTruncated: false,
          };
        },
      },
      files: {
        directory: async () => '/private-job-files',
        privateText: async () => '/private-job-files/value',
        remove: async () => {
          calls.push('files-remove');
        },
      },
      artifacts: {
        json: async (_label, body) => {
          if (
            typeof body === 'object' &&
            body !== null &&
            'state' in body &&
            body.state === 'import-sending'
          )
            state.beforeImport?.();
          if (state.recordFailure) throw new Error('secondary-artifact-failed');
          records.push(body);
          return '';
        },
      },
      redactor: { add: () => undefined },
    },
    {
      name,
      profile: {
        slug: 'lambda',
        provider: CloudType.Lambda,
        credentialName: name,
        credential: material,
        vmTypes: ['cpu_4x_general'],
      },
      mode,
      cleanupMs: 30_000,
      dependentsAbsent: guard,
    },
  );
  return { authorization, api, cleanup, records, calls, cliCalls, state };
}

describe('Job credential dependency lifecycle', () => {
  test('registers before import and releases only the exact API record after dependent absence', async () => {
    const world = fixture();
    expect(world.cleanup.observations()).toEqual([
      { label: `job-api-authorization-${name}`, completed: false },
    ]);
    const binding = await world.authorization.create(Date.now() + 30_000);
    expect(binding).toMatchObject({
      name,
      provider: CloudType.Lambda,
      recordId,
    });
    expect(world.authorization.material(binding)).toEqual(material);
    await world.authorization.release(binding, Date.now() + 30_000);
    expect(world.calls).toEqual([
      'read',
      'save',
      'read',
      'read',
      'delete',
      'files-remove',
    ]);
    expect(world.cleanup.observations().every((entry) => entry.completed)).toBe(
      true,
    );
    expect(world.records.at(-1)).toMatchObject({
      apiAbsent: true,
      nativeOwnership: 'borrowed-retained',
      nativeAbsent: null,
    });
    expect(JSON.stringify(world.records)).not.toContain(material.apiKey);
    await expect(
      world.authorization.create(Date.now() + 30_000),
    ).rejects.toThrow('single use');
    expect(() => world.authorization.material(binding)).toThrow('released');
  });

  test('uses the public token import with private output and actual selected child environment', async () => {
    const world = fixture('public-token-import');
    await world.authorization.create(Date.now() + 30_000);
    expect(world.cliCalls).toHaveLength(1);
    expect(world.cliCalls[0]).toMatchObject({
      // Flags first, then the name — the order cliArgs emits.
      args: ['credentials', 'new', '--provider', 'lambda', name],
      options: {
        recordArtifact: false,
        env: { LAMBDA_API_KEY: material.apiKey, AWS_CONFIG_FILE: '/dev/null' },
      },
    });
    await world.cleanup.run();
    expect(world.state.credential).toBeUndefined();
  });

  test('retains credentials while a dependent Job or bucket remains uncertain', async () => {
    const world = fixture();
    await world.authorization.create(Date.now() + 30_000);
    world.state.dependentPresent = true;
    await expect(world.cleanup.run()).rejects.toThrow(
      'dependent native or storage absence unresolved',
    );
    expect(world.state.credential).toEqual(material);
    expect(world.calls).not.toContain('delete');
    expect(world.cleanup.observations()).toEqual([
      { label: `job-api-authorization-${name}`, completed: false },
    ]);
    expect(world.records.at(-1)).toMatchObject({
      state: 'api-cleanup-incomplete',
      apiAbsent: false,
    });
  });

  test.each(['bootstrap', 'public-token-import'] as const)(
    'does not adopt or replay a lost %s API import reply',
    async (mode) => {
      const world = fixture(mode);
      world.state.loseImport = true;
      await expect(
        world.authorization.create(Date.now() + 30_000),
      ).rejects.toThrow();
      await expect(world.cleanup.run()).rejects.toThrow(
        'reply or record binding is unresolved',
      );
      expect(
        world.calls.filter((call) => ['save', 'cli-import'].includes(call)),
      ).toHaveLength(1);
      expect(world.calls).not.toContain('delete');
      expect(world.cleanup.observations()[0].completed).toBe(false);
      expect(world.records.at(-1)).toMatchObject({
        apiSent: true,
        apiConfirmed: false,
        apiAbsent: false,
      });
    },
  );

  test('does not delete a same-name replacement API record', async () => {
    const world = fixture();
    const binding = await world.authorization.create(Date.now() + 30_000);
    world.state.databaseId = 'b'.repeat(64);
    await expect(
      world.authorization.release(binding, Date.now() + 30_000),
    ).rejects.toThrow('name was reassigned');
    expect(world.calls).not.toContain('delete');
  });

  test('fences a controller change during the pre-import artifact before any API send', async () => {
    const world = fixture();
    world.state.beforeImport = () => {
      world.api.controller.generation++;
    };
    await expect(
      world.authorization.create(Date.now() + 30_000),
    ).rejects.toThrow('original API endpoint or generation');
    expect(world.calls).not.toContain('save');
    await world.cleanup.run();
    expect(world.calls).not.toContain('delete');
    expect(world.state.credential).toBeUndefined();
    expect(world.cleanup.observations()[0].completed).toBe(true);
    expect(world.records.at(-1)).toMatchObject({
      apiSent: false,
      apiAbsent: true,
    });
  });

  test('cleans a confirmed import through independent readback after foreground cancellation', async () => {
    const world = fixture();
    world.state.abortAfterAcknowledgement = true;
    await expect(
      world.authorization.create(Date.now() + 30_000),
    ).rejects.toThrow('foreground readback cancelled');
    expect(world.state.credential).toEqual(material);
    await world.cleanup.run();
    expect(world.calls.slice(-2)).toEqual(['cleanup-read', 'delete']);
    expect(world.state.credential).toBeUndefined();
    expect(world.cleanup.observations()[0].completed).toBe(true);
    expect(world.records.at(-1)).toMatchObject({
      apiConfirmed: true,
      apiAbsent: true,
      recordId: null,
    });
  });

  test('does not turn a confirmed but cancelled import into ownership of a foreign database record', async () => {
    const world = fixture();
    world.state.abortAfterAcknowledgement = true;
    await expect(
      world.authorization.create(Date.now() + 30_000),
    ).rejects.toThrow('foreground readback cancelled');
    world.state.databaseId = 'b'.repeat(64);
    await expect(world.cleanup.run()).rejects.toThrow('name was reassigned');
    expect(world.calls).not.toContain('delete');
    expect(world.cleanup.observations()[0].completed).toBe(false);
  });

  test('rejects copied authorizations and a changed original endpoint', async () => {
    const world = fixture();
    const binding = await world.authorization.create(Date.now() + 30_000);
    await expect(
      world.authorization.release({ ...binding }, Date.now() + 30_000),
    ).rejects.toThrow('another import');
    world.api.controller.url = 'http://different-controller.invalid';
    await expect(
      world.authorization.release(binding, Date.now() + 30_000),
    ).rejects.toThrow('original API endpoint');
    expect(world.calls).not.toContain('delete');
  });

  test('rejects import after disposal and while disposal closes pending preparation', async () => {
    const unused = fixture();
    await unused.cleanup.run();
    await expect(
      unused.authorization.create(Date.now() + 30_000),
    ).rejects.toThrow('begun cleanup');
    expect(unused.calls).not.toContain('save');
    const preparing = fixture();
    const create = preparing.authorization.create(Date.now() + 30_000);
    const dispose = preparing.cleanup.run();
    await expect(create).rejects.toThrow('begun cleanup');
    await dispose;
    expect(preparing.calls).not.toContain('save');
    expect(preparing.state.credential).toBeUndefined();
    expect(preparing.cleanup.observations()[0].completed).toBe(true);
  });

  test('retains primary cleanup and secondary artifact failures without retrying a mutation', async () => {
    const world = fixture();
    const binding = await world.authorization.create(Date.now() + 30_000);
    world.state.deletionFailed = true;
    world.state.recordFailure = true;
    const failure = await world.authorization
      .release(binding, Date.now() + 30_000)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('missing aggregate');
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      'original-delete-failed',
      'secondary-artifact-failed',
    ]);
    await expect(world.cleanup.run()).rejects.toThrow();
    expect(world.calls.filter((call) => call === 'delete')).toHaveLength(1);
    expect(world.state.credential).toEqual(material);
    expect(world.cleanup.observations()[0].completed).toBe(false);
  });
});
