import type { RemoteExecutor } from './remote.js';
import type {
  CommandResult,
  WorkloadFixtureObservation,
  WorkloadInspection,
} from './types.js';
import { isRecord } from './types.js';
import { retryTransientProbeError } from './wait.js';
import type { Waiter } from './wait.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeWorkloadId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`Unsafe VM workload ID: ${value}`);
  }
  return value;
}

function requireSuccess(label: string, result: CommandResult): string {
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.spawnError
  ) {
    throw new Error(
      `${label} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}): ${result.combined}`,
    );
  }
  return result.stdout.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error(`${label}.${key} was not boolean`);
  }
  return field;
}

export class VmHarness {
  readonly #remote: RemoteExecutor;
  readonly #wait: Waiter;

  constructor(remote: RemoteExecutor, wait: Waiter) {
    this.#remote = remote;
    this.#wait = wait;
  }

  async inspectWorkload(workloadId: string): Promise<WorkloadInspection> {
    const id = safeWorkloadId(workloadId);
    const dockerSocketGid = requireSuccess(
      'Docker socket group inspection',
      await this.#remote.run(id, 'vm', "stat -c '%g' /var/run/docker.sock"),
    );
    if (!/^\d+$/u.test(dockerSocketGid)) {
      throw new Error(
        `Docker socket returned invalid group ${dockerSocketGid || '<empty>'}`,
      );
    }
    const workspaceMode = requireSuccess(
      'workspace mode inspection',
      await this.#remote.run(id, 'vm', "stat -c '%a' /workspace"),
    );
    const inspectionResult = await this.#remote.run(
      id,
      'vm',
      `docker inspect ${shellQuote(id)}`,
    );
    const output = requireSuccess('workload inspection', inspectionResult);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error('Docker inspection did not return exactly one container');
    }
    const container = record(parsed[0], 'container');
    const args: unknown = container.Args;
    if (
      !Array.isArray(args) ||
      !args.every(
        (argument): argument is string => typeof argument === 'string',
      )
    ) {
      throw new Error('container.Args was not an array of strings');
    }
    const state = record(container.State, 'container.State');
    const config = record(container.Config, 'container.Config');
    if (typeof config.User !== 'string') {
      throw new Error('container.Config.User was not a string');
    }
    const hostConfig = record(container.HostConfig, 'container.HostConfig');
    const restartPolicy = record(
      hostConfig.RestartPolicy,
      'container.HostConfig.RestartPolicy',
    );
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const groupAdd = Array.isArray(hostConfig.GroupAdd)
      ? hostConfig.GroupAdd.map(String)
      : [];
    const portBindings =
      hostConfig.PortBindings === null
        ? {}
        : record(hostConfig.PortBindings, 'container.HostConfig.PortBindings');
    const mounts = Array.isArray(container.Mounts)
      ? container.Mounts.filter(isRecord)
      : [];
    const runtimeResult = await this.#remote.run(
      id,
      'vm',
      `docker exec ${shellQuote(id)} /bin/sh -lc ${shellQuote('[ "$PWD" = /workspace ] && [ -w /workspace ] && [ -S /var/run/docker.sock ] && [ -r /var/run/docker.sock ] && [ -w /var/run/docker.sock ]')}`,
    );

    return {
      args,
      dockerSocketGroupAdded: groupAdd.includes(dockerSocketGid),
      dockerSocketGid,
      initEnabled: hostConfig.Init === true,
      managedLabel:
        typeof labels['sh.anycloud.managed'] === 'string'
          ? labels['sh.anycloud.managed']
          : '',
      name: typeof container.Name === 'string' ? container.Name : '',
      path: typeof container.Path === 'string' ? container.Path : '',
      running: state.Running === true,
      workloadIdLabel:
        typeof labels['sh.anycloud.deployment-id'] === 'string'
          ? labels['sh.anycloud.deployment-id']
          : '',
      roleLabel:
        typeof labels['sh.anycloud.role'] === 'string'
          ? labels['sh.anycloud.role']
          : '',
      workingDirectory:
        typeof config.WorkingDir === 'string' ? config.WorkingDir : '',
      workspaceMode,
      restartPolicy:
        typeof restartPolicy.Name === 'string' ? restartPolicy.Name : '',
      publishedPortCount: Object.keys(portBindings).length,
      writableWorkspaceMountCount: mounts.filter(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === '/workspace' &&
          mount.Destination === '/workspace' &&
          mount.RW === true,
      ).length,
      writableDockerSocketMountCount: mounts.filter(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === '/var/run/docker.sock' &&
          mount.Destination === '/var/run/docker.sock' &&
          mount.RW === true,
      ).length,
      runtimePathsAccessible: runtimeResult.exitCode === 0,
      user: config.User,
    };
  }

  async probeWorkloadFixture(
    workloadId: string,
    environmentMarker: string,
    secretDigest: string,
  ): Promise<WorkloadFixtureObservation> {
    const id = safeWorkloadId(workloadId);
    const script = [
      'pwd_ok=false',
      'env_present=false',
      'env_matches=false',
      'secret_present=false',
      'secret_matches=false',
      '[ "$PWD" = /workspace ] && pwd_ok=true',
      '[ "${VM_SMOKE_ENV_MARKER+x}" = x ] && env_present=true',
      `[ "\${VM_SMOKE_ENV_MARKER:-}" = ${shellQuote(environmentMarker)} ] && env_matches=true`,
      '[ "${VM_SMOKE_SECRET_TOKEN+x}" = x ] && secret_present=true',
      'actual_digest=$(printf "%s" "${VM_SMOKE_SECRET_TOKEN:-}" | sha256sum)',
      `[ "\${actual_digest%% *}" = ${shellQuote(secretDigest)} ] && secret_matches=true`,
      'printf \'{"workingDirectoryMatches":%s,"environmentPresent":%s,"environmentMatches":%s,"secretPresent":%s,"secretDigestMatches":%s}\\n\' "$pwd_ok" "$env_present" "$env_matches" "$secret_present" "$secret_matches"',
    ].join('; ');
    const result = await this.#remote.run(
      id,
      'container',
      `docker exec ${shellQuote(id)} /bin/sh -lc ${shellQuote(script)}`,
    );
    const output = requireSuccess('workload fixture probe', result);
    const parsed = record(JSON.parse(output), 'workload fixture observation');
    return {
      workingDirectoryMatches: booleanField(
        parsed,
        'workingDirectoryMatches',
        'observation',
      ),
      environmentPresent: booleanField(
        parsed,
        'environmentPresent',
        'observation',
      ),
      environmentMatches: booleanField(
        parsed,
        'environmentMatches',
        'observation',
      ),
      secretPresent: booleanField(parsed, 'secretPresent', 'observation'),
      secretDigestMatches: booleanField(
        parsed,
        'secretDigestMatches',
        'observation',
      ),
    };
  }

  async verifyHostDocker(
    workloadId: string,
    successMarker: string,
  ): Promise<string> {
    const id = safeWorkloadId(workloadId);
    const result = await this.#remote.run(
      id,
      'vm',
      `test -S /var/run/docker.sock && docker info >/dev/null && printf '%s\\n' ${shellQuote(successMarker)}`,
    );
    return requireSuccess('host Docker probe', result);
  }

  async writeWorkspaceMarker(
    workloadId: string,
    filename: string,
    marker: string,
  ): Promise<void> {
    const id = safeWorkloadId(workloadId);
    if (!/^[a-zA-Z0-9._-]+$/u.test(filename)) {
      throw new Error(`Unsafe workspace marker filename: ${filename}`);
    }
    const inner = `printf '%s\\n' ${shellQuote(marker)} > ${shellQuote(`/workspace/${filename}`)}`;
    const result = await this.#remote.run(
      id,
      'vm',
      `docker exec ${shellQuote(id)} /bin/sh -lc ${shellQuote(inner)}`,
    );
    requireSuccess('write workspace marker', result);
  }

  async workloadContainerId(workloadId: string): Promise<string> {
    const id = safeWorkloadId(workloadId);
    const result = await this.#remote.run(
      id,
      'vm',
      `docker inspect --format '{{.Id}}' ${shellQuote(id)}`,
    );
    const containerId = requireSuccess('read workload container ID', result);
    if (!/^[a-f0-9]{12,}$/u.test(containerId)) {
      throw new Error(
        `Docker returned an invalid container ID: ${containerId}`,
      );
    }
    return containerId;
  }

  async removeWorkload(workloadId: string): Promise<void> {
    const id = safeWorkloadId(workloadId);
    const result = await this.#remote.run(
      id,
      'vm',
      `docker rm -f ${shellQuote(id)}`,
    );
    requireSuccess('remove workload container', result);
  }

  /** Paths under root's Docker config or `/run/anycloud` that hold a GHCR
   * login, or a per-pull Docker config the API left behind. */
  async ghcrCredentialFiles(workloadId: string): Promise<string[]> {
    const id = safeWorkloadId(workloadId);
    const result = await this.#remote.run(
      id,
      'vm',
      "{ grep -rlsF ghcr.io /root/.docker /run/anycloud; find /run/anycloud -mindepth 1 -maxdepth 1 -name 'docker-config-*'; } 2>/dev/null | sort -u",
    );
    return requireSuccess('list GHCR credential files', result)
      .split('\n')
      .filter(Boolean);
  }

  /** Leave a GHCR login where earlier releases did, then remove the
   * Workload's container and image so the repair pulls again. */
  async seedLegacyGhcrLoginAndRemoveWorkload(
    workloadId: string,
  ): Promise<void> {
    const id = safeWorkloadId(workloadId);
    // A placeholder credential ("legacy:placeholder"), not a real token.
    const legacy = '{"auths":{"ghcr.io":{"auth":"bGVnYWN5OnBsYWNlaG9sZGVy"}}}';
    const result = await this.#remote.run(
      id,
      'vm',
      `mkdir -p /root/.docker && printf '%s\\n' ${shellQuote(legacy)} > /root/.docker/config.json && image=$(docker inspect --format '{{.Image}}' ${shellQuote(id)}) && docker rm -f ${shellQuote(id)} && docker rmi -f "$image"`,
    );
    requireSuccess('seed a legacy GHCR login and remove the workload', result);
  }

  async waitForRepair(
    workloadId: string,
    originalContainerId: string,
    markerFilename: string,
    marker: string,
    timeoutMs: number,
  ): Promise<string> {
    const id = safeWorkloadId(workloadId);
    return this.#wait.for(
      `workload repair for ${id}`,
      async () => {
        const inspection = await this.#remote.run(
          id,
          'vm',
          `docker inspect --format '{{.Id}} {{.State.Running}}' ${shellQuote(id)} 2>/dev/null`,
        );
        if (inspection.exitCode !== 0) return '';
        const [candidateId, running] = inspection.stdout.trim().split(/\s+/u);
        if (
          !candidateId ||
          candidateId === originalContainerId ||
          running !== 'true'
        ) {
          return '';
        }
        const markerScript = `test "$(cat ${shellQuote(`/workspace/${markerFilename}`)})" = ${shellQuote(marker)}`;
        const markerResult = await this.#remote.run(
          id,
          'vm',
          `docker exec ${shellQuote(id)} /bin/sh -lc ${shellQuote(markerScript)}`,
        );
        return markerResult.exitCode === 0 ? candidateId : '';
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: retryTransientProbeError,
        unmet: (candidateId) =>
          candidateId.length > 0 ? undefined : 'container not repaired',
      },
    );
  }
}
