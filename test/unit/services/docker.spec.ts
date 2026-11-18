import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import {
  DockerManager,
  SECRETS_ENV_FILE,
} from '../../../src/api/services/docker';

type ExecFn = DockerManager['exec'];
import { SSHExecError } from '../../../src/api/services/gateways/ssh';
import { type StoredWorkload } from '../../../src/api/services/workload-record.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  ContainerState,
  isContainerHealthy,
} from '../../../src/shared/runtime.js';
import {
  ANYCLOUD_DOCKER_LABEL_KEYS,
  ANYCLOUD_DOCKER_ROLES,
} from '../../../src/shared/docker-labels';
import { bucketHostPathsForRoot } from '../../../src/shared/providers';
import { makeStoredWorkload } from '../helpers/fixtures';

// Mock SSH manager to avoid actual SSH connections
vi.mock('../../../src/api/services/gateways/ssh', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/gateways/ssh')
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

describe('DockerManager', () => {
  describe('docker run command construction with dockerOptions', () => {
    let dockerManager: DockerManager;
    let execSpy: Mock<ExecFn>;

    beforeEach(() => {
      // Create manager for local execution (127.0.0.1 uses execSync, not SSH)
      dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');

      // Spy on the exec method to capture the docker command
      execSpy = vi
        .fn<ExecFn>()
        .mockResolvedValue({ code: 0, stdout: 'container-id', stderr: '' });
      dockerManager.exec = execSpy;
    });

    it('should include --gpus flag when specified', async () => {
      const props = mockStoredWorkload({ dockerOptions: { gpus: 'all' } });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--gpus 'all'");
    });

    it('should include --runtime flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { runtime: 'nvidia' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--runtime 'nvidia'");
    });

    it('should include --network flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { network: 'anycloud-control' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--network 'anycloud-control'");
    });

    it('should include --shm-size flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { shmSize: '8g' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--shm-size '8g'");
    });

    it('should include --ipc flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { ipc: 'host' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--ipc 'host'");
    });

    it('should include multiple --ulimit flags when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { ulimits: ['memlock=-1:-1', 'stack=67108864'] },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--ulimit 'memlock=-1:-1'");
      expect(cmd).toContain("--ulimit 'stack=67108864'");
    });

    it('should include --memory flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { memory: '32g' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--memory '32g'");
    });

    it('should include --cpus flag when specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: { cpus: '8' },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--cpus '8'");
    });

    it('should include all docker options when all are specified', async () => {
      const props = mockStoredWorkload({
        dockerOptions: {
          gpus: 'all',
          runtime: 'nvidia',
          shmSize: '8g',
          ipc: 'host',
          ulimits: ['memlock=-1:-1'],
          memory: '64g',
          cpus: '16',
        },
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).toContain("--gpus 'all'");
      expect(cmd).toContain("--runtime 'nvidia'");
      expect(cmd).toContain("--shm-size '8g'");
      expect(cmd).toContain("--ipc 'host'");
      expect(cmd).toContain("--ulimit 'memlock=-1:-1'");
      expect(cmd).toContain("--memory '64g'");
      expect(cmd).toContain("--cpus '16'");
    });

    it('should not include docker options when not specified', async () => {
      const props = mockStoredWorkload();

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).not.toContain('--gpus');
      expect(cmd).not.toContain('--runtime');
      expect(cmd).not.toContain('--shm-size');
      expect(cmd).not.toContain('--ipc');
      expect(cmd).not.toContain('--ulimit');
      expect(cmd).not.toContain('--memory');
      expect(cmd).not.toContain('--cpus');
    });

    it('should not include docker options when dockerOptions is empty object', async () => {
      const props = mockStoredWorkload({
        dockerOptions: {},
      });

      await dockerManager.startContainer(props);

      const cmd = execSpy.mock.calls.find((c) =>
        c[0].includes('docker run'),
      )?.[0];
      expect(cmd).not.toContain('--gpus');
      expect(cmd).not.toContain('--runtime');
      expect(cmd).not.toContain('--shm-size');
    });
  });

  describe('VM host preparation', () => {
    it('creates the shared workspace and uses the numeric socket GID', async () => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      const execSpy = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      dockerManager.exec = execSpy;
      dockerManager.execResult = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '998\n', stderr: '' });

      await dockerManager.startContainer(
        mockStoredWorkload({ workloadType: 'vm' }),
      );

      expect(execSpy.mock.calls[1][0]).toBe("install -d -m 0777 '/workspace'");
      const run = execSpy.mock.calls.find((call) =>
        String(call[0]).includes('docker run'),
      )?.[0];
      expect(run).toContain('--group-add 998');
    });

    it.each([
      [{ code: 1, stdout: '', stderr: 'missing' }, 'Cannot determine'],
      [{ code: 0, stdout: 'docker\n', stderr: '' }, 'Cannot determine'],
    ])('fails clearly for an unusable socket GID', async (result, message) => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      const execSpy = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      dockerManager.exec = execSpy;
      dockerManager.execResult = vi.fn().mockResolvedValue(result);

      await expect(
        dockerManager.startContainer(
          mockStoredWorkload({ workloadType: 'vm' }),
        ),
      ).rejects.toThrow(message);
      expect(
        execSpy.mock.calls.some((call) =>
          String(call[0]).includes('docker run'),
        ),
      ).toBe(false);
    });
  });

  describe('--host-docker Job host preparation', () => {
    it('reads the socket and kvm groups on the host and raises the inotify limit', async () => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      const execSpy = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      dockerManager.exec = execSpy;
      const gids: Record<string, string> = {
        '/var/run/docker.sock': '991\n',
        '/dev/kvm': '994\n',
      };
      dockerManager.execResult = vi.fn(async (command: string) => {
        const path = Object.keys(gids).find((p) => command.includes(p));
        return {
          code: path ? 0 : 1,
          stdout: path ? gids[path] : '',
          stderr: '',
        };
      });

      await dockerManager.startContainer(
        mockStoredWorkload({
          hostDocker: true,
          requireNestedVirtualization: true,
        }),
      );

      const commands = execSpy.mock.calls.map((call) => String(call[0]));
      expect(commands).toContain("install -d -m 0777 '/workspace'");
      expect(commands).toContain(
        '[ "$(cat /proc/sys/fs/inotify/max_user_instances)" -ge 8192 ] || sysctl -qw fs.inotify.max_user_instances=8192',
      );
      // Other machines can't open connections to its published ports.
      const guard = commands.findIndex((command) =>
        command.includes(
          'rule="DOCKER-USER -i $dev -m conntrack --ctstate NEW -j DROP"',
        ),
      );
      const runIndex = commands.findIndex((command) =>
        command.includes('docker run'),
      );
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(runIndex);
      const run = commands[runIndex];
      expect(run).toContain('--group-add 991');
      expect(run).toContain('--device /dev/kvm --group-add 994');

      // A nested Job on a host without /dev/kvm fails before docker run.
      delete gids['/dev/kvm'];
      execSpy.mockClear();
      await expect(
        dockerManager.startContainer(
          mockStoredWorkload({
            hostDocker: true,
            requireNestedVirtualization: true,
          }),
        ),
      ).rejects.toThrow(
        'nested virtualization was requested but /dev/kvm is missing on this host',
      );
      expect(
        execSpy.mock.calls.some((call) =>
          String(call[0]).includes('docker run'),
        ),
      ).toBe(false);
    });
  });

  describe('VM readiness contract', () => {
    it('checks only the shared workspace and socket access', async () => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      const execResult = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      dockerManager.execResult = execResult;

      await dockerManager.assertVmContainerReady('vm-1');

      const command = execResult.mock.calls[0][0] as string;
      expect(command).toContain('/bin/sh');
      expect(command).toContain('/workspace');
      expect(command).toContain('/var/run/docker.sock');
      expect(command).not.toContain('id -u');
      expect(command).not.toContain('id -g');
      expect(command).not.toContain('docker info');
      expect(command).not.toContain('docker compose version');
      expect(command).not.toContain('docker buildx version');
    });

    it('fails clearly when a custom image violates the runtime contract', async () => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      dockerManager.execResult = vi.fn().mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'permission denied',
      });

      await expect(
        dockerManager.assertVmContainerReady('vm-1'),
      ).rejects.toThrow(
        'VM container failed its runtime contract: permission denied',
      );
    });
  });

  describe('non-destructive VM container repair', () => {
    function repairManager(): DockerManager {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      vi.spyOn(
        dockerManager as any,
        'prepareVmContainerHost',
      ).mockResolvedValue({ socket: 998 });
      return dockerManager;
    }

    it('treats an unrelated same-name container as a conflict', async () => {
      const dockerManager = repairManager();
      vi.spyOn(dockerManager, 'getContainerStatus').mockResolvedValue({
        state: ContainerState.Running,
      });
      dockerManager.execResult = vi.fn().mockResolvedValue({
        code: 0,
        stdout: JSON.stringify({
          [ANYCLOUD_DOCKER_LABEL_KEYS.managed]: 'true',
          [ANYCLOUD_DOCKER_LABEL_KEYS.role]: ANYCLOUD_DOCKER_ROLES.workload,
          [ANYCLOUD_DOCKER_LABEL_KEYS.workloadId]: 'someone-else',
        }),
        stderr: '',
      });

      await expect(
        dockerManager.inspectVmContainer({
          id: 'test-workload',
          userId: 'testuser',
        }),
      ).resolves.toEqual({
        kind: 'conflict',
        state: ContainerState.Running,
      });
    });

    it('creates a missing container without a prior stop or remove', async () => {
      const dockerManager = repairManager();
      vi.spyOn(dockerManager, 'inspectVmContainer').mockResolvedValue({
        kind: 'missing',
      });
      const execResult = vi.fn().mockResolvedValue({
        code: 0,
        stdout: 'container-id',
        stderr: '',
      });
      dockerManager.execResult = execResult;

      await expect(
        dockerManager.createContainerIfAbsent(
          mockStoredWorkload({ workloadType: 'vm' }),
          undefined,
          async () => true,
        ),
      ).resolves.toEqual({ outcome: 'created' });

      expect(execResult).toHaveBeenCalledOnce();
      const command = execResult.mock.calls[0][0] as string;
      expect(command).toContain('docker run');
      expect(command).not.toContain('docker rm');
      expect(command).not.toContain('docker stop');
    });

    it('aborts creation when the durable workload is no longer eligible', async () => {
      const dockerManager = repairManager();
      vi.spyOn(dockerManager, 'inspectVmContainer').mockResolvedValue({
        kind: 'missing',
      });
      dockerManager.execResult = vi.fn();

      await expect(
        dockerManager.createContainerIfAbsent(
          mockStoredWorkload({ workloadType: 'vm' }),
          undefined,
          async () => false,
        ),
      ).resolves.toEqual({ outcome: 'aborted' });
      expect(dockerManager.execResult).not.toHaveBeenCalled();
    });

    it('converges when another repair wins Docker name uniqueness', async () => {
      const dockerManager = repairManager();
      vi.spyOn(dockerManager, 'inspectVmContainer')
        .mockResolvedValueOnce({ kind: 'missing' })
        .mockResolvedValueOnce({
          kind: 'managed',
          state: ContainerState.Running,
        });
      dockerManager.execResult = vi.fn().mockResolvedValue({
        code: 125,
        stdout: '',
        stderr: 'name is already in use',
      });

      await expect(
        dockerManager.createContainerIfAbsent(
          mockStoredWorkload({ workloadType: 'vm' }),
        ),
      ).resolves.toEqual({ outcome: 'already-running' });
    });

    it.each([
      ContainerState.Exited,
      ContainerState.Paused,
      ContainerState.Restarting,
    ])('never mutates an existing managed %s container', async (state) => {
      const dockerManager = repairManager();
      vi.spyOn(dockerManager, 'inspectVmContainer').mockResolvedValue({
        kind: 'managed',
        state,
      });
      dockerManager.execResult = vi.fn();

      await expect(
        dockerManager.createContainerIfAbsent(
          mockStoredWorkload({ workloadType: 'vm' }),
        ),
      ).resolves.toEqual({ outcome: 'managed-not-running', state });
      expect(dockerManager.execResult).not.toHaveBeenCalled();
    });
  });

  describe('getCommand static method', () => {
    const baseProps = mockStoredWorkload();

    it('should build basic docker run command', () => {
      const cmd = DockerManager.getCommand(baseProps);

      expect(cmd).toContain('docker run -d');
      expect(cmd).toContain('--name test-workload');
      expect(cmd).toContain('nginx:latest');
      expect(cmd).toContain('--restart no'); // job uses no restart
      // The public HTTP publish + PORT env must stay Service-exclusive — a job
      // must never expose port 80 to the internet.
      expect(cmd).not.toContain('0.0.0.0:80:8088');
      expect(cmd).not.toContain('PORT=8088');
    });

    it('runs the resolved image digest, not the mutable tag', () => {
      const digest = `sha256:${'b'.repeat(64)}`;
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({
          image: 'ghcr.io/anycloud-sh/x:latest',
          imageDigest: digest,
        }),
      );
      expect(cmd).toContain(`ghcr.io/anycloud-sh/x@${digest}`);
      expect(cmd).not.toContain('ghcr.io/anycloud-sh/x:latest');
    });

    it('should label AnyCloud workload containers for cleanup', () => {
      const cmd = DockerManager.getCommand(baseProps);

      expect(cmd).toContain(
        `--label '${ANYCLOUD_DOCKER_LABEL_KEYS.managed}=true'`,
      );
      expect(cmd).toContain(
        `--label '${ANYCLOUD_DOCKER_LABEL_KEYS.role}=${ANYCLOUD_DOCKER_ROLES.workload}'`,
      );
      expect(cmd).toContain(
        `--label '${ANYCLOUD_DOCKER_LABEL_KEYS.workloadId}=test-workload'`,
      );
      expect(cmd).toContain(
        `--label '${ANYCLOUD_DOCKER_LABEL_KEYS.userId}=testuser'`,
      );
    });

    it('should build Service docker run command with restart and HTTP publish', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({ workloadType: 'service' }),
      );

      expect(cmd).toContain('--restart unless-stopped');
      expect(cmd).toContain('-p 0.0.0.0:80:8088');
      expect(cmd).toContain('PORT=8088');
    });

    it('should use Service env PORT for HTTP publish and injected PORT', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({
          workloadType: 'service',
          env: { PORT: '9000', FOO: 'bar' },
        }),
      );

      expect(cmd).toContain('--restart unless-stopped');
      expect(cmd).toContain('-p 0.0.0.0:80:9000');
      expect(cmd).toContain('PORT=9000');
      expect(cmd).toContain('FOO=bar');
      expect(cmd).not.toContain('0.0.0.0:80:8088');
      expect(cmd.match(/PORT=9000/g)).toHaveLength(1);
    });

    it('builds the exact VM container profile', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({
          workloadType: 'vm',
          image: 'ghcr.io/acme/dev:latest',
          env: { FOO: 'bar', HOME: '/home/dev', PORT: '3000' },
          command: ['ignored'],
          dockerOptions: { gpus: 'all', ipc: 'host' },
        }),
        undefined,
        false,
        { socket: 998 },
      );

      for (const fragment of [
        '--init',
        '--group-add 998',
        '--entrypoint /bin/sh',
        '--workdir /workspace',
        '--add-host host.docker.internal:host-gateway',
        '--restart unless-stopped',
        '-v /var/run/docker.sock:/var/run/docker.sock',
        '-v /workspace:/workspace',
        'HOME=/home/dev',
        'PORT=3000',
        'FOO=bar',
        "--gpus 'all'",
        "--ipc 'host'",
        "'ghcr.io/acme/dev:latest' -c 'while :; do sleep 3600; done'",
      ]) {
        expect(cmd).toContain(fragment);
      }
      expect(cmd.match(/HOME=/g)).toHaveLength(1);
      expect(cmd.match(/PORT=3000/g)).toHaveLength(1);
      expect(cmd).not.toContain('--user');
      expect(cmd).not.toContain('/home/anycloud');
      expect(cmd).not.toContain('0.0.0.0:80:');
      expect(cmd).not.toContain('ignored');
    });

    describe('--host-docker Job', () => {
      const job = (overrides: Partial<StoredWorkload> = {}) =>
        mockStoredWorkload({
          workloadType: 'job',
          hostDocker: true,
          command: ['./ci.sh'],
          dockerOptions: { shmSize: '2g', ulimits: ['nofile=1048576:1048576'] },
          ...overrides,
        });

      it('mounts the host socket and workspace, keeps its command, and adds no privilege', () => {
        const cmd = DockerManager.getCommand(job(), undefined, false, {
          socket: 991,
        });
        for (const fragment of [
          '--init --group-add 991 --workdir /workspace --add-host host.docker.internal:host-gateway',
          '--restart no',
          '-v /var/run/docker.sock:/var/run/docker.sock',
          '-v /workspace:/workspace',
          "--shm-size '2g'",
          "--ulimit 'nofile=1048576:1048576'",
          "'./ci.sh'",
        ])
          expect(cmd).toContain(fragment);
        for (const absent of [
          '--privileged',
          '--cap-add',
          '--security-opt',
          '--entrypoint',
          '/dev/kvm',
        ])
          expect(cmd).not.toContain(absent);
      });

      it('adds /dev/kvm and its host group when nested, only where the host has it', () => {
        const nested = job({ requireNestedVirtualization: true });
        expect(
          DockerManager.getCommand(nested, undefined, false, {
            socket: 991,
            kvm: 994,
          }),
        ).toContain(
          '--group-add 991 --workdir /workspace --add-host host.docker.internal:host-gateway --device /dev/kvm --group-add 994',
        );
        expect(
          DockerManager.getCommand(nested, undefined, false, { socket: 991 }),
        ).not.toContain('/dev/kvm');
        // The submit-time display line names both groups it can't know yet.
        expect(DockerManager.getCommand(nested, undefined, true)).toContain(
          '--group-add <host-docker-socket-gid> --workdir /workspace --add-host host.docker.internal:host-gateway --device /dev/kvm --group-add <host-kvm-gid>',
        );
        // Without --host-docker, nesting alone passes nothing through.
        expect(
          DockerManager.getCommand(
            job({ hostDocker: false, requireNestedVirtualization: true }),
            undefined,
            false,
            { socket: 991, kvm: 994 },
          ),
        ).not.toMatch(/docker\.sock|\/dev\/kvm|--group-add|\/workspace/);
      });
    });

    it('should reject invalid Service env PORT values', () => {
      expect(() =>
        DockerManager.getCommand(
          mockStoredWorkload({
            workloadType: 'service',
            env: { PORT: 'not-a-port' },
          }),
        ),
      ).toThrow(
        'PORT must be an integer between 1 and 65535 for service workloads',
      );
    });

    it('should allow job containers to receive PORT without Service ingress', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({ env: { PORT: '9000' } }),
      );

      expect(cmd).toContain('PORT=9000');
      expect(cmd).not.toContain('0.0.0.0:80:9000');
      expect(cmd).not.toContain('0.0.0.0:80:8088');
    });

    it('should include WORKLOAD_ID and its 0.1.64 DEPLOYMENT_ID alias', () => {
      const cmd = DockerManager.getCommand(baseProps);

      expect(cmd).toContain("-e 'WORKLOAD_ID=test-workload'");
      expect(cmd).toContain("-e 'DEPLOYMENT_ID=test-workload'");
    });

    it('defaults Python output to unbuffered for live container logs', () => {
      const cmd = DockerManager.getCommand(baseProps);

      expect(cmd).toContain('PYTHONUNBUFFERED=1');
      expect(cmd.match(/PYTHONUNBUFFERED=/g)).toHaveLength(1);
    });

    it('preserves an explicit Python unbuffering opt-out', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({ env: { PYTHONUNBUFFERED: '' } }),
      );

      expect(cmd).toContain('PYTHONUNBUFFERED=');
      expect(cmd).not.toContain('PYTHONUNBUFFERED=1');
      expect(cmd.match(/PYTHONUNBUFFERED=/g)).toHaveLength(1);
    });

    it('emits --gpus all when conduct injects a GPU dockerOption', () => {
      // The conduct layer derives `{ gpus: 'all' }` from the resolved config
      // (isGPUVMType) and passes it as runtimeProps.dockerOptions; this
      // proves that flag actually reaches the docker run command.
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({ dockerOptions: { gpus: 'all' } }),
      );

      expect(cmd).toContain("--gpus 'all'");
    });

    describe('explicit NVIDIA device nodes', () => {
      const roots: string[] = [];
      afterEach(() => {
        for (const root of roots.splice(0)) {
          rmSync(root, { recursive: true, force: true });
        }
      });

      /** `nvidia-smi -q` lines for GPUs whose index order maps to these minors. */
      const smiQuery = (...minors: number[]) =>
        [
          '==============NVSMI LOG==============',
          '',
          `Attached GPUs                             : ${minors.length}`,
          ...minors.flatMap((minor, index) => [
            `GPU 00000001:0${index}:00.0`,
            '    Product Name                          : Tesla T4',
            `    Minor Number                          : ${minor}`,
            '    PCI',
            `        Bus Id                            : 00000001:0${index}:00.0`,
          ]),
        ].join('\n');

      /**
       * Runs the command in sh with stub docker and nvidia-smi on a PATH holding
       * only the stubs and awk; returns docker's argv. The nvidia-smi stub, like
       * the real one, rejects `--query-gpu` fields it lacks.
       */
      function runOnHost(
        gpus: string | undefined,
        nodes: string,
        smi?: string,
      ) {
        const root = mkdtempSync(join(tmpdir(), 'nvidia-nodes-'));
        roots.push(root);
        for (const node of nodes.split(' ').filter(Boolean)) {
          writeFileSync(join(root, node), '');
        }
        const stub = (name: string, body: string) => {
          writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`);
          chmodSync(join(root, name), 0o755);
        };
        stub('docker', `printf '%s\\n' "$@"`);
        if (smi !== undefined) {
          writeFileSync(join(root, 'smi-q.txt'), `${smi}\n`);
          stub(
            'nvidia-smi',
            `[ "$1" = -q ] && exec /bin/cat ${root}/smi-q.txt\necho 'Field is not a valid field to query.' >&2; exit 2`,
          );
        }
        const awk = execFileSync('/bin/sh', ['-c', 'command -v awk'], {
          encoding: 'utf8',
        }).trim();
        symlinkSync(awk, join(root, 'awk'));
        const cmd = DockerManager.getCommand(
          mockStoredWorkload({ dockerOptions: gpus ? { gpus } : null }),
        ).replaceAll('/dev/nvidia', `${root}/nvidia`);
        return execFileSync('/bin/sh', ['-c', cmd], {
          encoding: 'utf8',
          env: { PATH: root },
        })
          .trimEnd()
          .split('\n')
          .map((arg) => arg.replace(`${root}/`, ''));
      }
      const devices = (argv: string[]) =>
        argv.filter((_, i) => argv[i - 1] === '--device').join(' ');

      it('passes every GPU and control node for --gpus all', () => {
        const all = 'nvidiactl nvidia-uvm nvidia-uvm-tools nvidia0 nvidia1';
        const argv = runOnHost('all', `${all} nvidia-modeset`);
        expect(argv.join(' ')).toContain('--gpus all --device');
        expect(devices(argv)).toBe(all);
        expect(argv.at(-1)).toBe('nginx:latest');
      });

      it('maps a GPU count to the first indexes minor numbers', () => {
        const nodes = 'nvidiactl nvidia-uvm nvidia0 nvidia2 nvidia3';
        const argv = runOnHost('2', nodes, smiQuery(0, 2, 3));
        expect(argv.join(' ')).toContain('--gpus 2 --device');
        expect(devices(argv)).toBe('nvidiactl nvidia-uvm nvidia0 nvidia2');
      });

      it('skips missing nodes and keeps --gpus when nvidia-smi is absent', () => {
        const nodes = 'nvidiactl nvidia0';
        expect(devices(runOnHost('all', nodes))).toBe(nodes);
        expect(devices(runOnHost('all', ''))).toBe('');
        const argv = runOnHost('1', nodes);
        expect(argv.join(' ')).toContain('--gpus 1');
        expect(devices(argv)).toBe('nvidiactl');
      });

      it('passes no device for a CPU target', () => {
        expect(devices(runOnHost(undefined, 'nvidiactl'))).toBe('');
      });
    });

    it('emits no --gpus for a CPU target (dockerOptions undefined)', () => {
      const cmd = DockerManager.getCommand(
        mockStoredWorkload({ dockerOptions: undefined }),
      );

      expect(cmd).not.toContain('--gpus');
    });

    it('should include volume mounts for all configured buckets', () => {
      const cmd = DockerManager.getCommand(baseProps, {
        input: '/mnt/input',
        output: '/mnt/output',
        checkpoint: '/mnt/checkpoint',
      });

      expect(cmd).toContain('-v /mnt/input:/mnt/input:ro');
      expect(cmd).toContain('-v /mnt/output:/mnt/output');
      expect(cmd).toContain('-v /mnt/checkpoint:/mnt/checkpoint');
    });

    it('routes bucket mounts through explicit host paths without changing container paths', () => {
      const bucketHostPaths = bucketHostPathsForRoot(
        '/var/lib/anycloud/deployments/test-workload',
      );
      const cmd = DockerManager.getCommand(baseProps, {
        input: bucketHostPaths.input,
        output: bucketHostPaths.output,
        checkpoint: bucketHostPaths.checkpoint,
      });

      expect(cmd).toContain(
        '-v /var/lib/anycloud/deployments/test-workload/input:/mnt/input:ro',
      );
      expect(cmd).toContain(
        '-v /var/lib/anycloud/deployments/test-workload/output:/mnt/output',
      );
      expect(cmd).toContain(
        '-v /var/lib/anycloud/deployments/test-workload/checkpoint:/mnt/checkpoint',
      );
      expect(cmd).not.toContain('-v /mnt/input:/mnt/input:ro');
      expect(cmd).not.toContain('-v /mnt/output:/mnt/output');
      expect(cmd).not.toContain('-v /mnt/checkpoint:/mnt/checkpoint');
    });

    it('should include only configured bucket mounts', () => {
      const cmd = DockerManager.getCommand(baseProps, {
        output: '/mnt/output',
      });

      expect(cmd).toContain('-v /mnt/output:/mnt/output');
      expect(cmd).not.toContain('/mnt/input');
      expect(cmd).not.toContain('/mnt/checkpoint');
    });

    it('should mount input bucket as read-only', () => {
      const cmd = DockerManager.getCommand(baseProps, {
        input: '/mnt/input',
      });

      expect(cmd).toContain('-v /mnt/input:/mnt/input:ro');
    });

    it('should not include volume mounts when no buckets configured', () => {
      const cmd = DockerManager.getCommand(baseProps, undefined);

      expect(cmd).not.toContain('-v');
    });

    it('should not include checkpoint mount when checkpoint is undefined', () => {
      const cmd = DockerManager.getCommand(baseProps, {
        input: '/mnt/input',
        output: '/mnt/output',
        checkpoint: undefined, // No checkpoint for non-spot
      });

      expect(cmd).toContain('-v /mnt/input:/mnt/input:ro');
      expect(cmd).toContain('-v /mnt/output:/mnt/output');
      expect(cmd).not.toContain('/mnt/checkpoint');
    });

    it('should include checkpoint mount when checkpoint is provided for spot instances', () => {
      const cmd = DockerManager.getCommand(baseProps, {
        input: '/mnt/input',
        output: '/mnt/output',
        checkpoint: '/mnt/checkpoint',
      });

      expect(cmd).toContain('-v /mnt/input:/mnt/input:ro');
      expect(cmd).toContain('-v /mnt/output:/mnt/output');
      expect(cmd).toContain('-v /mnt/checkpoint:/mnt/checkpoint');
    });

    it('should redact explicit user secrets when redactSecrets=true', () => {
      const props = mockStoredWorkload({
        githubToken: 'super-secret-token',
        env: {
          API_KEY: 'my-api-key',
          PASSWORD: 'my-password',
          NORMAL_VAR: 'visible-value',
        },
      });

      const cmd = DockerManager.getCommand(props, undefined, true);

      expect(cmd).not.toContain('--env-file');
      expect(cmd).not.toContain('GITHUB_TOKEN=');
      expect(cmd).not.toContain('super-secret-token');

      // Explicit user secrets are still redacted in the diagnostic command.
      expect(cmd).toContain('API_KEY=<REDACTED>');
      expect(cmd).toContain('PASSWORD=<REDACTED>');
      expect(cmd).not.toContain('my-api-key');
      expect(cmd).not.toContain('my-password');

      // Normal vars should be visible
      expect(cmd).toContain('NORMAL_VAR=visible-value');
    });

    it('should never pass the registry token or username to the container', () => {
      const props = mockStoredWorkload({
        githubToken: 'super-secret-token',
        env: {
          API_KEY: 'my-api-key',
        },
      });

      const cmd = DockerManager.getCommand(props, undefined, false);

      expect(cmd).not.toContain('--env-file');
      expect(cmd).not.toContain('GITHUB_TOKEN=');
      expect(cmd).not.toContain('GITHUB_USER=');
      expect(cmd).not.toContain('super-secret-token');

      // Unredacted user env retains its existing behavior.
      expect(cmd).toContain('API_KEY=my-api-key');
      expect(cmd).not.toContain('<REDACTED>');
    });

    it('should redact various secret patterns case-insensitively', () => {
      const props = mockStoredWorkload({
        env: {
          // Various secret patterns
          password: 'secret1',
          PASSWD: 'secret2',
          secret_key: 'secret3',
          access_token: 'secret4',
          api_key: 'secret5',
          private_key: 'secret6',
          auth_header: 'secret7',
          bearer_token: 'secret8',
          session_id: 'secret9',
          // Non-secrets
          DEBUG: 'true',
          PORT: '8080',
        },
      });

      const cmd = DockerManager.getCommand(props, undefined, true);

      // All secret patterns should be redacted
      expect(cmd).toContain('password=<REDACTED>');
      expect(cmd).toContain('PASSWD=<REDACTED>');
      expect(cmd).toContain('secret_key=<REDACTED>');
      expect(cmd).toContain('access_token=<REDACTED>');
      expect(cmd).toContain('api_key=<REDACTED>');
      expect(cmd).toContain('private_key=<REDACTED>');
      expect(cmd).toContain('auth_header=<REDACTED>');
      expect(cmd).toContain('bearer_token=<REDACTED>');
      expect(cmd).toContain('session_id=<REDACTED>');

      // Non-secrets should be visible
      expect(cmd).toContain('DEBUG=true');
      expect(cmd).toContain('PORT=8080');
    });

    it('should include all docker options in command', () => {
      const props = mockStoredWorkload({
        dockerOptions: {
          gpus: 'all',
          shmSize: '8g',
          ipc: 'host',
        },
      });

      const cmd = DockerManager.getCommand(props);

      expect(cmd).toContain("--gpus 'all'");
      expect(cmd).toContain("--shm-size '8g'");
      expect(cmd).toContain("--ipc 'host'");
    });

    it('should include -v flags for binds when specified', () => {
      const props = mockStoredWorkload({
        dockerOptions: {
          binds: [
            '/var/run/docker.sock:/var/run/docker.sock',
            '/host/path:/container/path:ro',
          ],
        },
      });

      const cmd = DockerManager.getCommand(props);

      expect(cmd).toContain("-v '/var/run/docker.sock:/var/run/docker.sock'");
      expect(cmd).toContain("-v '/host/path:/container/path:ro'");
    });

    it('should create a configured Docker network before docker run', async () => {
      const dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      const execSpy = vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: 'container-id', stderr: '' });
      dockerManager.exec = execSpy;

      await dockerManager.startContainer(
        mockStoredWorkload({
          dockerOptions: { network: 'anycloud-control' },
        }),
      );

      expect(execSpy.mock.calls[0][0]).toContain(
        "docker network inspect 'anycloud-control'",
      );
      expect(
        execSpy.mock.calls.some((call) => call[0].includes('docker run')),
      ).toBe(true);
    });

    it('should not include -v flags when binds is empty', () => {
      const props = mockStoredWorkload({
        dockerOptions: { binds: [] },
      });

      const cmd = DockerManager.getCommand(props);

      expect(cmd).not.toContain('-v');
    });

    it('should append command args after image when command is specified', () => {
      const props = mockStoredWorkload({
        command: ['python', 'train.py', '--epochs', '10'],
      });

      const cmd = DockerManager.getCommand(props);

      // Command args should appear after the image
      expect(cmd).toMatch(
        /'nginx:latest'\s+'python'\s+'train.py'\s+'--epochs'\s+'10'/,
      );
    });

    it('should not append anything after image when command is empty', () => {
      const props = mockStoredWorkload({
        command: [],
      });

      const cmd = DockerManager.getCommand(props);

      // Image should be the last thing in the command
      expect(cmd).toMatch(/'nginx:latest'$/);
    });

    it('should not append anything after image when command is undefined', () => {
      const cmd = DockerManager.getCommand(baseProps);

      expect(cmd).toMatch(/'nginx:latest'$/);
    });

    it('should shell-escape command args with spaces', () => {
      const props = mockStoredWorkload({
        command: ['bash', '-c', 'echo hello world'],
      });

      const cmd = DockerManager.getCommand(props);

      expect(cmd).toContain("'bash'");
      expect(cmd).toContain("'-c'");
      expect(cmd).toContain("'echo hello world'");
    });

    it('should include complex env vars with bash commands in docker command', () => {
      const props = mockStoredWorkload({
        env: {
          OUTPUT_DIR: '/mnt/example-bucket/run_5_branch_test',
          CHECKOUT_BRANCH:
            'git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:" && git fetch && git checkout feature/branch_test && git pull',
          CONDA_ACTIVATE:
            'source /opt/conda/etc/profile.d/conda.sh && conda activate ml',
          CORE_CMD: 'python scripts/train.py output.dir=$OUTPUT_DIR',
          CMD: 'mkdir -p "$OUTPUT_DIR" && eval "$CHECKOUT_BRANCH"  && set -o pipefail && eval "$CONDA_ACTIVATE" && ( eval "$CORE_CMD" ) 2>&1 | tee $OUTPUT_DIR/log_$(date +%Y-%m-%d_%H-%M-%S).txt',
        },
      });

      const cmd = DockerManager.getCommand(props);

      // Command should include -e flags for each env var
      expect(cmd).toContain('-e');
      // Env vars should be properly escaped (shellEscape wraps in single quotes)
      expect(cmd).toContain(
        "'OUTPUT_DIR=/mnt/example-bucket/run_5_branch_test'",
      );
      expect(cmd).toContain('CHECKOUT_BRANCH=');
      expect(cmd).toContain('CONDA_ACTIVATE=');
      expect(cmd).toContain('CORE_CMD=');
      expect(cmd).toContain('CMD=');
      // Verify the complex command with pipes and redirects is included
      expect(cmd).toContain('tee');
      expect(cmd).toContain('conda activate');
    });
  });

  describe('startContainer runtime secret injection', () => {
    let dockerManager: DockerManager;
    let execSpy: Mock<ExecFn>;
    let writeFileSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      execSpy = vi
        .fn<ExecFn>()
        .mockResolvedValue({ code: 0, stdout: 'container-id', stderr: '' });
      dockerManager.exec = execSpy;
      writeFileSpy = vi.fn().mockResolvedValue(undefined);
      (dockerManager as any).writeFile = writeFileSpy;
    });

    function commandContaining(fragment: string): string | undefined {
      return execSpy.mock.calls
        .map((call) => call[0] as string)
        .find((command) => command.includes(fragment));
    }

    function writtenSecrets(): Record<string, string> {
      const envWrites = writeFileSpy.mock.calls.filter(
        ([path]) => path === SECRETS_ENV_FILE,
      );
      expect(envWrites).toHaveLength(1);
      const content = envWrites[0][1] as string;
      return Object.fromEntries(
        content.split('\n').map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
    }

    it('writes named secrets before docker run and never adds the registry token', async () => {
      await dockerManager.startContainer(
        mockStoredWorkload({
          githubToken: 'registry-token',
          secretNames: ['github'],
        }),
        undefined,
        [
          {
            name: 'github',
            revision: '0123456789abcdef',
            values: { GITHUB_TOKEN: 'named-secret-token' },
          },
        ],
      );

      expect(writtenSecrets()).toEqual({ GITHUB_TOKEN: 'named-secret-token' });
      // The Secret's file is written and swapped in before the container starts.
      expect(writeFileSpy).toHaveBeenCalledWith(
        '/run/anycloud-secrets/files/.github.0123456789abcdef/GITHUB_TOKEN',
        'named-secret-token',
        { mode: 0o444, directoryMode: 0o755 },
      );
      const swapIndex = execSpy.mock.calls.findIndex((call) =>
        (call[0] as string).includes('mv -T'),
      );

      const runIndex = execSpy.mock.calls.findIndex((call) =>
        (call[0] as string).includes('docker run'),
      );
      expect(runIndex).toBeGreaterThanOrEqual(0);
      expect(writeFileSpy.mock.invocationCallOrder[0]).toBeLessThan(
        execSpy.mock.invocationCallOrder[runIndex],
      );

      expect(swapIndex).toBeGreaterThanOrEqual(0);
      expect(swapIndex).toBeLessThan(runIndex);

      const dockerCommand = execSpy.mock.calls[runIndex][0] as string;
      expect(dockerCommand).toContain(`--env-file ${SECRETS_ENV_FILE}`);
      expect(dockerCommand).toContain(
        '-v /run/anycloud-secrets/files:/run/anycloud-secrets:ro',
      );
      expect(dockerCommand).not.toContain('registry-token');
      expect(dockerCommand).not.toContain('GITHUB_TOKEN=');
    });

    it('lets an explicit env value override a named secret', async () => {
      await dockerManager.startContainer(
        mockStoredWorkload({
          secretNames: ['runtime'],
          env: { GITHUB_TOKEN: 'explicit-env-token' },
        }),
        undefined,
        [
          {
            name: 'runtime',
            revision: '0123456789abcdef',
            values: {
              API_KEY: 'named-api-key',
              GITHUB_TOKEN: 'named-secret-token',
            },
          },
        ],
      );

      expect(writtenSecrets()).toEqual({
        API_KEY: 'named-api-key',
        GITHUB_TOKEN: 'named-secret-token',
      });

      const dockerCommand = commandContaining('docker run');
      expect(dockerCommand).toBeDefined();
      expect(dockerCommand!.match(/--env-file/g)).toHaveLength(1);
      expect(dockerCommand).toContain('GITHUB_TOKEN=explicit-env-token');
      expect(dockerCommand).not.toContain('named-secret-token');
    });

    it('does not write a secret file for a registry token alone', async () => {
      await dockerManager.startContainer(
        mockStoredWorkload({ githubToken: 'registry-token' }),
      );

      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(commandContaining('docker run')).not.toContain('--env-file');
    });

    it('does not write or reference a secret file without runtime secrets', async () => {
      await dockerManager.startContainer(mockStoredWorkload());

      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(commandContaining('docker run')).not.toContain('--env-file');
      expect(commandContaining('docker run')).not.toContain(
        '/run/anycloud-secrets',
      );
    });
  });

  describe('getContainerStatus uptime parsing', () => {
    let dockerManager: DockerManager;
    let execSpy: Mock<ExecFn>;

    beforeEach(() => {
      dockerManager = new DockerManager('127.0.0.1', 'fake-private-key');
      execSpy = vi.fn<ExecFn>();
      dockerManager.execResult = execSpy;
    });

    it('should correctly parse container state from JSON', async () => {
      execSpy.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify({
          Status: 'running',
          ExitCode: 0,
          StartedAt: '2024-01-15T14:30:45.123456789Z',
          OOMKilled: false,
          Error: '',
        }),
        stderr: '',
      });

      const status = await dockerManager.getContainerStatus('test-workload');

      expect(isContainerHealthy(status)).toBe(true);
      expect(status.state).toBe(ContainerState.Running);
      expect(status.uptime).toBeDefined();
      expect(status.uptime).not.toContain('NaN');
      expect(status.startedAt).toBe('2024-01-15T14:30:45.123456789Z');
      expect(Object.keys(status)).toContain('startedAt');
    });

    it('should return valid uptime format (days/hours/minutes/seconds)', async () => {
      // Set a timestamp from ~2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      execSpy.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify({
          Status: 'running',
          ExitCode: 0,
          StartedAt: twoHoursAgo.toISOString(),
          OOMKilled: false,
          Error: '',
        }),
        stderr: '',
      });

      const status = await dockerManager.getContainerStatus('test-workload');

      expect(status.uptime).toMatch(/^\d+[dhms]$/);
    });

    it('should report a missing container only when Docker is healthy', async () => {
      execSpy.mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'container not found',
      });
      execSpy.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

      const status = await dockerManager.getContainerStatus('test-workload');

      expect(isContainerHealthy(status)).toBe(false);
      expect(status.state).toBe(ContainerState.NotFound);
      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy.mock.calls[1][0]).toContain('docker info');
    });

    it('does not report a missing container when Docker is unavailable', async () => {
      // execResult resolves with the nonzero exit code (it does not reject);
      // a failing `docker info` means the daemon is down, so this must throw.
      execSpy
        .mockResolvedValueOnce({
          code: 1,
          stdout: '',
          stderr: 'connection failed',
        })
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });

      await expect(
        dockerManager.getContainerStatus('test-workload'),
      ).rejects.toThrow('Docker daemon unavailable (exit 1)');
    });

    it('should handle stopped container with exit code and OOM', async () => {
      // First call: docker inspect
      execSpy.mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          Status: 'exited',
          ExitCode: 137,
          StartedAt: '2024-01-15T14:30:45.123456789Z',
          OOMKilled: true,
          Error: '',
        }),
        stderr: '',
      });
      // Second call: docker logs
      execSpy.mockResolvedValueOnce({
        code: 0,
        stdout: 'Starting process\nError: out of memory\nProcess terminated',
        stderr: '',
      });

      const status = await dockerManager.getContainerStatus('test-workload');

      expect(isContainerHealthy(status)).toBe(false);
      expect(status.state).toBe(ContainerState.Exited);
      expect(status.exitCode).toBe(137);
      expect(status.oomKilled).toBe(true);
      expect(status.logs).toContain('Error: out of memory');
    });

    it('preserves exit code 7 when logs are unavailable', async () => {
      execSpy.mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          Status: 'exited',
          ExitCode: 7,
          StartedAt: '2024-01-15T14:30:45.123456789Z',
          OOMKilled: false,
          Error: '',
        }),
        stderr: '',
      });
      execSpy.mockRejectedValueOnce(new Error('log channel closed'));

      await expect(
        dockerManager.getContainerStatus('test-workload'),
      ).resolves.toMatchObject({
        state: ContainerState.Exited,
        exitCode: 7,
      });
    });

    describe('log filtering for non-running containers', () => {
      it('should show all logs when 6 or fewer lines', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Processing request\nUnhandled exception in module\nShutting down',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nProcessing request\nUnhandled exception in module\nShutting down',
        );
      });

      it('should filter logs containing "failed" keyword', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: 'Connecting to database\nDatabase connection failed\nExiting',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nConnecting to database\nDatabase connection failed\nExiting',
        );
      });

      it('should filter logs containing "fatal" keyword', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Starting service\nfatal: unable to allocate memory\nTerminating',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nStarting service\nfatal: unable to allocate memory\nTerminating',
        );
      });

      it('should filter logs containing "panic" keyword', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 2,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Initializing\npanic: runtime error: index out of range\ngoroutine exit',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nInitializing\npanic: runtime error: index out of range\ngoroutine exit',
        );
      });

      it('should filter logs containing "traceback" keyword', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Running script\nTraceback (most recent call last):\nProcess ended',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nRunning script\nTraceback (most recent call last):\nProcess ended',
        );
      });

      it('should filter logs containing "Error:" pattern', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: 'Loading modules\nError: ENOENT: file not found\nAborting',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nLoading modules\nError: ENOENT: file not found\nAborting',
        );
      });

      it('should filter stack trace lines matching "  at " pattern', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'TypeError: Cannot read property\n  at Module.load (module.js:123)\n  at Function.execute (index.js:45)\nExiting',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nTypeError: Cannot read property\n  at Module.load (module.js:123)\n  at Function.execute (index.js:45)\nExiting',
        );
      });

      it('should filter multiple error lines from mixed logs', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Starting server\nListening on port 8088\nConnection error: refused\nRetrying connection\nFatal: max retries reached\nShutdown complete',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nStarting server\nListening on port 8088\nConnection error: refused\nRetrying connection\nFatal: max retries reached\nShutdown complete',
        );
      });

      it('should return undefined logs when no error patterns found', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 0,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout:
            'Starting application\nProcessing items\nCompleted successfully\nShutdown gracefully',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBe(
          'Container logs:\nStarting application\nProcessing items\nCompleted successfully\nShutdown gracefully',
        );
      });

      it('should limit error lines to last 30 entries', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 1,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        // Generate 50 error lines
        const errorLines = Array.from(
          { length: 50 },
          (_, i) => `Error ${i + 1}: something went wrong`,
        );
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: errorLines.join('\n'),
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        // Should have both "Error logs:" section (last 30 errors) and "Container logs:" section (first 3, ..., last 3)
        expect(status.logs).toContain('Error logs:');
        expect(status.logs).toContain('Container logs:');
        expect(status.logs).toContain('Error 50:'); // Last error in Error logs section
        expect(status.logs).toContain('Error 21:'); // First error in Error logs section (50 - 30 + 1)
        expect(status.logs).toContain('Error 1:'); // First line in Container logs section
        expect(status.logs).toContain('Error 2:'); // Second line in Container logs section
        expect(status.logs).toContain('Error 3:'); // Third line in Container logs section
        expect(status.logs).toContain('...'); // Separator in Container logs section
        expect(status.logs).toContain('Error 48:'); // Third from last in Container logs section
        expect(status.logs).toContain('Error 49:'); // Second from last in Container logs section
      });

      it('should combine Docker State.Error with filtered container logs', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 127,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: 'OCI runtime create failed: executable not found',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: 'Starting process\nError: command not found\nExiting',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toContain(
          'Docker error: OCI runtime create failed',
        );
        expect(status.logs).toBe(
          'Docker error: OCI runtime create failed: executable not found\nContainer logs:\nStarting process\nError: command not found\nExiting',
        );
      });

      it('should handle empty logs gracefully', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'exited',
            ExitCode: 0,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: '',
          }),
          stderr: '',
        });
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: '',
          stderr: '',
        });

        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status.logs).toBeUndefined();
      });

      it('should not treat a created container default exit code as completion', async () => {
        execSpy.mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({
            Status: 'created',
            ExitCode: 0,
            StartedAt: '2024-01-15T14:30:45.123456789Z',
            OOMKilled: false,
            Error: 'container failed to start: permission denied',
          }),
          stderr: '',
        });
        const status = await dockerManager.getContainerStatus('test-workload');

        expect(status).toEqual({ state: ContainerState.Created });
        expect(execSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('writeSecretsEnvFile error handling', () => {
    it('throws a generic error that does not include transport output or the secret', async () => {
      const dockerManager = new DockerManager('10.0.0.5', 'fake-private-key');
      const secretValue = 'super-secret-token-xyz';
      (dockerManager as any).writeFile = vi
        .fn()
        .mockRejectedValue(
          new SSHExecError(
            'SSH file-write stream closed before completion',
            `unexpected stdout ${secretValue}`,
            `unexpected stderr ${secretValue}`,
          ),
        );

      // writeSecretsEnvFile is private; access via `any` for test.
      let caught: Error | undefined;
      try {
        await (dockerManager as any).writeSecretsEnvFile({ KEY: secretValue });
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toBe(
        'Failed to write secrets env file on 10.0.0.5',
      );
      // Neither the raw secret nor its base64 encoding should appear anywhere.
      expect(caught!.message).not.toContain(secretValue);
      // The thrown error must be a fresh Error without stdout/stderr props.
      expect((caught as any).stdout).toBeUndefined();
      expect((caught as any).stderr).toBeUndefined();
    });
  });
});
