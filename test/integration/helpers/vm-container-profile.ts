import { DockerManager } from '../../../src/api/services/docker.js';
import { pullImage } from '../../../src/api/services/host-runtime/image-delivery.js';
import { SSHManager } from '../../../src/api/services/gateways/ssh.js';
import { type StoredWorkload } from '../../../src/api/services/workload-record.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { shellEscape } from '../../../src/shared/utils.js';

export interface VmContainerProfileParams {
  ssh: SSHManager;
  host: string;
  port: number;
  username?: string;
  privateKey: string;
  idPrefix: string;
  cloudProvider: CloudType;
}

const ALPINE_322_IMAGE =
  'mirror.gcr.io/library/alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce';
const DOCKER_CLI_IMAGE =
  'mirror.gcr.io/library/docker:29.7.2-cli@sha256:000bb62ff495f986c9f5578eb67cc2cb98b91138eda81d7762d5371eb8a497fe';

/**
 * Exercise provider-neutral VM workload behavior against an already-running
 * VM host. Local SmolVM supplies the inexpensive host; every assertion belongs
 * to DockerManager's shared VM-container contract.
 */
export async function verifyVmContainerProfile({
  ssh,
  host,
  port,
  username,
  privateKey,
  idPrefix,
  cloudProvider,
}: VmContainerProfileParams): Promise<void> {
  const minimalId = `${idPrefix}-minimal`;
  const nonrootId = `${idPrefix}-nonroot`;
  const dockerId = `${idPrefix}-docker`;
  const nonrootImage = 'anycloud-vm-nonroot:test';
  const childImage = 'anycloud-vm-child:test';
  const fixtureDir = '/tmp/anycloud-vm-runtime-fixture';
  const workloadIds = [minimalId, nonrootId, dockerId];
  const manager = () => new DockerManager(host, privateKey, port, username);
  const removeResources = async () => {
    await ssh
      .exec(
        `docker rm -f ${workloadIds.map(shellEscape).join(' ')} >/dev/null 2>&1 || true`,
        1,
      )
      .catch(() => undefined);
    await ssh
      .exec(
        `docker image rm -f ${shellEscape(childImage)} ${shellEscape(nonrootImage)} >/dev/null 2>&1 || true`,
        1,
      )
      .catch(() => undefined);
    await ssh
      .exec(`rm -rf ${shellEscape(fixtureDir)}`, 1)
      .catch(() => undefined);
  };

  await removeResources();
  try {
    const minimalProps = vmWorkload(
      minimalId,
      ALPINE_322_IMAGE,
      privateKey,
      cloudProvider,
    );
    const minimalManager = manager();
    await pullImage(minimalManager, minimalProps);
    await minimalManager.startContainer(minimalProps);
    await minimalManager.assertVmContainerReady(minimalId);

    const [minimalInspect] = await inspectContainer(ssh, minimalId);
    contract(
      minimalInspect.Path === '/bin/sh',
      `minimal VM entrypoint was ${minimalInspect.Path}`,
    );
    contract(
      JSON.stringify(minimalInspect.Args) ===
        JSON.stringify(['-c', 'while :; do sleep 3600; done']),
      `minimal VM arguments were ${JSON.stringify(minimalInspect.Args)}`,
    );
    contract(
      minimalInspect.Config.WorkingDir === '/workspace',
      `minimal VM working directory was ${minimalInspect.Config.WorkingDir}`,
    );
    contract(
      minimalInspect.Config.User === '',
      `minimal VM unexpectedly set user ${minimalInspect.Config.User}`,
    );
    contract(minimalInspect.HostConfig.Init, 'minimal VM omitted Docker init');
    contract(
      minimalInspect.HostConfig.RestartPolicy.Name === 'unless-stopped',
      `minimal VM restart policy was ${minimalInspect.HostConfig.RestartPolicy.Name}`,
    );
    contract(
      Object.keys(minimalInspect.HostConfig.PortBindings ?? {}).length === 0,
      'minimal VM unexpectedly published a container port',
    );
    contract(
      minimalInspect.Config.Labels['sh.anycloud.managed'] === 'true' &&
        minimalInspect.Config.Labels['sh.anycloud.role'] === 'workload' &&
        minimalInspect.Config.Labels['sh.anycloud.deployment-id'] === minimalId,
      'minimal VM ownership labels were missing',
    );
    const { stdout: socketGid } = await ssh.exec(
      "stat -c '%g' /var/run/docker.sock",
      1,
    );
    contract(
      minimalInspect.HostConfig.GroupAdd.includes(socketGid.trim()),
      'minimal VM omitted the Docker socket group',
    );
    const { stdout: workspaceMode } = await ssh.exec(
      "stat -c '%a' /workspace",
      1,
    );
    contract(
      workspaceMode.trim() === '777',
      `workspace mode was ${workspaceMode.trim()}`,
    );
    contract(
      minimalInspect.Mounts.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === '/workspace' &&
          mount.Destination === '/workspace' &&
          mount.RW,
      ),
      'minimal VM omitted the workspace bind mount',
    );
    contract(
      minimalInspect.Mounts.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === '/var/run/docker.sock' &&
          mount.Destination === '/var/run/docker.sock' &&
          mount.RW,
      ),
      'minimal VM omitted the Docker socket bind mount',
    );
    await expectCommandFailure(
      ssh,
      `docker exec ${shellEscape(minimalId)} /bin/sh -c 'command -v docker >/dev/null'`,
    );

    await ssh.exec(
      `docker exec ${shellEscape(minimalId)} /bin/sh -c 'printf persistence > /workspace/persistence-marker'`,
      1,
    );
    await minimalManager.startContainer(minimalProps);
    await minimalManager.assertVmContainerReady(minimalId);
    const { stdout: persistence } = await ssh.exec(
      `docker exec ${shellEscape(minimalId)} cat /workspace/persistence-marker`,
      1,
    );
    contract(
      persistence.trim() === 'persistence',
      'VM workspace did not survive container recreation',
    );

    await ssh.exec(
      `install -d ${shellEscape(fixtureDir)} && cat > ${shellEscape(fixtureDir)}/Dockerfile <<'EOF'
FROM ${ALPINE_322_IMAGE}
RUN addgroup -g 23456 developer \\
    && adduser -D -u 12345 -G developer -h /home/developer developer
ENV HOME=/home/developer
USER 12345:23456
WORKDIR /home/developer
EOF
docker build -t ${shellEscape(nonrootImage)} ${shellEscape(fixtureDir)} >/dev/null`,
      1,
      false,
      120_000,
    );
    const nonrootManager = manager();
    await nonrootManager.startContainer(
      vmWorkload(nonrootId, nonrootImage, privateKey, cloudProvider),
    );
    await nonrootManager.assertVmContainerReady(nonrootId);
    const [nonrootInspect] = await inspectContainer(ssh, nonrootId);
    contract(
      nonrootInspect.Config.User === '12345:23456',
      `non-management VM user was ${nonrootInspect.Config.User}`,
    );
    const { stdout: identity } = await ssh.exec(
      `docker exec ${shellEscape(nonrootId)} /bin/sh -c 'printf "%s:%s:%s" "$(id -u)" "$(id -g)" "$HOME"'`,
      1,
    );
    contract(
      identity.trim() === '12345:23456:/home/developer',
      `non-management VM identity was ${identity.trim()}`,
    );

    const dockerManager = manager();
    const dockerProps = vmWorkload(
      dockerId,
      DOCKER_CLI_IMAGE,
      privateKey,
      cloudProvider,
    );
    await pullImage(dockerManager, dockerProps);
    await dockerManager.startContainer(dockerProps);
    await dockerManager.assertVmContainerReady(dockerId);
    await ssh.exec(
      `docker exec ${shellEscape(dockerId)} docker info >/dev/null`,
      1,
    );
    const nestedDockerScript = [
      'mkdir -p /workspace/build /workspace/bind',
      `printf 'FROM ${ALPINE_322_IMAGE}\\nRUN echo built >/built\\n' > /workspace/build/Dockerfile`,
      `printf 'same-path\\n' > /workspace/bind/marker`,
      `docker build -t ${childImage} /workspace/build >/dev/null`,
      `test "$(docker run --rm ${childImage} cat /built)" = built`,
      `test "$(docker run --rm -v /workspace/bind:/data:ro ${ALPINE_322_IMAGE} cat /data/marker)" = same-path`,
    ].join(' && ');
    await ssh.exec(
      `docker exec ${shellEscape(dockerId)} /bin/sh -c ${shellEscape(nestedDockerScript)}`,
      1,
      false,
      120_000,
    );
  } finally {
    await removeResources();
  }
}

function vmWorkload(
  id: string,
  image: string,
  privateKey: string,
  cloudProvider: CloudType,
): StoredWorkload {
  return {
    id,
    userId: 'vm-container-profile',
    registryUsername: 'vm-container-profile',
    deploymentId: null,
    nodePoolId: null,
    nodePoolName: null,
    currentExecutionId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    firstClaimedAt: null,
    workloadType: WorkloadType.Vm,
    image,
    cloudProvider,
    region: 'local',
    vmType: 'local',
    gpuType: null,
    spot: false,
    state: WorkloadState.Running,
    startedAt: Date.now(),
    completedAt: null,
    cleanedAt: null,
    endReason: null,
    lastAttemptEndReason: null,
    maxRetries: null,
    noCheckpoint: false,
    requireNestedVirtualization: false,
    hostDocker: false,
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 1,
    sshPrivateKey: privateKey,
    credentialId: null,
    inputStorageCredentialId: null,
    inputStorageRegion: null,
    outputStorageCredentialId: null,
    outputStorageRegion: null,
    checkpointStorageCredentialId: null,
    checkpointStorageRegion: null,
    command: ['ignored-by-vm-profile'],
    imageDigest: null,
    imageRuntime: null,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId: null,
    publicEndpoint: null,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
    latestMessage: null,
  };
}

interface ContainerInspection {
  Path: string;
  Args: string[];
  Config: {
    User: string;
    WorkingDir: string;
    Labels: Record<string, string>;
  };
  HostConfig: {
    Init: boolean;
    GroupAdd: string[];
    PortBindings: Record<string, unknown> | null;
    RestartPolicy: { Name: string };
  };
  Mounts: Array<{
    Type: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;
}

async function inspectContainer(
  ssh: SSHManager,
  id: string,
): Promise<ContainerInspection[]> {
  const { stdout } = await ssh.exec(`docker inspect ${shellEscape(id)}`, 1);
  return JSON.parse(stdout) as ContainerInspection[];
}

async function expectCommandFailure(
  ssh: SSHManager,
  command: string,
): Promise<void> {
  try {
    await ssh.exec(command, 1);
  } catch {
    return;
  }
  throw new Error(`command unexpectedly succeeded: ${command}`);
}

function contract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
