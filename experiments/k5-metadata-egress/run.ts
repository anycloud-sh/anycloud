#!/usr/bin/env tsx
/** The K5 metadata egress spike; see README.md. */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
import { buildNodePoolAgentStartupScript } from '../../src/api/services/kubernetes/node-pool-join.js';
import {
  buildNodePoolEgressPolicy,
  buildNodePoolNamespace,
} from '../../src/api/services/kubernetes/node-pool-namespace.js';
import {
  NVIDIA_ACCELERATOR_LABEL_VALUE,
  nodePoolNamespace,
  nodePoolPodScheduling,
} from '../../src/api/services/kubernetes/node-pool-scheduling.js';
import { selectAzureGpuImageId } from '../../src/shared/catalog/azure-gpu-map.js';
import { CloudType } from '../../src/shared/cloud.js';

const TAG = { key: 'anycloud-spike', value: 'k5-metadata-egress' };
const AWS_REGION = 'us-east-1';
const AZURE_REGION = 'westus2';
const GCP_ZONE = 'us-central1-a';
const ROUNDS = 3;
const PROBES = 60;
const GUEST_DEADLINE_MIN = 50;
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const runId = process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
const name = `ac-spike-k5md-${runId}`;

interface Target {
  id: 'azure-gpu' | 'azure-cpu' | 'aws' | 'gcp';
  cloud: CloudType;
  size: string;
  /** The GPU model; the CI runner has no catalog to look it up. */
  accelerator?: string;
}
const TARGETS: Target[] = [
  {
    id: 'azure-gpu',
    cloud: CloudType.Azure,
    size: 'Standard_NC4as_T4_v3',
    accelerator: 'T4',
  },
  { id: 'azure-cpu', cloud: CloudType.Azure, size: 'Standard_D2s_v5' },
  { id: 'aws', cloud: CloudType.AWS, size: 't3.medium' },
  { id: 'gcp', cloud: CloudType.GCP, size: 'e2-standard-2' },
];

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** The guest: a local K3s server, the product's join script, then the rounds. */
function guestScript(target: Target, uploadUrl: string) {
  const nodePoolId = `spike${target.id.replace('-', '')}`;
  const clusterId = 'spike';
  const token = randomBytes(16).toString('hex');
  const join = buildNodePoolAgentStartupScript(
    {
      clusterId,
      nodePoolId,
      cloudProvider: target.cloud,
      vmRowId: 1,
      ...(target.accelerator
        ? { accelerator: NVIDIA_ACCELERATOR_LABEL_VALUE }
        : {}),
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
  const pod = (podName: string, command: string) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: podName, namespace },
    spec: {
      ...nodePoolPodScheduling(clusterId, nodePoolId),
      restartPolicy: 'Never',
      dnsPolicy: 'Default',
      containers: [
        {
          name: 'main',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          command: ['sh', '-c', command],
        },
      ],
    },
  });
  // wget's error text separates the outcomes: any HTTP answer means the TCP
  // connection was made. On Azure the Pod also tries the WireServer's two
  // ports at its first moment, beside the first metadata probes, and
  // after them.
  const wire =
    target.cloud === CloudType.Azure
      ? (when: string) =>
          `for port in 80 32526; do echo "WIRE $port ${when} $(try http://168.63.129.16:$port/)" & done`
      : () => ':';
  const probe = `try() { if out=$(wget -q -T 1 -O /dev/null "$1" 2>&1); then echo reachable
else case "$out" in *"server returned"*) echo reachable;; *refused*) echo refused;; *"timed out"*) echo timeout;; *) echo "other:$out";; esac; fi; }
${wire('start')}
i=0; while [ $i -lt ${PROBES} ]; do i=$((i+1))
echo "PROBE $i $(try http://169.254.169.254/)"; sleep 0.5; done
wait
${wire('end')}
wait
if timeout 5 nslookup example.com 169.254.169.254 >/dev/null 2>&1; then echo "DNS ok"; else echo "DNS failed"; fi`;
  const files: Record<string, unknown> = {
    'policy.json': {
      apiVersion: 'v1',
      kind: 'List',
      items: [
        buildNodePoolNamespace({ clusterId, nodePoolId }),
        buildNodePoolEgressPolicy({ clusterId, nodePoolId }),
      ],
    },
  };
  for (let round = 1; round <= ROUNDS; round++) {
    files[`done-${round}.json`] = pod(`done-${round}`, 'sleep 5');
    files[`probe-${round}.json`] = pod(`probe-${round}`, probe);
  }
  const heredocs = Object.entries(files)
    .map(
      ([file, body]) => `cat > ${file} <<'JSON'\n${JSON.stringify(body)}\nJSON`,
    )
    .join('\n');
  return `#!/bin/bash
shutdown -h +${GUEST_DEADLINE_MIN}
exec > >(tee /var/log/spike.log /dev/console) 2>&1
mkdir -p /var/spike/snap && cd /var/spike
upload() {
  touch /var/spike/done
  journalctl -b -o short-iso-precise --no-pager -u k3s-agent > agent.journal
  journalctl -b -o short-iso-precise --no-pager -u spike-k3s-server > server.journal
  journalctl -b -o short-iso-precise --no-pager -u anycloud-metadata-block > block.journal
  cp /var/log/spike.log .
  tar czf /var/spike.tgz -C /var/spike .
  curl -sf --retry 5 -X PUT -H 'Content-Type: application/gzip' --upload-file /var/spike.tgz ${JSON.stringify(uploadUrl)}
  shutdown -h now
}
trap upload EXIT
${heredocs}
cat > join.sh <<'ANYCLOUD_JOIN'
${join}ANYCLOUD_JOIN
echo "variant=${join.includes('anycloud-metadata-block') ? 'B' : 'A'}" > meta
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
# K3s exits, with status 0 or 1, when a startup race stops its cloud
# controller; restart it whatever the status.
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
ready() { k get nodes --no-headers 2>/dev/null | grep -q ' Ready'; }
for i in $(seq 150); do ready && break; sleep 2; done
ready || { echo "SPIKE Node never became Ready"; exit 1; }
k get nodes -o wide > nodes.txt
echo "block=$(systemctl is-active anycloud-metadata-block 2>/dev/null)" >> meta
echo "externalIp=$(grep -c node-external-ip /etc/rancher/k3s/config.yaml)" >> meta
k apply -f policy.json
PATH=$PATH:/var/lib/rancher/k3s/data/current/bin
capture() {
  while [ ! -e /var/spike/done ]; do
    ts=$(date +%s.%N)
    for dump in "iptables-save -t filter" "iptables-save -t raw"; do
      key=$(echo "$dump" | tr ' ' _)
      $dump > cur 2>/dev/null || true
      cmp -s cur "last-$key" || { cp cur "snap/$ts.$key"; cp cur "last-$key"; }
    done
    echo "$ts $(k get pods -n ${namespace} -o wide --no-headers 2>/dev/null | awk '{printf "%s/%s/%s ", $1, $3, $6}')" >> pods.log
    sleep 1
  done
}
capture &
sleep 30
for r in $(seq ${ROUNDS}); do
  echo "SPIKE round $r $(date +%s.%N)"
  k create -f done-$r.json
  k wait -n ${namespace} pod/done-$r --for=jsonpath='{.status.phase}'=Succeeded --timeout=300s
  k delete -n ${namespace} pod/done-$r --wait=true
  echo "probe-$r created $(date +%s.%N)" >> rounds.log
  k create -f probe-$r.json
  k wait -n ${namespace} pod/probe-$r --for=jsonpath='{.status.phase}'=Succeeded --timeout=300s
  k logs -n ${namespace} probe-$r --timestamps > probe-$r.log
  k get -n ${namespace} pod/probe-$r -o json > probe-$r.pod.json
  k delete -n ${namespace} pod/probe-$r --wait=true
  sleep 10
done
echo "SPIKE complete"
`;
}

/** Read one target's extracted evidence into per-round outcomes. */
function analyse(dir: string) {
  const meta = Object.fromEntries(
    readFileSync(join(dir, 'meta'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
  // A guest that stopped before the rounds says why in its last SPIKE line.
  if (!existsSync(join(dir, 'rounds.log'))) {
    const log = readFileSync(join(dir, 'spike.log'), 'utf8');
    return {
      variant: meta.variant,
      error: log.match(/^SPIKE .*$/gm)?.pop() ?? 'no rounds ran',
    };
  }
  const snaps = readdirSync(join(dir, 'snap'))
    .filter((file) => file.endsWith('.iptables-save_-t_filter'))
    .map((file) => ({
      at: Number(file.slice(0, file.indexOf('.iptables'))),
      rules: readFileSync(join(dir, 'snap', file), 'utf8'),
    }));
  const rawRules = readdirSync(join(dir, 'snap'))
    .filter((file) => file.endsWith('.iptables-save_-t_raw'))
    .map((file) => readFileSync(join(dir, 'snap', file), 'utf8'))
    .pop();
  const created = readFileSync(join(dir, 'rounds.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => Number(line.split(' ')[2]));
  /** The filter rules in force at a moment. */
  const rulesAt = (at: number) =>
    snaps.filter((snap) => snap.at <= at).pop()?.rules ?? '';
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round++) {
    let log: string, podJson: string;
    try {
      log = readFileSync(join(dir, `probe-${round}.log`), 'utf8');
      podJson = readFileSync(join(dir, `probe-${round}.pod.json`), 'utf8');
    } catch {
      break;
    }
    const lines = log
      .trim()
      .split('\n')
      .map((line) => {
        const [stamp, ...rest] = line.split(' ');
        return { at: Date.parse(stamp!) / 1000, text: rest.join(' ') };
      });
    const probes = lines.filter((line) => line.text.startsWith('PROBE '));
    const start = probes[0]?.at ?? NaN;
    const reachable = probes.filter((line) => line.text.endsWith(' reachable'));
    const podIp: string = JSON.parse(podJson).status?.podIP ?? '';
    const ip = `${podIp}/32`;
    const createdAt = created[round - 1]!;
    const ruleAt = rulesAt(createdAt).includes(ip)
      ? createdAt
      : snaps.find((snap) => snap.at > createdAt && snap.rules.includes(ip))
          ?.at;
    rounds.push({
      podIp,
      probes: probes.length,
      reachable: reachable.length,
      firstProbe: probes[0]?.text ?? '',
      lastReachableSec: reachable.length
        ? +(reachable.at(-1)!.at - start).toFixed(2)
        : null,
      ruleSec: ruleAt === undefined ? null : +(ruleAt - start).toFixed(2),
      dns: lines.find((line) => line.text.startsWith('DNS'))?.text ?? '',
      wireServer: lines
        .filter((line) => line.text.startsWith('WIRE '))
        .map((line) => line.text.slice('WIRE '.length)),
    });
  }
  return {
    variant: meta.variant,
    blockUnit: meta.block || 'absent',
    externalIpDiscovered: meta.externalIp === '1',
    rawChainInstalled: rawRules?.includes('-j ANYCLOUD-METADATA') ?? false,
    leaked: rounds.some((round) => round.reachable > 0),
    rounds,
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
      UserData: Buffer.from(script).toString('base64'),
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

async function launchAzure(targets: Target[], scripts: string[]) {
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
  await Promise.all(
    targets.map(async (target, index) => {
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
      const image = target.accelerator
        ? {
            communityGalleryImageId: selectAzureGpuImageId(
              target.size,
              target.accelerator,
            )!,
          }
        : {
            publisher: 'canonical',
            offer: 'ubuntu-24_04-lts',
            sku: 'server',
            version: 'latest',
          };
      await compute.virtualMachines.beginCreateOrUpdateAndWait(
        name,
        target.id,
        {
          location: AZURE_REGION,
          tags,
          hardwareProfile: { vmSize: target.size },
          osProfile: {
            computerName: target.id,
            adminUsername: 'spike',
            // Never used: no inbound rule exists and the join script stops SSH.
            adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
            customData: Buffer.from(scripts[index]!).toString('base64'),
          },
          storageProfile: {
            imageReference: image,
            osDisk: { createOption: 'FromImage', deleteOption: 'Delete' },
          },
          networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true }],
          },
        },
      );
    }),
  );
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
  const azureTargets = targets.filter((t) => t.cloud === CloudType.Azure);
  const launches = await Promise.allSettled([
    ...(azureTargets.length
      ? [
          launchAzure(
            azureTargets,
            azureTargets.map((t) => scripts[targets.indexOf(t)]!),
          ),
        ]
      : []),
    ...targets.flatMap((target, index) =>
      target.cloud === CloudType.AWS
        ? [launchAws(target, scripts[index]!)]
        : target.cloud === CloudType.GCP
          ? [launchGcp(target, scripts[index]!)]
          : [],
    ),
  ]);
  const launchErrors = launches.flatMap((launch) =>
    launch.status === 'rejected' ? [String(launch.reason)] : [],
  );
  const results: Record<
    string,
    ReturnType<typeof analyse> | { error: string }
  > = {};
  const deadline = Date.now() + (GUEST_DEADLINE_MIN + 5) * 60_000;
  const pending = new Set(targets.map((target) => target.id));
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
        results[id] = { error: String(error) };
      }
    }
  }
  for (const id of pending) results[id] = { error: 'no evidence uploaded' };
  const sourceSha = process.env.SPIKE_SOURCE_SHA ?? null;
  save('summary.json', { runId, sourceSha, launchErrors, results });
  console.log(JSON.stringify({ launchErrors, results }, null, 2));
  // "No leak" counts only from every round's full set of probes.
  const incomplete = Object.values(results).some(
    (r) =>
      'error' in r ||
      r.rounds.length !== ROUNDS ||
      r.rounds.some((round) => round.probes !== PROBES),
  );
  if (launchErrors.length || incomplete) {
    throw new Error('a target did not launch or finish; see summary.json');
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
  const filter = `labels.${TAG.key}=${TAG.value}`;
  const gcpOwned = async () => {
    const [list] = await instances.list({
      project: process.env.GCP_PROJECT_ID!,
      zone: GCP_ZONE,
      filter,
    });
    return list.map((instance) => instance.name!);
  };
  const storage = new Storage(gcpOptions());
  const bucketsOwned = async () => {
    const [buckets] = await storage.getBuckets({ prefix: 'ac-spike-k5md-' });
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
