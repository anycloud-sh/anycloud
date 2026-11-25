import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { DockerManager } from '../../../../src/api/services/docker';
import { pullImage } from '../../../../src/api/services/host-runtime/image-delivery';

type ExecFn = DockerManager['exec'];
import {
  CONTAINERD_TRANSFER_CHUNK_BYTES,
  CONTAINERD_TRANSFER_CONCURRENCY,
} from '../../../../src/api/services/containerd-transfer';
import { SSHExecError } from '../../../../src/api/services/gateways/ssh';
import { type StoredWorkload } from '../../../../src/api/services/workload-record.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { makeStoredWorkload } from '../../helpers/fixtures';
import { isUserError } from '../../../../src/shared/error-formatter.js';

// Mock SSH manager to avoid actual SSH connections
vi.mock('../../../../src/api/services/gateways/ssh', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/api/services/gateways/ssh')
    >();
  return {
    ...actual,
    SSHManager: vi.fn().mockImplementation(function () {
      return {
        exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        execStream: vi.fn().mockResolvedValue(0),
        writeFile: vi.fn().mockResolvedValue(undefined),
        ping: vi.fn().mockResolvedValue(true),
      };
    }),
  };
});

// Shrink the detached-pull control-loop timings so the poll loop runs in
// milliseconds instead of its production 15s cadence / 60-min budget.
vi.mock('../../../../src/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/api/config')>()),
  PULL_TOTAL_TIMEOUT_MS: 300,
  PULL_POLL_INTERVAL_MS: 5,
  PULL_CONTROL_TIMEOUT_MS: 1000,
}));

function mockStoredWorkload(
  overrides?: Partial<StoredWorkload>,
): StoredWorkload {
  return makeStoredWorkload({
    id: 'test-workload',
    userId: 'testuser',
    workloadType: 'job',
    image: 'nginx:latest',
    cloudProvider: CloudType.Local,
    region: null,
    vmType: null,
    gpuType: null,
    spot: false,
    state: WorkloadState.Running,
    startedAt: Date.now(),
    completedAt: null,
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    diskSizeGb: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 1,
    sshPrivateKey: 'key',
    credentialId: 'cred-1',
    inputStorageCredentialId: null,
    inputStorageRegion: null,
    outputStorageCredentialId: null,
    outputStorageRegion: null,
    command: null,
    imageDigest: null,
    ...overrides,
  });
}

describe('pullImage timeout captures SSH output', () => {
  let dockerManager: DockerManager;
  let execSpy: Mock<ExecFn>;

  const baseProps = mockStoredWorkload();

  beforeEach(() => {
    vi.useFakeTimers();
    dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
    execSpy = vi.fn<ExecFn>();
    dockerManager.exec = execSpy;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should include SSH output in PullError when exec throws SSHExecError', async () => {
    // First call: df (disk space check)
    execSpy.mockResolvedValueOnce({
      code: 0,
      stdout: 'Filesystem Size',
      stderr: '',
    });
    // Subsequent calls: pull attempts all timeout with partial output
    execSpy.mockRejectedValue(
      new SSHExecError(
        'SSH command timed out after 3600000ms: docker pull',
        'Pulling layer abc123\nDownloading: 50%',
        'WARNING: something',
      ),
    );

    const pullPromise = pullImage(dockerManager, baseProps).catch(
      (e: any) => e,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await pullPromise;

    expect(error.name).toBe('PullError');
    expect(error.pullStdout).toContain('Downloading: 50%');
    expect(error.pullStderr).toContain('WARNING: something');
  });

  it('should prefer last SSHExecError output over earlier attempts', async () => {
    // First call: df
    execSpy.mockResolvedValueOnce({
      code: 0,
      stdout: 'Filesystem Size',
      stderr: '',
    });
    // The Job host pre-pull probe: none on this host.
    execSpy.mockResolvedValueOnce({ code: 0, stdout: 'none\n', stderr: '' });
    // Pull attempts: each timeout with distinguishable output
    for (let i = 1; i <= 5; i++) {
      execSpy.mockRejectedValueOnce(
        new SSHExecError('timeout', `attempt ${i} output`, `attempt ${i} err`),
      );
    }

    const pullPromise = pullImage(dockerManager, baseProps).catch(
      (e: any) => e,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await pullPromise;

    expect(error.name).toBe('PullError');
    expect(error.pullStdout).toBe('attempt 5 output');
    expect(error.pullStderr).toBe('attempt 5 err');
  });
});

describe('pullImage (detached on a remote VM)', () => {
  const REMOTE_HOST = 'vm.example.test';
  const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
  const INDEX_DIGEST = `sha256:${'c'.repeat(64)}`;
  let savedIsTest: string | undefined;

  beforeEach(() => {
    savedIsTest = process.env.IS_TEST;
  });
  afterEach(() => {
    if (savedIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = savedIsTest;
  });

  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  type AuthenticationMockOptions = {
    loginError?: Error;
    loginResult?: ReturnType<typeof ok>;
    authSetupError?: Error;
    authSetupResult?: ReturnType<typeof ok>;
    df?: string;
  };

  function ghcrWorkload(
    githubToken: string | null,
    image = 'ghcr.io/anycloud-sh/private:latest',
  ) {
    return mockStoredWorkload({ image, githubToken, userId: 'octocat' });
  }

  // Dispatch a mocked `exec` by command, returning poll responses in sequence
  // (repeating the last). A poll response of 'THROW' makes that poll throw an
  // SSHExecError — i.e. a mid-pull SSH stream drop.
  function makeExec(
    pollResponses: string[],
    opts: AuthenticationMockOptions & { logTail?: string } = {},
  ) {
    let pollIdx = 0;
    const calls: string[] = [];
    const fn = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('df -h'))
        return ok(opts.df ?? '/dev/root 97G 3G 94G 3% /');
      if (cmd.includes('ps -p 1')) return ok('systemd'); // runDetachedOnVm probe
      if (cmd.includes('docker login')) {
        if (opts.loginError) throw opts.loginError;
        return opts.loginResult ?? ok('Login Succeeded');
      }
      if (cmd.includes('install -d -m 0700 /run/anycloud')) {
        if (opts.authSetupError) throw opts.authSetupError;
        return opts.authSetupResult ?? ok();
      }
      if (cmd.includes('systemd-run')) return ok('');
      if (cmd.includes('tail -c'))
        return ok(opts.logTail ?? 'latest: Pulling from x\n');
      if (cmd.includes('systemctl stop')) return ok('');
      const r = pollResponses[Math.min(pollIdx, pollResponses.length - 1)];
      pollIdx++;
      if (r === 'THROW') {
        throw new SSHExecError(
          'SSH stream closed abnormally before command completed',
          '',
          '',
        );
      }
      return ok(r);
    });
    return { fn, calls };
  }

  function newDocker(execMock: Mock<ExecFn>) {
    const d = new DockerManager(REMOTE_HOST, 'key');
    d.exec = execMock;
    d.execResult = execMock;
    return d;
  }

  it('launches a detached pull and resolves once the sentinel reports success', async () => {
    const { fn, calls } = makeExec(['active', 'active', 'DONE 0']);
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, mockStoredWorkload({ image: 'nginx:latest' })),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
    });

    // Pull ran as a VM-side systemd transient unit, then was polled to completion.
    expect(
      calls.some((c) => c.includes('systemd-run') && c.includes('ac-pull-')),
    ).toBe(true);
    expect(calls.some((c) => c.includes('[ -f') && c.includes('.done'))).toBe(
      true,
    );
  });

  it('pulls the standard image digest by reference, with no tag-back', async () => {
    const { fn, calls } = makeExec(['DONE 0']);
    const docker = newDocker(fn);

    await pullImage(
      docker,
      mockStoredWorkload({
        image: 'nginx:latest',
        imageDigest: IMAGE_DIGEST,
      }),
    );

    const launch = calls.find((c) => c.includes('systemd-run')) ?? '';
    expect(launch).toContain(`docker.io/library/nginx@${IMAGE_DIGEST}`);
    expect(launch).not.toContain('AC_RUN_IMAGE');
    expect(launch).not.toContain('nginx:latest');
  });

  it('pulls digest-pinned image references as submitted', async () => {
    const { fn, calls } = makeExec(['DONE 0']);
    const docker = newDocker(fn);

    await pullImage(
      docker,
      mockStoredWorkload({
        image: `ghcr.io/anycloud-sh/x@${INDEX_DIGEST}`,
        imageDigest: IMAGE_DIGEST,
      }),
    );

    const launch = calls.find((c) => c.includes('systemd-run')) ?? '';
    expect(launch).toContain(`ghcr.io/anycloud-sh/x@${INDEX_DIGEST}`);
    expect(launch).not.toContain(`ghcr.io/anycloud-sh/x@${IMAGE_DIGEST}`);
    expect(launch).not.toContain('--setenv=AC_RUN_IMAGE=');
  });

  it('recovers when a poll hits a transient SSH stream drop mid-pull', async () => {
    // The regression: a poll throws "stream closed abnormally", but the detached
    // pull keeps running VM-side, so the next poll succeeds.
    const { fn } = makeExec(['active', 'THROW', 'DONE 0']);
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, mockStoredWorkload({ image: 'nginx:latest' })),
    ).resolves.toMatchObject({
      method: 'docker',
      outcome: 'succeeded',
    });
  });

  it('throws PullError with a log tail when the pull exits non-zero', async () => {
    const { fn, calls } = makeExec(['DONE 1'], { logTail: 'manifest unknown' });
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, mockStoredWorkload({ image: 'nginx:latest' })),
    ).rejects.toMatchObject({
      name: 'PullError',
      message: expect.stringContaining(
        "Failed to pull image 'nginx:latest' on vm.example.test: exited with code 1",
      ),
      pullStdout: expect.stringContaining('manifest unknown'),
      imagePull: expect.objectContaining({
        schemaVersion: 1,
        method: 'docker',
        outcome: 'failed',
      }),
    });
    // Relaunched up to the cap (cached layers are skipped on relaunch).
    expect(calls.filter((c) => c.includes('systemd-run')).length).toBe(3);
  });

  // The VQ-3 Azure GPU docker pull: 144 s to the last byte of 321 s.
  const PULL_STATS =
    'AC_PULL_STATS bytes=9830000000 last_byte_ms=144000 elapsed_ms=321000\n';
  const PULL_TIMING = {
    bytesFetched: 9_830_000_000,
    timeToLastByteMs: 144_000,
    unpackTailMs: 177_000,
  };

  it('records the bytes, time to last byte and unpack tail of a Docker pull', async () => {
    const { fn, calls } = makeExec(['DONE 0'], {
      logTail: `latest: Pulling from x\n${PULL_STATS}`,
    });

    await expect(
      pullImage(newDocker(fn), mockStoredWorkload({ image: 'nginx:latest' })),
    ).resolves.toMatchObject({ method: 'docker', ...PULL_TIMING });
    const launch = calls.find((c) => c.includes('systemd-run')) ?? '';
    expect(launch).toContain('AC_PULL_STATS');
  });

  it('keeps pull timing on a failed pull and out of its Docker output', async () => {
    const { fn } = makeExec(['DONE 1'], {
      logTail: `manifest unknown\n${PULL_STATS}`,
    });

    const error = await pullImage(
      newDocker(fn),
      mockStoredWorkload({ image: 'nginx:latest' }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'PullError',
      imagePull: { outcome: 'failed', ...PULL_TIMING },
    });
    expect((error as { pullStdout: string }).pullStdout).toBe(
      'manifest unknown\n',
    );
  });

  it('throws PullError and stops the unit if the pull never finishes within budget', async () => {
    const { fn, calls } = makeExec(['active']); // never completes
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, mockStoredWorkload({ image: 'nginx:latest' })),
    ).rejects.toMatchObject({ name: 'PullError' });
    // The runaway unit was stopped (a standalone stop, not the stop baked into launch).
    expect(
      calls.some(
        (c) => c.includes('systemctl stop') && !c.includes('systemd-run'),
      ),
    ).toBe(true);
  });

  it('keeps the GHCR token on the login exec only — never in the detached unit', async () => {
    delete process.env.IS_TEST; // enable the real private-registry auth path
    const TOKEN = 'ghp_super_secret_token';
    const { fn, calls } = makeExec(['DONE 0']);
    const docker = newDocker(fn);

    await pullImage(
      docker,
      ghcrWorkload(TOKEN, 'ghcr.io/anycloud-sh/x:latest'),
    );

    const login = calls.find((c) => c.includes('docker login'));
    expect(login).toContain(TOKEN); // token authenticates here…
    // …but never reaches the detached unit's argv (journal / `ps`), nor anywhere else.
    for (const c of calls) {
      if (!c.includes('docker login')) expect(c).not.toContain(TOKEN);
    }
  });

  it('skips GHCR authentication when no token is present', async () => {
    delete process.env.IS_TEST;
    const { fn, calls } = makeExec(['DONE 0']);
    const docker = newDocker(fn);

    await expect(
      pullImage(
        docker,
        ghcrWorkload(null, 'ghcr.io/anycloud-sh/public:latest'),
      ),
    ).resolves.toMatchObject({ method: 'docker', outcome: 'succeeded' });

    expect(calls.some((cmd) => cmd.includes('docker login'))).toBe(false);
  });

  it('attaches Docker pull telemetry when private GHCR authentication fails', async () => {
    delete process.env.IS_TEST;
    const token = 'ghp_expired_secret_token';
    const { fn, calls } = makeExec(['DONE 0'], {
      loginResult: { code: 1, stdout: '', stderr: 'denied: invalid token' },
    });
    const docker = newDocker(fn);

    const error = await pullImage(docker, ghcrWorkload(token)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: 'PullError',
      pullStderr: 'denied: invalid token',
      imagePull: {
        schemaVersion: 1,
        method: 'docker',
        outcome: 'failed',
        reason: 'registry_auth',
      },
    });
    expect(calls.some((cmd) => cmd.includes('systemd-run'))).toBe(false);
    expect(
      JSON.stringify({ message: (error as Error).message, error }),
    ).not.toContain(token);
  });

  it('classifies a GHCR login that exits 124 as a timeout', async () => {
    delete process.env.IS_TEST;
    const { fn } = makeExec(['DONE 0'], {
      loginResult: { code: 124, stdout: '', stderr: '' },
    });

    await expect(
      pullImage(newDocker(fn), ghcrWorkload('ghp_slow_login_token')),
    ).rejects.toMatchObject({ imagePull: { reason: 'timeout' } });
  });

  it('reports Docker availability failures as auth setup failures', async () => {
    delete process.env.IS_TEST;
    const { fn, calls } = makeExec(['DONE 0'], {
      loginResult: {
        code: 1,
        stdout: '',
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      },
    });
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, ghcrWorkload('ghp_valid_but_docker_is_unavailable')),
    ).rejects.toMatchObject({
      name: 'PullError',
      pullStderr: expect.stringContaining(
        'Cannot connect to the Docker daemon',
      ),
      imagePull: {
        schemaVersion: 1,
        method: 'docker',
        outcome: 'failed',
        reason: 'auth_setup_failed',
      },
    });
    expect(calls.some((cmd) => cmd.includes('systemd-run'))).toBe(false);
  });

  it.each([
    {
      label: 'SSH stream drop',
      failure: new SSHExecError(
        'SSH stream closed abnormally before command completed',
        '',
        'connection reset',
      ),
      reason: 'transport_error',
    },
    {
      label: 'SSH command timeout',
      failure: new SSHExecError(
        'SSH command timed out after 1000ms',
        'ghp_transport_failure_secret_token',
        'ghp_transport_failure_secret_token',
      ),
      reason: 'timeout',
    },
  ])('retries and classifies a $label during GHCR login', async (testCase) => {
    vi.useFakeTimers();
    try {
      delete process.env.IS_TEST;
      const token = 'ghp_transport_failure_secret_token';
      const { fn, calls } = makeExec(['DONE 0'], {
        loginError: testCase.failure,
      });
      const docker = newDocker(fn);

      const pending = pullImage(docker, ghcrWorkload(token)).catch(
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await pending;

      expect(error).toMatchObject({
        name: 'PullError',
        imagePull: {
          schemaVersion: 1,
          method: 'docker',
          outcome: 'failed',
          reason: testCase.reason,
        },
      });
      expect(calls.filter((cmd) => cmd.includes('docker login'))).toHaveLength(
        4,
      );
      expect(JSON.stringify(error)).not.toContain(token);
    } finally {
      vi.useRealTimers();
    }
  });

  function makeSupportedTransferExec(
    transferExitCode = 0,
    opts: AuthenticationMockOptions & { transferLogTail?: string } = {},
  ) {
    const calls: string[] = [];
    const fn = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('df -h'))
        return ok(opts.df ?? '/dev/root 97G 3G 94G 3% /');
      if (cmd === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (cmd.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (cmd.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      if (cmd.startsWith('containerd --config')) {
        return ok(`version = 3

[plugins."io.containerd.transfer.v1.local"]
  max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}
  concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}
`);
      }
      if (cmd.startsWith("cat '/etc/docker/daemon.json'")) return ok('{}\n');
      if (cmd.startsWith("docker info --format '{{.Driver}}'")) {
        return ok(
          'overlayfs\n[["driver-type","io.containerd.snapshotter.v1"]]\n',
        );
      }
      if (cmd.includes('docker login')) {
        if (opts.loginError) throw opts.loginError;
        return opts.loginResult ?? ok('Login Succeeded');
      }
      if (cmd.includes('install -d -m 0700 /run/anycloud')) {
        if (opts.authSetupError) throw opts.authSetupError;
        return opts.authSetupResult ?? ok();
      }
      if (cmd.includes('ps -p 1')) return ok('systemd');
      if (cmd.includes('systemd-run')) return ok();
      if (cmd.includes('tail -c')) {
        return ok(
          opts.transferLogTail ??
            (transferExitCode === 0 ? 'transfer complete' : '429 denied'),
        );
      }
      if (cmd.includes('/tmp/ac-transfer-') && cmd.includes('[ -f')) {
        return ok(`DONE ${transferExitCode}`);
      }
      if (cmd.includes('/tmp/ac-pull-') && cmd.includes('[ -f')) {
        return ok('DONE 0');
      }
      if (cmd.includes('systemctl stop')) return ok();
      return ok();
    });
    return { fn, calls };
  }

  it('uses containerd transfer on a qualified GPU runtime', async () => {
    const { fn, calls } = makeSupportedTransferExec();
    const docker = newDocker(fn);

    await expect(
      pullImage(
        docker,
        mockStoredWorkload({ image: 'docker.io/library/nginx:latest' }),
        { preferContainerdTransfer: true },
      ),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      method: 'containerd-transfer',
      outcome: 'succeeded',
      containerdVersion: '2.2.1',
      snapshotter: 'overlayfs',
    });

    const launches = calls.filter((cmd) => cmd.includes('systemd-run'));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('ac-transfer-test-workload');
    expect(launches[0]).toContain(
      "--setenv=AC_CONTAINERD_ADDRESS='/run/containerd/containerd.sock'",
    );
    expect(launches[0]).toContain("--setenv=AC_CONTAINERD_NAMESPACE='moby'");
    expect(launches[0]).toContain("--setenv=AC_SNAPSHOTTER='overlayfs'");
    expect(launches[0]).toContain('docker image inspect');
    expect(launches[0]).not.toContain('docker pull');
  });

  it('records the bytes, time to last byte and unpack tail of a transfer', async () => {
    const { fn, calls } = makeSupportedTransferExec(0, {
      transferLogTail: `transfer complete\n${PULL_STATS}`,
    });

    await expect(
      pullImage(
        newDocker(fn),
        mockStoredWorkload({ image: 'docker.io/library/nginx:latest' }),
        { preferContainerdTransfer: true },
      ),
    ).resolves.toMatchObject({ method: 'containerd-transfer', ...PULL_TIMING });
    const launch = calls.find((c) => c.includes('systemd-run')) ?? '';
    expect(launch).toContain('AC_PULL_STATS');
  });

  it('falls back to the ordinary Docker pull when transfer fails', async () => {
    const { fn, calls } = makeSupportedTransferExec(1);
    const docker = newDocker(fn);

    await expect(
      pullImage(
        docker,
        mockStoredWorkload({ image: 'docker.io/library/nginx:latest' }),
        { preferContainerdTransfer: true },
      ),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      method: 'docker-fallback',
      outcome: 'succeeded',
      reason: 'registry_throttled',
    });

    const launches = calls.filter((cmd) => cmd.includes('systemd-run'));
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain('ac-transfer-test-workload');
    expect(launches[1]).toContain('ac-pull-test-workload');
    expect(launches[1]).toContain('docker pull --platform "linux/$$(uname -m');
  });

  it.each([
    ['401 Unauthorized', 'registry_auth'],
    ['context deadline: request timed out', 'timeout'],
    ['unexpected EOF reading layer', 'transfer_failed'],
  ])(
    'classifies a transfer failure logging "%s" as %s',
    async (transferLogTail, reason) => {
      const { fn } = makeSupportedTransferExec(1, { transferLogTail });

      await expect(
        pullImage(
          newDocker(fn),
          mockStoredWorkload({ image: 'docker.io/library/nginx:latest' }),
          { preferContainerdTransfer: true },
        ),
      ).resolves.toMatchObject({ method: 'docker-fallback', reason });
    },
  );

  it('reports Docker success when the requested transfer runtime is unavailable', async () => {
    const { fn } = makeExec(['not installed', 'DONE 0']);
    const docker = newDocker(fn);

    await expect(
      pullImage(
        docker,
        mockStoredWorkload({ image: 'docker.io/library/nginx:latest' }),
        { preferContainerdTransfer: true },
      ),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      reason: 'containerd_missing',
    });
  });

  it('uses containerd transfer for a digest-pinned image', async () => {
    const { fn, calls } = makeSupportedTransferExec();
    const docker = newDocker(fn);

    await pullImage(
      docker,
      mockStoredWorkload({
        image: 'ghcr.io/anycloud-sh/x:latest',
        imageDigest: IMAGE_DIGEST,
      }),
      { preferContainerdTransfer: true },
    );

    expect(calls).toContain('containerd --version');
    const launch = calls.find((cmd) => cmd.includes('systemd-run')) ?? '';
    expect(launch).toContain('ac-transfer-test-workload');
    expect(launch).toContain(`ghcr.io/anycloud-sh/x@${IMAGE_DIGEST}`);
  });

  it('does not place private GHCR credentials in the transfer unit', async () => {
    delete process.env.IS_TEST;
    const token = 'ghp_transfer_secret_token';
    const { fn, calls } = makeSupportedTransferExec();
    const docker = newDocker(fn);

    await pullImage(
      docker,
      ghcrWorkload(token, 'ghcr.io/anycloud-sh/x:latest'),
      { preferContainerdTransfer: true },
    );

    const login = calls.find((cmd) => cmd.includes('docker login')) ?? '';
    const authSetup = calls.find((cmd) => cmd.includes('base64 -d >')) ?? '';
    const launch = calls.find((cmd) => cmd.includes('systemd-run')) ?? '';
    expect(login).toContain(token);
    expect(login).not.toContain('/run/anycloud/registry-auth-test-workload');
    expect(authSetup).toContain('/run/anycloud/registry-auth-test-workload');
    expect(authSetup).not.toContain(token);
    expect(launch).toContain(
      "--setenv=AC_REGISTRY_AUTH_FILE='/run/anycloud/registry-auth-test-workload'",
    );
    expect(launch).not.toContain(token);
  });

  it('attaches transfer telemetry when private GHCR authentication fails', async () => {
    delete process.env.IS_TEST;
    const { fn, calls } = makeSupportedTransferExec(0, {
      loginResult: {
        code: 1,
        stdout: '',
        stderr: 'unauthorized: bad credentials',
      },
    });
    const docker = newDocker(fn);

    await expect(
      pullImage(docker, ghcrWorkload('ghp_expired_transfer_token'), {
        preferContainerdTransfer: true,
      }),
    ).rejects.toMatchObject({
      name: 'PullError',
      imagePull: {
        schemaVersion: 1,
        method: 'containerd-transfer',
        outcome: 'failed',
        reason: 'registry_auth',
      },
    });
    expect(calls.some((cmd) => cmd.includes('systemd-run'))).toBe(false);
  });

  it('pulls with Docker when the transfer auth file fails', async () => {
    delete process.env.IS_TEST;
    const token = 'ghp_transfer_auth_setup_secret';
    const { fn, calls } = makeSupportedTransferExec(0, {
      authSetupResult: {
        code: 1,
        stdout: '',
        stderr: 'chmod: operation not permitted',
      },
    });

    await expect(
      pullImage(newDocker(fn), ghcrWorkload(token), {
        preferContainerdTransfer: true,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      method: 'docker-fallback',
      outcome: 'succeeded',
      reason: 'auth_setup_failed',
      containerdVersion: '2.2.1',
    });
    const launches = calls.filter((cmd) => cmd.includes('systemd-run'));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('ac-pull-test-workload');
    expect(calls).toContain(
      "rm -f '/run/anycloud/registry-auth-test-workload'",
    );
    expect(launches[0]).not.toContain(token);
  });

  it('fails a GHCR login on a full root disk as invalid', async () => {
    delete process.env.IS_TEST;
    const { fn, calls } = makeSupportedTransferExec(0, {
      df: 'Filesystem Size Used Avail Use% Mounted on\n/dev/root 193G 193G 0 100% /',
      loginResult: {
        code: 1,
        stdout: '',
        stderr:
          'Error saving credentials: write /root/.docker/config.json: no space left on device',
      },
    });

    const error = await pullImage(
      newDocker(fn),
      ghcrWorkload('ghp_full_disk_token'),
      { preferContainerdTransfer: true },
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: 'PullError',
      message:
        "Failed to prepare registry authentication for image 'ghcr.io/anycloud-sh/private:latest' on vm.example.test: the VM's root disk is full (193G); increase `--disk-size`",
      imagePull: { outcome: 'failed', reason: 'auth_setup_failed' },
    });
    expect(isUserError(error)).toBe(true);
    expect(calls.some((cmd) => cmd.includes('systemd-run'))).toBe(false);
  });

  it('fails a Docker pull out of disk space as invalid', async () => {
    const { fn } = makeExec(['DONE 1'], {
      df: '',
      logTail:
        'failed to register layer: write /var/lib/docker/x: no space left on device',
    });

    const error = await pullImage(newDocker(fn), mockStoredWorkload()).catch(
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toBe(
      "Failed to pull image 'nginx:latest' on vm.example.test: the VM's root disk is full; increase `--disk-size` (exited with code 1)",
    );
    expect(isUserError(error)).toBe(true);
  });

  it("fails a pull of an image without the host's architecture as invalid", async () => {
    const { fn } = makeExec(['DONE 1'], {
      df: '',
      logTail: 'no match for platform in manifest: not found',
    });

    const error = await pullImage(
      newDocker(fn),
      mockStoredWorkload({
        cloudProvider: CloudType.AWS,
        vmType: 'm8g.xlarge',
      }),
    ).catch((cause: unknown) => cause);

    expect((error as Error).message).toContain(
      "Failed to pull image 'nginx:latest' on vm.example.test: nginx:latest has no linux/arm64 build",
    );
    expect(isUserError(error)).toBe(true);
  });

  it.each([
    ['free space', '/dev/root 97G 3G 94G 3% /', false],
    ['100% use with 1.9G free', '/dev/root 193G 191G 1.9G 100% /', false],
    ['no space free', '/dev/root 193G 193G 0 100% /', true],
    ['512K free', '/dev/root 193G 193G 512K 100% /', true],
    ['1.0M free', '/dev/root 193G 193G 1.0M 100% /', false],
  ])('classifies a GHCR login outage with %s', async (_, df, full) => {
    delete process.env.IS_TEST;
    const { fn } = makeExec(['DONE 0'], {
      df,
      loginResult: {
        code: 1,
        stdout: '',
        stderr:
          'Error response from daemon: login attempt to https://ghcr.io/v2/ failed with status: 503 Service Unavailable',
      },
    });

    const error = await pullImage(
      newDocker(fn),
      ghcrWorkload('ghp_registry_outage_token'),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ imagePull: { reason: 'auth_setup_failed' } });
    expect(isUserError(error)).toBe(full);
  });
});
