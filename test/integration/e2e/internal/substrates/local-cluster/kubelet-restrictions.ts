import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import {
  ATTEMPT_NODE_LABEL,
  NODE_POOL_MEMBER_LABEL,
  nodePoolNodeName,
} from '../../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  FLANNEL_ANNOTATION_PREFIX,
  K3S_CONTROLLER_USER,
  NODE_STATUS_POLICY_NAME,
} from '../../../../../../src/api/services/kubernetes/cluster-addons.js';
import { MANAGEMENT_MEMBER_LABEL } from '../../../../../../src/shared/system-release.js';
import { executeLocalKubernetesCommand } from './command.js';

const AGENT = '/var/lib/rancher/k3s/agent';

/**
 * What this rests on, checked from a pool agent with its own Node's kubelet
 * credential, which a root process on the Node can read: NodeRestriction
 * refuses that credential the protected labels on its own Node, and the K3s
 * supervisor refuses it a kubelet certificate for another Node name. The
 * shared K3s controller certificate on the same Node may change only
 * flannel's annotations on another Node's status. Each refusal has a
 * control that the same request succeeds where it should, so a wrong path or
 * credential can't pass as a refusal.
 */
export async function assertKubeletRestrictions(input: {
  clients: KubernetesClients;
  server: string;
  nodePoolId: string;
}): Promise<void> {
  const { items } = await input.clients.core.listNode({
    labelSelector: `${NODE_POOL_MEMBER_LABEL}=${input.nodePoolId}`,
  });
  const node = items[0];
  const name = node?.metadata?.name;
  if (!node || !name) {
    throw new Error(`Node pool ${input.nodePoolId} has no member Node`);
  }
  const attempt = Number(node.metadata?.labels?.[ATTEMPT_NODE_LABEL]);
  const { stdout } = await executeLocalKubernetesCommand('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.anycloud.node-pool-id=${input.nodePoolId}`,
    '--filter',
    `label=com.anycloud.attempt=${String(attempt)}`,
  ]);
  const container = stdout.trim();
  if (!container || container.includes('\n')) {
    throw new Error(`Node ${name} has no single agent container`);
  }

  // A dry run still passes admission, so nothing changes on the Node.
  const label = (key: string) =>
    executeLocalKubernetesCommand('docker', [
      'exec',
      container,
      'kubectl',
      '--kubeconfig',
      `${AGENT}/kubelet.kubeconfig`,
      'label',
      'node',
      name,
      `${key}=probe`,
      '--overwrite',
      '--dry-run=server',
    ]).then(
      () => 'allowed',
      (error: Error) => error.message,
    );
  const control = await label('anycloud.sh/kubelet-probe');
  if (control !== 'allowed') {
    throw new Error(`Node ${name}'s kubelet can't label itself: ${control}`);
  }
  for (const key of [
    NODE_POOL_MEMBER_LABEL,
    MANAGEMENT_MEMBER_LABEL,
    'node-role.kubernetes.io/control-plane',
  ]) {
    const outcome = await label(key);
    if (!/forbidden/iu.test(outcome)) {
      throw new Error(`Node ${name}'s kubelet set ${key}: ${outcome}`);
    }
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'kubelet-probe-'));
  try {
    for (const file of [
      `${AGENT}/client-kubelet.crt`,
      `${AGENT}/client-kubelet.key`,
      `${AGENT}/client-k3s-controller.crt`,
      `${AGENT}/client-k3s-controller.key`,
      '/etc/rancher/node/password',
    ]) {
      await executeLocalKubernetesCommand('docker', [
        'cp',
        `${container}:${file}`,
        directory,
      ]);
    }
    const password = (
      await readFile(path.join(directory, 'password'), 'utf8')
    ).trim();
    // TLS to the supervisor isn't what is checked: its authorization is.
    const certificate = async (nodeName: string) =>
      (
        await executeLocalKubernetesCommand('curl', [
          '--silent',
          '--insecure',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--cert',
          path.join(directory, 'client-kubelet.crt'),
          '--key',
          path.join(directory, 'client-kubelet.key'),
          '--header',
          `K3s-Node-Name: ${nodeName}`,
          '--header',
          `K3s-Node-Password: ${password}`,
          `${input.server}/v1-k3s/client-kubelet.crt`,
        ])
      ).stdout;
    const own = await certificate(name);
    if (own !== '200') {
      throw new Error(
        `The supervisor refused Node ${name} its own certificate: HTTP ${own}`,
      );
    }
    // The next attempt's Node, which hasn't registered.
    const other = await certificate(
      nodePoolNodeName(input.nodePoolId, attempt + 1),
    );
    // K3s answers a name that isn't the certificate's with 400 (run
    // 41893851628); the control above rules out any other cause.
    if (!/^4\d\d$/u.test(other)) {
      throw new Error(
        `The supervisor answered Node ${name}'s request for another Node's certificate with HTTP ${other}`,
      );
    }

    // A dry run still passes admission, so nothing changes on the Node.
    const target = (await input.clients.core.listNode()).items.find(
      (entry) => entry.metadata?.name !== name,
    )?.metadata?.name;
    if (!target) throw new Error(`No Node other than ${name} to patch`);
    const status = async (patch: unknown) => {
      const { stdout } = await executeLocalKubernetesCommand('curl', [
        '--silent',
        '--insecure',
        '--write-out',
        '\n%{http_code}',
        '--cert',
        path.join(directory, 'client-k3s-controller.crt'),
        '--key',
        path.join(directory, 'client-k3s-controller.key'),
        '--request',
        'PATCH',
        '--header',
        'Content-Type: application/merge-patch+json',
        '--data',
        JSON.stringify(patch),
        `${input.server}/api/v1/nodes/${target}/status?dryRun=All`,
      ]);
      const code = stdout.slice(stdout.lastIndexOf('\n') + 1);
      return code === '200'
        ? 'allowed'
        : stdout.includes(NODE_STATUS_POLICY_NAME)
          ? 'denied'
          : `HTTP ${code}`;
    };
    const flannel = await status({
      metadata: {
        annotations: { [`${FLANNEL_ANNOTATION_PREFIX}probe`]: 'x' },
      },
    });
    if (flannel !== 'allowed') {
      throw new Error(
        `${K3S_CONTROLLER_USER} can't write flannel's annotation on Node ${target}: ${flannel}`,
      );
    }
    for (const [what, patch] of [
      ['a label', { metadata: { labels: { [NODE_POOL_MEMBER_LABEL]: 'x' } } }],
      ['another annotation', { metadata: { annotations: { probe: 'x' } } }],
      ['its addresses', { status: { addresses: [] } }],
    ] as const) {
      const outcome = await status(patch);
      if (outcome !== 'denied') {
        throw new Error(
          `${K3S_CONTROLLER_USER} changing ${what} on Node ${target}: ${outcome}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
