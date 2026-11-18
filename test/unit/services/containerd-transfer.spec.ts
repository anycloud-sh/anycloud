import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINERD_TRANSFER_CHUNK_BYTES,
  containerdImageReference,
  CONTAINERD_TRANSFER_CONCURRENCY,
  CONTAINERD_TRANSFER_MAX_ATTEMPTS,
  CONTAINERD_TRANSFER_PULL_COMMAND,
  CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS,
  configureContainerdTransferStore,
  detectContainerdTransferRuntime,
  ghcrLoginCommand,
  hasExpectedContainerdTransferConfig,
  parseContainerdVersion,
  transferAuthFileCommand,
  transferAuthFilePath,
  versionAtLeast,
  withContainerdTransferConfig,
  withDockerContainerdImageStore,
} from '../../../src/api/services/containerd-transfer';
import { log } from '../../../src/api/services/logger';

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

describe('containerd transfer runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recognizes the containerd 2.1 transfer-service boundary', () => {
    expect(versionAtLeast('2.1.0', '2.1.0')).toBe(true);
    expect(versionAtLeast('v2.2.1', '2.1.0')).toBe(true);
    expect(versionAtLeast('3.0.0-rc.1', '2.1.0')).toBe(true);
    expect(versionAtLeast('2.0.9', '2.1.0')).toBe(false);
    expect(versionAtLeast('1.7.27', '2.1.0')).toBe(false);
    expect(versionAtLeast('unknown', '2.1.0')).toBe(false);
  });

  it('parses both Lambda and Azure containerd version strings', () => {
    expect(
      parseContainerdVersion(
        'containerd containerd.io v2.2.1 dea7da592f5d1d2b7755e3a161be07f43fad8f75',
      ),
    ).toBe('2.2.1');
    expect(
      parseContainerdVersion(
        'containerd github.com/containerd/containerd/v2 v2.2.4 1a2b3c',
      ),
    ).toBe('2.2.4');
    expect(parseContainerdVersion('not installed')).toBeNull();
  });

  it('qualifies a reference for ctr', () => {
    expect(containerdImageReference('ubuntu')).toBe(
      'docker.io/library/ubuntu:latest',
    );
    expect(containerdImageReference('acme/x:1')).toBe('docker.io/acme/x:1');
    const pinned = `ghcr.io/acme/x@sha256:${'a'.repeat(64)}`;
    expect(containerdImageReference(pinned)).toBe(pinned);
  });

  it('adds transfer controls without disturbing unrelated containerd config', () => {
    const source = `version = 3

[plugins.'io.containerd.snapshotter.v1.overlayfs']
  root_path = ''
`;
    const configured = withContainerdTransferConfig(source);

    expect(configured).toContain(source.trimEnd());
    expect(configured).toContain('[plugins."io.containerd.transfer.v1.local"]');
    expect(configured).toContain(
      `max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}`,
    );
    expect(configured).toContain(
      `concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}`,
    );
    expect(hasExpectedContainerdTransferConfig(configured)).toBe(true);
    expect(withContainerdTransferConfig(configured)).toBe(configured);
  });

  it('sets extra transfer controls only when asked', () => {
    const configured = withContainerdTransferConfig('version = 3\n', {
      max_concurrent_unpacks: 4,
    });
    expect(configured).toContain('  max_concurrent_unpacks = 4\n');
    expect(configured).toContain(
      `max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}`,
    );
    expect(withContainerdTransferConfig('version = 3\n')).not.toContain(
      'max_concurrent_unpacks',
    );
  });

  it('recognizes the configured values in config dump formatting', () => {
    const dump = (buffer: number) => `version = 3

[plugins]
    [plugins.'io.containerd.transfer.v1.local']
      config_path = ''
      max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}
      concurrent_layer_fetch_buffer = ${buffer}
      max_concurrent_uploaded_layers = 3

      [[plugins.'io.containerd.transfer.v1.local'.unpack_config]]
        concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}
`;

    expect(
      hasExpectedContainerdTransferConfig(
        dump(CONTAINERD_TRANSFER_CHUNK_BYTES),
      ),
    ).toBe(true);
    expect(hasExpectedContainerdTransferConfig(dump(0))).toBe(false);
    expect(hasExpectedContainerdTransferConfig('version = 3\n')).toBe(false);
  });

  it('updates either quoted transfer table in place and is idempotent', () => {
    const source = `version = 2

[plugins.'io.containerd.transfer.v1.local']
  max_concurrent_downloads = 8
  concurrent_layer_fetch_buffer = 33554432

[timeouts]
  'io.containerd.timeout.shim.cleanup' = '5s'
`;
    const configured = withContainerdTransferConfig(source);

    expect(
      configured.match(/io\.containerd\.transfer\.v1\.local/g),
    ).toHaveLength(1);
    expect(configured).toContain(
      `max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}`,
    );
    expect(configured).toContain(
      `concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}`,
    );
    expect(configured).toContain('[timeouts]');
    expect(withContainerdTransferConfig(configured)).toBe(configured);
  });

  it('enables Docker containerd storage while preserving unrelated settings', () => {
    const configured = JSON.parse(
      withDockerContainerdImageStore(
        JSON.stringify({
          log: { level: 'info' },
          features: { cdi: true },
          runtimes: {
            nvidia: {
              path: 'nvidia-container-runtime',
              runtimeArgs: [],
            },
          },
          'storage-driver': 'overlay2',
        }),
      ),
    );

    expect(configured).toEqual({
      log: { level: 'info' },
      features: { cdi: true, 'containerd-snapshotter': true },
      runtimes: {
        nvidia: {
          path: 'nvidia-container-runtime',
          runtimeArgs: [],
        },
      },
    });
  });

  it('refuses Docker configs that cannot be migrated safely', () => {
    expect(() => withDockerContainerdImageStore('{')).toThrow('invalid JSON');
    expect(() =>
      withDockerContainerdImageStore(
        JSON.stringify({ 'storage-driver': 'devicemapper' }),
      ),
    ).toThrow('not migratable');
  });

  it('reports pre-2.1 hosts as unsupported without probing further', async () => {
    const exec = vi.fn(async () =>
      ok('containerd github.com/containerd/containerd 1.7.27 abcdef'),
    );

    await expect(detectContainerdTransferRuntime(exec)).resolves.toEqual({
      supported: false,
      reason: 'containerd_1.7.27_lt_2.1',
      containerdVersion: '1.7.27',
    });
    // Version gate short-circuits: no runtime probe, no config or restart.
    expect(exec).toHaveBeenCalledOnce();
  });

  it('fails init immediately on an unsupported containerd version', async () => {
    const exec = vi.fn(async () =>
      ok('containerd github.com/containerd/containerd 1.7.27 abcdef'),
    );

    await configureContainerdTransferStore(exec, {
      id: 'job-unsupported',
      ip: 'ip',
    });

    expect(exec).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      'containerd transfer store unavailable; pull will use Docker',
      expect.objectContaining({
        id: 'job-unsupported',
        reason: 'containerd_1.7.27_lt_2.1',
      }),
    );
  });

  it('detects a ready store when Docker is on the containerd image store', async () => {
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        return ok(
          'overlayfs\n[["driver-type","io.containerd.snapshotter.v1"]]\n',
        );
      }
      return ok();
    });

    await expect(detectContainerdTransferRuntime(exec)).resolves.toEqual({
      supported: true,
      reason: 'ready',
      containerdVersion: '2.2.1',
      address: '/run/containerd/containerd.sock',
      namespace: 'moby',
      snapshotter: 'overlayfs',
    });
    // Detection is read-only — the store is configured at init, not here.
    expect(
      calls.some(
        (command) =>
          command.includes('anycloud-transfer-bak') ||
          command.includes('anycloud-tmp') ||
          command.includes('systemctl restart'),
      ),
    ).toBe(false);
  });

  it('configures the transfer store against the system containerd at init', async () => {
    const calls: string[] = [];
    let storeReads = 0;
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      if (command.startsWith('containerd --config')) {
        return ok(`version = 3

[plugins.'io.containerd.transfer.v1.local']
  max_concurrent_downloads = 3
  concurrent_layer_fetch_buffer = 0
`);
      }
      if (command.startsWith("cat '/etc/docker/daemon.json'")) {
        return ok('{"log-level":"info","storage-driver":"overlay2"}\n');
      }
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        storeReads++;
        return storeReads === 1
          ? ok('overlay2\n[]\n')
          : ok('overlayfs\n[["driver-type","io.containerd.snapshotter.v1"]]\n');
      }
      return ok();
    });

    await expect(
      configureContainerdTransferStore(exec, { id: 'job-1', ip: 'ip' }),
    ).resolves.toBeUndefined();
    expect(
      calls.some((command) => command.includes('anycloud-transfer-bak')),
    ).toBe(true);
    expect(
      calls.some(
        (command) =>
          command.includes('anycloud-transfer-missing') &&
          command.includes('zz-anycloud-containerd-store.conf.anycloud-bak'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (command) =>
          command.includes(
            `max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}`,
          ) &&
          command.includes(
            `concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}`,
          ),
      ),
    ).toBe(true);
    expect(
      calls.some((command) =>
        command.includes('"containerd-snapshotter":true'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (command) =>
          command.includes('systemctl restart containerd') &&
          command.includes('systemctl restart docker'),
      ),
    ).toBe(true);
  });

  it('falls back after one failed readiness check without mutating', async () => {
    const calls: string[] = [];
    let runtimeReads = 0;
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        runtimeReads++;
        throw new Error('runtime unavailable');
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await configureContainerdTransferStore(exec, {
      id: 'job-unavailable',
      ip: 'ip',
    });

    expect(runtimeReads).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      'containerd transfer store unavailable; pull will use Docker',
      expect.objectContaining({
        id: 'job-unavailable',
        reason: 'docker_not_wired_to_configurable_system_containerd',
        readinessCheckMs: expect.any(Number),
      }),
    );
    expect(
      calls.some(
        (command) =>
          command.includes('anycloud-transfer-bak') ||
          command.includes('anycloud-tmp') ||
          command.includes('systemctl restart'),
      ),
    ).toBe(false);
  });

  it('leaves an invalid host Docker configuration untouched', async () => {
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      if (command.startsWith('containerd --config')) return ok('version = 3\n');
      if (command.startsWith("cat '/etc/docker/daemon.json'")) {
        return ok('{ invalid json\n');
      }
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        return ok('overlay2\n[]\n');
      }
      return ok();
    });

    await expect(
      configureContainerdTransferStore(exec, { id: 'job-1', ip: 'ip' }),
    ).resolves.toBeUndefined();
    expect(calls.some((command) => command.includes('anycloud-tmp'))).toBe(
      false,
    );
    expect(calls.some((command) => command.includes('systemctl restart'))).toBe(
      false,
    );
  });

  it('is a no-op when the transfer store is already fully configured', async () => {
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      // The containerd config already carries the canonical transfer controls.
      if (command.startsWith('containerd --config')) {
        return ok(`version = 3

[plugins."io.containerd.transfer.v1.local"]
  max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}
  concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}
`);
      }
      if (command.startsWith("cat '/etc/docker/daemon.json'"))
        return ok('{}\n');
      // Docker already proves it is on the containerd image store.
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        return ok(
          'overlayfs\n[["driver-type","io.containerd.snapshotter.v1"]]\n',
        );
      }
      return ok();
    });

    await expect(
      configureContainerdTransferStore(exec, { id: 'job-1', ip: 'ip' }),
    ).resolves.toBeUndefined();
    // Idempotent re-init: no daemon.json rewrite, no config write, no restart.
    expect(calls.some((command) => command.includes('anycloud-tmp'))).toBe(
      false,
    );
    expect(
      calls.some((command) => command.includes('containerd-snapshotter')),
    ).toBe(false);
    expect(calls.some((command) => command.includes('systemctl restart'))).toBe(
      false,
    );
    expect(
      calls.some((command) => command.includes('anycloud-transfer-bak')),
    ).toBe(false);
  });

  it('restores Docker when the store-enabling restart fails', async () => {
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        return ok('io.containerd.transfer.v1 local linux/amd64 ok\n');
      }
      if (command.startsWith('containerd --config')) return ok('version = 3\n');
      if (command.startsWith("cat '/etc/docker/daemon.json'"))
        return ok('{}\n');
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        return ok('overlayfs\n[]\n');
      }
      // The store-enabling restart fails: the new config keeps Docker from
      // coming up. (Backup/restore blocks start with `set +e`, not `set -e`.)
      if (
        command.startsWith('set -e') &&
        command.includes('systemctl restart docker')
      ) {
        throw new Error('docker failed to restart');
      }
      return ok();
    });

    // Best-effort: resolves (void) even though the restart failed.
    await expect(
      configureContainerdTransferStore(exec, { id: 'job-1', ip: 'ip' }),
    ).resolves.toBeUndefined();
    // The restore block reinstated all three prior files and restarted Docker.
    expect(
      calls.some(
        (command) =>
          command.startsWith('set +e') &&
          command.includes('cp -f') &&
          command.includes('anycloud-transfer-bak') &&
          command.includes('anycloud-transfer-missing') &&
          command.includes('zz-anycloud-containerd-store.conf.anycloud-bak') &&
          command.includes(
            'zz-anycloud-containerd-store.conf.anycloud-missing',
          ) &&
          command.includes('systemctl restart docker'),
      ),
    ).toBe(true);
  });

  it('rolls back when post-restart verification fails', async () => {
    const calls: string[] = [];
    let pluginReads = 0;
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (command === 'containerd --version') {
        return ok('containerd containerd.io v2.2.1 deadbeef');
      }
      if (command.includes('dockerd_pid=$(systemctl show')) {
        return ok(
          '/run/containerd/containerd.sock\nmoby\n/etc/containerd/config.toml\n',
        );
      }
      if (command.startsWith('ctr --address')) {
        pluginReads++;
        return pluginReads === 1
          ? ok('io.containerd.transfer.v1 local linux/amd64 ok\n')
          : ok('io.containerd.transfer.v1 local linux/amd64 error\n');
      }
      if (command.startsWith('containerd --config')) return ok('version = 3\n');
      if (command.startsWith("cat '/etc/docker/daemon.json'"))
        return ok('{}\n');
      if (command.startsWith("docker info --format '{{.Driver}}'")) {
        return ok('overlayfs\n[]\n');
      }
      return ok();
    });

    await expect(
      configureContainerdTransferStore(exec, { id: 'job-1', ip: 'ip' }),
    ).resolves.toBeUndefined();
    expect(pluginReads).toBe(2);
    expect(
      calls.some(
        (command) =>
          command.startsWith('set +e') &&
          command.includes('cp -f') &&
          command.includes('systemctl restart containerd'),
      ),
    ).toBe(true);
  });

  it('keeps long-lived GHCR credentials out of the detached worker', () => {
    const token = 'ghp_transfer_secret';
    const authPath = transferAuthFilePath('deploy/unsafe id');
    const login = ghcrLoginCommand(
      'octocat',
      token,
      '/run/anycloud/docker-config-x',
    );
    const authSetup = transferAuthFileCommand('octocat', token, authPath);

    expect(authPath).toBe('/run/anycloud/registry-auth-deploy_unsafe_id');
    expect(login).toContain(token);
    expect(login).not.toContain(authPath);
    expect(authSetup).toContain(authPath);
    expect(authSetup).toContain('chmod 0600');
    expect(authSetup).not.toContain(token);
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).not.toContain(token);
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain('--hosts-dir');
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain('docker image inspect');
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain(
      `[ "$pull_attempt" -lt ${CONTAINERD_TRANSFER_MAX_ATTEMPTS} ]`,
    );
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain(
      `sleep ${CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS}`,
    );
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain(
      'registry-throttled; falling back without retry',
    );
    expect(CONTAINERD_TRANSFER_PULL_COMMAND).toContain(
      'trap cleanup_transfer_auth EXIT HUP INT TERM',
    );
  });

  it('retries a transient ctr failure inside the detached worker', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'anycloud-transfer-retry-'));
    const counterPath = join(fixtureDir, 'ctr-count');
    try {
      const ctrPath = join(fixtureDir, 'ctr');
      writeFileSync(
        ctrPath,
        `#!/bin/sh
count=0
[ ! -f "$AC_TEST_CTR_COUNT" ] || count=$(cat "$AC_TEST_CTR_COUNT")
count=$((count + 1))
printf '%s\n' "$count" > "$AC_TEST_CTR_COUNT"
[ "$count" -ge 2 ]
`,
      );
      chmodSync(ctrPath, 0o755);
      for (const command of ['docker', 'sleep']) {
        const commandPath = join(fixtureDir, command);
        writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');
        chmodSync(commandPath, 0o755);
      }

      const result = spawnSync(
        '/bin/sh',
        ['-c', CONTAINERD_TRANSFER_PULL_COMMAND],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fixtureDir}:${process.env.PATH ?? ''}`,
            AC_TEST_CTR_COUNT: counterPath,
            AC_PULL_IMAGE: 'ghcr.io/anycloud-sh/mace@sha256:fixture',
            AC_CONTAINERD_ADDRESS: '/run/containerd/containerd.sock',
            AC_CONTAINERD_NAMESPACE: 'moby',
            AC_SNAPSHOTTER: 'overlayfs',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(counterPath, 'utf8')).toBe('2\n');
      expect(result.stderr).toContain(
        `retrying in ${CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS}s (attempt 2/${CONTAINERD_TRANSFER_MAX_ATTEMPTS})`,
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('falls back without retrying a registry-throttled transfer', () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), 'anycloud-transfer-throttle-'),
    );
    const counterPath = join(fixtureDir, 'ctr-count');
    const sleepPath = join(fixtureDir, 'sleep-called');
    try {
      const ctrPath = join(fixtureDir, 'ctr');
      writeFileSync(
        ctrPath,
        `#!/bin/sh
count=0
[ ! -f "$AC_TEST_CTR_COUNT" ] || count=$(cat "$AC_TEST_CTR_COUNT")
count=$((count + 1))
printf '%s\n' "$count" > "$AC_TEST_CTR_COUNT"
printf '%s\n' 'ctr: unexpected status: 429 Too Many Requests' >&2
exit 1
`,
      );
      chmodSync(ctrPath, 0o755);
      const dockerPath = join(fixtureDir, 'docker');
      writeFileSync(dockerPath, '#!/bin/sh\nexit 0\n');
      chmodSync(dockerPath, 0o755);
      const sleepCommandPath = join(fixtureDir, 'sleep');
      writeFileSync(
        sleepCommandPath,
        '#!/bin/sh\nprintf called > "$AC_TEST_SLEEP_CALLED"\n',
      );
      chmodSync(sleepCommandPath, 0o755);

      const result = spawnSync(
        '/bin/sh',
        ['-c', CONTAINERD_TRANSFER_PULL_COMMAND],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fixtureDir}:${process.env.PATH ?? ''}`,
            AC_TEST_CTR_COUNT: counterPath,
            AC_TEST_SLEEP_CALLED: sleepPath,
            AC_PULL_IMAGE: 'ghcr.io/anycloud-sh/mace@sha256:fixture',
            AC_CONTAINERD_ADDRESS: '/run/containerd/containerd.sock',
            AC_CONTAINERD_NAMESPACE: 'moby',
            AC_SNAPSHOTTER: 'overlayfs',
          },
        },
      );

      expect(result.status).toBe(1);
      expect(readFileSync(counterPath, 'utf8')).toBe('1\n');
      expect(existsSync(sleepPath)).toBe(false);
      expect(result.stderr).toContain(
        'registry-throttled; falling back without retry',
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('pulls a logged-in GHCR image with a scoped bearer', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'anycloud-transfer-auth-'));
    try {
      const stub = (name: string, body: string) => {
        writeFileSync(join(fixtureDir, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(fixtureDir, name), 0o755);
      };
      stub(
        'curl',
        `printf '%s\\n' "$*" > "$AC_TEST_DIR/curl.args"
printf '%s' '{"token":"bearer.fixture"}'`,
      );
      stub(
        'ctr',
        `printf '%s\\n' "$*" > "$AC_TEST_DIR/ctr.args"
while [ "$1" != --hosts-dir ]; do shift; done
cp "$2/ghcr.io/hosts.toml" "$AC_TEST_DIR/hosts.toml"`,
      );
      stub('docker', 'exit 0');
      // /run is root-only here; keep the worker's private dir in the fixture.
      stub(
        'mktemp',
        `if [ "$1" = -d ]; then d="$AC_TEST_DIR/auth"; mkdir "$d"; echo "$d"; else exec /usr/bin/mktemp "$@"; fi`,
      );
      const authFile = join(fixtureDir, 'registry-auth');
      writeFileSync(
        authFile,
        `${Buffer.from('octocat').toString('base64')}\n${Buffer.from('ghp_fixture').toString('base64')}\n`,
      );
      const env = {
        AC_PULL_IMAGE: 'ghcr.io/anycloud-sh/mace:latest',
        AC_CONTAINERD_ADDRESS: '/run/containerd/containerd.sock',
        AC_CONTAINERD_NAMESPACE: 'moby',
        AC_SNAPSHOTTER: 'overlayfs',
        AC_REGISTRY_AUTH_FILE: authFile,
      };

      const result = spawnSync(
        '/bin/sh',
        ['-c', CONTAINERD_TRANSFER_PULL_COMMAND],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ...env,
            PATH: `${fixtureDir}:${process.env.PATH ?? ''}`,
            AC_TEST_DIR: fixtureDir,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(join(fixtureDir, 'curl.args'), 'utf8')).toContain(
        'scope=repository:anycloud-sh/mace:pull',
      );
      expect(readFileSync(join(fixtureDir, 'ctr.args'), 'utf8')).toContain(
        '--hosts-dir',
      );
      expect(readFileSync(join(fixtureDir, 'hosts.toml'), 'utf8')).toContain(
        'authorization = "Bearer bearer.fixture"',
      );
      expect(existsSync(authFile)).toBe(false);
      expect(existsSync(join(fixtureDir, 'auth'))).toBe(false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
