import { randomBytes, randomInt } from 'node:crypto';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCKER_VERSION,
  RCLONE_VERSION,
} from '../../src/api/runtime-artifacts.js';
import {
  Local,
  localMachineName,
  runLocalSmolvmPreflight,
} from '../../src/api/services/gateways/local.js';
import { cleanupLocalSmolvmMachines } from '../../src/api/services/gateways/local-smolvm-cleanup.js';
import { LOCAL_SMOLVM_CONTRACT } from '../../src/api/services/gateways/local-smolvm-contract.js';
import {
  createDefaultLocalSmolvmRuntime,
  type LocalSmolvmRuntime,
  type LocalSmolvmRuntimeClient,
  type LocalSmolvmRuntimeConfig,
} from '../../src/api/services/gateways/local-smolvm-runtime.js';
import { SSHManager } from '../../src/api/services/gateways/ssh.js';
import {
  assertSmolvmHealth,
  isSmolvmPortInUse,
} from '../../src/api/services/gateways/smolvm-serve-client.js';
import { initializeVM } from '../../src/api/services/vm-initializer.js';
import { generateStartupScript } from '../../src/api/services/vm-startup-script.js';
import { CloudType, type CloudConfig } from '../../src/shared/cloud.js';
import { shellEscape } from '../../src/shared/utils.js';
import { verifyVmContainerProfile } from './helpers/vm-container-profile.js';

const RUNTIME_TIMEOUT_MS = 10 * 60 * 1000;
const BARE_GUEST_BASELINE = `set -eux
apk add --no-cache bash openssh-server curl python3 ca-certificates iptables coreutils findutils procps tar unzip util-linux
mkdir -p /root/.ssh /var/empty /run/sshd /var/run/sshd
chown root:root /root /var/empty
chmod 755 /root /var/empty /run/sshd /var/run/sshd
`;

describe.sequential('Local SmolVM runtime', () => {
  const runtime = createDefaultLocalSmolvmRuntime();
  const runId = `${Date.now().toString(36)}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const workloadPrefix = `runtime-${runId}`;
  const ownedMachinePrefix = `${runtime.config.machinePrefix}${workloadPrefix}`;
  const scopedRuntime: LocalSmolvmRuntime = {
    client: runtime.client,
    config: {
      ...runtime.config,
      machinePrefix: `${ownedMachinePrefix}-`,
    },
  };

  beforeAll(async () => {
    await cleanupOwnedMachines(runtime, ownedMachinePrefix);
  }, RUNTIME_TIMEOUT_MS);

  afterEach(async () => {
    await cleanupOwnedMachines(runtime, ownedMachinePrefix);
  }, RUNTIME_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupOwnedMachines(runtime, ownedMachinePrefix);
  }, RUNTIME_TIMEOUT_MS);

  it(
    'passes health and the disposable host preflight repeatedly without leaks',
    async () => {
      const health = assertSmolvmHealth(
        await runtime.client.health(),
        LOCAL_SMOLVM_CONTRACT.supportedVersion,
      );
      expect(health.version).toBe(LOCAL_SMOLVM_CONTRACT.supportedVersion);

      for (let iteration = 0; iteration < 2; iteration++) {
        const machineName = localMachineName(
          scopedRuntime.config.machinePrefix,
          'preflight',
          `preflight-${iteration}`,
        );
        await runLocalSmolvmPreflight(scopedRuntime, { machineName });
        expect(
          (await runtime.client.listMachines()).some(
            (machine) => machine.name === machineName,
          ),
        ).toBe(false);
      }
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    'cold-boots isolated VMs from the prepared runner image',
    async () => {
      const workloadId = `${workloadPrefix}-prepared`;
      const preflightId = `${workloadPrefix}-gateway-preflight`;
      const primaryKeypair = await SSHManager.generateKeypair();
      const siblingKeypair = await SSHManager.generateKeypair();
      const cloudConfig: CloudConfig = {
        cloudProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
      };
      const compute = new Local(completeCloudConfig(cloudConfig), {
        runtime: scopedRuntime,
        preflightIdFactory: () => preflightId,
      }).compute();
      const cloudIds: string[] = [];

      try {
        const primary = await compute.newVM({
          workloadId,
          vmId: `${workloadId}-0`,
          ipWhitelist: [],
          startupScript: generateStartupScript(primaryKeypair),
          version: 'local-smolvm-runtime',
          userId: 'local-smolvm-runtime',
        });
        cloudIds.push(primary.cloudId);
        expect(primary.sshHost).toBeTruthy();
        expect(primary.sshPort).toBeTruthy();
        if (!primary.sshHost || !primary.sshPort) {
          throw new Error(
            `Local VM ${primary.cloudId} did not publish an SSH endpoint`,
          );
        }

        const primarySsh = new SSHManager(
          primary.sshHost,
          primaryKeypair.privateKey,
          primary.sshPort,
          primary.sshUsername,
        );
        const { stdout: primaryHostKey } = await primarySsh.exec(
          "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'",
          1,
        );
        await primarySsh.exec(
          [
            'set -e',
            'test ! -e /etc/anycloud-key',
            `grep -qx ${shellEscape(primaryKeypair.publicKey)} /root/.ssh/authorized_keys`,
            `grep -qx ${shellEscape(LOCAL_SMOLVM_CONTRACT.runnerVersion)} /etc/anycloud-image-version`,
            `docker --version | grep -F ${shellEscape(DOCKER_VERSION)}`,
            `rclone version | head -n 1 | grep -F ${shellEscape(`v${RCLONE_VERSION}`)}`,
            'test -d /storage/docker',
            'test -s /etc/docker/daemon.json',
          ].join('\n'),
          1,
        );

        await initializeVM(primarySsh, {
          workloadId,
          vmIp: primary.sshHost,
        });
        const { stdout: workloadOutput } = await primarySsh.exec(
          [
            'set -e',
            `docker --version | grep -F ${shellEscape(DOCKER_VERSION)}`,
            `rclone version | head -n 1 | grep -F ${shellEscape(`v${RCLONE_VERSION}`)}`,
            'docker info >/dev/null',
            `test "$(docker info --format '{{.Driver}}')" = overlay2`,
            `test "$(docker info --format '{{.DockerRootDir}}')" = /storage/docker`,
            'docker image inspect busybox:1.36 >/dev/null',
            "docker run --rm busybox:1.36 sh -c 'printf initialized-ok'",
          ].join('\n'),
          1,
          false,
          180_000,
        );
        expect(workloadOutput).toContain('initialized-ok');

        await verifyVmContainerProfile({
          ssh: primarySsh,
          host: primary.sshHost,
          port: primary.sshPort,
          username: primary.sshUsername,
          privateKey: primaryKeypair.privateKey,
          idPrefix: workloadId,
          cloudProvider: CloudType.Local,
        });

        const sibling = await compute.newVM({
          workloadId,
          vmId: `${workloadId}-identity-sibling`,
          ipWhitelist: [],
          startupScript: generateStartupScript(siblingKeypair),
          version: 'local-smolvm-runtime',
          userId: 'local-smolvm-runtime',
        });
        cloudIds.push(sibling.cloudId);
        expect(sibling.sshHost).toBeTruthy();
        expect(sibling.sshPort).toBeTruthy();
        if (!sibling.sshHost || !sibling.sshPort) {
          throw new Error(
            `Local VM ${sibling.cloudId} did not publish an SSH endpoint`,
          );
        }

        const siblingSsh = new SSHManager(
          sibling.sshHost,
          siblingKeypair.privateKey,
          sibling.sshPort,
          sibling.sshUsername,
        );
        const { stdout: siblingHostKey } = await siblingSsh.exec(
          [
            `grep -qx ${shellEscape(siblingKeypair.publicKey)} /root/.ssh/authorized_keys`,
            `! grep -qx ${shellEscape(primaryKeypair.publicKey)} /root/.ssh/authorized_keys`,
            "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'",
          ].join(' && '),
          6,
        );
        expect(siblingHostKey.trim()).not.toBe(primaryHostKey.trim());
        await primarySsh.exec(
          `! grep -qx ${shellEscape(siblingKeypair.publicKey)} /root/.ssh/authorized_keys`,
          1,
        );
      } finally {
        if (cloudIds.length > 0) {
          const terminated = await compute.terminateVMs(
            [...cloudIds].reverse(),
          );
          expect([...terminated].sort()).toEqual([...cloudIds].sort());
        }
      }
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    'installs pinned Docker and rclone into one source-less bare VM',
    async () => {
      const name = `${ownedMachinePrefix}-bare-installer`.slice(0, 63);
      const keypair = await SSHManager.generateKeypair();
      let hostPort: number | undefined;

      try {
        // eslint-disable-next-line local/no-hand-written-retry-loops -- retries a port collision at once with a fresh random port, deleting the half-created VM between attempts
        for (let attempt = 1; attempt <= 3; attempt++) {
          const candidatePort = randomInt(20_000, 61_000);
          try {
            await runtime.client.createMachine({
              name,
              network: true,
              networkBackend: runtime.config.networkBackend,
              ports: [{ host: candidatePort, guest: 22 }],
              cpus: runtime.config.cpus,
              memoryMb: runtime.config.memoryMb,
              overlayGb: runtime.config.overlayGb,
              storageGb: runtime.config.storageGb,
            });
            await runtime.client.startMachine(name);
            hostPort = candidatePort;
            break;
          } catch (error) {
            await runtime.client.stopMachine(name).catch(() => undefined);
            await runtime.client
              .deleteMachine(name, true)
              .catch(() => undefined);
            if (!isSmolvmPortInUse(error) || attempt === 3) throw error;
          }
        }
        if (hostPort === undefined) {
          throw new Error(`bare installer VM ${name} did not receive SSH`);
        }

        await requireSuccessfulGuestExec(
          runtime.client,
          name,
          ['/bin/sh', '-s'],
          BARE_GUEST_BASELINE,
          120,
        );
        await requireSuccessfulGuestExec(
          runtime.client,
          name,
          ['/bin/bash', '-s'],
          generateStartupScript(keypair),
          runtime.config.setupTimeoutSecs,
        );

        const ssh = new SSHManager(
          runtime.config.sshHost,
          keypair.privateKey,
          hostPort,
          runtime.config.sshUsername,
        );
        await ssh.exec(
          '! command -v docker >/dev/null 2>&1 && ! command -v rclone >/dev/null 2>&1',
          6,
        );
        await initializeVM(ssh, {
          workloadId: `${workloadPrefix}-bare-installer`,
          vmIp: runtime.config.sshHost,
        });
        await ssh.exec(
          [
            `docker --version | grep -F ${shellEscape(DOCKER_VERSION)}`,
            `rclone version | head -n 1 | grep -F ${shellEscape(`v${RCLONE_VERSION}`)}`,
            'docker info >/dev/null',
          ].join(' && '),
          1,
          false,
          180_000,
        );
      } finally {
        await runtime.client.stopMachine(name).catch(() => undefined);
        await runtime.client.deleteMachine(name, true).catch(() => undefined);
      }
    },
    RUNTIME_TIMEOUT_MS,
  );
});

async function cleanupOwnedMachines(
  runtime: LocalSmolvmRuntime,
  machinePrefix: string,
): Promise<void> {
  const result = await cleanupLocalSmolvmMachines(
    {
      config: { machinePrefix },
      client: runtime.client,
    },
    { minAgeMs: null },
  );
  expect(result.errors).toEqual([]);
  const remaining = (await runtime.client.listMachines())
    .map((machine) => machine.name)
    .filter((name) => name.startsWith(machinePrefix));
  expect(remaining).toEqual([]);
}

async function requireSuccessfulGuestExec(
  client: LocalSmolvmRuntimeClient,
  machineName: string,
  command: string[],
  stdin: string,
  timeoutSecs: LocalSmolvmRuntimeConfig['setupTimeoutSecs'],
): Promise<void> {
  const result = await client.execMachine(machineName, {
    command,
    stdin,
    timeoutSecs,
  });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
}
