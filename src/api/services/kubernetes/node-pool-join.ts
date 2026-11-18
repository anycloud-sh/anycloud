import { createHash, randomBytes } from 'node:crypto';
import type { CoreV1Api, V1Secret } from '@kubernetes/client-node';
import type { CloudType } from '../../../shared/cloud.js';
import {
  apiImageTagReference,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../shared/system-release.js';
import { resolveWorkloadImage } from '../container-image.js';
import type { ManagedImage } from '../deployment-store.js';
import { pullsWithSecret } from './pod-parts.js';
import type { NodePoolBootInputs } from '../gateways/cloud.js';
import {
  CONTAINERD_TRANSFER_CHUNK_BYTES,
  CONTAINERD_TRANSFER_CONCURRENCY,
} from '../containerd-transfer.js';
import { kubernetesRequestOptions } from './request-options.js';
import {
  ATTEMPT_NODE_LABEL,
  NODE_POOL_NODE_LABEL,
  nodePoolNodeLabels,
  nodePoolNodeName,
  nodePoolNodeTaints,
  type NodePoolNodeIdentity,
} from './node-pool-scheduling.js';
import { isKubernetesNotFoundError } from './managed-resources.js';
import { POD_CIDR } from './node-pool-namespace.js';
import { NODE_CACHE_DIR } from './pool-objects.js';
import type { NodePoolDisk } from './node-pool-disk.js';
import { userNamespaceJoinScript } from './user-namespace.js';
import { NODE_EVICTION_MEMORY_MI } from './pod-options.js';
import {
  NVIDIA_GPU_FABRIC_POLL_INTERVAL_MS,
  NVIDIA_GPU_FABRIC_READY_STATE,
  NVIDIA_GPU_FABRIC_READY_TIMEOUT_MS,
} from '../gpu-fabric.js';
import { UNPIGZ_INSTALL_TIMEOUT_MS } from '../vm-initializer.js';
import { installUnpigzCommand } from '../../runtime-artifacts.js';
import {
  RESOURCE_DISK_PROBE,
  resourceDiskStoreUnit,
  STORE_UNIT,
} from '../resource-disk-store.js';

/**
 * Keyless worker join. A node pool VM receives no SSH key and no cloud
 * credential: it downloads the system release's pinned K3s binary, verifies
 * its checksum and joins the cluster over the outbound agent tunnel with a
 * per-attempt Kubernetes bootstrap token. The token is created through the
 * cluster connection and deleted once the Node is observed, so a leaked
 * script cannot join later. This is the Kubernetes minor the pinned agent
 * speaks; skew is checked against the cluster.
 */
const K3S_AGENT_KUBERNETES_MINOR = 35;
/** The pinned asset is the linux/amd64 build; other architectures refuse to join. */
const K3S_AGENT_ARCHITECTURE = 'x86_64';
const K3S_DOWNLOAD_URL = `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(SYSTEM_RELEASE_K3S_VERSION)}/k3s`;
const BOOTSTRAP_TOKEN_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BOOTSTRAP_TOKEN_TTL_MS = 60 * 60_000;
const SYSTEM_NAMESPACE = 'kube-system';
const K3S_NODE_TOKEN_GROUP = 'system:bootstrappers:k3s:default-node-token';

export interface NodePoolJoinInput extends NodePoolNodeIdentity {
  clusterId: string;
  nodePoolId: string;
  cloudProvider: CloudType;
  vmRowId: number;
  /** The cluster's https API endpoint from its verified connection. */
  joinEndpoint: string;
  /** Base64 PEM of the cluster's server CA, from the same connection. */
  certificateAuthorityData: string;
  disk: Pick<NodePoolDisk, 'nvme' | 'systemReservedGi' | 'kubeReservedGi'>;
  /** The compute provider's boot inputs. */
  boot: NodePoolBootInputs;
  /** Public image references the Node pulls once its agent runs, in order. */
  prepullImages: string[];
  /** The pool admits user-namespace Jobs (RFC 0049 C32). */
  userNamespace?: { nestedVirtualization: boolean };
}

export interface NodePoolJoinCredential {
  /** `K10<sha256 of the CA PEM>::<id>.<secret>`, pinned to this cluster's CA. */
  token: string;
  secretName: string;
  expiresAt: number;
}

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index++) {
    out +=
      BOOTSTRAP_TOKEN_ID_ALPHABET[
        bytes[index] % BOOTSTRAP_TOKEN_ID_ALPHABET.length
      ];
  }
  return out;
}

export function bootstrapTokenSecretName(tokenId: string): string {
  return `bootstrap-token-${tokenId}`;
}

/** Pin the join token to the cluster CA so an agent refuses another endpoint. */
export function k3sSecureToken(
  certificateAuthorityData: string,
  bootstrapToken: string,
): string {
  const caPem = Buffer.from(certificateAuthorityData, 'base64');
  const hash = createHash('sha256').update(caPem).digest('hex');
  return `K10${hash}::${bootstrapToken}`;
}

export function bootstrapTokenSecret(input: {
  tokenId: string;
  tokenSecret: string;
  expiresAt: number;
  nodePoolId: string;
  vmRowId: number;
}): V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: bootstrapTokenSecretName(input.tokenId),
      namespace: SYSTEM_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'anycloud',
        [NODE_POOL_NODE_LABEL]: input.nodePoolId,
        [ATTEMPT_NODE_LABEL]: String(input.vmRowId),
      },
    },
    type: 'bootstrap.kubernetes.io/token',
    stringData: {
      description: `AnyCloud node pool ${input.nodePoolId} attempt ${input.vmRowId}`,
      'token-id': input.tokenId,
      'token-secret': input.tokenSecret,
      expiration: new Date(input.expiresAt).toISOString(),
      'usage-bootstrap-authentication': 'true',
      'auth-extra-groups': K3S_NODE_TOKEN_GROUP,
    },
  };
}

export async function createNodePoolJoinCredential(
  core: Pick<CoreV1Api, 'createNamespacedSecret'>,
  input: Pick<
    NodePoolJoinInput,
    'nodePoolId' | 'vmRowId' | 'certificateAuthorityData'
  >,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<NodePoolJoinCredential> {
  const tokenId = randomToken(6);
  const tokenSecret = randomToken(16);
  const expiresAt = now + BOOTSTRAP_TOKEN_TTL_MS;
  await core.createNamespacedSecret(
    {
      namespace: SYSTEM_NAMESPACE,
      body: bootstrapTokenSecret({
        tokenId,
        tokenSecret,
        expiresAt,
        nodePoolId: input.nodePoolId,
        vmRowId: input.vmRowId,
      }),
    },
    kubernetesRequestOptions(signal),
  );
  return {
    token: k3sSecureToken(
      input.certificateAuthorityData,
      `${tokenId}.${tokenSecret}`,
    ),
    secretName: bootstrapTokenSecretName(tokenId),
    expiresAt,
  };
}

/**
 * Remove every join token issued for one attempt once its Node registered or
 * the attempt ended. Tokens are found by their attempt labels, so cleanup
 * survives an API restart between issuing the token and observing the join.
 */
export async function deleteNodePoolJoinCredentials(
  core: Pick<CoreV1Api, 'listNamespacedSecret' | 'deleteNamespacedSecret'>,
  input: { nodePoolId: string; vmRowId: number },
  signal?: AbortSignal,
): Promise<number> {
  const list = await core.listNamespacedSecret(
    {
      namespace: SYSTEM_NAMESPACE,
      labelSelector: `${NODE_POOL_NODE_LABEL}=${input.nodePoolId},${ATTEMPT_NODE_LABEL}=${input.vmRowId}`,
    },
    kubernetesRequestOptions(signal),
  );
  let deleted = 0;
  for (const secret of list.items) {
    const name = secret.metadata?.name;
    if (!name || secret.type !== 'bootstrap.kubernetes.io/token') continue;
    try {
      await core.deleteNamespacedSecret(
        {
          namespace: SYSTEM_NAMESPACE,
          name,
          body: { preconditions: { uid: secret.metadata?.uid } },
        },
        kubernetesRequestOptions(signal),
      );
      deleted += 1;
    } catch (error) {
      if (!isKubernetesNotFoundError(error)) throw error;
    }
  }
  return deleted;
}

/**
 * Kubernetes supports a kubelet up to three minors older than the API server
 * and never newer. The agent version is pinned here, the cluster is whatever the
 * installation registered, so the skew is checked before any VM is bought.
 */
export class NodePoolAgentSkewError extends Error {
  constructor(gitVersion: string) {
    super(
      `cluster runs ${gitVersion}; the node pool agent ${SYSTEM_RELEASE_K3S_VERSION} needs a cluster between v1.${K3S_AGENT_KUBERNETES_MINOR} and v1.${K3S_AGENT_KUBERNETES_MINOR + 3}`,
    );
    this.name = 'NodePoolAgentSkewError';
  }
}

export function assertAgentVersionSkew(server: {
  major: number;
  minor: number;
  gitVersion: string;
}): void {
  const oldestSupportedAgent = server.minor - 3;
  if (
    server.major !== 1 ||
    K3S_AGENT_KUBERNETES_MINOR > server.minor ||
    K3S_AGENT_KUBERNETES_MINOR < oldestSupportedAgent
  ) {
    throw new NodePoolAgentSkewError(server.gitVersion);
  }
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

/**
 * Kubelet scratch, container images and `NODE_CACHE_DIR` share one
 * filesystem: the OS disk, the raw NVMe on H100 and A100 sizes (`NVME_UNIT`),
 * or Azure's resource disk on other Azure sizes (`resourceDiskStoreScript`).
 * The cache is bound beside kubelet's storage, so its eviction thresholds see
 * the cache and a full cache never fills the OS disk.
 */
const SCRATCH_DIR = '/var/lib/anycloud/scratch';
const CONTAINERD_DIR = '/var/lib/rancher/k3s/agent/containerd';

/**
 * ST2b: every boot, before the agent, put kubelet and containerd on the
 * local NVMe, RAID 0 when there are several devices. A deallocated VM comes
 * back with the devices wiped, so a missing filesystem is made again; a size
 * without them fails here and its Node never joins.
 */
const NVME_UNIT = `cat > /usr/local/sbin/anycloud-scratch <<'SCRIPT'
#!/bin/bash
set -euo pipefail
FS=/dev/disk/by-label/anycloud-scratch
[ -e "$FS" ] || { mdadm --assemble --scan || true; udevadm settle; }
if [ ! -e "$FS" ]; then
  # Take over local NVMe an image claimed: the AWS DLAMI's unit makes it an
  # LVM volume at /opt/dlami/nvme before user data runs (spike 38622584290).
  # Only the partitioned boot disk is left alone; an interrupted array of our
  # own is stopped the same way.
  for unit in $(grep -ls nvme_ephemeral_drives /etc/systemd/system/*.service /lib/systemd/system/*.service); do
    systemctl disable --now "\${unit##*/}" || true
  done
  RAW=()
  for d in $(lsblk -dnpo NAME,TYPE | awk '$2 == "disk" && index($1, "/dev/nvme") == 1 {print $1}'); do
    [[ "$(lsblk -nlo TYPE "$d")" == *part* ]] || RAW+=("$d")
  done
  [ \${#RAW[@]} -gt 0 ] || { echo "anycloud: no local NVMe" >&2; exit 1; }
  for dev in $(lsblk -nlpo NAME,TYPE "\${RAW[@]}" | awk '$2 ~ /^(raid|lvm)/ {print $1}' | sort -u); do
    umount "$dev" 2>/dev/null || true
  done
  VGS=$({ pvs --noheadings -o vg_name "\${RAW[@]}" 2>/dev/null || true; } | xargs -n1 | sort -u | xargs)
  [ -z "$VGS" ] || vgchange -an $VGS
  for md in $(lsblk -nlpo NAME,TYPE "\${RAW[@]}" | awk '$2 ~ /^raid/ {print $1}' | sort -u); do
    mdadm --stop "$md"
  done
  for d in "\${RAW[@]}"; do
    umount "$d" 2>/dev/null || true
    wipefs -a "$d"
  done
  DEV=\${RAW[0]}
  if [ \${#RAW[@]} -gt 1 ]; then
    command -v mdadm >/dev/null || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm; }
    mdadm --create /dev/md/anycloud-scratch --run --level=0 --raid-devices=\${#RAW[@]} "\${RAW[@]}"
    DEV=/dev/md/anycloud-scratch
  fi
  mkfs.ext4 -F -q -m 0 -L anycloud-scratch -E lazy_itable_init=1,lazy_journal_init=1,nodiscard "$DEV"
  udevadm settle
fi
mkdir -p ${SCRATCH_DIR}
mountpoint -q ${SCRATCH_DIR} || mount "$FS" ${SCRATCH_DIR}
for dir in kubelet containerd node-cache; do
  mkdir -p ${SCRATCH_DIR}/$dir
done
mkdir -p /var/lib/kubelet ${CONTAINERD_DIR} ${NODE_CACHE_DIR}
mountpoint -q /var/lib/kubelet || mount --bind ${SCRATCH_DIR}/kubelet /var/lib/kubelet
mountpoint -q ${CONTAINERD_DIR} || mount --bind ${SCRATCH_DIR}/containerd ${CONTAINERD_DIR}
mountpoint -q ${NODE_CACHE_DIR} || mount --bind ${SCRATCH_DIR}/node-cache ${NODE_CACHE_DIR}
SCRIPT
chmod 755 /usr/local/sbin/anycloud-scratch
cat > /etc/systemd/system/anycloud-scratch.service <<'UNIT'
[Unit]
Description=AnyCloud kubelet scratch on local NVMe
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/anycloud-scratch
UNIT
`;

/**
 * An NVIDIA Node joins only once every GPU's NVSwitch fabric is ready,
 * as a VM host's container waits for it, so no Pod starts CUDA into error
 * 802. A GPU without a fabric reports Not Supported or N/A and passes at
 * once, as does a host without nvidia-smi or the query. A fabric still not
 * ready at the bound fails the unit: the agent, which requires it, never
 * starts, and the controller replaces the VM as a Node that never joined.
 */
const GPU_FABRIC_UNIT = `cat > /usr/local/sbin/anycloud-gpu-fabric <<'SCRIPT'
#!/bin/bash
command -v nvidia-smi >/dev/null 2>&1 || exit 0
deadline=$((SECONDS + ${NVIDIA_GPU_FABRIC_READY_TIMEOUT_MS / 1000}))
while :; do
  states=$(nvidia-smi --query-gpu=fabric.state --format=csv,noheader 2>/dev/null) || exit 0
  printf '%s\\n' "$states" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//' | grep -v '^$' |
    grep -qviE '^${NVIDIA_GPU_FABRIC_READY_STATE}$' || exit 0
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "anycloud: NVIDIA GPU fabric not ready: $(echo $states)" >&2
    exit 1
  fi
  sleep ${NVIDIA_GPU_FABRIC_POLL_INTERVAL_MS / 1000}
done
SCRIPT
chmod 755 /usr/local/sbin/anycloud-gpu-fabric
cat > /etc/systemd/system/anycloud-gpu-fabric.service <<'UNIT'
[Unit]
Description=AnyCloud: NVIDIA GPU fabric ready before the agent starts
After=nvidia-fabricmanager.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/anycloud-gpu-fabric
UNIT
`;

/**
 * K3s's config template pins CRI pulls to containerd's local path
 * (`use_local_image_pull = true`), which fetches each layer on one stream. An
 * import from the template's `config-v3.toml.d` overrides the pin, so pulls go
 * through the transfer service with the VM hosts' ranged fetch.
 */
const CONTAINERD_TRANSFER_DROP_IN = `mkdir -p /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/50-anycloud.toml <<'CONTAINERD'
version = 3
[plugins.'io.containerd.cri.v1.images']
  use_local_image_pull = false
[plugins.'io.containerd.transfer.v1.local']
  max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}
  concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}
CONTAINERD
`;

/**
 * R1 for Nodes: when the resource disk is mounted and at least
 * as large as the root filesystem, a per-boot unit binds kubelet, containerd
 * and the Node cache onto it before the agent, and re-creates them on the
 * fresh disk a deallocation leaves; the agent's `Wants=` starts it. The
 * heredoc is unquoted so the shell fills the probed mount; the unit holds no
 * other expansion.
 * Without the disk there is no unit and the stores stay on the OS disk.
 */
function resourceDiskStoreScript(): string {
  const unit = resourceDiskStoreUnit(
    '$STORE_MOUNT',
    {
      kubelet: '/var/lib/kubelet',
      containerd: CONTAINERD_DIR,
      'node-cache': NODE_CACHE_DIR,
    },
    'k3s-agent.service',
  );
  return `STORE_MOUNT=$( { ${RESOURCE_DISK_PROBE}
} | awk 'index($1, "/") == 1 && $1 != "/" && $2 + 0 >= $3 + 0 { print $1 }') || STORE_MOUNT=''
if [ -n "$STORE_MOUNT" ]; then
cat > /etc/systemd/system/${STORE_UNIT} <<UNIT
${unit}
UNIT
fi
`;
}

/**
 * K5 at the Node: Pods never reach the provider's host-only
 * addresses, whatever the NetworkPolicy controller's timing. The `raw` table
 * runs before conntrack and every `filter` chain kube-router and flannel
 * reorder, and Pod packets pass PREROUTING while the Node's own traffic
 * (EXTERNAL_IP discovery, the cloud agents) leaves through OUTPUT. Port 53
 * stays open where the Node resolves through one of them (GCP's metadata
 * server, Azure's WireServer). The agent requires this unit, so a Node that
 * can't install it runs no Pods.
 */
function metadataBlockUnit(boot: NodePoolBootInputs): string {
  const dns = boot.resolvesThroughHostOnly
    ? `iptables -t raw -A ANYCLOUD-METADATA -p udp --dport 53 -j RETURN
iptables -t raw -A ANYCLOUD-METADATA -p tcp --dport 53 -j RETURN
`
    : '';
  const jumps = boot.hostOnlyCidrs
    .map((target) => {
      const jump = `-s ${POD_CIDR} -d ${target} -j ANYCLOUD-METADATA`;
      return `iptables -t raw -C PREROUTING ${jump} 2>/dev/null ||
  iptables -t raw -I PREROUTING 1 ${jump}
`;
    })
    .join('');
  return `cat > /usr/local/sbin/anycloud-metadata-block <<'SCRIPT'
#!/bin/sh
set -eu
iptables -t raw -N ANYCLOUD-METADATA 2>/dev/null || iptables -t raw -F ANYCLOUD-METADATA
${dns}iptables -t raw -A ANYCLOUD-METADATA -j DROP
${jumps}SCRIPT
chmod 755 /usr/local/sbin/anycloud-metadata-block
cat > /etc/systemd/system/anycloud-metadata-block.service <<'UNIT'
[Unit]
Description=AnyCloud: no Pod reaches instance metadata
Before=k3s-agent.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/anycloud-metadata-block
UNIT
`;
}

/** C11: the pool's newest public Job images a new Node pulls. */
const PREPULL_JOB_IMAGE_LIMIT = 4;
/** How long a new Node keeps pulling; a slower image waits for its replica. */
const PREPULL_DEADLINE_SECONDS = 8 * 60;

/**
 * RFC 0049 C11: what a new Node pulls. The runner-install image comes first,
 * then the digests of the pool's newest live managed Deployments whose
 * replicas pull without a Secret, each once: a member's sign-in never goes
 * on a Node for a pull.
 */
export function nodePoolPrepullImages(
  version: string,
  managed: ManagedImage[],
): string[] {
  const jobImages = managed
    .filter((spec) => !pullsWithSecret(spec.image, spec.registryToken))
    .map(resolveWorkloadImage);
  return [
    apiImageTagReference(version),
    ...[...new Set(jobImages)].slice(0, PREPULL_JOB_IMAGE_LIMIT),
  ];
}

/**
 * RFC 0049 C11: once the agent runs, pull each image through the CRI, so
 * the transfer service fetches it, one at a time, before a replica asks.
 * The pull runs in the background and nothing waits for it: the Node
 * registers and turns Ready on its own schedule, a replica's pull of the same
 * image joins the one in flight, and a failed or late pull is only logged.
 * Image sizes are unknown, so the store's free space is watched during each
 * pull: the pulls stay within the Node's image allowance (`kubeReserved`)
 * and 2 GiB above the kubelet's 5% `imagefs.available` eviction threshold, so
 * a pull's overshoot between 1 s checks never reaches it, and a pull that
 * crosses either bound is stopped with the ones after it.
 */
function prepullUnit(images: string[], allowanceGi: number): string {
  return `cat > /usr/local/sbin/anycloud-prepull <<'SCRIPT'
#!/bin/bash
deadline=$((SECONDS + ${PREPULL_DEADLINE_SECONDS}))
until k3s crictl info >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || exit 0
  sleep 2
done
avail() { df --output=avail -B1 ${CONTAINERD_DIR} | tail -n 1; }
floor=$(($(avail) - ${allowanceGi} * 1024 ** 3))
bound="the image allowance"
eviction=$(($(df --output=size -B1 ${CONTAINERD_DIR} | tail -n 1) / 20 + 2 * 1024 ** 3))
if [ "$floor" -lt "$eviction" ]; then
  floor=$eviction
  bound="the eviction threshold"
fi
fits() { (($(avail) > floor)); }
for image in ${images.map(shellQuote).join(' ')}; do
  left=$((deadline - SECONDS))
  if [ "$left" -le 0 ]; then
    echo "anycloud: pre-pull stopped at its deadline before $image" >&2
    break
  fi
  if ! fits; then
    echo "anycloud: pre-pull stopped at $bound before $image" >&2
    break
  fi
  timeout "$left" k3s crictl pull "$image" >/dev/null &
  pull=$!
  while kill -0 "$pull" 2>/dev/null; do
    if ! fits; then
      kill "$pull" 2>/dev/null
      wait "$pull"
      echo "anycloud: pre-pull stopped at $bound during $image" >&2
      exit 0
    fi
    sleep 1
  done
  wait "$pull" || echo "anycloud: pre-pull of $image failed" >&2
done
exit 0
SCRIPT
chmod 755 /usr/local/sbin/anycloud-prepull
cat > /etc/systemd/system/anycloud-prepull.service <<'UNIT'
[Unit]
Description=AnyCloud: pull the pool's recent images once the agent runs
After=k3s-agent.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/anycloud-prepull
UNIT
`;
}

/**
 * Placeholder the provider's discovery command fills with the VM's public
 * address, or the field is left out. The cluster reaches pool kubelets through
 * the agent tunnel, but Pod traffic across clouds (flannel) uses external IPs.
 */
export const NODE_EXTERNAL_IP_PLACEHOLDER = '__NODE_EXTERNAL_IP__';

/**
 * First-boot script for a node pool VM. It never installs SSH access, a
 * cloud credential or a peer network; the only inbound path is the K3s agent
 * tunnel it opens itself.
 */
export function buildNodePoolAgentStartupScript(
  input: NodePoolJoinInput,
  credential: Pick<NodePoolJoinCredential, 'token'>,
): string {
  // JSON is valid YAML, so the K3s configuration is rendered with a real
  // serializer instead of hand quoting; the heredoc is single-quoted, so the
  // shell leaves the body untouched.
  const config = JSON.stringify(
    {
      server: input.joinEndpoint,
      token: credential.token,
      'node-name': nodePoolNodeName(input.nodePoolId, input.vmRowId),
      'node-label': Object.entries(nodePoolNodeLabels(input)).map(
        ([key, value]) => `${key}=${value}`,
      ),
      'node-taint': nodePoolNodeTaints(input.nodePoolId).map(
        (taint) => `${taint.key}=${taint.value}:${taint.effect}`,
      ),
      'node-external-ip': NODE_EXTERNAL_IP_PLACEHOLDER,
    },
    null,
    2,
  );
  const resourceDiskStore = input.boot.resourceDiskStore && !input.disk.nvme;
  if (config.includes('\nCONFIG\n')) {
    throw new Error(
      'Node pool agent configuration cannot contain the heredoc delimiter',
    );
  }
  return `#!/bin/bash
set -euo pipefail
umask 077
if [ "$(uname -m)" != ${shellQuote(K3S_AGENT_ARCHITECTURE)} ]; then
  echo "anycloud node-pool agent supports ${K3S_AGENT_ARCHITECTURE} only; refusing to join from $(uname -m)" >&2
  exit 1
fi
systemctl disable --now ssh.service ssh.socket sshd.service 2>/dev/null || true
curl --fail --location --retry 5 --max-time 180 ${shellQuote(K3S_DOWNLOAD_URL)} -o /usr/local/bin/k3s
echo ${shellQuote(`${SYSTEM_RELEASE_K3S_SHA256}  /usr/local/bin/k3s`)} | sha256sum -c -
chmod 755 /usr/local/bin/k3s
mkdir -p -m 755 ${NODE_CACHE_DIR}
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/config.yaml <<'CONFIG'
${config}
CONFIG
${input.boot.externalIpDiscovery ?? "EXTERNAL_IP=''"}
if [ -n "$EXTERNAL_IP" ]; then
  sed -i "s/${NODE_EXTERNAL_IP_PLACEHOLDER}/$EXTERNAL_IP/" /etc/rancher/k3s/config.yaml
else
  sed -i '/${NODE_EXTERNAL_IP_PLACEHOLDER}/d' /etc/rancher/k3s/config.yaml
fi
chmod 600 /etc/rancher/k3s/config.yaml
# Containers share the Node's inotify instances, 128 by default: CI's
# Docker-in-Docker and nested K3s need more, as on CI's runner hosts (#2093).
echo fs.inotify.max_user_instances=8192 > /etc/sysctl.d/99-anycloud.conf
sysctl -p /etc/sysctl.d/99-anycloud.conf
# A container OOM kills only its largest process, the runner's Job, not the
# runner, which then uploads and reports it (RFC 0044). The kubelet takes
# this only from its configuration, never as a flag. An OS shutdown (a spot
# eviction, a host stop) gives Pods up to 80 s to stop, so the runner's final
# upload can run; a GCP preemption allows 30 s.
# The VM class's reserves (RFC 0043 § Disk), with eviction at 5% free on the
# one shared filesystem: the 15% image default would evict replicas still
# inside their limits.
mkdir -p /var/lib/rancher/k3s/agent/etc/kubelet.conf.d
cat > /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-anycloud.conf <<'KUBELET'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
singleProcessOOMKill: true
shutdownGracePeriod: 90s
shutdownGracePeriodCriticalPods: 10s
systemReserved:
  ephemeral-storage: ${input.disk.systemReservedGi}Gi
kubeReserved:
  ephemeral-storage: ${input.disk.kubeReservedGi}Gi
evictionHard:
  memory.available: ${NODE_EVICTION_MEMORY_MI}Mi
  nodefs.available: 5%
  nodefs.inodesFree: 5%
  imagefs.available: 5%
  imagefs.inodesFree: 5%
KUBELET
${CONTAINERD_TRANSFER_DROP_IN}${input.userNamespace ? userNamespaceJoinScript(input.userNamespace.nestedVirtualization) : ''}${input.disk.nvme ? NVME_UNIT : resourceDiskStore ? resourceDiskStoreScript() : ''}${input.accelerator ? GPU_FABRIC_UNIT : ''}${metadataBlockUnit(input.boot)}${prepullUnit(input.prepullImages, input.disk.kubeReservedGi)}cat > /etc/systemd/system/k3s-agent.service <<'UNIT'
[Unit]
Description=AnyCloud node pool K3s agent
After=network-online.target
Wants=network-online.target
Requires=anycloud-metadata-block.service
After=anycloud-metadata-block.service
${input.disk.nvme ? 'Requires=anycloud-scratch.service\nAfter=anycloud-scratch.service\n' : ''}${resourceDiskStore ? `Wants=${STORE_UNIT}\nAfter=${STORE_UNIT}\n` : ''}${input.accelerator ? 'Requires=anycloud-gpu-fabric.service\nAfter=anycloud-gpu-fabric.service\n' : ''}[Service]
Type=notify
# A restart keeps the kubelet certificates: once the Node exists they are the
# agent's only credential, as its bootstrap token is deleted. An agent that
# crashed before its Node registered can't rejoin (K3s's 401 retry resends an
# already-read CSR body); the controller replaces its VM after
# NODE_ABSENT_GRACE_MS.
ExecStart=/usr/local/bin/k3s agent
KillMode=process
Delegate=yes
Restart=always
RestartSec=5
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity
[Install]
WantedBy=multi-user.target
UNIT
# Best effort: K3s's containerd unpacks layers with unpigz when it's on PATH,
# else with Go's one-thread gzip (#2087).
timeout ${UNPIGZ_INSTALL_TIMEOUT_MS / 1000} sh -c ${shellQuote(installUnpigzCommand())} ||
  echo "anycloud: unpigz install failed; pulls use Go gzip" >&2
systemctl daemon-reload
systemctl enable --now k3s-agent.service
systemctl start --no-block anycloud-prepull.service
`;
}
