#!/usr/bin/env tsx
/**
 * Why a T4 is unusable after the product restarts an evicted Azure spot
 * VM in place. One Standard_NC4as_T4_v3 spot VM, set up by the product's
 * initializeVM, runs hypothesis B (a host `systemctl daemon-reload` revokes a
 * running container's GPU), hypothesis A (device nodes absent or late when the
 * container starts) and a restart loop in the product's resume order. See
 * README.md.
 */
import './env.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ClientSecretCredential } from '@azure/identity';
import { DockerManager } from '../../src/api/services/docker.js';
import { SSHManager } from '../../src/api/services/gateways/ssh.js';
import { initializeVM } from '../../src/api/services/vm-initializer.js';
import { generateStartupScript } from '../../src/api/services/vm-startup-script.js';
import { selectAzureGpuImageId } from '../../src/shared/catalog/azure-gpu-map.js';
import { GpuRuntime } from '../../src/shared/cloud.js';

const TAG = { key: 'anycloud-spike', value: 'gpu-restart-hypotheses' };
const VM_SIZE = 'Standard_NC4as_T4_v3';
const VM = 'gpu';
// Tried in order until one has spot capacity; each carries the dstack image.
const REGIONS = ['westus2', 'eastus', 'southcentralus', 'westeurope'];
// The MACE legs' image (test/integration/e2e/internal/contracts/job-policy.ts).
const IMAGE =
  'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d';
// The verbatim errors from the customer reports this spike investigates.
const CUSTOMER_ERRORS = [
  'CUDA-capable device(s) is/are busy or unavailable',
  'no CUDA-capable device is detected',
  'Failed to initialize NVML: Unknown Error',
  'No CUDA GPUs are available',
];
// The Spike workflow stops the step at 85 minutes; a cycle starts only with
// CYCLE_MS left, and the last container is held for up to FINAL_HOLD_MS.
const DEADLINE = Date.now() + 80 * 60_000;
const CYCLE_MS = 9 * 60_000;
const HOLD_MS = 60_000;
const FINAL_HOLD_MS = 10 * 60_000;
const DIR = '/var/lib/gpu-spike';
const LRO = { abortSignal: AbortSignal.timeout(84 * 60_000) };
const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
const runId = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
  : randomBytes(4).toString('hex');

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
);
const subscription = process.env.AZURE_SUBSCRIPTION_ID!;
const compute = new ComputeManagementClient(credential, subscription);
const network = new NetworkManagementClient(credential, subscription);
const resources = new ResourceManagementClient(credential, subscription);

interface Vm {
  group: string;
  region: string;
  ip: string;
}

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

const records: Record<string, unknown>[] = [];
function record(entry: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), ...entry });
  save('records.json', records);
  save(
    'summary.json',
    records.map(({ label, healthy, customerErrors, check2068 }) => ({
      label,
      healthy,
      customerErrors,
      check2068: (check2068 as { passed: boolean } | undefined)?.passed,
    })),
  );
  console.log(JSON.stringify({ label: entry.label, healthy: entry.healthy }));
}

// ------------------------------------------------------------------ host side

/** Runs a script on the VM and returns its combined output, whatever its exit code. */
async function shell(
  ssh: SSHManager,
  script: string,
  timeoutMs = 120_000,
): Promise<string> {
  const { stdout } = await ssh.exec(
    `{\n${script}\n} 2>&1; exit 0`,
    1,
    false,
    timeoutMs,
  );
  return stdout.trim();
}

/** Non-invasive: nothing here loads a module or creates a device node. */
const BEFORE = `echo "uptime=$(cut -d' ' -f1 /proc/uptime) now=$(date -u +%FT%T.%3NZ) boot=$(uptime -s)"
tr -s '\\0' '\\n' < /var/lib/hyperv/.kvp_pool_3 | paste - - | grep -i '^PhysicalHostName\\b'
ls -l --time-style=+%T.%3N /dev/nvidia*
lsmod | grep -E '^nvidia' || echo 'no nvidia modules'
echo "docker=$(systemctl is-active docker) socket=$(systemctl is-active docker.socket) persistenced=$(systemctl is-active nvidia-persistenced)"`;

/** The container's device access, kernel and systemd timing, and host devices. */
const AFTER = `ID=$(docker inspect -f '{{.Id}}' job)
docker inspect -f 'started={{.State.StartedAt}} running={{.State.Running}} requests={{json .HostConfig.DeviceRequests}} devices={{json .HostConfig.Devices}}' job
systemctl show "docker-$ID.scope" -p DeviceAllow -p DevicePolicy
CG=/sys/fs/cgroup/system.slice/docker-$ID.scope
cat "$CG/devices.list" 2>/dev/null || { command -v bpftool >/dev/null && bpftool cgroup show "$CG"; } || echo 'no devices.list (cgroup v2) and no bpftool'
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); h=s.get("hooks") or {}; print(json.dumps({"devices": s["linux"].get("devices"), "hooks": {k: [x["path"] for x in v] for k, v in h.items()}}))' "/run/containerd/io.containerd.runtime.v2.task/moby/$ID/config.json"
echo "docker active since $(systemctl show docker -p ActiveEnterTimestamp --value)"
journalctl -k -b -o short-iso-precise --no-pager | grep -E 'NVRM|Xid|nvidia' | tail -30
journalctl -b _PID=1 -o short-iso-precise --no-pager | grep -i 'reload' | tail -20
ls -l --time-style=+%T.%3N /dev/nvidia*`;

/** Invasive host evidence: nvidia-smi loads modules and creates device nodes. */
const HOST_SMI = `timeout 60 nvidia-smi -q | head -40
dmesg | grep -E 'NVRM|Xid' | tail -20`;

// waitForUsableGpus at 4c8f23541 (host-runtime/gpu-probe.ts):
// `nvidia-smi -L`, then a CUDA context on each device, up to 3 tries 20 s apart.
const CUDA_CONTEXT_CHECK = [
  'import ctypes as c',
  'l=c.CDLL("libcuda.so.1");n=c.c_int();d=c.c_int();x=c.c_void_p()',
  'r=l.cuInit(0) or l.cuDeviceGetCount(c.byref(n))',
  'for i in range(n.value): r=r or l.cuDeviceGet(c.byref(d),i) or l.cuCtxCreate_v2(c.byref(x),0,d) or l.cuCtxDestroy_v2(x)',
  'print("CUresult",r);raise SystemExit(r)',
].join('\n');

async function check2068(ssh: SSHManager) {
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await shell(
      ssh,
      `timeout 30 nvidia-smi -L 2>&1 && timeout 30 python3 -c '${CUDA_CONTEXT_CHECK}' 2>&1; echo "exit=$?"`,
      75_000,
    );
    attempts.push(out);
    if (/^GPU \d+:/m.test(out) && out.endsWith('exit=0')) {
      return { passed: true, attempts };
    }
    if (attempt < 3) await delay(20_000);
  }
  return { passed: false, attempts };
}

/** As the product's waitForDockerReady: the ping socket-activates Docker. */
async function waitDocker(ssh: SSHManager): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const out = await shell(
      ssh,
      'systemctl is-active --quiet docker || docker version >/dev/null 2>&1; echo "rc=$?"',
      30_000,
    );
    if (out.endsWith('rc=0')) return;
    await delay(5_000);
  }
  throw new Error('Docker never became ready');
}

async function waitSsh(ssh: SSHManager, vm: Vm): Promise<number> {
  // Drop the control master from before the restart rather than wait it out.
  await SSHManager.closeConnection(vm.ip, 22);
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    try {
      await ssh.exec('true', 1, false, 15_000);
      return Date.now() - started;
    } catch {
      await delay(3_000);
    }
  }
  throw new Error('SSH never became ready');
}

/** A Job container as docker.ts starts one: `--restart no --gpus all`. */
function runContainer(label: string, extra = ''): string {
  return `docker rm -f job >/dev/null 2>&1
docker run -d --name job --restart no --gpus all ${extra} -v ${DIR}:/spike -e SPIKE_LABEL=${label} --entrypoint python3 ${IMAGE} /spike/probe.py monitor`;
}

/**
 * A Job container with the product's exact `docker run` args from
 * DockerManager.getCommand; `unfixed` drops the `--device` substitution.
 */
function productContainer(
  label: string,
  unfixed: boolean,
  gpus = 'all',
): string {
  const cmd = DockerManager.getCommand({
    id: 'job',
    image: IMAGE,
    workloadType: 'job',
    env: { SPIKE_LABEL: label },
    registryUsername: 'spike',
    deploymentId: null,
    userId: 'spike',
    dockerOptions: { gpus, binds: [`${DIR}:/spike`] },
    command: ['python3', '/spike/probe.py', 'monitor'],
    secretNames: null,
    imageDigest: null,
  });
  const fixed = cmd.replace(/ \$\(for d in .*?; done\)/, '');
  if (fixed === cmd) throw new Error(`no --device substitution in: ${cmd}`);
  return `docker rm -f job >/dev/null 2>&1\n${unfixed ? fixed : cmd}`;
}

function customerErrors(text: string): string[] {
  return CUSTOMER_ERRORS.filter((error) => text.includes(error));
}

/** Runs probe.py in the running container and classifies the result. */
async function probe(ssh: SSHManager) {
  const out = await shell(
    ssh,
    'docker exec job python3 /spike/probe.py',
    300_000,
  );
  let parsed: {
    nvml?: string;
    cuInit?: string;
    torch?: { rc: number | null };
  } = {};
  try {
    parsed = JSON.parse(out.split('\n').at(-1)!) as typeof parsed;
  } catch {
    // An exec that never reached Python is recorded raw.
  }
  return {
    probe: parsed.nvml ? parsed : out,
    healthy:
      Boolean(parsed.nvml?.startsWith('ok')) &&
      Boolean(parsed.cuInit?.startsWith('ok')) &&
      parsed.torch?.rc === 0,
    customerErrors: customerErrors(out),
  };
}

interface ResumeOptions {
  /** Run the GPU-usability check after the Docker ping and before the container, as the product does. */
  check2068First?: boolean;
  /** Skip nvidia-smi on the host, so a later re-probe still sees the state. */
  keepHostState?: boolean;
  runArgs?: string;
  /** Replaces runContainer's `docker run` script. */
  container?: string;
  extra?: Record<string, unknown>;
}

/** The product's resume order after SSH: Docker, the container, the first CUDA call. */
async function resume(
  ssh: SSHManager,
  label: string,
  options: ResumeOptions = {},
): Promise<void> {
  const t0 = Date.now();
  const before = await shell(ssh, BEFORE);
  await waitDocker(ssh);
  const dockerMs = Date.now() - t0;
  const first2068 = options.check2068First ? await check2068(ssh) : undefined;
  const run = await shell(
    ssh,
    options.container ?? runContainer(label, options.runArgs),
    300_000,
  );
  const containerMs = Date.now() - t0;
  const result = await probe(ssh);
  const probeMs = Date.now() - t0;
  const after = await shell(ssh, AFTER);
  const hostSmi = options.keepHostState
    ? undefined
    : await shell(ssh, HOST_SMI);
  const last2068 = options.keepHostState ? undefined : await check2068(ssh);
  record({
    label,
    ...options.extra,
    ...result,
    customerErrors: [
      ...new Set([...result.customerErrors, ...customerErrors(run)]),
    ],
    check2068: first2068 ?? last2068,
    check2068Order: first2068 ? 'before-container' : 'after-probe',
    timingsMs: { dockerMs, containerMs, probeMs },
    before,
    run,
    after,
    hostSmi,
  });
}

/** Re-probes the running container after a host-side change. */
async function reprobe(ssh: SSHManager, label: string): Promise<void> {
  const result = await probe(ssh);
  record({
    label,
    ...result,
    after: await shell(ssh, AFTER),
    check2068: await check2068(ssh),
  });
}

/** Summarizes the container's 15 s monitor log for one label. */
async function readMonitor(ssh: SSHManager, label: string): Promise<void> {
  const log = await shell(ssh, `cat ${DIR}/monitor-${label}.log`);
  const lines = log.split('\n').filter(Boolean);
  const failing = lines.filter(
    (line) =>
      !/"nvml": "ok/.test(line) ||
      !/"cuInit": "ok/.test(line) ||
      /"torchLive": "[A-Za-z]+Error/.test(line),
  );
  record({
    label: `${label}-monitor`,
    healthy: failing.length === 0,
    customerErrors: customerErrors(log),
    ticks: lines.length,
    firstFailing: failing.slice(0, 3),
    // Candidate reload triggers after the container starts.
    reloads: await shell(
      ssh,
      `journalctl -b _PID=1 -o short-iso-precise --no-pager | grep -i 'reload' | tail -20
journalctl -b -u apt-daily -u apt-daily-upgrade -u unattended-upgrades -u walinuxagent -o short-iso-precise --no-pager | tail -20
systemctl list-timers --no-pager | head -15`,
    ),
  });
}

// ----------------------------------------------------------------- Azure side

async function createVm(publicKey: string): Promise<Vm> {
  const runnerIp = (
    await (
      await fetch('https://checkip.amazonaws.com', {
        signal: AbortSignal.timeout(30_000),
      })
    ).text()
  ).trim();
  const tags = { [TAG.key]: TAG.value };
  for (const region of REGIONS) {
    const group = `ac-spike-gpurestart-${runId}-${region}`;
    const at = { location: region, tags };
    try {
      await resources.resourceGroups.createOrUpdate(group, at);
      const nsg =
        await network.networkSecurityGroups.beginCreateOrUpdateAndWait(
          group,
          VM,
          {
            ...at,
            securityRules: [
              {
                name: 'ssh-from-runner',
                priority: 100,
                direction: 'Inbound',
                access: 'Allow',
                protocol: 'Tcp',
                sourceAddressPrefix: `${runnerIp}/32`,
                sourcePortRange: '*',
                destinationAddressPrefix: '*',
                destinationPortRange: '22',
              },
            ],
          },
          LRO,
        );
      const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
        group,
        VM,
        {
          ...at,
          addressSpace: { addressPrefixes: ['10.20.0.0/16'] },
          subnets: [
            {
              name: VM,
              addressPrefix: '10.20.0.0/24',
              networkSecurityGroup: { id: nsg.id },
            },
          ],
        },
        LRO,
      );
      const ip = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
        group,
        VM,
        {
          ...at,
          sku: { name: 'Standard' },
          publicIPAllocationMethod: 'Static',
        },
        LRO,
      );
      const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
        group,
        VM,
        {
          ...at,
          ipConfigurations: [
            {
              name: 'primary',
              subnet: { id: vnet.subnets![0]!.id },
              publicIPAddress: { id: ip.id },
            },
          ],
        },
        LRO,
      );
      await compute.virtualMachines.beginCreateOrUpdateAndWait(
        group,
        VM,
        {
          ...at,
          hardwareProfile: { vmSize: VM_SIZE },
          // As the product's Azure gateway creates a Job's spot VM.
          priority: 'Spot',
          evictionPolicy: 'Deallocate',
          billingProfile: { maxPrice: -1 },
          osProfile: {
            computerName: VM,
            adminUsername: 'anycloud',
            // Never used: the product's startup script authorizes root's key.
            adminPassword: `Sp1-${randomBytes(18).toString('base64url')}`,
            customData: Buffer.from(
              generateStartupScript({ publicKey, privateKey: '' }),
            ).toString('base64'),
          },
          storageProfile: {
            imageReference: {
              communityGalleryImageId: selectAzureGpuImageId(VM_SIZE, 'T4')!,
            },
            osDisk: {
              createOption: 'FromImage',
              deleteOption: 'Delete',
              diskSizeGB: 128,
            },
          },
          networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true }],
          },
          // As the product does; diagnose() reads the serial log.
          diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        },
        LRO,
      );
      return { group, region, ip: ip.ipAddress! };
    } catch (error) {
      save(`create-${region}.txt`, String(error));
      // Cleanup confirms the deletion.
      await resources.resourceGroups.beginDelete(group).catch(() => undefined);
    }
  }
  throw new Error(`no region had ${VM_SIZE} spot capacity`);
}

async function powerState(vm: Vm): Promise<string | undefined> {
  const view = await compute.virtualMachines.instanceView(vm.group, VM);
  return view.statuses
    ?.find((status) => status.code?.startsWith('PowerState/'))
    ?.code?.slice('PowerState/'.length);
}

async function waitStopped(vm: Vm, timeoutMs: number): Promise<boolean> {
  // As the product's recovery does: three settled reads 5 s apart.
  let settled = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await powerState(vm);
    settled = state === 'deallocated' || state === 'stopped' ? settled + 1 : 0;
    if (settled === 3) return true;
    await delay(5_000);
  }
  return false;
}

/** Deallocates or evicts the VM, then starts it again in place. */
async function restart(vm: Vm, evict: boolean) {
  const t0 = Date.now();
  let fellBack = false;
  if (evict) {
    await compute.virtualMachines.simulateEviction(vm.group, VM);
    fellBack = !(await waitStopped(vm, 3 * 60_000));
  }
  if (!evict || fellBack) {
    await compute.virtualMachines.beginDeallocateAndWait(vm.group, VM, LRO);
    await waitStopped(vm, 3 * 60_000);
  }
  const stopMs = Date.now() - t0;
  await compute.virtualMachines.beginStartAndWait(vm.group, VM, LRO);
  return {
    kind: evict ? 'simulate-eviction' : 'deallocate',
    fellBack,
    stopMs,
    startMs: Date.now() - t0 - stopMs,
  };
}

// --------------------------------------------------------------------- phases

const EARLY_UNIT = `[Unit]
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
TimeoutStartSec=300
ExecStart=/bin/bash -c 'exec >>${DIR}/early.log 2>&1; echo "uptime=$(cut -d" " -f1 /proc/uptime)"; ls -l /dev/nvidia*; lsmod | grep -E "^nvidia" || echo "no nvidia modules"; docker run --rm --gpus all -v ${DIR}:/spike --entrypoint python3 ${IMAGE} /spike/probe.py; echo "docker rc=$?"'
[Install]
WantedBy=multi-user.target
`;

/** Records what Azure saw when SSH was lost: power state and the serial log. */
async function diagnose(vm: Vm, label: string, error: unknown): Promise<void> {
  let serial: string;
  try {
    const { serialConsoleLogBlobUri } =
      await compute.virtualMachines.retrieveBootDiagnosticsData(vm.group, VM);
    const response = await fetch(serialConsoleLogBlobUri!, {
      signal: AbortSignal.timeout(30_000),
    });
    serial = (await response.text()).slice(-60_000);
  } catch (serialError) {
    serial = String(serialError);
  }
  save(`${label}-serial.txt`, serial);
  const view = await compute.virtualMachines
    .instanceView(vm.group, VM)
    .then((v) => ({ statuses: v.statuses, agent: v.vmAgent?.statuses }))
    .catch(String);
  record({ label, healthy: false, error: String(error), instanceView: view });
}

/** The image pull outlasts any one SSH session, so it reconnects on loss. */
async function pull(vm: Vm, ssh: SSHManager): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ssh.exec(
        `timeout 1200 docker pull -q ${IMAGE}`,
        1,
        false,
        1_230_000,
      );
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await diagnose(vm, `setup-pull-${attempt}`, error);
      await waitSsh(ssh, vm);
      record({
        label: `setup-pull-${attempt}-reconnected`,
        boots: await shell(
          ssh,
          'journalctl --list-boots --no-pager | tail -3; uptime -s; last -x reboot shutdown | head -4',
        ),
      });
    }
  }
}

async function setup(vm: Vm, ssh: SSHManager): Promise<void> {
  const sshMs = await waitSsh(ssh, vm);
  const t0 = Date.now();
  await initializeVM(ssh, {
    workloadId: `spike-${runId}`,
    vmIp: vm.ip,
    gpuRuntime: GpuRuntime.Cuda,
  });
  const initializeMs = Date.now() - t0;
  await ssh.exec(`mkdir -p ${DIR}`, 1);
  await ssh.writeFile(
    `${DIR}/probe.py`,
    readFileSync(new URL('./probe.py', import.meta.url)),
  );
  await pull(vm, ssh);
  save('host.json', {
    sshMs,
    initializeMs,
    pullMs: Date.now() - t0 - initializeMs,
    host: await shell(
      ssh,
      `echo "cgroupfs=$(stat -fc %T /sys/fs/cgroup)"
docker info --format 'driver={{.CgroupDriver}} cgroup={{.CgroupVersion}} docker={{.ServerVersion}} runtimes={{json .Runtimes}}'
grep -vE '^\\s*(#|$)' /etc/nvidia-container-runtime/config.toml
nvidia-ctk --version; nvidia-container-cli --version | head -1
cat /etc/docker/daemon.json
uname -r; grep PRETTY /etc/os-release; cat /proc/driver/nvidia/version
systemctl is-enabled docker.service docker.socket nvidia-persistenced.service unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
systemctl list-timers --all --no-pager
ls -l /etc/cdi /var/run/cdi`,
    ),
  });
}

/** Hypothesis B: a daemon-reload while a GPU container runs. */
async function testB(ssh: SSHManager): Promise<void> {
  // NVIDIA's documented workaround: the existing nodes passed explicitly.
  const devices =
    '$(for d in /dev/nvidiactl /dev/nvidia0 /dev/nvidia-uvm /dev/nvidia-uvm-tools; do [ -e $d ] && printf -- "--device %s " $d; done)';
  // B3: the product's args without, then with, explicit device nodes; `-count`
  // takes the `--gpus 1` path through nvidia-smi's minor numbers.
  for (const [label, options] of [
    ['B1', {}],
    ['B2-explicit-devices', { runArgs: devices }],
    [
      'B3-product-unfixed',
      { container: productContainer('B3-product-unfixed', true) },
    ],
    ['B3-product', { container: productContainer('B3-product', false) }],
    [
      'B3-product-count',
      { container: productContainer('B3-product-count', false, '1') },
    ],
  ] as const) {
    await resume(ssh, label, options);
    await shell(ssh, 'systemctl daemon-reload; sleep 3');
    await reprobe(ssh, `${label}-after-daemon-reload`);
    // The monitor's torch, initialized before the reload, as a running Job's is.
    await delay(20_000);
    await readMonitor(ssh, label);
  }
}

/** Hypothesis A: device nodes absent, or late, when the container starts. */
async function testA(vm: Vm, ssh: SSHManager): Promise<void> {
  // A0: the earliest start possible, from a boot unit as soon as Docker is up.
  await ssh.writeFile(
    '/etc/systemd/system/gpu-spike-early.service',
    EARLY_UNIT,
  );
  await shell(
    ssh,
    'docker rm -f job; systemctl daemon-reload; systemctl enable gpu-spike-early.service',
  );
  await compute.virtualMachines.beginRestartAndWait(vm.group, VM, LRO);
  await waitSsh(ssh, vm);
  // SSH answers before the oneshot unit has finished its probe.
  await shell(
    ssh,
    `for _ in $(seq 60); do grep -q 'docker rc=' ${DIR}/early.log 2>/dev/null && break; sleep 5; done`,
    320_000,
  );
  const early = await shell(ssh, `cat ${DIR}/early.log`);
  record({
    label: 'A0-boot-unit',
    healthy: /"cuInit": "ok/.test(early) && /"nvml": "ok/.test(early),
    customerErrors: customerErrors(early),
    early,
    after: await shell(
      ssh,
      `systemctl show gpu-spike-early docker -p ActiveEnterTimestamp -p ActiveState -p Result
journalctl -k -b -o short-iso-precise --no-pager | grep -E 'NVRM|nvidia' | head -10`,
    ),
  });
  await shell(ssh, 'systemctl disable gpu-spike-early.service');

  // A1: a reboot, then the product's order with nothing touching the GPU first.
  await compute.virtualMachines.beginRestartAndWait(vm.group, VM, LRO);
  await waitSsh(ssh, vm);
  await resume(ssh, 'A1-reboot');

  // A2: the nodes deliberately absent at start, then created while it runs.
  // The toolkit's hook loads modules and creates nodes itself unless
  // `load-kmods = false`, so each case runs with and without it.
  const toolkit = '/etc/nvidia-container-runtime/config.toml';
  try {
    for (const kmods of ['load-kmods', 'no-load-kmods']) {
      if (kmods === 'no-load-kmods') {
        await shell(
          ssh,
          `cp ${toolkit} ${toolkit}.spike && sed -i -E 's/^#? *load-kmods *=.*/load-kmods = false/' ${toolkit}`,
        );
      }
      const extra = {
        toolkit: await shell(ssh, `grep -n load-kmods ${toolkit}`),
      };
      await shell(
        ssh,
        'docker rm -f job; rmmod nvidia_uvm; rm -f /dev/nvidia-uvm /dev/nvidia-uvm-tools',
      );
      await resume(ssh, `A2-${kmods}-uvm-absent`, {
        keepHostState: true,
        extra,
      });
      await shell(ssh, 'nvidia-modprobe -u -c 0');
      await reprobe(ssh, `A2-${kmods}-uvm-late`);
      await shell(ssh, 'docker rm -f job; rm -f /dev/nvidia0 /dev/nvidiactl');
      await resume(ssh, `A2-${kmods}-nodes-absent`, {
        keepHostState: true,
        extra,
      });
      await shell(ssh, 'nvidia-modprobe -c 0');
      await reprobe(ssh, `A2-${kmods}-nodes-late`);
    }
  } finally {
    await shell(
      ssh,
      `[ -f ${toolkit}.spike ] && mv ${toolkit}.spike ${toolkit}`,
    );
  }
}

/** Deallocate or evict, start, then resume in the product's order. */
async function loop(vm: Vm, ssh: SSHManager, cycles: number): Promise<void> {
  let label = '';
  for (let i = 0; i < cycles && Date.now() + CYCLE_MS < DEADLINE; i++) {
    const cycle = await restart(vm, i % 2 === 1);
    const sshMs = await waitSsh(ssh, vm);
    label = `L${i + 1}`;
    await resume(ssh, label, {
      check2068First: Math.floor(i / 2) % 2 === 1,
      extra: { cycle: { ...cycle, sshMs } },
    });
    await delay(HOLD_MS);
    await readMonitor(ssh, label);
  }
  // Customers failed 4-8 minutes after the restart; hold the last container.
  const hold = Math.min(FINAL_HOLD_MS, DEADLINE - Date.now() - 2 * 60_000);
  if (label && hold > HOLD_MS) {
    await delay(hold);
    await readMonitor(ssh, label);
  }
}

async function owned(): Promise<string[]> {
  const groups: string[] = [];
  for await (const group of resources.resourceGroups.list({
    filter: `tagName eq '${TAG.key}' and tagValue eq '${TAG.value}'`,
  })) {
    groups.push(group.name!);
  }
  return groups;
}

async function cleanup(): Promise<void> {
  const groups = await owned();
  await Promise.all(
    groups.map((group) =>
      resources.resourceGroups.beginDeleteAndWait(group, {
        forceDeletionTypes: 'Microsoft.Compute/virtualMachines',
        abortSignal: AbortSignal.timeout(18 * 60_000),
      }),
    ),
  );
  const remaining = await owned();
  save('cleanup.json', { deleted: groups, remaining });
  if (remaining.length) {
    throw new Error(`resource groups remain: ${remaining.join(', ')}`);
  }
}

async function run(mode: string | undefined, cycles: number): Promise<void> {
  const keys = await SSHManager.generateKeypair();
  const vm = await createVm(keys.publicKey);
  save('vm.json', { ...vm, size: VM_SIZE, image: IMAGE });
  const ssh = new SSHManager(vm.ip, keys.privateKey);
  try {
    await setup(vm, ssh);
    if (mode !== 'loop') await testB(ssh);
    if (mode === 'b') return;
    if (mode !== 'loop') await testA(vm, ssh);
    await loop(vm, ssh, cycles);
  } catch (error) {
    await diagnose(vm, 'failure', error);
    throw error;
  } finally {
    await SSHManager.closeConnection(vm.ip, 22);
  }
}

// `[]` runs B, A and the loop; `["b"]` only B; `["loop"]` only the loop;
// `[..., "<n>"]` caps the cycles; `["cleanup"]` deletes every tagged group.
const args = process.argv.slice(2);
if (args[0] === 'cleanup') {
  await cleanup();
} else {
  await run(args[0], Number(args.find((a) => /^\d+$/.test(a)) ?? 15));
}
