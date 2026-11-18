#!/usr/bin/env tsx
/**
 * Does the AWS GPU AMI claim the instance store before ST2b's per-boot NVMe
 * unit runs, and do the unit's takeover and boot ordering hold across a
 * reboot? One g4dn.xlarge on the production DLAMI; see README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { AWS_NODE_POOL_BOOT } from '../../src/api/services/gateways/aws.js';
import { buildNodePoolAgentStartupScript } from '../../src/api/services/kubernetes/node-pool-join.js';
import { CloudType } from '../../src/shared/cloud.js';

const REGION = 'us-east-1';
const INSTANCE_TYPE = 'g4dn.xlarge';
const OWNER_TAG = { Key: 'anycloud-spike', Value: 'dlami-nvme' };
const DEADLINE_MS = 40 * 60_000;
const ec2 = new EC2Client({ region: REGION });
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');

function save(name: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** ST2b's NVMe unit and the agent's ordering lines, exactly as a pool VM gets them. */
function st2bUnits(): { unit: string; agentOrdering: string } {
  const script = buildNodePoolAgentStartupScript(
    {
      clusterId: 'spike',
      nodePoolId: 'spike',
      cloudProvider: CloudType.AWS,
      vmRowId: 1,
      joinEndpoint: 'https://192.0.2.1:6443',
      certificateAuthorityData: Buffer.from('ca').toString('base64'),
      disk: { nvme: true, systemReservedGi: 0, kubeReservedGi: 100 },
      boot: AWS_NODE_POOL_BOOT,
      prepullImages: [],
    },
    { token: 'K10spike::spike.spike' },
  );
  const agent = "cat > /etc/systemd/system/k3s-agent.service <<'UNIT'\n";
  const start = script.indexOf('cat > /usr/local/sbin/anycloud-scratch');
  const agentUnit = script.slice(script.indexOf(agent) + agent.length);
  return {
    unit: script.slice(start, script.indexOf(agent)),
    agentOrdering: agentUnit
      .slice(0, agentUnit.indexOf('[Service]'))
      .split('\n')
      .filter((line) => /^(Requires|After|Wants)=/.test(line))
      .join('\n'),
  };
}

/** Phase 1 records what the DLAMI did, installs the unit and reboots once; phase 2 reports. */
function userData(): string {
  const { unit, agentOrdering } = st2bUnits();
  return `#!/bin/bash
exec > >(tee /dev/console) 2>&1
echo "SPIKE-PHASE first boot $(date -u +%FT%TZ)"
systemctl list-units --all --no-pager | grep -i -E 'nvme|dlami' || true
for u in $(grep -ls nvme_ephemeral_drives /etc/systemd/system/*.service /lib/systemd/system/*.service); do
  echo "SPIKE-DLAMI-UNIT $u"; cat "$u"
  systemctl show --no-pager -p ActiveState,ActiveEnterTimestampMonotonic,After,Before,WantedBy "\${u##*/}"
done
systemctl show --no-pager -p ActiveEnterTimestampMonotonic cloud-config.service cloud-final.service
lsblk -f; findmnt /opt/dlami/nvme || echo "SPIKE /opt/dlami/nvme not mounted"; cat /proc/mdstat; cat /etc/fstab
${unit}cat > /etc/systemd/system/k3s-agent.service <<'UNIT'
[Unit]
Description=Spike stand-in for the node pool agent
${agentOrdering}
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
UNIT
cat > /usr/local/sbin/spike-report <<'SCRIPT'
#!/bin/bash
exec > /dev/console 2>&1
echo "SPIKE-PHASE second boot $(date -u +%FT%TZ)"
echo "SPIKE agent=$(systemctl is-active k3s-agent) scratch=$(systemctl is-active anycloud-scratch)"
journalctl -b --no-pager | grep -i -E 'ordering cycle|anycloud-scratch|k3s-agent|dlami|nvme_ephemeral' || true
findmnt /var/lib/kubelet; findmnt /var/lib/rancher/k3s/agent/containerd; findmnt /opt/dlami/nvme || true
lsblk -f; cat /etc/fstab
echo SPIKE-DONE
systemctl poweroff
SCRIPT
chmod 755 /usr/local/sbin/spike-report
cat > /etc/systemd/system/spike-report.service <<'UNIT'
[Unit]
After=k3s-agent.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/spike-report
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now k3s-agent.service
echo "SPIKE first boot agent=$(systemctl is-active k3s-agent) scratch=$(systemctl is-active anycloud-scratch)"
findmnt /var/lib/kubelet; findmnt /var/lib/rancher/k3s/agent/containerd; lsblk -f; cat /etc/fstab
systemctl enable spike-report.service
echo "SPIKE-PHASE rebooting"
systemctl reboot
`;
}

async function dlamiImage(): Promise<string> {
  const { Images = [] } = await ec2.send(
    new DescribeImagesCommand({
      Owners: ['amazon'],
      Filters: [
        {
          Name: 'name',
          Values: [
            'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*',
          ],
        },
      ],
    }),
  );
  const image = Images.filter((i) =>
    /^Deep Learning Base OSS Nvidia Driver GPU AMI \(Ubuntu 24\.04\) [0-9]{8}$/.test(
      i.Name ?? '',
    ),
  ).sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
  )[0];
  if (!image?.ImageId) throw new Error('no DLAMI in ' + REGION);
  save('image.json', { id: image.ImageId, name: image.Name });
  return image.ImageId;
}

async function ownedInstances(): Promise<string[]> {
  const { Reservations = [] } = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${OWNER_TAG.Key}`, Values: [OWNER_TAG.Value] },
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
}

async function cleanup(): Promise<void> {
  const ids = await ownedInstances();
  if (ids.length) {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
  }
  for (let i = 0; i < 40; i++) {
    if ((await ownedInstances()).length === 0) {
      save('cleanup.json', { terminated: ids, remaining: [] });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error('spike instances are still not terminated');
}

async function run(): Promise<void> {
  const imageId = await dlamiImage();
  const { Instances = [] } = await ec2.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: INSTANCE_TYPE,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData()).toString('base64'),
      InstanceInitiatedShutdownBehavior: 'terminate',
      TagSpecifications: [{ ResourceType: 'instance', Tags: [OWNER_TAG] }],
    }),
  );
  const id = Instances[0]!.InstanceId!;
  save('instance.json', { id, region: REGION, type: INSTANCE_TYPE });
  const started = Date.now();
  // `Latest` returns the newest 64 KB, so the first boot's lines are kept
  // from earlier reads.
  const seen = new Set<string>();
  const serial: string[] = [];
  const done = () => serial.some((line) => line.includes('SPIKE-DONE'));
  while (Date.now() - started < DEADLINE_MS && !done()) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const { Output } = await ec2.send(
      new GetConsoleOutputCommand({ InstanceId: id, Latest: true }),
    );
    for (const line of Buffer.from(Output ?? '', 'base64')
      .toString('utf8')
      .split(/\r?\n/)) {
      if (!seen.has(line)) serial.push(line);
      seen.add(line);
    }
  }
  save('console.txt', serial.join('\n'));
  save('summary.json', {
    done: done(),
    orderingCycle: serial.some((line) => /ordering cycle/i.test(line)),
    lines: serial.filter((line) => line.includes('SPIKE')),
  });
  if (!done()) {
    throw new Error('the instance never reported its second boot');
  }
}

const phase = process.argv[2] ?? process.env.SPIKE_PHASE ?? 'run';
await (phase === 'cleanup' ? cleanup() : run());
