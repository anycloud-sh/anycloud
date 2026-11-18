import { z } from 'zod';

import {
  METADATA_NODE_POOL_BOOT,
  type CloudCompute,
} from '../../../../../../src/api/services/gateways/cloud.js';
import { DockerEngine } from './docker-engine.js';
import { NODE_EXTERNAL_IP_PLACEHOLDER } from '../../../../../../src/api/services/kubernetes/node-pool-join.js';
import {
  executeLocalKubernetesCommand,
  localKubernetesCommandSucceeds,
} from './command.js';
import {
  clusterLocalBootImagesTaint,
  clusterLocalDockerLabel,
  clusterLocalK3sImage,
  clusterLocalRegion,
  localClusterServerContainer,
  localClusterVmType,
} from './constants.js';

function clusterLocalInvariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The K3s agent configuration the production join script writes to
 * `/etc/rancher/k3s/config.yaml`. The fixture runs the same agent from the
 * same configuration in a container instead of a first-boot VM, so the join
 * endpoint, CA-pinned bootstrap token, Node name, labels and taints are the
 * ones the node pool controller issued. `node-external-ip` is rendered as a
 * placeholder the script fills from instance metadata at boot, or drops when
 * no metadata service answers; a container has none, so the fixture takes
 * the script's drop branch and the agent registers with its bridge address
 * only (the cluster reaches it through the agent tunnel either way).
 */
export const clusterLocalAgentConfigSchema = z
  .object({
    server: z.string().url(),
    token: z.string().regex(/^K10[0-9a-f]{64}::[a-z0-9]{6}\.[a-z0-9]{16}$/u),
    'node-name': z.string().min(1).max(63),
    'node-label': z.array(z.string().regex(/^[^=]+=[^=]*$/u)),
    'node-taint': z.array(z.string().regex(/^[^=]+=[^:]*:[A-Za-z]+$/u)),
    'node-external-ip': z.literal(NODE_EXTERNAL_IP_PLACEHOLDER),
  })
  .strict();

export type ClusterLocalAgentConfig = z.output<
  typeof clusterLocalAgentConfigSchema
>;

export function clusterLocalAgentConfigFromStartupScript(
  startupScript: string,
): ClusterLocalAgentConfig {
  const match = startupScript.match(
    /cat > \/etc\/rancher\/k3s\/config\.yaml <<'CONFIG'\n([\s\S]*?)\nCONFIG\n/u,
  );
  clusterLocalInvariant(
    match?.[1],
    'local node pool compute could not find the K3s agent configuration in the startup script',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(
      'local node pool compute could not parse the K3s agent configuration',
      { cause: error },
    );
  }
  return clusterLocalAgentConfigSchema.parse(parsed);
}

/**
 * A drop-in the join script writes under K3s's agent `etc`, so the agent
 * runs with it too: `KUBELET` for the kubelet, `CONTAINERD` for containerd.
 */
export function clusterLocalDropInFromStartupScript(
  startupScript: string,
  delimiter: 'KUBELET' | 'CONTAINERD',
): { path: string; content: string } {
  const match = startupScript.match(
    new RegExp(
      `cat > (/var/lib/rancher/k3s/agent/etc/[\\w./-]+) <<'${delimiter}'\n([\\s\\S]*?)\n${delimiter}\n`,
      'u',
    ),
  );
  clusterLocalInvariant(
    match?.[1] && match[2],
    `local node pool compute could not find the ${delimiter} drop-in in the startup script`,
  );
  return { path: match[1], content: match[2] };
}

export function localClusterVmRowIdFromAgentConfig(
  config: ClusterLocalAgentConfig,
): number {
  const attempt = config['node-label']
    .map((label) => label.match(/^anycloud\.sh\/attempt=(\d+)$/u)?.[1])
    .find(Boolean);
  const vmRowId = attempt ? Number(attempt) : NaN;
  clusterLocalInvariant(
    Number.isSafeInteger(vmRowId) && vmRowId > 0,
    'local node pool compute could not recover the attempt id from the Node labels',
  );
  return vmRowId;
}

export function localClusterNodeContainer(cloudId: string): string {
  return `anycloud-node-${cloudId}`;
}

export function clusterLocalCapacityNetwork(nodePoolId: string): string {
  return `anycloud-node-pool-${nodePoolId}`;
}

async function inspectLocalClusterNodeContainer(cloudId: string): Promise<{
  readonly running: boolean;
  readonly ip: string | undefined;
} | null> {
  const container = localClusterNodeContainer(cloudId);
  if (
    !(await localKubernetesCommandSucceeds('docker', ['inspect', container]))
  ) {
    return null;
  }
  const { stdout } = await executeLocalKubernetesCommand('docker', [
    'inspect',
    '--format',
    '{{.State.Running}}{{range .NetworkSettings.Networks}} {{.IPAddress}}{{end}}',
    container,
  ]);
  const [running, ...addresses] = stdout.trim().split(/\s+/u);
  return { running: running === 'true', ip: addresses.find(Boolean) };
}

/** Removes the container in any state; an agent that died on its own leaves its log first. */
async function removeLocalClusterNodeContainer(
  cloudId: string,
  container: { readonly running: boolean },
): Promise<void> {
  const name = localClusterNodeContainer(cloudId);
  if (!container.running) {
    try {
      const logs = await executeLocalKubernetesCommand(
        'docker',
        ['logs', '--tail', '200', name],
        { timeoutMs: 30_000 },
      );
      process.stderr.write(
        `--- ${name} exited on its own; last agent output ---\n${logs.stdout}${logs.stderr}`,
      );
    } catch (error) {
      process.stderr.write(`could not read ${name} logs: ${String(error)}\n`);
    }
  }
  await executeLocalKubernetesCommand('docker', ['rm', '--force', name]);
}

/**
 * The agent container is the VM and the K3s agent is its only process: a
 * container that exited is a VM that no longer exists. The node pool
 * controller observes it as a released host and replaces it, the way it
 * replaces a cloud VM that disappears; the exited container itself goes at
 * that first observation so the pool network can be removed and the pool
 * reads absent afterwards. Restarting the same container in place would
 * instead keep the agent's half-issued join state and loop on it.
 */
export async function observeLocalClusterVm(cloudId: string) {
  const container = await inspectLocalClusterNodeContainer(cloudId);
  if (!container) return null;
  if (!container.running) {
    await removeLocalClusterNodeContainer(cloudId, container);
    return null;
  }
  clusterLocalInvariant(
    container.ip,
    `local node pool VM ${cloudId} has no IP`,
  );
  return {
    cloudId,
    ip: container.ip,
    privateIp: container.ip,
    createdAt: Date.now(),
    region: clusterLocalRegion,
  };
}

export async function deleteLocalClusterVm(cloudId: string): Promise<void> {
  const container = await inspectLocalClusterNodeContainer(cloudId);
  if (!container) return;
  await removeLocalClusterNodeContainer(cloudId, container);
}

const KWOK_CLOUD_ID_LABEL = 'e2e.anycloud.sh/cloud-id';

/** `kubectl` on the management node, the manifest passed as an argument. */
function managementKubectl(runId: string, args: string, manifest = '') {
  return executeLocalKubernetesCommand('docker', [
    'exec',
    localClusterServerContainer(runId),
    'sh',
    '-c',
    `printf %s "$0" | kubectl ${args}`,
    manifest,
  ]);
}

/**
 * S12's KWOK "VM": a Node with the join configuration's name, labels and
 * taints, which the KWOK controller marks Ready and whose Pods it runs
 * without containers (`kwok.ts`). Its address is a stand-in from the
 * benchmarking range, unique per attempt.
 */
async function createKwokNode(
  runId: string,
  config: ClusterLocalAgentConfig,
  cloudId: string,
) {
  const vmRowId = localClusterVmRowIdFromAgentConfig(config);
  const split = (text: string) => text.split(/=(.*)/su, 2) as [string, string];
  await managementKubectl(
    runId,
    'create -f -',
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name: config['node-name'],
        labels: {
          ...Object.fromEntries(config['node-label'].map(split)),
          [KWOK_CLOUD_ID_LABEL]: cloudId,
        },
        annotations: { 'kwok.x-k8s.io/node': 'fake' },
      },
      spec: {
        taints: config['node-taint'].map((taint) => {
          const [key, rest] = split(taint);
          const [value, effect] = rest.split(':');
          return { key, value, effect };
        }),
      },
    }),
  );
  return kwokVm(cloudId, vmRowId);
}

function kwokVm(cloudId: string, vmRowId: number) {
  const ip = `198.18.${String((vmRowId >> 8) & 255)}.${String(vmRowId & 255)}`;
  return {
    cloudId,
    ip,
    privateIp: ip,
    createdAt: Date.now(),
    region: clusterLocalRegion,
  };
}

async function observeKwokVm(runId: string, cloudId: string) {
  const { stdout } = await managementKubectl(
    runId,
    `get nodes -l ${KWOK_CLOUD_ID_LABEL}=${cloudId} -o jsonpath='{.items[*].metadata.labels.anycloud\\.sh/attempt}'`,
  );
  const vmRowId = Number(stdout.trim());
  return stdout.trim() && Number.isSafeInteger(vmRowId)
    ? kwokVm(cloudId, vmRowId)
    : null;
}

/**
 * "Provisioning a VM" for a local node pool starts one privileged K3s agent
 * container that joins the cluster through the production join credential. The
 * agent never receives SSH, a cloud credential or a host mount.
 */
export function createClusterLocalCapacityCompute(input: {
  readonly createCloudCompute: typeof import('../../../../../../src/api/services/gateways/cloud.js').createCloudCompute;
  readonly CloudType: typeof import('../../../../../../src/shared/cloud.js').CloudType;
  readonly CloudFailureDiagnosis: typeof import('../../../../../../src/shared/cloud.js').CloudFailureDiagnosis;
  readonly runId: string;
  readonly region: string;
  /** Every launch here fails as AWS's capacity error. */
  readonly full: boolean;
  /** Its VMs are KWOK Nodes, not agent containers. */
  readonly kwok: boolean;
  /** Agents join tainted until the environment imports their images. */
  readonly bootImages: boolean;
}): CloudCompute {
  const { createCloudCompute, CloudType, CloudFailureDiagnosis, runId } = input;
  const docker = new DockerEngine();
  const observe = (cloudId: string) =>
    input.kwok ? observeKwokVm(runId, cloudId) : observeLocalClusterVm(cloudId);
  const remove = async (cloudId: string) => {
    if (!input.kwok) return deleteLocalClusterVm(cloudId);
    await managementKubectl(
      runId,
      `delete nodes -l ${KWOK_CLOUD_ID_LABEL}=${cloudId} --wait=false`,
    );
  };

  return createCloudCompute({
    type: CloudType.AWS,
    region: input.region,
    vmType: localClusterVmType,
    rawValidateCredentials: () => Promise.resolve(),
    rawClassifyError: (error) =>
      (error as { code?: unknown }).code === 'InsufficientInstanceCapacity'
        ? CloudFailureDiagnosis.CapacityExhausted
        : CloudFailureDiagnosis.TemporaryProviderFailure,
    rawNewVM: () =>
      Promise.reject(
        new Error('workload VM provisioning is outside this contract'),
      ),
    rawRequestVMTermination: remove,
    rawTerminateNetworking: () => Promise.resolve(),
    rawGetAllVMs: () => Promise.resolve([]),
    rawUpsertFirewall: () => Promise.resolve(),
    observeVMReleaseOnce: async (cloudId) =>
      (await observe(cloudId))
        ? { state: 'present' as const }
        : { state: 'release-candidate' as const },
    releaseConfirmMaxAttempts: 1,
    releaseConfirmWaitMs: 1,
    resourceScoped: {
      nodePoolBoot: METADATA_NODE_POOL_BOOT,
      async prepareResourceNetwork(_spec, scope) {
        const name = clusterLocalCapacityNetwork(scope.id);
        if (
          !(await localKubernetesCommandSucceeds('docker', [
            'network',
            'inspect',
            name,
          ]))
        ) {
          await executeLocalKubernetesCommand('docker', [
            'network',
            'create',
            '--label',
            `${clusterLocalDockerLabel}=true`,
            '--label',
            `com.anycloud.e2e-run=${runId}`,
            '--label',
            `com.anycloud.node-pool-id=${scope.id}`,
            name,
          ]);
        }
        return {};
      },
      async adoptResourceProvisioningAttempt(attempt) {
        return observe(attempt.vmId);
      },
      async newResourceVM(params) {
        if (input.full) {
          throw Object.assign(
            new Error(`local region ${input.region} is full`),
            { code: 'InsufficientInstanceCapacity' },
          );
        }
        const config = clusterLocalAgentConfigFromStartupScript(
          params.startupScript,
        );
        if (input.kwok) return createKwokNode(runId, config, params.vmId);
        const vmRowId = localClusterVmRowIdFromAgentConfig(config);
        const kubelet = clusterLocalDropInFromStartupScript(
          params.startupScript,
          'KUBELET',
        );
        const containerd = clusterLocalDropInFromStartupScript(
          params.startupScript,
          'CONTAINERD',
        );
        const container = localClusterNodeContainer(params.vmId);
        await docker.createContainer(container, {
          Image: clusterLocalK3sImage,
          // The agent starts with the join script's kubelet and containerd
          // drop-ins.
          Entrypoint: [
            '/bin/sh',
            '-c',
            'mkdir -p "${KUBELET_DROP_IN%/*}" "${CONTAINERD_DROP_IN%/*}" && printf \'%s\\n\' "$KUBELET_CONFIG" > "$KUBELET_DROP_IN" && printf \'%s\\n\' "$CONTAINERD_CONFIG" > "$CONTAINERD_DROP_IN" && exec /bin/k3s "$@"',
            'k3s',
          ],
          // No `--node-external-ip`: the script's no-metadata branch.
          Cmd: [
            'agent',
            '--node-name',
            config['node-name'],
            ...config['node-label'].flatMap((label) => ['--node-label', label]),
            ...config['node-taint'].flatMap((taint) => ['--node-taint', taint]),
            ...(input.bootImages
              ? [
                  '--node-taint',
                  `${clusterLocalBootImagesTaint}=loading:NoSchedule`,
                ]
              : []),
          ],
          Env: [
            `K3S_URL=${config.server}`,
            `K3S_TOKEN=${config.token}`,
            `KUBELET_DROP_IN=${kubelet.path}`,
            `KUBELET_CONFIG=${kubelet.content}`,
            `CONTAINERD_DROP_IN=${containerd.path}`,
            `CONTAINERD_CONFIG=${containerd.content}`,
          ],
          HostConfig: {
            Privileged: true,
            // No in-place restart: see observeLocalClusterVm.
            RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
            ExtraHosts: ['host.docker.internal:host-gateway'],
            // K3s's own container guidance: runtime sockets on tmpfs, as the
            // cluster already has.
            Tmpfs: { '/run': '', '/var/run': '' },
          },
          Labels: {
            [clusterLocalDockerLabel]: 'true',
            'com.anycloud.e2e-run': runId,
            'com.anycloud.node-pool-id': params.scope.id,
            'com.anycloud.attempt': String(vmRowId),
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [clusterLocalCapacityNetwork(params.scope.id)]: {},
            },
          },
        });
        await docker.startContainer(container);
        const vm = await observeLocalClusterVm(params.vmId);
        clusterLocalInvariant(
          vm,
          `local node pool compute did not create ${params.vmId}`,
        );
        return vm;
      },
      async terminateResourceNetwork(scope) {
        const name = clusterLocalCapacityNetwork(scope.id);
        if (
          await localKubernetesCommandSucceeds('docker', [
            'network',
            'inspect',
            name,
          ])
        ) {
          await executeLocalKubernetesCommand('docker', [
            'network',
            'rm',
            name,
          ]);
        }
      },
    },
  });
}
