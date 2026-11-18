import { test, expect } from '../fixture.js';

test('CLI commands exit within their contracts and surface bounded failures', async ({
  e2e,
}) => {
  const fastDockerDirectory = await e2e.files.commandShim(
    'docker-fast-failure',
    'docker',
    { kind: 'exit', code: 1 },
  );
  const hangingDockerDirectory = await e2e.files.commandShim(
    'docker-hang',
    'docker',
    { kind: 'hang', milliseconds: 30_000 },
  );
  const noApiFastDirectory = await e2e.files.directory('no-api-fast');
  const noApiHangDirectory = await e2e.files.directory('no-api-hang');

  const expectBounded = (
    result: Awaited<ReturnType<typeof e2e.cli.run>>,
  ): void => {
    expect(result.spawnError).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  };

  const listHelp = await e2e.cli.run(['list', '--help'], {
    timeoutMs: 5_000,
  });
  expectBounded(listHelp);
  expect(listHelp.exitCode).toBe(0);

  const missingWorkload = await e2e.cli.run(['status', 'nonexistent'], {
    timeoutMs: 30_000,
  });
  expectBounded(missingWorkload);

  const noApi = await e2e.cli.run(['status', 'nonexistent-workload-12345'], {
    timeoutMs: 5_000,
    prependPath: fastDockerDirectory,
    env: {
      API_URL: '',
      ANYCLOUD_DIR: noApiFastDirectory,
    },
  });
  expectBounded(noApi);
  expect(noApi.exitCode).not.toBe(0);
  expect(noApi.combined).toContain('No local API is running');

  // `wait` must not retry forever when no API can answer, and must reject a
  // malformed deadline before contacting one.
  const waitNoApi = await e2e.cli.run(['wait', 'nonexistent-workload-12345'], {
    timeoutMs: 5_000,
    prependPath: fastDockerDirectory,
    env: {
      API_URL: '',
      ANYCLOUD_DIR: noApiFastDirectory,
    },
  });
  expectBounded(waitNoApi);
  expect(waitNoApi.exitCode).toBe(2);
  expect(waitNoApi.combined).toContain('No local API is running');

  const waitBadTimeout = await e2e.cli.run(
    ['wait', 'nonexistent-workload-12345', '--timeout', '5'],
    { timeoutMs: 5_000 },
  );
  expectBounded(waitBadTimeout);
  expect(waitBadTimeout.exitCode).toBe(2);
  expect(waitBadTimeout.combined).toContain('--timeout');

  // Usage and sign-in errors are observer errors too, never "a Workload failed".
  const waitNoIds = await e2e.cli.run(['wait'], { timeoutMs: 5_000 });
  expectBounded(waitNoIds);
  expect(waitNoIds.exitCode).toBe(2);
  const waitNoToken = await e2e.cli.run(
    ['wait', 'nonexistent-workload-12345'],
    {
      timeoutMs: 5_000,
      env: {
        GITHUB_TOKEN: '',
        ANYCLOUD_DIR: noApiFastDirectory,
      },
    },
  );
  expectBounded(waitNoToken);
  expect(waitNoToken.exitCode).toBe(2);
  const waitHelp = await e2e.cli.run(['wait', '--help'], { timeoutMs: 5_000 });
  expectBounded(waitHelp);
  expect(waitHelp.exitCode).toBe(0);

  const hungDocker = await e2e.cli.run(
    ['status', 'nonexistent-workload-12345'],
    {
      timeoutMs: 5_000,
      prependPath: hangingDockerDirectory,
      env: {
        API_URL: '',
        ANYCLOUD_DIR: noApiHangDirectory,
      },
    },
  );
  expectBounded(hungDocker);
  expect(hungDocker.exitCode).not.toBe(0);
  expect(hungDocker.combined).toContain(
    'Timed out checking the local API container',
  );

  const removedConfig = await e2e.cli.run(['config'], { timeoutMs: 5_000 });
  expectBounded(removedConfig);
  expect(removedConfig.exitCode).not.toBe(0);
  expect(removedConfig.combined).toContain('unknown command');

  const removedWorker = await e2e.cli.run(['worker'], {
    timeoutMs: 5_000,
  });
  expectBounded(removedWorker);
  expect(removedWorker.exitCode).not.toBe(0);
  expect(removedWorker.combined).toContain('unknown command');

  const credentialsHelp = await e2e.cli.run(['credentials', '--help'], {
    timeoutMs: 5_000,
  });
  expectBounded(credentialsHelp);
  expect(credentialsHelp.exitCode).toBe(0);

  const missingStatusId = await e2e.cli.run(['status'], {
    timeoutMs: 5_000,
  });
  expectBounded(missingStatusId);
  expect(missingStatusId.exitCode).not.toBe(0);

  const missingTerminateId = await e2e.cli.run(['terminate'], {
    timeoutMs: 5_000,
  });
  expectBounded(missingTerminateId);
  expect(missingTerminateId.exitCode).not.toBe(0);

  const missingImage = await e2e.cli.run(['job'], {
    timeoutMs: 10_000,
    env: { GITHUB_TOKEN: 'dummy-token' },
  });
  expectBounded(missingImage);
  expect(missingImage.exitCode).not.toBe(0);
  expect(missingImage.combined).toContain('Image required');

  const missingProvider = await e2e.cli.run(['credentials', 'new', 'my-cred'], {
    timeoutMs: 10_000,
    env: { GITHUB_TOKEN: 'dummy-token' },
  });
  expectBounded(missingProvider);
  expect(missingProvider.exitCode).not.toBe(0);
  expect(missingProvider.combined.toLowerCase()).toContain('provider');

  const missingComputeTarget = await e2e.cli.run(['job', 'nginx:alpine'], {
    timeoutMs: 10_000,
    env: {
      GITHUB_TOKEN: 'dummy-token',
      AWS_ACCESS_KEY_ID: 'dummy-access-key',
      AWS_SECRET_ACCESS_KEY: 'dummy-secret-key',
    },
  });
  expectBounded(missingComputeTarget);
  expect(missingComputeTarget.exitCode).not.toBe(0);
  expect(missingComputeTarget.combined).toContain(
    'Pass either --vm-type <type> or --gpu-type <type>',
  );
});
