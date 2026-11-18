import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { V1Secret } from '@kubernetes/client-node';
import {
  apiImageTagReference,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../../src/shared/system-release.js';
import {
  assertAgentVersionSkew,
  bootstrapTokenSecret,
  bootstrapTokenSecretName,
  buildNodePoolAgentStartupScript,
  createNodePoolJoinCredential,
  deleteNodePoolJoinCredentials,
  k3sSecureToken,
  NodePoolAgentSkewError,
  nodePoolPrepullImages,
} from '../../../../src/api/services/kubernetes/node-pool-join.js';
import { AWS_NODE_POOL_BOOT } from '../../../../src/api/services/gateways/aws.js';
import { AZURE_NODE_POOL_BOOT } from '../../../../src/api/services/gateways/azure.js';
import { GCP_NODE_POOL_BOOT } from '../../../../src/api/services/gateways/gcp.js';
import { LAMBDA_NODE_POOL_BOOT } from '../../../../src/api/services/gateways/lambda.js';
import type { NodePoolBootInputs } from '../../../../src/api/services/gateways/cloud.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  CONTAINERD_TRANSFER_CHUNK_BYTES,
  CONTAINERD_TRANSFER_CONCURRENCY,
} from '../../../../src/api/services/containerd-transfer.js';
import { installUnpigzCommand } from '../../../../src/api/runtime-artifacts.js';
import { RESOURCE_DISK_PROBE } from '../../../../src/api/services/resource-disk-store.js';
import { USER_NAMESPACE_BASE_SPEC } from '../../../../src/api/services/kubernetes/user-namespace.js';
import { NODE_POOL_JOIN_REVISION } from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';

const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const caData = Buffer.from(caPem).toString('base64');
const joinInput = {
  clusterId: 'cluster-production-1',
  nodePoolId: 'node-pool-aws-east-1',
  cloudProvider: CloudType.AWS,
  vmRowId: 42,
  joinEndpoint: 'https://203.0.113.5:6443',
  certificateAuthorityData: caData,
  disk: { nvme: false, systemReservedGi: 10, kubeReservedGi: 10 },
  boot: AWS_NODE_POOL_BOOT,
  prepullImages: ['ghcr.io/anycloud-sh/api:0.1.72'],
};
/** A provider with none of the existing clouds' addresses or command. */
const newProvider: NodePoolBootInputs = {
  hostOnlyCidrs: ['192.0.2.53/32', '198.51.100.0/24'],
  resolvesThroughHostOnly: true,
  externalIpDiscovery: 'EXTERNAL_IP="$(new-provider-ip)"',
  resourceDiskStore: true,
};

/**
 * Runs a join script's pre-pull with a `deadline`-second budget against a
 * fake CRI and a fake 100 GiB store with `availGi` free. A pull of an image
 * named `fill-<n>` leaves `n` GiB free, and a `slow` one then hangs.
 */
function prepullOnFakeStore(
  script: string,
  { deadline = 60, criUp = true, availGi = 90 } = {},
) {
  const start = "anycloud-prepull <<'SCRIPT'\n";
  const body = script.slice(script.indexOf(start) + start.length);
  const unit = body.slice(0, body.indexOf('\nSCRIPT\n'));
  const dir = mkdtempSync(join(tmpdir(), 'anycloud-prepull-'));
  const gib = 1024 ** 3;
  writeFileSync(join(dir, 'avail'), `${availGi * gib}\n`);
  writeFileSync(
    join(dir, 'k3s'),
    `#!/bin/bash
[ "$2" = info ] && exit ${criUp ? 0 : 1}
echo "$3" >> ${dir}/pulls
case "$3" in *fill-*) n=\${3##*fill-}; echo $((\${n%%[!0-9]*} * ${gib})) > ${dir}/avail ;; esac
case "$3" in *broken*) exit 1 ;; *slow*) exec /bin/sleep 30 ;; esac
`,
  );
  writeFileSync(
    join(dir, 'df'),
    `#!/bin/bash
[ "$1" = --output=size ] && printf '    Size\\n%s\\n' ${100 * gib} && exit
printf '   Avail\\n%s\\n' "$(cat ${dir}/avail)"
`,
  );
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.05\n');
  for (const tool of ['k3s', 'df', 'sleep']) {
    chmodSync(join(dir, tool), 0o755);
  }
  const started = Date.now();
  const run = spawnSync(
    '/bin/bash',
    ['-c', unit.replace(/SECONDS \+ \d+/, `SECONDS + ${deadline}`)],
    {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  return {
    status: run.status,
    seconds: (Date.now() - started) / 1000,
    pulls: existsSync(join(dir, 'pulls'))
      ? readFileSync(join(dir, 'pulls'), 'utf8').trim().split('\n')
      : [],
    stderr: run.stderr,
  };
}

describe('node pool keyless join', () => {
  it('pins the bootstrap token to the cluster CA in the K3s secure-token format', () => {
    const token = k3sSecureToken(caData, 'abcdef.0123456789abcdef');
    const hash = createHash('sha256').update(caPem).digest('hex');
    expect(token).toBe(`K10${hash}::abcdef.0123456789abcdef`);
    expect(
      k3sSecureToken(Buffer.from('other').toString('base64'), 'x.y'),
    ).not.toBe(token);
  });

  it('shapes the bootstrap token Secret for K3s node authentication', () => {
    const secret = bootstrapTokenSecret({
      tokenId: 'abcdef',
      tokenSecret: '0123456789abcdef',
      expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      nodePoolId: joinInput.nodePoolId,
      vmRowId: 42,
    });
    expect(secret).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'bootstrap-token-abcdef',
        namespace: 'kube-system',
        labels: {
          'app.kubernetes.io/managed-by': 'anycloud',
          'anycloud.sh/node-pool': joinInput.nodePoolId,
          'anycloud.sh/attempt': '42',
        },
      },
      type: 'bootstrap.kubernetes.io/token',
      stringData: {
        description: `AnyCloud node pool ${joinInput.nodePoolId} attempt 42`,
        'token-id': 'abcdef',
        'token-secret': '0123456789abcdef',
        expiration: '2026-01-02T03:04:05.000Z',
        'usage-bootstrap-authentication': 'true',
        'auth-extra-groups': 'system:bootstrappers:k3s:default-node-token',
      },
    });
    expect(bootstrapTokenSecretName('zz9')).toBe('bootstrap-token-zz9');
  });

  it('creates one per-attempt token through the cluster and returns a CA-pinned credential', async () => {
    const createNamespacedSecret = vi.fn(
      async ({ body }: { body: V1Secret }) => body,
    );
    const now = Date.UTC(2026, 5, 1);
    const credential = await createNodePoolJoinCredential(
      { createNamespacedSecret },
      joinInput,
      now,
    );
    expect(createNamespacedSecret).toHaveBeenCalledTimes(1);
    const body = createNamespacedSecret.mock.calls[0][0].body;
    const tokenId = body.stringData!['token-id'];
    const tokenSecret = body.stringData!['token-secret'];
    expect(tokenId).toMatch(/^[a-z0-9]{6}$/);
    expect(tokenSecret).toMatch(/^[a-z0-9]{16}$/);
    expect(body.stringData!.expiration).toBe(
      new Date(now + 60 * 60_000).toISOString(),
    );
    expect(credential).toEqual({
      token: k3sSecureToken(caData, `${tokenId}.${tokenSecret}`),
      secretName: `bootstrap-token-${tokenId}`,
      expiresAt: now + 60 * 60_000,
    });

    const second = await createNodePoolJoinCredential(
      { createNamespacedSecret },
      joinInput,
      now,
    );
    expect(second.token).not.toBe(credential.token);
  });

  it("deletes only this attempt's bootstrap tokens by exact UID and tolerates absence", async () => {
    const listNamespacedSecret = vi.fn(async () => ({
      items: [
        {
          metadata: { name: 'bootstrap-token-aaaaaa', uid: 'uid-a' },
          type: 'bootstrap.kubernetes.io/token',
        },
        { metadata: { name: 'unrelated', uid: 'uid-b' }, type: 'Opaque' },
      ],
    }));
    const deleteNamespacedSecret = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 404 }));
    await expect(
      deleteNodePoolJoinCredentials(
        { listNamespacedSecret, deleteNamespacedSecret },
        { nodePoolId: joinInput.nodePoolId, vmRowId: 42 },
      ),
    ).resolves.toBe(1);
    expect(listNamespacedSecret).toHaveBeenCalledWith(
      {
        namespace: 'kube-system',
        labelSelector: `anycloud.sh/node-pool=${joinInput.nodePoolId},anycloud.sh/attempt=42`,
      },
      undefined,
    );
    expect(deleteNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(deleteNamespacedSecret).toHaveBeenCalledWith(
      {
        namespace: 'kube-system',
        name: 'bootstrap-token-aaaaaa',
        body: { preconditions: { uid: 'uid-a' } },
      },
      undefined,
    );

    await expect(
      deleteNodePoolJoinCredentials(
        { listNamespacedSecret, deleteNamespacedSecret },
        { nodePoolId: joinInput.nodePoolId, vmRowId: 42 },
      ),
    ).resolves.toBe(0);
    deleteNamespacedSecret.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      deleteNodePoolJoinCredentials(
        { listNamespacedSecret, deleteNamespacedSecret },
        { nodePoolId: joinInput.nodePoolId, vmRowId: 42 },
      ),
    ).rejects.toThrow('forbidden');
  });

  it('boots a keyless amd64 agent that verifies the pinned binary and joins with labels and taints', () => {
    const script = buildNodePoolAgentStartupScript(joinInput, {
      token: 'K10abc::id.secret',
    });
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\n')).toBe(true);
    expect(script).toContain(`if [ "$(uname -m)" != 'x86_64' ]; then`);
    expect(script.indexOf('uname -m')).toBeLessThan(script.indexOf('curl'));
    expect(script).toContain(
      'systemctl disable --now ssh.service ssh.socket sshd.service',
    );
    expect(script).toContain(
      `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(SYSTEM_RELEASE_K3S_VERSION)}/k3s`,
    );
    expect(script).toContain(
      `${SYSTEM_RELEASE_K3S_SHA256}  /usr/local/bin/k3s' | sha256sum -c -`,
    );
    expect(script).toContain('mkdir -p -m 755 /var/lib/anycloud/node-cache');
    const configText = script.slice(
      script.indexOf("<<'CONFIG'\n") + "<<'CONFIG'\n".length,
      script.indexOf('\nCONFIG\n'),
    );
    expect(JSON.parse(configText)).toEqual({
      server: 'https://203.0.113.5:6443',
      token: 'K10abc::id.secret',
      'node-name': 'anycloud-node-pool-aws-east-1-42',
      'node-label': [
        'anycloud.sh/cluster=cluster-production-1',
        'anycloud.sh/node-pool=node-pool-aws-east-1',
        'anycloud.sh/provider=aws',
        'anycloud.sh/attempt=42',
        'anycloud.sh/join-revision=4',
      ],
      'node-taint': ['anycloud.sh/node-pool=node-pool-aws-east-1:NoSchedule'],
      'node-external-ip': '__NODE_EXTERNAL_IP__',
    });
    // The boot script fills the Node external IP from whichever instance
    // metadata service answers (AWS IMDSv2, GCP, Azure) or drops the field.
    expect(script).toContain(
      'http://169.254.169.254/latest/meta-data/public-ipv4',
    );
    expect(script).toContain(
      'metadata.google.internal/computeMetadata/v1/instance',
    );
    expect(script).toContain('publicIpAddress?api-version=2021-02-01');
    expect(script).toContain(
      `sed -i "s/__NODE_EXTERNAL_IP__/$EXTERNAL_IP/" /etc/rancher/k3s/config.yaml`,
    );
    expect(script).toContain(
      "sed -i '/__NODE_EXTERNAL_IP__/d' /etc/rancher/k3s/config.yaml",
    );
    expect(script.indexOf('EXTERNAL_IP=')).toBeLessThan(
      script.indexOf('chmod 600 /etc/rancher/k3s/config.yaml'),
    );
    // A container OOM kills only its largest process, so a pool Job's runner
    // survives it; the kubelet reads this from a drop-in before it starts.
    expect(script).toContain(
      "cat > /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-anycloud.conf <<'KUBELET'\napiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nsingleProcessOOMKill: true\nshutdownGracePeriod: 90s\nshutdownGracePeriodCriticalPods: 10s\nsystemReserved:\n  ephemeral-storage: 10Gi\nkubeReserved:\n  ephemeral-storage: 10Gi\nevictionHard:\n  memory.available: 100Mi\n  nodefs.available: 5%\n  nodefs.inodesFree: 5%\n  imagefs.available: 5%\n  imagefs.inodesFree: 5%\nKUBELET\n",
    );
    // CI's Docker-in-Docker and nested K3s need more inotify instances than
    // the default 128, set before the agent starts.
    expect(script).toContain(
      'echo fs.inotify.max_user_instances=8192 > /etc/sysctl.d/99-anycloud.conf\nsysctl -p /etc/sysctl.d/99-anycloud.conf\n',
    );
    expect(script.indexOf('sysctl -p')).toBeLessThan(
      script.indexOf('systemctl enable --now k3s-agent.service'),
    );
    expect(script.indexOf('kubelet.conf.d')).toBeLessThan(
      script.indexOf('systemctl enable --now k3s-agent.service'),
    );
    // Once the bootstrap token is deleted, the kubelet certificates are the
    // agent's only credential: a restart or reboot must keep them.
    expect(script).not.toMatch(/client-kubelet|serving-kubelet/);
    expect(script).toContain('ExecStart=/usr/local/bin/k3s agent');
    // GPU node pools label their Nodes so the cluster-scoped device plugin
    // DaemonSet selects them; CPU node pools carry no accelerator label.
    const gpuScript = buildNodePoolAgentStartupScript(
      { ...joinInput, accelerator: 'nvidia' },
      { token: 'K10abc::id.secret' },
    );
    const gpuConfig = gpuScript.slice(
      gpuScript.indexOf("<<'CONFIG'\n") + "<<'CONFIG'\n".length,
      gpuScript.indexOf('\nCONFIG\n'),
    );
    expect(JSON.parse(gpuConfig)['node-label']).toEqual([
      'anycloud.sh/cluster=cluster-production-1',
      'anycloud.sh/node-pool=node-pool-aws-east-1',
      'anycloud.sh/provider=aws',
      'anycloud.sh/attempt=42',
      'anycloud.sh/join-revision=4',
      'anycloud.sh/accelerator=nvidia',
    ]);
    // GPU Nodes carry only the pool taint, as CPU Nodes do: the GPU rule is
    // the render-time validator on AnyCloud's workload templates, so the
    // pool's Traefik (a CPU Pod tolerating that taint) still lands on a GPU
    // ingress entry.
    expect(JSON.parse(gpuConfig)['node-taint']).toEqual([
      'anycloud.sh/node-pool=node-pool-aws-east-1:NoSchedule',
    ]);
    expect(script).not.toMatch(
      /authorized_keys|ssh-rsa|AWS_ACCESS|GOOGLE_APPLICATION|get\.k3s\.io/,
    );
    // Values are serialized, never spliced: quotes cannot break the document.
    const quoted = buildNodePoolAgentStartupScript(joinInput, {
      token: `K10::it's "quoted"`,
    });
    const quotedConfig = quoted.slice(
      quoted.indexOf("<<'CONFIG'\n") + "<<'CONFIG'\n".length,
      quoted.indexOf('\nCONFIG\n'),
    );
    expect(JSON.parse(quotedConfig).token).toBe(`K10::it's "quoted"`);
    expect(() =>
      buildNodePoolAgentStartupScript(joinInput, { token: 'x\nCONFIG\ny' }),
    ).not.toThrow();
  });

  it("blocks Pods from the provider's host-only addresses at the Node before the agent starts, idempotently: instance metadata, the WireServer on Azure, DNS open on GCP and Azure only", () => {
    const blockOf = (boot: NodePoolBootInputs) => {
      const script = buildNodePoolAgentStartupScript(
        { ...joinInput, boot },
        { token: 'K10abc::id.secret' },
      );
      execFileSync('bash', ['-n'], { input: script });
      // The agent can't start, so no Pod runs, without the block.
      expect(script).toContain(
        'Requires=anycloud-metadata-block.service\nAfter=anycloud-metadata-block.service\n',
      );
      const start = "anycloud-metadata-block <<'SCRIPT'\n";
      const body = script.slice(script.indexOf(start) + start.length);
      return body.slice(0, body.indexOf('\nSCRIPT\n'));
    };
    // Each boot runs it again: a stub iptables keeps the chain and the jump.
    const run = (block: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'anycloud-metadata-'));
      writeFileSync(
        join(dir, 'iptables'),
        `#!/bin/bash
args="$*"
echo "$args" >> ${dir}/calls
case "$args" in
  *" -N "*) [ ! -e ${dir}/chain ] && touch ${dir}/chain ;;
  *" -C "*) grep -qxF -- "\${args/-C PREROUTING/-I PREROUTING 1}" ${dir}/calls ;;
esac
`,
      );
      chmodSync(join(dir, 'iptables'), 0o755);
      for (let boot = 0; boot < 2; boot += 1) {
        execFileSync('sh', ['-c', block], {
          env: { PATH: `${dir}:/usr/bin:/bin` },
        });
      }
      return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    };
    const jump = (target: string) =>
      `PREROUTING -s 10.42.0.0/16 -d ${target} -j ANYCLOUD-METADATA`;
    const dns = [
      '-t raw -A ANYCLOUD-METADATA -p udp --dport 53 -j RETURN',
      '-t raw -A ANYCLOUD-METADATA -p tcp --dport 53 -j RETURN',
    ];
    const boot = (
      first: boolean,
      open: string[],
      targets: readonly string[],
    ) => [
      '-t raw -N ANYCLOUD-METADATA',
      ...(first ? [] : ['-t raw -F ANYCLOUD-METADATA']),
      ...open,
      '-t raw -A ANYCLOUD-METADATA -j DROP',
      ...targets.flatMap((target) => [
        `-t raw -C ${jump(target)}`,
        ...(first
          ? [`-t raw -I ${jump(target).replace('PREROUTING', 'PREROUTING 1')}`]
          : []),
      ]),
    ];
    const metadata = ['169.254.169.254/32'];
    // GCP Nodes resolve through the metadata server.
    expect(run(blockOf(GCP_NODE_POOL_BOOT))).toEqual([
      ...boot(true, dns, metadata),
      ...boot(false, dns, metadata),
    ]);
    // Azure Nodes resolve through the WireServer, which is blocked too.
    const azure = [...metadata, '168.63.129.16/32'];
    expect(run(blockOf(AZURE_NODE_POOL_BOOT))).toEqual([
      ...boot(true, dns, azure),
      ...boot(false, dns, azure),
    ]);
    for (const cloud of [AWS_NODE_POOL_BOOT, LAMBDA_NODE_POOL_BOOT]) {
      expect(run(blockOf(cloud))).toEqual([
        ...boot(true, [], metadata),
        ...boot(false, [], metadata),
      ]);
    }
    // A new provider's addresses are its whole deny list.
    expect(run(blockOf(newProvider))).toEqual([
      ...boot(true, dns, newProvider.hostOnlyCidrs),
      ...boot(false, dns, newProvider.hostOnlyCidrs),
    ]);
  });

  it("fills the Node external IP from the provider's discovery command, or drops it when there is none", () => {
    const configAfterDiscovery = (externalIpDiscovery: string | null) => {
      const script = buildNodePoolAgentStartupScript(
        { ...joinInput, boot: { ...newProvider, externalIpDiscovery } },
        { token: 'K10abc::id.secret' },
      );
      const dir = mkdtempSync(join(tmpdir(), 'anycloud-external-ip-'));
      const config = join(dir, 'config.yaml');
      writeFileSync(
        config,
        '{\n  "node-external-ip": "__NODE_EXTERNAL_IP__"\n}\n',
      );
      writeFileSync(
        join(dir, 'new-provider-ip'),
        '#!/bin/sh\necho 203.0.113.7\n',
      );
      chmodSync(join(dir, 'new-provider-ip'), 0o755);
      const discovery = script
        .slice(
          script.indexOf('\nCONFIG\n') + '\nCONFIG\n'.length,
          script.indexOf('chmod 600 /etc/rancher/k3s/config.yaml'),
        )
        .replaceAll('/etc/rancher/k3s/config.yaml', config);
      execFileSync('bash', ['-c', `set -euo pipefail\n${discovery}`], {
        env: { PATH: `${dir}:/usr/bin:/bin` },
      });
      return readFileSync(config, 'utf8');
    };
    expect(configAfterDiscovery(newProvider.externalIpDiscovery)).toBe(
      '{\n  "node-external-ip": "203.0.113.7"\n}\n',
    );
    expect(configAfterDiscovery(null)).toBe('{\n}\n');
  });

  it("routes the Node's image pulls through containerd's transfer service with the VM hosts' ranged fetch, before the agent starts", () => {
    const script = buildNodePoolAgentStartupScript(joinInput, {
      token: 'K10abc::id.secret',
    });
    // K3s v1.35's template imports config-v3.toml.d and pins
    // use_local_image_pull = true; containerd v2.2.3-k3s1 lets an import
    // override it (issuecomment-6449617215).
    const dropIn = `cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/50-anycloud.toml <<'CONTAINERD'
version = 3
[plugins.'io.containerd.cri.v1.images']
  use_local_image_pull = false
[plugins.'io.containerd.transfer.v1.local']
  max_concurrent_downloads = ${CONTAINERD_TRANSFER_CONCURRENCY}
  concurrent_layer_fetch_buffer = ${CONTAINERD_TRANSFER_CHUNK_BYTES}
CONTAINERD
`;
    expect(script).toContain(dropIn);
    expect(script.indexOf(dropIn)).toBeLessThan(
      script.indexOf('systemctl enable --now k3s-agent.service'),
    );
  });

  it('RFC 0049 C32: adds the user-namespace handler and its base spec before the agent starts, and /dev/kvm 0666 with nested virtualization', () => {
    const script = (nestedVirtualization: boolean) =>
      buildNodePoolAgentStartupScript(
        { ...joinInput, userNamespace: { nestedVirtualization } },
        { token: 'K10abc::id.secret' },
      );
    const dir = '/var/lib/rancher/k3s/agent/etc/containerd';
    const dropIn = `cat > ${dir}/config-v3.toml.d/60-anycloud-userns.toml <<'CONTAINERD'
version = 3
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.anycloud-userns]
  runtime_type = "io.containerd.runc.v2"
  cgroup_writable = true
  base_runtime_spec = "${dir}/anycloud-userns-spec.json"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.anycloud-userns.options]
    SystemdCgroup = true
CONTAINERD
`;
    const plain = script(false);
    expect(plain).toContain(dropIn);
    expect(plain.indexOf(dropIn)).toBeLessThan(
      plain.indexOf('systemctl enable --now k3s-agent.service'),
    );
    const spec = JSON.parse(
      /<<'SPEC'\n(.*)\nSPEC\n/su.exec(plain)![1]!,
    ) as typeof USER_NAMESPACE_BASE_SPEC;
    expect(spec).toEqual(USER_NAMESPACE_BASE_SPEC);
    // The Node's /sys, recursively and read-write, and no NOFILE of 1024.
    expect(spec.mounts.find((m) => m.destination === '/sys')).toEqual({
      destination: '/sys',
      type: 'bind',
      source: '/sys',
      options: ['rbind', 'nosuid', 'noexec', 'nodev', 'rw'],
    });
    expect(spec.process).not.toHaveProperty('rlimits');
    expect(plain).not.toContain('99-anycloud-kvm.rules');
    expect(script(true)).toContain(
      `echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' > /etc/udev/rules.d/99-anycloud-kvm.rules
udevadm control --reload-rules
if [ -e /dev/kvm ]; then
  udevadm trigger --action=change --name-match=kvm
  udevadm settle
fi
`,
    );
    // Within AWS's 16 KiB of user data, with the most C11 images on NVMe.
    const longest = nodePoolPrepullImages(
      '0.1.72',
      Array.from({ length: 10 }, (_, index) => ({
        image: `registry.example.com/organization/team/image-${index}`,
        imageDigest: `sha256:${'a'.repeat(64)}`,
        registryToken: false,
      })),
    );
    expect(
      Buffer.byteLength(
        buildNodePoolAgentStartupScript(
          {
            ...joinInput,
            disk: { ...joinInput.disk, nvme: true },
            prepullImages: longest,
            userNamespace: { nestedVirtualization: true },
          },
          { token: 'K10abc::id.secret' },
        ),
      ),
    ).toBeLessThanOrEqual(16 * 1024);
  });

  it('C11: a new Node pulls the runner-install image, then the newest four managed images that pull without a Secret, by digest and once each', () => {
    const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
    const managed = (image: string, hex: string, registryToken = false) => ({
      image,
      imageDigest: digest(hex),
      registryToken,
    });
    expect(
      nodePoolPrepullImages('0.1.72', [
        // A non-ghcr.io image pulls without its submitter's token.
        managed('quay.io/org/tool:1', 'd', true),
        managed('ghcr.io/org/private:latest', 'b', true),
        managed('example/public:latest', 'a'),
        // Another shape of the same digest pulls the same image.
        managed('example/public:latest', 'a'),
        managed('ghcr.io/org/public:latest', 'c'),
        managed('example/next:1', 'e'),
        managed('example/oldest:1', 'f'),
      ]),
    ).toEqual([
      apiImageTagReference('0.1.72'),
      `quay.io/org/tool@${digest('d')}`,
      `docker.io/example/public@${digest('a')}`,
      `ghcr.io/org/public@${digest('c')}`,
      `docker.io/example/next@${digest('e')}`,
    ]);
    expect(nodePoolPrepullImages('0.1.72', [])).toEqual([
      apiImageTagReference('0.1.72'),
    ]);
  });

  it('C11: pulls the listed images in the background once the agent runs, in order and under one deadline, so no pull delays registration', () => {
    const images = [
      'ghcr.io/anycloud-sh/api:0.1.72',
      'docker.io/library/broken@sha256:1',
      'docker.io/library/slow@sha256:2',
      "docker.io/library/late@sha256:3'quoted",
    ];
    const script = buildNodePoolAgentStartupScript(
      { ...joinInput, prepullImages: images },
      { token: 'K10abc::id.secret' },
    );
    execFileSync('bash', ['-n'], { input: script });
    // The agent neither requires nor waits for the pull, which starts
    // without blocking once the agent's unit is up and has no boot target.
    const agentUnit = script.slice(
      script.indexOf("k3s-agent.service <<'UNIT'"),
    );
    expect(agentUnit.slice(0, agentUnit.indexOf('\nUNIT\n'))).not.toMatch(
      /prepull/,
    );
    expect(script).toMatch(
      /systemctl enable --now k3s-agent\.service\nsystemctl start --no-block anycloud-prepull\.service\n$/,
    );
    expect(script).toContain(
      "cat > /etc/systemd/system/anycloud-prepull.service <<'UNIT'\n[Unit]\nDescription=AnyCloud: pull the pool's recent images once the agent runs\nAfter=k3s-agent.service\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/anycloud-prepull\nUNIT\n",
    );

    // A failed pull moves on; a slow one ends at the deadline, and the
    // images after it are skipped. Each quoted reference arrives intact.
    const slow = prepullOnFakeStore(script, { deadline: 2 });
    expect(slow).toMatchObject({
      status: 0,
      pulls: images.slice(0, 3),
    });
    expect(slow.seconds).toBeLessThan(10);
    expect(slow.stderr).toContain(
      'anycloud: pre-pull of docker.io/library/broken@sha256:1 failed',
    );
    expect(slow.stderr).toContain(
      'anycloud: pre-pull of docker.io/library/slow@sha256:2 failed',
    );
    expect(slow.stderr).toContain(
      `anycloud: pre-pull stopped at its deadline before ${images[3]}`,
    );
    // A CRI that never answers ends the pull at the deadline with nothing
    // pulled.
    expect(
      prepullOnFakeStore(script, { deadline: 0, criUp: false }),
    ).toMatchObject({ status: 0, pulls: [] });
  });

  it("C11: stops pre-pulling within the Node's image allowance and 2 GiB above the 5% eviction threshold", () => {
    const run = (images: string[], availGi: number) => {
      const script = buildNodePoolAgentStartupScript(
        { ...joinInput, prepullImages: images },
        { token: 'K10abc::id.secret' },
      );
      expect(script).toContain('kubeReserved:\n  ephemeral-storage: 10Gi');
      return prepullOnFakeStore(script, { availGi });
    };
    // 10 GiB allowance from 60 GiB free: the pull that leaves 49 GiB is
    // stopped while it runs, and nothing after it starts.
    const allowance = run(
      ['example/fill-56', 'example/slow-fill-49', 'example/fill-48'],
      60,
    );
    expect(allowance).toMatchObject({
      status: 0,
      pulls: ['example/fill-56', 'example/slow-fill-49'],
    });
    expect(allowance.seconds).toBeLessThan(10);
    expect(allowance.stderr).toContain(
      'anycloud: pre-pull stopped at the image allowance during example/slow-fill-49',
    );
    // From 10 GiB free on a 100 GiB store, the eviction bound (5% plus
    // 2 GiB, 7 GiB) is the tighter one: the pull that crosses it is the
    // last, whether the watch sees it cross before or after the pull ends.
    const eviction = run(
      ['example/fill-8', 'example/fill-6', 'example/fill-5'],
      10,
    );
    expect(eviction).toMatchObject({
      status: 0,
      pulls: ['example/fill-8', 'example/fill-6'],
    });
    expect(eviction.stderr).toContain(
      'anycloud: pre-pull stopped at the eviction threshold',
    );
  });

  it("pins each cloud's join script rendered from its gateway's inputs, within AWS's 16 KiB user data", () => {
    const rendered = (
      boot: NodePoolBootInputs,
      cloudProvider = CloudType.AWS,
      nvme = false,
      prepullImages = joinInput.prepullImages,
    ) =>
      buildNodePoolAgentStartupScript(
        {
          ...joinInput,
          cloudProvider,
          accelerator: 'nvidia',
          disk: { ...joinInput.disk, nvme },
          boot,
          prepullImages,
        },
        { token: 'K10abc::id.secret' },
      );
    // The revision label is left out, so the hash moves only with the
    // script itself, and is pinned with the revision it shipped under.
    const sha256 = (script: string) =>
      createHash('sha256')
        .update(script.replace(`join-revision=${NODE_POOL_JOIN_REVISION}`, ''))
        .digest('hex');
    const bump =
      'the join script changed: bump NODE_POOL_JOIN_REVISION (once per release) and update this hash';
    expect(NODE_POOL_JOIN_REVISION, bump).toBe('4');
    // Each cloud's whole script, so any change to one is deliberate.
    expect(
      {
        aws: sha256(rendered(AWS_NODE_POOL_BOOT, CloudType.AWS)),
        gcp: sha256(rendered(GCP_NODE_POOL_BOOT, CloudType.GCP)),
        azure: sha256(rendered(AZURE_NODE_POOL_BOOT, CloudType.Azure)),
        lambda: sha256(rendered(LAMBDA_NODE_POOL_BOOT, CloudType.Lambda)),
        // NVMe's scratch unit, which carries the Node cache (C12).
        awsNvme: sha256(rendered(AWS_NODE_POOL_BOOT, CloudType.AWS, true)),
      },
      bump,
    ).toEqual({
      aws: '33241eec8ad8cfdc7ce6644a1346115a4d31342dea61ddb578c20c236045addf',
      gcp: 'ef564f1a20a8152442b02d96a2eb36f3683ed0ed36d5d25b142e359372129761',
      azure: '70caa48043cd215e5f568cd921309c5310bd2893eee73079e4ba537856c18cdf',
      lambda:
        '41d1deea2484bf5713d73b6183662d1519a79f9e614f76458d9e20b88535eaec',
      awsNvme:
        'aa784161e3b74818a695518e27f1177b30d7944371fc43a53cd3312d47c755db',
    });
    // B1: the largest script, on NVMe with the runner and C11's most Job
    // images, fits AWS's limit, the tightest.
    const longest = nodePoolPrepullImages(
      '0.1.72',
      Array.from({ length: 10 }, (_, index) => ({
        image: `registry.example.com/organization/team/image-${index}`,
        imageDigest: `sha256:${'a'.repeat(64)}`,
        registryToken: false,
      })),
    );
    for (const boot of [
      AWS_NODE_POOL_BOOT,
      GCP_NODE_POOL_BOOT,
      AZURE_NODE_POOL_BOOT,
      LAMBDA_NODE_POOL_BOOT,
      newProvider,
    ]) {
      expect(
        Buffer.byteLength(rendered(boot, CloudType.AWS, true, longest)),
      ).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it('mounts local NVMe under kubelet, containerd and the Node cache before the agent on NVMe sizes only', () => {
    const disk = { nvme: true, systemReservedGi: 0, kubeReservedGi: 100 };
    const script = buildNodePoolAgentStartupScript(
      { ...joinInput, disk },
      { token: 'K10abc::id.secret' },
    );
    execFileSync('bash', ['-n'], { input: script });
    expect(script).toContain(
      'Requires=anycloud-scratch.service\nAfter=anycloud-scratch.service\n',
    );
    expect(script).toContain('kubeReserved:\n  ephemeral-storage: 100Gi');
    // The script mounts; a mount unit ordered after the service would loop
    // through local-fs.target on every later boot.
    expect(script).not.toContain('.mount');
    const plain = buildNodePoolAgentStartupScript(joinInput, {
      token: 'K10abc::id.secret',
    });
    expect(plain).not.toMatch(/anycloud-scratch/);

    // The per-boot script against stubbed disk tools, as spike 38622584290
    // found the AWS DLAMI leaves an instance: its unit has made one device an
    // LVM volume mounted at /opt/dlami/nvme. Another holds an interrupted
    // array. Both are taken over; the partitioned root is not.
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-scratch-'));
    mkdirSync(`${dir}/lib/systemd/system`, { recursive: true });
    writeFileSync(
      `${dir}/lib/systemd/system/dlami-nvme.service`,
      'ExecStart=/opt/aws/dlami/bin/nvme_ephemeral_drives.sh\n',
    );
    let unit = script.slice(
      script.indexOf("<<'SCRIPT'\n") + "<<'SCRIPT'\n".length,
      script.indexOf('\nSCRIPT\n'),
    );
    for (const path of ['/var/lib/', '/etc/', '/lib/systemd/']) {
      unit = unit.replaceAll(` ${path}`, ` ${dir}${path}`);
    }
    const stubs: Record<string, string> = {
      lsblk: `case "$*" in
  -dnpo*) printf '/dev/nvme0n1 disk\\n/dev/nvme1n1 disk\\n/dev/nvme2n1 disk\\n/dev/sda disk\\n' ;;
  "-nlo TYPE /dev/nvme0n1") printf 'disk\\npart\\n' ;;
  "-nlo TYPE /dev/nvme1n1") printf 'disk\\nlvm\\n' ;;
  -nlo*) printf 'disk\\nraid0\\n' ;;
  -nlpo*) printf '/dev/nvme1n1 disk\\n/dev/mapper/vg.01-lv_ephemeral lvm\\n/dev/nvme2n1 disk\\n/dev/md127 raid0\\n' ;;
esac`,
      pvs: `echo '  vg.01'`,
      mountpoint: 'exit 1',
    };
    for (const tool of [
      ...Object.keys(stubs),
      'systemctl',
      'umount',
      'vgchange',
      'wipefs',
      'mdadm',
      'mkfs.ext4',
      'udevadm',
      'mount',
    ]) {
      writeFileSync(
        join(dir, tool),
        `#!/bin/bash\necho "${tool} $*" >> ${dir}/calls\n${stubs[tool] ?? ''}\n`,
      );
      chmodSync(join(dir, tool), 0o755);
    }
    execFileSync('bash', ['-c', unit], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .filter((call) => !/^(udevadm|mountpoint|lsblk)/.test(call));
    expect(calls).toEqual([
      'mdadm --assemble --scan',
      'systemctl disable --now dlami-nvme.service',
      'umount /dev/mapper/vg.01-lv_ephemeral',
      'umount /dev/md127',
      'pvs --noheadings -o vg_name /dev/nvme1n1 /dev/nvme2n1',
      'vgchange -an vg.01',
      'mdadm --stop /dev/md127',
      'umount /dev/nvme1n1',
      'wipefs -a /dev/nvme1n1',
      'umount /dev/nvme2n1',
      'wipefs -a /dev/nvme2n1',
      'mdadm --create /dev/md/anycloud-scratch --run --level=0 --raid-devices=2 /dev/nvme1n1 /dev/nvme2n1',
      'mkfs.ext4 -F -q -m 0 -L anycloud-scratch -E lazy_itable_init=1,lazy_journal_init=1,nodiscard /dev/md/anycloud-scratch',
      `mount /dev/disk/by-label/anycloud-scratch ${dir}/var/lib/anycloud/scratch`,
      `mount --bind ${dir}/var/lib/anycloud/scratch/kubelet ${dir}/var/lib/kubelet`,
      `mount --bind ${dir}/var/lib/anycloud/scratch/containerd ${dir}/var/lib/rancher/k3s/agent/containerd`,
      // The cache sits on the filesystem kubelet's eviction watches.
      `mount --bind ${dir}/var/lib/anycloud/scratch/node-cache ${dir}/var/lib/anycloud/node-cache`,
    ]);
  });

  it("starts an NVIDIA Node's agent only once every GPU's fabric is ready, and fails the boot when it never is", () => {
    const script = buildNodePoolAgentStartupScript(
      { ...joinInput, accelerator: 'nvidia' },
      { token: 'K10abc::id.secret' },
    );
    execFileSync('bash', ['-n'], { input: script });
    expect(script).toContain(
      'Requires=anycloud-gpu-fabric.service\nAfter=anycloud-gpu-fabric.service\n',
    );
    expect(
      buildNodePoolAgentStartupScript(joinInput, {
        token: 'K10abc::id.secret',
      }),
    ).not.toMatch(/anycloud-gpu-fabric/);
    const start = "anycloud-gpu-fabric <<'SCRIPT'\n";
    const body = script.slice(script.indexOf(start) + start.length);
    const unit = body.slice(0, body.indexOf('\nSCRIPT\n'));

    /** Each `nvidia-smi` call prints the next output; null: no nvidia-smi. */
    const gate = (outputs: string[] | null, timeout = true) => {
      const dir = mkdtempSync(join(tmpdir(), 'anycloud-gpu-fabric-'));
      for (const tool of ['sed', 'grep', 'cat']) {
        const path = execFileSync('sh', ['-c', `command -v ${tool}`])
          .toString()
          .trim();
        symlinkSync(path, join(dir, tool));
      }
      writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n');
      chmodSync(join(dir, 'sleep'), 0o755);
      outputs?.forEach((output, index) =>
        writeFileSync(join(dir, `out.${index}`), output),
      );
      if (outputs) {
        writeFileSync(
          join(dir, 'nvidia-smi'),
          `#!/bin/bash
echo "$*" >> ${dir}/calls
n=$(cat ${dir}/calls | grep -c .)
f=${dir}/out.$((n - 1))
[ -e "$f" ] || f=${dir}/out.${(outputs.length || 1) - 1}
[ "$(cat "$f")" = unsupported ] && { echo 'Field "fabric.state" is not a valid field to query.'; exit 2; }
cat "$f"
`,
        );
        chmodSync(join(dir, 'nvidia-smi'), 0o755);
      }
      const run = spawnSync(
        '/bin/bash',
        ['-c', timeout ? unit.replace(/SECONDS \+ \d+/, 'SECONDS') : unit],
        { env: { PATH: dir } },
      );
      const calls = outputs
        ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
        : [];
      return {
        status: run.status,
        polls: calls.length,
        stderr: `${run.stderr}`,
      };
    };
    // A fabric still registering holds the agent until every GPU completes.
    expect(
      gate(['In Progress\nCompleted\n', 'Completed\nCompleted\n'], false),
    ).toMatchObject({ status: 0, polls: 2 });
    // GPUs without a fabric, in each form drivers print, pass at once.
    for (const output of ['N/A\n', '"Not Supported"\n', 'state  N/A\n', '']) {
      expect(gate([output])).toMatchObject({ status: 0, polls: 1 });
    }
    // An older driver without the query, or no nvidia-smi, proceeds.
    expect(gate(['unsupported'])).toMatchObject({ status: 0, polls: 1 });
    expect(gate(null)).toMatchObject({ status: 0 });
    // A fabric that never comes up fails the unit, so the agent never starts.
    expect(gate(['Completed\nNot Started\n'])).toMatchObject({
      status: 1,
      polls: 1,
      stderr: expect.stringContaining('Completed Not Started'),
    });
  });

  it("installs the VM hosts' pinned unpigz before the agent's first pull, and joins when the install fails", () => {
    const script = buildNodePoolAgentStartupScript(joinInput, {
      token: 'K10abc::id.secret',
    });
    const install = `timeout 300 sh -c '${installUnpigzCommand().replaceAll("'", `'"'"'`)}' ||\n  echo "anycloud: unpigz install failed; pulls use Go gzip" >&2\n`;
    expect(script).toContain(install);
    expect(script.indexOf(install)).toBeLessThan(
      script.indexOf('systemctl enable --now k3s-agent.service'),
    );
    // The quoted command reaches sh intact, and a failed or timed-out
    // install leaves the strict boot script running.
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-unpigz-'));
    writeFileSync(
      join(dir, 'timeout'),
      `#!/bin/bash\nprintf '%s' "$4" > ${dir}/command\nexit 124\n`,
    );
    chmodSync(join(dir, 'timeout'), 0o755);
    const run = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n${install}echo joined`],
      { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('joined\n');
    expect(readFileSync(join(dir, 'command'), 'utf8')).toBe(
      installUnpigzCommand(),
    );
  });

  it("binds kubelet, containerd and the Node cache to Azure's resource disk before the agent on sizes without NVMe", () => {
    const azure = (nvme: boolean) =>
      buildNodePoolAgentStartupScript(
        {
          ...joinInput,
          cloudProvider: CloudType.Azure,
          disk: { ...joinInput.disk, nvme },
          boot: AZURE_NODE_POOL_BOOT,
        },
        { token: 'K10abc::id.secret' },
      );
    const script = azure(false);
    execFileSync('bash', ['-n'], { input: script });
    // Wants, not Requires: without the disk the stores stay on the OS disk.
    expect(script).toContain(
      'Wants=anycloud-image-store.service\nAfter=anycloud-image-store.service\n[Service]',
    );
    // Raw-NVMe sizes keep ST2b; other clouds never probe for the disk.
    for (const other of [
      azure(true),
      buildNodePoolAgentStartupScript(joinInput, {
        token: 'K10abc::id.secret',
      }),
    ]) {
      expect(other).not.toContain('anycloud-image-store');
    }
    expect(azure(true)).toContain('Requires=anycloud-scratch.service');

    // The first-boot step against a probed disk: the unit lands only for a
    // mounted disk at least as large as the root filesystem.
    const step = script.slice(
      script.indexOf('STORE_MOUNT='),
      script.indexOf('fi\n', script.indexOf('STORE_MOUNT=')) + 3,
    );
    expect(step).toContain(RESOURCE_DISK_PROBE);
    const firstBoot = (probe: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'anycloud-store-'));
      mkdirSync(`${dir}/etc/systemd/system`, { recursive: true });
      execFileSync('bash', [
        '-c',
        `set -euo pipefail\n${step
          .replace(RESOURCE_DISK_PROBE, `echo '${probe}'`)
          .replaceAll(' /etc/', ` ${dir}/etc/`)}`,
      ]);
      const unitPath = `${dir}/etc/systemd/system/anycloud-image-store.service`;
      return existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : null;
    };
    // NC4as_T4_v3: a 180 GB resource disk beside the 100 GB OS disk.
    const unit = firstBoot('/mnt 184443844 101430960')!.split('\n');
    for (const line of [
      'RequiresMountsFor=/mnt',
      'ConditionPathIsMountPoint=/mnt',
      'After=ephemeral-disk-warning.service',
      'Before=k3s-agent.service',
      'WantedBy=multi-user.target',
    ]) {
      expect(unit).toContain(line);
    }
    const execStart = unit
      .find((line) => line.startsWith('ExecStart=/bin/sh -c '))!
      .slice("ExecStart=/bin/sh -c '".length, -1);
    expect(execStart).toBe(
      'install -d -m 0711 /mnt/anycloud/kubelet /var/lib/kubelet && { mountpoint -q /var/lib/kubelet || mount --bind /mnt/anycloud/kubelet /var/lib/kubelet; } && ' +
        'install -d -m 0711 /mnt/anycloud/containerd /var/lib/rancher/k3s/agent/containerd && { mountpoint -q /var/lib/rancher/k3s/agent/containerd || mount --bind /mnt/anycloud/containerd /var/lib/rancher/k3s/agent/containerd; } && ' +
        'install -d -m 0711 /mnt/anycloud/node-cache /var/lib/anycloud/node-cache && { mountpoint -q /var/lib/anycloud/node-cache || mount --bind /mnt/anycloud/node-cache /var/lib/anycloud/node-cache; }',
    );
    for (const probe of [
      '',
      '/mnt 76794788 520300000',
      '/mnt unknown 101430960',
      '/ 184443844 101430960',
    ]) {
      expect(firstBoot(probe)).toBeNull();
    }
  });

  it('accepts clusterRecords within the kubelet skew window and refuses the rest', () => {
    for (const minor of [35, 36, 37, 38]) {
      expect(() =>
        assertAgentVersionSkew({
          major: 1,
          minor,
          gitVersion: `v1.${minor}.0`,
        }),
      ).not.toThrow();
    }
    for (const minor of [30, 34, 39, 40]) {
      expect(() =>
        assertAgentVersionSkew({
          major: 1,
          minor,
          gitVersion: `v1.${minor}.0`,
        }),
      ).toThrow(NodePoolAgentSkewError);
    }
    expect(() =>
      assertAgentVersionSkew({ major: 2, minor: 0, gitVersion: 'v2.0.0' }),
    ).toThrow(/between v1.35 and v1.38/);
  });
});
