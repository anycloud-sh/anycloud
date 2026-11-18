import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyNvidiaGpuFabricStateCsv,
  initializeVM,
  installRcloneCommand,
  UNPIGZ_INSTALL_TIMEOUT_MS,
  waitForNvidiaGpuFabricReady,
} from '../../../src/api/services/vm-initializer';
import type { VmTransport } from '../../../src/api/services/gateways/transport-contract';
import { GpuRuntime } from '../../../src/shared/cloud';
import {
  DOCKER_ARCH_REF,
  dockerArchiveUrl,
  GO_ARCH_REF,
  rcloneArchiveUrl,
  BOUNDED_CURL,
  DOCKER_DAEMON_CONFIG_COMMAND,
  installUnpigzCommand,
} from '../../../src/api/runtime-artifacts';
import { makeVmTransport } from '../helpers/vm-transport';
import { JOB_HOST_DOCKER } from '../../../src/api/services/job-host';

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('classifyNvidiaGpuFabricStateCsv', () => {
  it('treats Not Started as not ready', () => {
    expect(classifyNvidiaGpuFabricStateCsv('Not Started\n')).toEqual({
      ready: false,
      states: ['Not Started'],
    });
  });

  it('waits while any GPU is still in a transitional state', () => {
    expect(classifyNvidiaGpuFabricStateCsv('Completed\nNot Started\n')).toEqual(
      {
        ready: false,
        states: ['Completed', 'Not Started'],
      },
    );
  });

  it('accepts recognized ready and non-fabric states immediately', () => {
    expect(
      classifyNvidiaGpuFabricStateCsv('Completed\nNot Supported\nN/A\n'),
    ).toEqual({
      ready: true,
      result: 'GPUFABRIC_READY',
      states: ['Completed', 'Not Supported', 'N/A'],
    });
  });

  it('accepts driver-labeled non-fabric states', () => {
    expect(classifyNvidiaGpuFabricStateCsv('state  N/A\n')).toEqual({
      ready: true,
      result: 'GPUFABRIC_READY',
      states: ['state  N/A'],
    });
  });

  it('handles quoted single-column CSV values', () => {
    expect(
      classifyNvidiaGpuFabricStateCsv('"Completed"\n"Not Supported"\n'),
    ).toEqual({
      ready: true,
      result: 'GPUFABRIC_READY',
      states: ['Completed', 'Not Supported'],
    });
  });

  it('keeps unknown states pending instead of treating them as ready', () => {
    expect(classifyNvidiaGpuFabricStateCsv('Pending Registration\n')).toEqual({
      ready: false,
      states: ['Pending Registration'],
    });
  });
});

describe('installUnpigzCommand', () => {
  // Runs the command with stubbed tools; `install` records an install.
  function runWithStubs(stubs: Record<string, string>, systemPath = true) {
    const bin = mkdtempSync(path.join(tmpdir(), 'unpigz-stubs-'));
    for (const [name, body] of Object.entries({
      uname: 'echo x86_64',
      install: 'touch "$BIN/installed"',
      ...stubs,
    })) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    const result = spawnSync('/bin/sh', ['-c', installUnpigzCommand()], {
      encoding: 'utf8',
      env: { PATH: systemPath ? `${bin}:/usr/bin:/bin` : bin, BIN: bin },
    });
    const read = (file: string) =>
      existsSync(path.join(bin, file))
        ? readFileSync(path.join(bin, file), 'utf8')
        : null;
    const out = {
      ...result,
      installed: read('installed') !== null,
      curlArgs: read('curl-args'),
    };
    rmSync(bin, { recursive: true });
    return out;
  }
  const curlWrites =
    'echo "$@" > "$BIN/curl-args"; while [ "$1" != -o ]; do shift; done; echo deb > "$2"';

  it('generates a valid POSIX shell installer', () => {
    expect(
      spawnSync('/bin/sh', ['-n'], { input: installUnpigzCommand() }).status,
    ).toBe(0);
  });

  it('downloads over https with connect and total time limits', () => {
    const { curlArgs } = runWithStubs({
      'dpkg-deb': 'exit 0',
      curl: curlWrites,
    });

    expect(curlArgs).toMatch(/--connect-timeout \d+ /);
    expect(curlArgs).toMatch(/--max-time \d+ /);
    expect(curlArgs).toContain(' https://');
  });

  it('installs nothing when the download fails its checksum', () => {
    const result = runWithStubs({ 'dpkg-deb': 'exit 0', curl: curlWrites });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('FAILED');
    expect(result.installed).toBe(false);
  });

  it('installs nothing when the extracted binary cannot inflate', () => {
    const payload = mkdtempSync(path.join(tmpdir(), 'unpigz-payload-'));
    mkdirSync(path.join(payload, 'usr/bin'), { recursive: true });
    writeFileSync(path.join(payload, 'usr/bin/pigz'), '#!/bin/sh\nexit 1\n');
    const result = runWithStubs({
      curl: curlWrites,
      sha256sum: 'cat >/dev/null',
      'dpkg-deb': `tar -cf - -C '${payload}' ./usr/bin/pigz`,
    });
    rmSync(payload, { recursive: true });

    expect(result.status).not.toBe(0);
    expect(result.installed).toBe(false);
  });

  it('skips a host without dpkg-deb without downloading', () => {
    const result = runWithStubs({ curl: curlWrites }, false);

    expect(result.status).toBe(0);
    expect(result.curlArgs).toBeNull();
  });
});

describe('initializeVM', () => {
  it('generates a valid POSIX shell installer', () => {
    const result = spawnSync('/bin/sh', ['-n'], {
      input: installRcloneCommand(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('downloads the pinned runtime directly from its vendor', () => {
    const command = installRcloneCommand();

    expect(command).toContain(BOUNDED_CURL);
    expect(command).toContain(rcloneArchiveUrl(GO_ARCH_REF));
    expect(command).not.toContain('runtime-artifacts');
  });

  it('keeps both fresh runtime installs independent of Local plumbing', async () => {
    const calls: Parameters<VmTransport['exec']>[] = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (...args: Parameters<VmTransport['exec']>) => {
        calls.push(args);
        const [command] = args;
        if (command === 'docker --version' || command === 'rclone version') {
          throw new Error('not installed');
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') return ok('init\n');
        if (command === 'docker info >/dev/null 2>&1') {
          throw new Error('daemon is not running');
        }
        return ok();
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'local-cache-job',
      vmIp: 'localhost',
    });

    const installCalls = calls.filter(
      ([command]) =>
        command.includes('download.docker.com') ||
        command.includes('downloads.rclone.org'),
    );
    expect(installCalls).toHaveLength(2);
    // Keep the low-width bare-image contract pinned to the same vendor URLs as
    // production even though prepared Local images take the installed fast path.
    expect(
      installCalls.some(([command]) =>
        command.includes(dockerArchiveUrl(DOCKER_ARCH_REF)),
      ),
    ).toBe(true);
    expect(
      installCalls.some(([command]) =>
        command.includes(rcloneArchiveUrl(GO_ARCH_REF)),
      ),
    ).toBe(true);
    for (const [command, attempts, exponentialBackoff] of installCalls) {
      expect(command).toContain('curl -fsSL');
      expect(command).not.toContain('runtime-artifacts');
      expect(command).not.toContain('sha256sum');
      expect(attempts).toBe(5);
      expect(exponentialBackoff).toBe(true);
    }
  });

  it("installs a Job host's Docker as its user data does", async () => {
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, { workloadId: 'job-1', vmIp: 'ip', jobHost: true });

    expect(commands).toContain(
      `${JOB_HOST_DOCKER}\ninstall_docker && start_docker`,
    );
    // Never Docker 27, and never a Docker started outside start_docker.
    expect(
      commands.some((c) => c.includes(dockerArchiveUrl(DOCKER_ARCH_REF))),
    ).toBe(false);
    expect(commands.some((c) => c.includes('systemctl start docker'))).toBe(
      false,
    );
  });

  it('skips rclone install when rclone is already present', async () => {
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version') {
          return {
            code: 0,
            stdout: 'Docker version 27.5.1, build test\n',
            stderr: '',
          };
        }
        if (command === 'rclone version') {
          return {
            code: 0,
            stdout: 'rclone v1.66.0\n',
            stderr: '',
          };
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        if (command === 'systemctl is-active --quiet docker') {
          return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-1',
      vmIp: 'ac-control-job-1-0',
    });

    expect(commands).toContain('rclone version');
    expect(
      commands.some((command) => command.includes('downloads.rclone.org')),
    ).toBe(false);
  });

  it('does not configure the transfer store for a CPU workload', async () => {
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version') {
          return { code: 0, stdout: 'Docker version 27.5.1\n', stderr: '' };
        }
        if (command === 'rclone version') {
          return { code: 0, stdout: 'rclone v1.66.0\n', stderr: '' };
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        if (command === 'systemctl is-active --quiet docker') {
          return { code: 0, stdout: '', stderr: '' };
        }
        // reconcileNvidiaCdi's probe is best-effort and swallows failures.
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-1',
      vmIp: 'ip',
    });

    expect(
      commands.some(
        (c) =>
          c.includes('max_concurrent_downloads') ||
          c === 'systemctl restart docker',
      ),
    ).toBe(false);
  });

  it('enables the containerd transfer store at init on a GPU workload', async () => {
    const commands: string[] = [];
    let storeReads = 0;
    let dockerActiveReads = 0;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command.includes('nvidia-smi')) return ok('Completed\n');
        if (command === 'docker --version') {
          return ok('Docker version 27.5.1\n');
        }
        if (command === 'rclone version') return ok('rclone v1.66.0\n');
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return ok('systemd\n');
        }
        if (command === 'systemctl is-active --quiet docker') {
          dockerActiveReads++;
          if (dockerActiveReads === 1) throw new Error('inactive');
          return ok();
        }
        if (command === 'systemctl start docker') return ok();
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
        if (command.startsWith('containerd --config'))
          return ok('version = 3\n');
        if (command.startsWith("cat '/etc/docker/daemon.json'"))
          return ok('{}\n');
        if (command.startsWith("docker info --format '{{.Driver}}'")) {
          storeReads++;
          return storeReads === 1
            ? ok('overlay2\n[]\n')
            : ok(
                'overlayfs\n[["driver-type","io.containerd.snapshotter.v1"]]\n',
              );
        }
        // Best-effort settle/CDI probes + backup/write/restart execs.
        return ok();
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-1',
      vmIp: 'ip',
      gpuRuntime: GpuRuntime.Cuda,
    });

    // The transfer controls were written into the containerd config...
    expect(
      commands.some((c) => c.includes('max_concurrent_downloads = 3')),
    ).toBe(true);
    // ...and both daemons were restarted onto the new store.
    expect(
      commands.some(
        (c) =>
          c.includes('systemctl restart containerd') &&
          c.includes('systemctl restart docker'),
      ),
    ).toBe(true);
    // A preinstalled but inactive daemon is started before the transfer
    // capability preflight. No passive readiness loop is needed.
    expect(commands).toContain('systemctl start docker');
    expect(commands.indexOf('systemctl start docker')).toBeLessThan(
      commands.indexOf('containerd --version'),
    );
    expect(dockerActiveReads).toBe(2);
  });

  it('does not restart an already-active preinstalled Docker daemon', async () => {
    const commands: string[] = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version')
          return ok('Docker version 27.5.1\n');
        if (command === 'rclone version') return ok('rclone v1.66.0\n');
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return ok('systemd\n');
        }
        if (command === 'systemctl is-active --quiet docker') return ok();
        if (command === 'containerd --version') {
          return ok('containerd containerd.io 1.7.27 deadbeef\n');
        }
        // Best-effort settle/CDI probes are allowed to succeed without output.
        return ok();
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-active',
      vmIp: 'ip',
      gpuRuntime: GpuRuntime.Rocm,
    });

    expect(commands).toContain('systemctl is-active --quiet docker');
    expect(commands).not.toContain('systemctl start docker');
  });

  it('installs unpigz beside preinstalled Docker within a time limit, and a failed install does not fail init', async () => {
    const commands: string[] = [];
    let unpigzCommand = '';
    let unpigzTimeoutMs: number | undefined;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(
        async (
          ...[command, , , timeoutMs]: Parameters<VmTransport['exec']>
        ) => {
          commands.push(command);
          if (command.includes(installUnpigzCommand())) {
            unpigzCommand = command;
            unpigzTimeoutMs = timeoutMs;
            throw new Error('mirror down');
          }
          if (command === 'ps -p 1 -o comm= 2>/dev/null')
            return ok('systemd\n');
          return ok();
        },
      ),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, { workloadId: 'job-unpigz', vmIp: 'ip' });

    expect(commands).toContain('docker --version');
    expect(unpigzTimeoutMs).toBe(UNPIGZ_INSTALL_TIMEOUT_MS);

    // It downloads only when unpigz isn't installed: a Job host's user data
    // may have installed it already.
    const bin = mkdtempSync(path.join(tmpdir(), 'unpigz-present-'));
    for (const name of ['uname', 'curl', 'dpkg-deb']) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n');
      chmodSync(path.join(bin, name), 0o755);
    }
    const unpigz = path.join(bin, 'unpigz');
    const run = () =>
      spawnSync(
        '/bin/sh',
        ['-c', unpigzCommand.replaceAll('/usr/local/bin/unpigz', unpigz)],
        { env: { PATH: `${bin}:/usr/bin:/bin` } },
      ).status;
    expect(run()).not.toBe(0);
    writeFileSync(unpigz, '#!/bin/sh\n');
    chmodSync(unpigz, 0o755);
    expect(run()).toBe(0);
    rmSync(bin, { recursive: true });
  });

  it('starts an installed Docker daemon on a non-systemd VM', async () => {
    const commands: string[] = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version') {
          return ok('Docker version 27.5.1\n');
        }
        if (command === 'rclone version') return ok('rclone v1.66.0\n');
        if (command === 'ps -p 1 -o comm= 2>/dev/null') return ok('init\n');
        if (command === 'docker info >/dev/null 2>&1') {
          throw new Error('daemon is not running');
        }
        if (command.includes('nohup dockerd')) return ok();
        if (command.startsWith('for i in $(seq 1 30); do docker info')) {
          return ok();
        }
        // Best-effort settle/CDI probes are allowed to fail.
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-non-systemd',
      vmIp: 'ip',
    });

    expect(
      commands.some((command) =>
        command.includes('if [ -s /etc/docker/daemon.json ]; then'),
      ),
    ).toBe(true);
    expect(
      commands.some((command) => command.includes('nohup dockerd </dev/null')),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.includes('nohup dockerd --storage-driver=vfs </dev/null'),
      ),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.startsWith('for i in $(seq 1 30); do docker info'),
      ),
    ).toBe(true);
  });

  it('registers an explicitly requested NVIDIA runtime after installing Docker', async () => {
    const commands: string[] = [];
    let runtimeProbes = 0;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command.includes('cloud-init status --wait')) return ok();
        if (command.includes('nvidia-smi')) return ok('Completed\n');
        if (command === 'docker --version') {
          throw new Error('docker is not installed');
        }
        if (command === 'rclone version') return ok('rclone v1.66.0\n');
        if (command.includes('download.docker.com')) return ok();
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return ok('systemd\n');
        }
        if (command.includes('cat > /etc/systemd/system/docker.service')) {
          return ok();
        }
        if (
          command ===
          'systemctl daemon-reload && systemctl enable docker && systemctl start docker'
        ) {
          return ok();
        }
        if (command.includes("docker info --format '{{json .Runtimes}}'")) {
          runtimeProbes++;
          if (runtimeProbes === 1) throw new Error('runtime is absent');
          return ok();
        }
        if (command.includes('nvidia-ctk runtime configure --runtime=docker')) {
          return ok();
        }
        if (
          command ===
          'systemctl restart docker && systemctl is-active --quiet docker'
        ) {
          return ok();
        }
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'gcp-runtime-job',
      vmIp: 'ip',
      gpuRuntime: GpuRuntime.Cuda,
      dockerRuntime: 'nvidia',
    });

    const installIndex = commands.findIndex((command) =>
      command.includes('download.docker.com'),
    );
    const configureIndex = commands.findIndex((command) =>
      command.includes('nvidia-ctk runtime configure --runtime=docker'),
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(configureIndex).toBeGreaterThan(installIndex);
    expect(commands[installIndex]).toContain(BOUNDED_CURL);
    expect(commands[installIndex]).toContain('-o /tmp/docker.tgz');
    expect(commands[installIndex]).not.toContain('| tar');
    expect(commands).toContain(
      'systemctl restart docker && systemctl is-active --quiet docker',
    );
    expect(runtimeProbes).toBe(2);
    // The NIC's MTU and the open-file limit, in place before dockerd starts.
    const unitIndex = commands.findIndex((command) =>
      command.includes('cat > /etc/systemd/system/docker.service'),
    );
    expect(commands[unitIndex]).toContain(DOCKER_DAEMON_CONFIG_COMMAND);
    expect(unitIndex).toBeLessThan(
      commands.indexOf(
        'systemctl daemon-reload && systemctl enable docker && systemctl start docker',
      ),
    );
  });

  it('fails before transfer configuration when preinstalled Docker cannot start', async () => {
    const commands: string[] = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version')
          return ok('Docker version 27.5.1\n');
        if (command === 'rclone version') return ok('rclone v1.66.0\n');
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return ok('systemd\n');
        }
        if (command === 'systemctl is-active --quiet docker') {
          throw new Error('inactive');
        }
        if (command === 'systemctl start docker') {
          throw new Error('start failed');
        }
        // Best-effort settle/fabric probes are allowed to succeed.
        return ok('Completed\n');
      }),
      ping: vi.fn(async () => true),
    });

    await expect(
      initializeVM(ssh, {
        workloadId: 'job-start-failed',
        vmIp: 'ip',
        gpuRuntime: GpuRuntime.Cuda,
      }),
    ).rejects.toThrow('start failed');

    expect(commands).toContain('systemctl start docker');
    expect(commands).not.toContain('containerd --version');
  });

  it('waits for cloud-init to settle before building the runtime (first-boot upgrade guard)', async () => {
    // The Azure NGC image runs a first-boot cloud-init package_upgrade that
    // restarts docker/containerd ~2-3 min in, SIGKILLing a container started
    // mid-upgrade (exit 137, non-retryable). Init must wait it out first.
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version') {
          return { code: 0, stdout: 'Docker version 27.5.1\n', stderr: '' };
        }
        if (command === 'rclone version') {
          return { code: 0, stdout: 'rclone v1.66.0\n', stderr: '' };
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        if (command === 'systemctl is-active --quiet docker') {
          return { code: 0, stdout: '', stderr: '' };
        }
        // Best-effort settle/probe commands are allowed to fail.
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, { workloadId: 'job-1', vmIp: 'ip' });

    expect(commands.some((c) => c.includes('cloud-init status --wait'))).toBe(
      true,
    );
  });

  it('skips the NVIDIA fabric probe when the runtime is not CUDA', async () => {
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version') {
          return { code: 0, stdout: 'Docker version 27.5.1\n', stderr: '' };
        }
        if (command === 'rclone version') {
          return { code: 0, stdout: 'rclone v1.66.0\n', stderr: '' };
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        if (command === 'systemctl is-active --quiet docker') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'containerd --version') {
          return {
            code: 0,
            stdout: 'containerd containerd.io 1.7.27 deadbeef\n',
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-1',
      vmIp: 'ip',
      gpuRuntime: GpuRuntime.Rocm,
    });

    expect(commands.some((c) => c.includes('nvidia-smi'))).toBe(false);
  });

  it('probes NVIDIA fabric readiness before building the runtime for CUDA VMs', async () => {
    const commands: string[] = [];
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command.includes('nvidia-smi')) {
          return { code: 0, stdout: 'Completed\n', stderr: '' };
        }
        if (command === 'docker --version') {
          return { code: 0, stdout: 'Docker version 27.5.1\n', stderr: '' };
        }
        if (command === 'rclone version') {
          return { code: 0, stdout: 'rclone v1.66.0\n', stderr: '' };
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') {
          return { code: 0, stdout: 'systemd\n', stderr: '' };
        }
        if (command === 'systemctl is-active --quiet docker') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'containerd --version') {
          return {
            code: 0,
            stdout: 'containerd containerd.io 1.7.27 deadbeef\n',
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await initializeVM(ssh, {
      workloadId: 'job-1',
      vmIp: 'ip',
      gpuRuntime: GpuRuntime.Cuda,
    });

    expect(
      commands.some(
        (c) => c.includes('nvidia-smi') && c.includes('fabric.state'),
      ),
    ).toBe(true);
  });

  it('fails init when the GPU fabric never becomes ready (so it reprovisions on a fresh host)', async () => {
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        if (command.includes('nvidia-smi')) {
          return { code: 0, stdout: 'In Progress\n', stderr: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      }),
      ping: vi.fn(async () => true),
    });

    await expect(
      waitForNvidiaGpuFabricReady(ssh, 'job-2', 'ip', {
        pollIntervalMs: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow();
  });
});
