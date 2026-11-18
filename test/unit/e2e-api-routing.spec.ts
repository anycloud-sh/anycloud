import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, onTestFinished, test } from 'vitest';

import {
  ApiAuthScenarios,
  assertSecretListPrivacy,
} from '../integration/e2e/internal/api-auth.js';
import {
  completedCommand,
  rejectedCommand,
} from '../integration/e2e/internal/api-assertions.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import { type ApiFixtureRuntime } from '../integration/e2e/internal/local-api-process.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { FixtureNames } from '../integration/e2e/internal/names.js';
import packageJson from '../../package.json' with { type: 'json' };
import { TargetHttpClient } from '../integration/e2e/internal/transports/http.js';
import { commandResultForTest } from './helpers/e2e.js';

async function runtime(): Promise<ApiFixtureRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-api-routing-'));
  const cleanup = new CleanupStack();
  onTestFinished(async () => {
    await cleanup.run();
    await rm(directory, { force: true, recursive: true });
  });
  const signal = new AbortController().signal;
  const cleanupSignal = new AbortController().signal;
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(
    path.join(directory, 'artifacts'),
    redactor,
  );
  const files = new FixtureFiles(directory);
  return {
    artifacts,
    cleanup,
    cleanupSignal,
    files,
    redactor,
    signal,
    projectRoot: directory,
    runner: new ProcessRunner(artifacts, signal, directory),
    cleanupRunner: new ProcessRunner(artifacts, cleanupSignal, directory),
    http: new TargetHttpClient(artifacts, redactor, signal),
  };
}

describe('API observation failure propagation', () => {
  test('runs the secret owner through real non-force 409 and forced cleanup without provisioning', async () => {
    const fixture = await runtime();
    const projectRoot = process.cwd();
    const owner = new ApiAuthScenarios(
      {
        ...fixture,
        projectRoot,
        runner: new ProcessRunner(
          fixture.artifacts,
          fixture.signal,
          projectRoot,
        ),
        cleanupRunner: new ProcessRunner(
          fixture.artifacts,
          fixture.cleanupSignal,
          projectRoot,
        ),
      },
      new FixtureNames('secret409'),
      packageJson.version,
    );
    await expect(owner.secretCrudPrivacy()).resolves.toEqual({
      scenario: 'secret-crud-privacy',
      satisfied: true,
    });
    await fixture.cleanup.run();
    expect(
      fixture.cleanup.observations().every((entry) => entry.completed),
    ).toBe(true);
  });

  const summary = { name: 'private', createdAt: 1, updatedAt: 1 };
  test('accepts only a unique metadata-only secret summary', () => {
    expect(() =>
      assertSecretListPrivacy([summary], 'private', 'hidden-value'),
    ).not.toThrow();
    for (const bad of [
      [{ ...summary, value: 'hidden-value' }],
      [{ ...summary, values: { DIFFERENT: 'another-value' } }],
      [summary, summary],
      [],
      { secrets: [summary] },
    ]) {
      expect(() =>
        assertSecretListPrivacy(bad, 'private', 'hidden-value'),
      ).toThrow();
    }
  });

  test.each([
    { timedOut: true },
    { aborted: true },
    { outputTruncated: true },
    { signal: 'SIGTERM' as const },
    { spawnError: 'missing binary' },
  ])(
    'rejects interrupted observations despite matching output (%j)',
    (interrupted) => {
      expect(() =>
        completedCommand(
          commandResultForTest({ stdout: 'ok', ...interrupted }),
          'read',
        ),
      ).toThrow();
      expect(() =>
        rejectedCommand(
          commandResultForTest({
            exitCode: 1,
            combined: 'API access denied',
            ...interrupted,
          }),
          'API access denied',
        ),
      ).toThrow();
    },
  );

  test("names a killed command's timeout, not its missing exit code (run 40934357557)", () => {
    expect(() =>
      completedCommand(
        commandResultForTest({ exitCode: null, timedOut: true }),
        'bucket create (hosted check)',
      ),
    ).toThrow('bucket create (hosted check) timed out');
  });

  test('requires a genuine rejected command and its exact diagnostic', () => {
    expect(() =>
      rejectedCommand(
        commandResultForTest({ exitCode: 1, combined: 'API access denied' }),
        'API access denied',
      ),
    ).not.toThrow();
    expect(() =>
      rejectedCommand(
        commandResultForTest({ exitCode: 0, combined: 'API access denied' }),
        'API access denied',
      ),
    ).toThrow();
    expect(() =>
      rejectedCommand(
        commandResultForTest({ exitCode: 1, combined: 'some other failure' }),
        'API access denied',
      ),
    ).toThrow();
  });
});
