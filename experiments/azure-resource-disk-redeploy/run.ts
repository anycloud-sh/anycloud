#!/usr/bin/env tsx
/**
 * Do the VM host's image stores land on the Azure resource disk, and does the
 * boot unit re-create them after a deallocation hands the VM a fresh disk?
 * One Standard_NC4as_T4_v3 on the GPU image VM Jobs boot; see README.md.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DefaultAzureCredential } from '@azure/identity';
import {
  RESOURCE_DISK_PROBE,
  resourceDiskStoreInstallCommand,
  resourceDiskStoreMount,
} from '../../src/api/services/resource-disk-store.js';
import { selectAzureGpuImageId } from '../../src/shared/catalog/azure-gpu-map.js';

const TAG = { 'anycloud-spike': 'azure-resource-disk-redeploy' };
const REGION = 'westus2';
const SIZE = 'Standard_NC4as_T4_v3';
const BOOT_DEADLINE_MS = 20 * 60_000;
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const name = `ac-spike-rdisk-${process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex')}`;
const credential = new DefaultAzureCredential();
const subscription = process.env.AZURE_SUBSCRIPTION_ID!;
const compute = new ComputeManagementClient(credential, subscription);
const network = new NetworkManagementClient(credential, subscription);
const resources = new ResourceManagementClient(credential, subscription);

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** Each boot reports the binds, the units and a marker written on boot 1;
 * boot 1 installs the product's store unit the way initializeVM does. */
function customData(): string {
  // cloud-init mounts the disk at /mnt; WALinuxAgent at /mnt/resource.
  const install = ['/mnt', '/mnt/resource']
    .map(
      (mount) =>
        `${mount})\nsh <<'INSTALL'\n${resourceDiskStoreInstallCommand(mount)}\nINSTALL\n;;`,
    )
    .join('\n');
  return `#!/bin/bash
cat > /usr/local/sbin/spike-report <<'SCRIPT'
#!/bin/bash
exec > >(sed -u "s/^/SPIKE boot=$1 /" > /dev/ttyS0) 2>&1
# Where a stalled start waits: the queued jobs and the store unit, first.
systemctl list-jobs --no-pager | sed 's/^/jobs /'
systemctl status --no-pager anycloud-image-store | sed 's/^/store /'
# Queue the start and poll, so a stuck job cannot hold the report.
systemctl start --no-block docker
for _ in $(seq 60); do systemctl is-active -q docker && break; sleep 5; done
if ! systemctl is-active -q docker; then
  echo "docker start failed $(systemctl is-active docker)"
  systemctl list-jobs --no-pager | sed 's/^/jobs /'
  # Why the daemon exits: its status and journal, containerd's, the config
  # it reads and what the store binds hold.
  systemctl status docker --no-pager | sed 's/^/status /'
  journalctl -u docker -b --no-pager -n 120 | sed 's/^/docker-log /'
  journalctl -u containerd -b --no-pager -n 60 | sed 's/^/containerd-log /'
  sed 's/^/daemon.json /' /etc/docker/daemon.json
  ls -la /var/lib/docker /var/lib/containerd | sed 's/^/ls /'
  # Who made the store read-only: its mode and attributes, the audit records
  # of chmod and attribute changes, and the boot's disk units.
  stat -c '%n %A' /var/lib/docker /mnt; lsattr -d /var/lib/docker /mnt
  ausearch -i -k spike-attr 2>&1 | sed 's/^/audit-attr /'
  ausearch -i -k spike-chmod 2>&1 | awk 'BEGIN{RS="----"} /docker|DATALOSS/' | sed 's/^/audit-chmod /'
  journalctl -b -o short-monotonic --no-pager -u cloud-init -u mnt.mount -u anycloud-image-store -u ephemeral-disk-warning | sed 's/^/boot-journal /'
fi
echo "kernel $(uname -r)"
echo "units $(systemctl is-active anycloud-image-store containerd docker | xargs)"
for d in docker containerd; do echo "bind $d $(findmnt -n -o SOURCE,FSTYPE /var/lib/$d | xargs)"; done
echo "root $(timeout 60 docker info --format '{{.DockerRootDir}} {{.Driver}}')"
echo "marker $([ -e /var/lib/docker/spike-marker ] && echo present || echo absent)"
# Ubuntu's walinuxagent writes this to a fresh disk's mount point.
echo "warning $([ -e /mnt/DATALOSS_WARNING_README.txt ] && echo present || echo absent) $(lsattr -d /mnt | cut -d' ' -f1)"
{ systemctl show -p ActiveEnterTimestampMonotonic anycloud-image-store; systemctl show -p InactiveExitTimestampMonotonic containerd docker; systemctl show -p ActiveEnterTimestampMonotonic ephemeral-disk-warning; } | xargs echo order
journalctl -b --no-pager | grep -i 'ordering cycle' | sed 's/^/cycle /' || true
echo DONE
SCRIPT
chmod 755 /usr/local/sbin/spike-report
# Audit chmod and attribute changes: FS_IOC_SETFLAGS and FS_IOC_FSSETXATTR.
export DEBIAN_FRONTEND=noninteractive
{ apt-get install -y -q auditd || { apt-get update -q && apt-get install -y -q auditd; }; } > /dev/null 2>&1
echo "SPIKE boot=1 auditd $(command -v auditctl || echo missing)" > /dev/ttyS0
mkdir -p /etc/audit/rules.d
cat > /etc/audit/rules.d/spike.rules <<'RULES'
-i
-a always,exit -F arch=b64 -S ioctl -F a1=0x40086602 -k spike-attr
-a always,exit -F arch=b64 -S ioctl -F a1=0x401c5820 -k spike-attr
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -k spike-chmod
-a always,exit -F arch=b64 -S fchmodat2 -k spike-chmod
RULES
# Boot 2 reports from a timer once boot settles, outside the boot transaction.
cat > /etc/systemd/system/spike-report.service <<'UNIT'
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/spike-report 2
UNIT
cat > /etc/systemd/system/spike-report.timer <<'UNIT'
[Timer]
OnBootSec=60
[Install]
WantedBy=timers.target
UNIT
systemctl enable spike-report.timer
probe=$(sh <<'PROBE'
${RESOURCE_DISK_PROBE}
PROBE
)
echo "SPIKE boot=1 probe $probe" > /dev/ttyS0
case "\${probe%% *}" in
${install}
esac
systemctl start docker && touch /var/lib/docker/spike-marker
/usr/local/sbin/spike-report 1
touch /var/lib/spike-boot1-done
`;
}

/** The serial log; Azure keeps one log across a deallocation. */
async function serialLog(): Promise<string> {
  const { serialConsoleLogBlobUri } =
    await compute.virtualMachines.retrieveBootDiagnosticsData(name, 'vm');
  if (!serialConsoleLogBlobUri) return '';
  const response = await fetch(serialConsoleLogBlobUri);
  return response.ok ? response.text() : '';
}

/** Waits for the boot's report; on timeout, saves what the VM left behind. */
async function waitFor(boot: number, before: string[]): Promise<string[]> {
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  let log = '';
  let lines: string[] = [];
  while (Date.now() < deadline) {
    await delay(30_000);
    log = await serialLog();
    lines = log
      .split(/\r?\n/)
      .filter((l) => l.startsWith('SPIKE ') && !before.includes(l));
    if (lines.includes(`SPIKE boot=${boot} DONE`)) return lines;
  }
  save(`boot${boot}-partial.txt`, lines.join('\n'));
  save(`boot${boot}-serial.log`, log);
  save(
    `boot${boot}-instance-view.json`,
    await compute.virtualMachines.instanceView(name, 'vm'),
  );
  throw new Error(`boot ${boot} never reported`);
}

async function run(): Promise<void> {
  await resources.resourceGroups.createOrUpdate(name, {
    location: REGION,
    tags: TAG,
  });
  const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
    name,
    'vnet',
    {
      location: REGION,
      tags: TAG,
      addressSpace: { addressPrefixes: ['10.10.0.0/16'] },
      subnets: [{ name: 'spike', addressPrefix: '10.10.0.0/24' }],
    },
  );
  // A public IP for outbound access, as azure.ts gives a VM; no inbound rule.
  const ip = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
    name,
    'ip',
    {
      location: REGION,
      tags: TAG,
      sku: { name: 'Standard' },
      publicIPAllocationMethod: 'Static',
    },
  );
  const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
    name,
    'nic',
    {
      location: REGION,
      tags: TAG,
      ipConfigurations: [
        {
          name: 'primary',
          subnet: { id: vnet.subnets![0]!.id },
          publicIPAddress: { id: ip.id },
        },
      ],
    },
  );
  // azure.ts's GPU image and e2e-gpu's MACE OS disk (100 GB Premium_LRS).
  await compute.virtualMachines.beginCreateOrUpdateAndWait(name, 'vm', {
    location: REGION,
    tags: TAG,
    hardwareProfile: { vmSize: SIZE },
    osProfile: {
      computerName: 'spike',
      adminUsername: 'spike',
      // Never used: the network has no inbound rule.
      adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
      customData: Buffer.from(customData()).toString('base64'),
    },
    storageProfile: {
      imageReference: {
        communityGalleryImageId: selectAzureGpuImageId(SIZE, 'T4')!,
      },
      osDisk: {
        createOption: 'FromImage',
        deleteOption: 'Delete',
        diskSizeGB: 100,
        managedDisk: { storageAccountType: 'Premium_LRS' },
      },
    },
    networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
    diagnosticsProfile: { bootDiagnostics: { enabled: true } },
  });
  const boot1 = await waitFor(1, []);
  save('boot1.txt', boot1.join('\n'));
  await compute.virtualMachines.beginDeallocateAndWait(name, 'vm');
  await compute.virtualMachines.beginStartAndWait(name, 'vm');
  const boot2 = await waitFor(2, boot1);
  save('boot2.txt', boot2.join('\n'));

  const probe = boot1.find((l) => l.startsWith('SPIKE boot=1 probe '));
  const moved = (boot: number, lines: string[]) =>
    ['docker', 'containerd'].every((store) =>
      lines.some((l) =>
        new RegExp(
          `^SPIKE boot=${boot} bind ${store} \\S+\\[/anycloud/${store}\\]`,
        ).test(l),
      ),
    );
  // The store unit went active before docker, and containerd if it ran, began
  // starting; on a fresh disk, after Ubuntu's warning unit wrote its file.
  const order = (boot: number, lines: string[]) => {
    const line = lines.find((l) => l.startsWith(`SPIKE boot=${boot} order `));
    const [unit = 0, containerd = 0, docker = 0, warning = 0] = (line ?? '')
      .split(' ')
      .slice(3)
      .map((field) => Number(field.split('=')[1]));
    return { unit, containerd, docker, warning };
  };
  const ordered = (boot: number, lines: string[]) => {
    const { unit, containerd, docker } = order(boot, lines);
    return unit > 0 && unit < docker && (containerd === 0 || unit < containerd);
  };
  const { unit, warning } = order(2, boot2);
  const summary = {
    mount: resourceDiskStoreMount(probe?.split(' probe ')[1] ?? ''),
    boot1Moved: moved(1, boot1),
    boot2Moved: moved(2, boot2),
    boot1Ordered: ordered(1, boot1),
    boot2Ordered: ordered(2, boot2),
    boot2MarkerAbsent: boot2.includes('SPIKE boot=2 marker absent'),
    // The warning file sits on /mnt alone, which stays mutable.
    boot2WarningFirst: warning > 0 && warning < unit,
    boot2WarningOnMnt: boot2.some((l) =>
      /^SPIKE boot=2 warning present [^i ]+$/.test(l),
    ),
    boot2DockerRoot: boot2.some((l) =>
      l.startsWith('SPIKE boot=2 root /var/lib/docker '),
    ),
    orderingCycle: [...boot1, ...boot2].some((l) => / cycle /.test(l)),
  };
  save('summary.json', summary);
  const pass =
    summary.mount !== null &&
    summary.boot1Moved &&
    summary.boot2Moved &&
    summary.boot1Ordered &&
    summary.boot2Ordered &&
    summary.boot2MarkerAbsent &&
    summary.boot2WarningFirst &&
    summary.boot2WarningOnMnt &&
    summary.boot2DockerRoot &&
    !summary.orderingCycle;
  if (!pass)
    throw new Error(`redeploy check failed: ${JSON.stringify(summary)}`);
}

async function cleanup(): Promise<void> {
  const owned = async () => {
    const groups = [];
    for await (const group of resources.resourceGroups.list({
      filter: `tagName eq 'anycloud-spike' and tagValue eq '${TAG['anycloud-spike']}'`,
    })) {
      groups.push(group.name!);
    }
    return groups;
  };
  const deleted = await owned();
  await Promise.all(
    deleted.map((group) => resources.resourceGroups.beginDeleteAndWait(group)),
  );
  const remaining = await owned();
  save('cleanup.json', { deleted, remaining });
  if (remaining.length) throw new Error(`still present: ${remaining}`);
}

const phase = process.argv[2] ?? process.env.SPIKE_PHASE ?? 'run';
if (phase === 'render') console.log(customData());
else await (phase === 'cleanup' ? cleanup() : run());
