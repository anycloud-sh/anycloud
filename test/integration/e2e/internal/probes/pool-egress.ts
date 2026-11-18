import { randomBytes } from 'node:crypto';
import type { V1Pod } from '@kubernetes/client-node';
import type { KubernetesClients } from '../../../../../src/api/services/kubernetes/client.js';
import { INSTANCE_METADATA_CIDR } from '../../../../../src/api/services/gateways/cloud.js';
import {
  NODE_POOL_NODE_LABEL,
  nodePoolNamespace,
} from '../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { kubernetesE2EServeImage } from '../kubernetes-constants.js';
import type { PoolEgressObservation } from '../targets/cluster-node-pool.js';
import type { Waiter } from '../wait.js';

const METADATA_IP = INSTANCE_METADATA_CIDR.replace('/32', '');
const METADATA_PORT = 8254;
const PROBE_TIMEOUT_MS = 180_000;

function nginx(
  name: string,
  nodeName: string,
  extra: { hostNetwork?: boolean; command?: string } = {},
): V1Pod {
  return {
    metadata: { name, labels: { 'anycloud-e2e-egress': name } },
    spec: {
      nodeName,
      hostNetwork: extra.hostNetwork,
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'nginx',
          image: kubernetesE2EServeImage,
          ...(extra.command
            ? {
                command: ['sh', '-c', extra.command],
                securityContext: { privileged: true },
              }
            : {}),
          readinessProbe: {
            tcpSocket: { port: extra.hostNetwork ? METADATA_PORT : 80 },
          },
        },
      ],
    },
  };
}

/**
 * The kube-router controller K3s ships enforces a new Pod's policy shortly
 * after it starts, so each probe waits before its one request. Probes
 * resolve DNS through their Node, as replicas do.
 */
function probe(name: string, nodeName: string, url: string): V1Pod {
  return {
    metadata: { name, labels: { 'anycloud-e2e-egress': name } },
    spec: {
      nodeName,
      restartPolicy: 'Never',
      dnsPolicy: 'Default',
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'probe',
          image: kubernetesE2EServeImage,
          command: ['sh', '-c', `sleep 15; wget -q -T 5 -O /dev/null ${url}`],
        },
      ],
    },
  };
}

function waitForPod(
  clients: KubernetesClients,
  wait: Pick<Waiter, 'for'>,
  namespace: string,
  name: string,
  done: (pod: V1Pod) => boolean,
): Promise<V1Pod> {
  return wait.for(
    `pool egress probe Pod ${namespace}/${name}`,
    () => clients.core.readNamespacedPod({ namespace, name }),
    {
      timeoutMs: PROBE_TIMEOUT_MS,
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (pod) =>
        done(pod) ? undefined : `phase ${pod.status?.phase ?? 'unknown'}`,
    },
  );
}

const isReady = (condition: { type: string; status: string }) =>
  condition.type === 'Ready' && condition.status === 'True';
const ready = (pod: V1Pod) => pod.status?.conditions?.some(isReady) === true;

/**
 * One probe Pod per egress rule of a node pool namespace; each deny and the
 * internet probe are paired with a control from an unrestricted namespace.
 * The metadata target is an address the probe adds to one pool Node's
 * loopback, so it must run only on disposable local Nodes.
 */
export async function probePoolEgress(
  clients: KubernetesClients,
  wait: Pick<Waiter, 'for'>,
  nodePoolId: string,
): Promise<PoolEgressObservation> {
  const nodes = await clients.core.listNode({
    labelSelector: `${NODE_POOL_NODE_LABEL}=${nodePoolId}`,
  });
  const [nodeA, nodeB] = nodes.items
    .filter((node) => node.status?.conditions?.some(isReady))
    .map((node) => node.metadata!.name!);
  if (!nodeA || !nodeB) {
    throw new Error(`Pool egress probe: node pool ${nodePoolId} has <2 Nodes`);
  }
  const pool = nodePoolNamespace(nodePoolId);
  const control = `anycloud-e2e-egress-${randomBytes(4).toString('hex')}`;
  await clients.core.createNamespace({ body: { metadata: { name: control } } });
  try {
    const create = (namespace: string, body: V1Pod) =>
      clients.core.createNamespacedPod({ namespace, body });
    await Promise.all([
      create(control, nginx('target', nodeB)),
      create(pool, nginx('egress-peer', nodeB)),
      create(
        control,
        nginx('metadata', nodeA, {
          hostNetwork: true,
          command: [
            `ip addr add ${INSTANCE_METADATA_CIDR} dev lo`,
            `trap 'ip addr del ${INSTANCE_METADATA_CIDR} dev lo; exit 0' TERM`,
            `sed -i 's/80;/${String(METADATA_PORT)};/' /etc/nginx/conf.d/default.conf`,
            `nginx -g 'daemon off;' & wait`,
          ].join('; '),
        }),
      ),
    ]);
    const [target, peer] = await Promise.all([
      waitForPod(clients, wait, control, 'target', ready),
      waitForPod(clients, wait, pool, 'egress-peer', ready),
      waitForPod(clients, wait, control, 'metadata', ready),
    ]);
    const urls = {
      podIp: `http://${target.status!.podIP!}`,
      metadata: `http://${METADATA_IP}:${String(METADATA_PORT)}`,
      internet: 'http://example.com',
      crossNodePeer: `http://${peer.status!.podIP!}`,
    };
    const run = async (namespace: string, key: keyof typeof urls) => {
      const name = `probe-${key.toLowerCase()}`;
      await create(namespace, probe(name, nodeA, urls[key]));
      const pod = await waitForPod(
        clients,
        wait,
        namespace,
        name,
        (current) =>
          current.status?.phase === 'Succeeded' ||
          current.status?.phase === 'Failed',
      );
      return pod.status!.phase === 'Succeeded';
    };
    const [podIp, metadata, internet, crossNodePeer, ...controls] =
      await Promise.all([
        run(pool, 'podIp'),
        run(pool, 'metadata'),
        run(pool, 'internet'),
        run(pool, 'crossNodePeer'),
        run(control, 'podIp'),
        run(control, 'metadata'),
        run(control, 'internet'),
      ]);
    const [controlPodIp, controlMetadata, controlInternet] = controls;
    return {
      pool: { podIp, metadata, internet, crossNodePeer },
      control: {
        podIp: controlPodIp,
        metadata: controlMetadata,
        internet: controlInternet,
      },
    };
  } finally {
    await clients.core.deleteNamespace({ name: control });
    await clients.core.deleteCollectionNamespacedPod({
      namespace: pool,
      labelSelector: 'anycloud-e2e-egress',
    });
  }
}
