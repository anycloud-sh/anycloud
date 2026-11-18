import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { HostedHealthRecord } from './cluster-cloud.js';
import {
  cpuColdStartRecord,
  type PoolColdStartTimes,
} from './gpu-cold-start.js';
import type { StageProgress } from '../progress.js';
import { errorMessage } from '../types.js';
import { retryTransientProbeError, type Waiter } from '../wait.js';
import { baseSpecDrift, userNamespaceProbe } from './user-namespace-probe.js';
import { ROLE_CHECKS } from './role-connections.js';

/**
 * The 0.1.71 pool live checks, selected with `live_checks` on the
 * hosted journeys of `e2e-cluster-cloud`. Each one names the product PR whose
 * behaviour it proves; before that PR merges it fails.
 */
export const POOL_CHECKS = [
  // A pool Node rejoins as itself after an agent restart and a reboot.
  'agent-restart',
  // A pool Service answers every request through the upgrade's Node replacements.
  'entry-handoff',
  // RFC 0049 C27: a pool Job on the previous release's runner runs through the API upgrade.
  'pool-job-upgrade',
  // CPU-pool replicas without --cpus are sized at 1 vCPU and their share.
  'cpu-defaults',
  // The GPU fabric gate and the probe-gated rerun in a new Pod.
  'pool-gpu-probe',
  // The CPU cold-start record; with RFC 0049 C11, C12 and C22, their checks.
  'cpu-cold-start',
  // RFC 0049 C32: user-namespace Jobs run engines, nested K3s and KVM, not the Node.
  'user-namespace',
  // Role connections created, converged and deleted through each cloud's CLI.
  'role-apply',
  // RFC 0047 S14 to S17: contracts/role-connections.ts.
  ...ROLE_CHECKS,
] as const;
export type PoolCheck = (typeof POOL_CHECKS)[number];

/** A pool Node as the cluster reports it. */
export interface PoolNode {
  readonly name: string;
  readonly ready: boolean;
  readonly unschedulable: boolean;
  /** `anycloud.sh/unusable-gpu`, which marks the Node for replacement. */
  readonly unusableGpu: boolean;
  /** `anycloud.sh/attempt`: the VM row the Node joined from. */
  readonly attempt: string | null;
  readonly bootId: string;
  /** The kubelet's Lease in `kube-node-lease`, last renewed (ms); null without one. */
  readonly leaseRenewedAt: number | null;
  readonly allocatableMemoryBytes: number;
}

/** A Pod in the node pool's namespace. */
export interface PoolPod {
  readonly uid: string;
  readonly name: string;
  readonly nodeName: string | null;
  readonly phase: string;
  /** PodScheduled is False with reason Unschedulable. */
  readonly unschedulable: boolean;
  readonly createdAt: number;
  /** The first container's resources, in millicores and bytes; null when unset. */
  readonly cpuRequestMilli: number | null;
  readonly memoryRequestBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly ephemeralStorageRequestBytes: number | null;
  /** `nvidia.com/gpu` requested. */
  readonly gpus: number;
  /** The `runner-install` init container's image: the runner's release. */
  readonly runnerImage: string | null;
}

/** A Job through the hosted API: its state and each event with its metadata as text. */
export interface PoolJob {
  readonly state: WorkloadState;
  readonly events: readonly {
    readonly state: WorkloadState | 'baking';
    readonly text: string;
    /** A `syncing` event's replica Pod. */
    readonly podUid: string | null;
    readonly at: number;
  }[];
}

export interface PoolJobSpec {
  readonly image: string;
  readonly command: readonly string[];
  readonly gpus?: number;
  /** A bucket from `stageInput`, mounted at /mnt/input. */
  readonly inputBucket?: string;
  /** A bucket from `stageInput` that /mnt/output uploads to, under the Job's ID. */
  readonly outputBucket?: string;
  readonly cpus?: string;
  readonly privileged?: boolean;
  /** `--cache NAME:/path` each. */
  readonly caches?: readonly string[];
  readonly memory?: string;
  /** `--bind PATH`: an anonymous volume, on a privileged or `userNamespaceJobs` pool. */
  readonly bind?: string;
  /** The text the hosted API must refuse it with; `submitJob` then returns its output. */
  readonly refused?: string;
}

export interface PoolSpec {
  readonly vmTypes: readonly string[];
  readonly minVms: number;
  readonly maxVms: number;
  readonly diskSizeGb?: number;
  /** The journey pool's region unless set. */
  readonly region?: string | undefined;
  readonly privilegedJobs?: boolean;
  readonly userNamespaceJobs?: boolean;
  readonly requireNestedVirtualization?: boolean;
}

/**
 * What the checks read and drive. Every verb goes through the hosted API or
 * the installer's own cluster connection; creations register their cleanup
 * before they return, so a failed assertion still releases them.
 */
export interface PoolChecksPort {
  nodes(nodePoolId: string): Promise<readonly PoolNode[]>;
  /** The `anycloud.sh/attempt` of each bootstrap token Secret left for the pool. */
  bootstrapTokenAttempts(nodePoolId: string): Promise<readonly string[]>;
  /**
   * `script` in the host's namespaces, from a privileged Pod pinned to the
   * Node; its log once it ends. The Pod is deleted either way.
   */
  hostShell(nodeName: string, script: string): Promise<string>;
  /** `hostShell` without waiting for the Pod's end; returns the Pod's deletion. */
  startHostShell(
    nodeName: string,
    script: string,
  ): Promise<() => Promise<void>>;
  /** Pending or running native instances of the pool. */
  instances(nodePoolId: string): Promise<readonly string[]>;
  pods(nodePoolId: string): Promise<readonly PoolPod[]>;
  /** The replica Pod's and its Node's start, and the Node's VM launch. */
  coldStart(nodePoolId: string, podUid: string): Promise<PoolColdStartTimes>;
  createPool(label: string, spec: PoolSpec): Promise<string>;
  deletePool(nodePoolId: string): Promise<void>;
  /**
   * A bucket holding `bytes` of input, in objects the hosted API accepts;
   * deleted before the cluster is.
   */
  stageInput(bytes: number): Promise<string>;
  submitJob(
    label: string,
    nodePoolId: string,
    spec: PoolJobSpec,
  ): Promise<string>;
  /**
   * A Pod on the Node with a Secret's `marker` in its environment and as a
   * mounted file, as another replica's runner token is; returns its
   * deletion.
   */
  victim(nodeName: string, marker: string): Promise<() => Promise<void>>;
  job(id: string): Promise<PoolJob>;
  jobLog(id: string): Promise<string>;
  /** One object of a bucket from `stageInput`, as text. */
  readOutput(bucket: string, key: string): Promise<string>;
  terminateJob(id: string): Promise<void>;
  /** Once the Service's record is published and its URL answers 200 through the edge: both. */
  publishedService(
    serviceId: string,
  ): Promise<{ readonly url: string; readonly ip: string | null }>;
  /** The entry IP the Service's record points at, or null. */
  entryIp(serviceId: string): Promise<string | null>;
  /** Requests `url` every 250 ms until the returned stop is called. */
  watchRequests(url: string): () => Promise<HostedHealthRecord>;
  /** Writes a check's record next to the run's other evidence. */
  record(name: string, value: unknown): Promise<void>;
}

export interface PoolCheckPolicy {
  /** The journey pool's catalog GPUs per Node (0 on a CPU pool). */
  readonly gpusPerNode: number;
  /** cpu-defaults and cpu-cold-start: the pool's CPU type and its catalog vCPUs, and a 1 GiB type. */
  readonly cpu?: {
    readonly vmType: string;
    readonly vCPUs: number;
    readonly smallVmType: string;
  };
  /** pool-gpu-probe on a CPU journey pool: a GPU pool of its own. */
  readonly gpuPool?: {
    readonly vmType: string;
    readonly gpusPerNode: number;
    readonly region?: string | undefined;
  };
  /**
   * user-namespace: a nested-virtualization CPU type, the fixture's three
   * images, and the K3s image nested in a Job.
   */
  readonly userNamespace?: {
    readonly vmType: string;
    /** Root, sudo and no-sudo. */
    readonly images: readonly [string, string, string];
    readonly k3sImage: string;
    /** `USER_NAMESPACE_BASE_SPEC`, which the Node must hold. */
    readonly baseSpec: Record<string, unknown>;
  };
  /** pool-job-upgrade: the journey pool's vCPUs. */
  readonly poolVCPUs?: number;
  readonly nodePoolMs: number;
  readonly workloadMs: number;
}

export interface PoolCheckDependencies {
  readonly port: PoolChecksPort;
  readonly policy: PoolCheckPolicy;
  readonly wait: Pick<Waiter, 'for'>;
  readonly progress: Pick<StageProgress, 'mark'>;
  readonly clock: { now(): number };
}

/** The image every check Job and host shell runs: Debian, with python3 and nsenter. */
export const CHECK_IMAGE =
  'mirror.gcr.io/library/python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f';

/** A missing-GPU line `looksLikeMissingGPU` matches, from a Job whose GPU is fine. */
export const MISSING_GPU_LINE = 'No CUDA GPUs are available';

/** The GPU-probe check's retry reasons and its capped end on a passing check. */
export const POOL_RERUN = 'rerunning once in a new Pod';
export const POOL_RETRY_ELSEWHERE = 'retrying on another Node';
export const POOL_CHECK_PASSED = 'passed a CUDA check';
const GPU_CHECK_POD = /^anycloud-gpu-check-/u;
/**
 * The product bounds each Node GPU check at 60 s; a check Pod's life is read
 * from its creation (the API server's clock) to its last 2 s sighting (the
 * runner's), so a few seconds of skew and polling are allowed.
 */
const GPU_CHECK_BOUND_MS = 70_000;

/** A Lease renewal this long after the restart came from the new agent. */
const LEASE_MARGIN_MS = 20_000;
/** Before NODE_NOT_READY_GRACE_MS (15 min) replaces a NotReady Node. */
const REJOIN_MS = 5 * 60_000;
const REBOOT_REJOIN_MS = 14 * 60_000;

const GIB = 1024 ** 3;
/**
 * pool-job-upgrade's first Job outlasts the walk's upgrade with margin; its
 * record keeps how long the upgrade took, to tune this from real runs.
 */
const UPGRADE_JOB_SECONDS = 1200;
const UPGRADE_JOB_STARTED = 'claimed-before-upgrade';
const UPGRADE_JOB_FINISHED = 'finished-after-upgrade';
const UPGRADE_JOB_QUEUED = 'claimed-after-upgrade';
/** cpu-defaults' disk Job: 3 GiB in /tmp and a 1.5 GB input. */
const DISK_WRITE_BYTES = 3 * GIB;
const DISK_INPUT_BYTES = 1_500_000_000;

/**
 * cpu-cold-start's cache-heavy step: a hash-locked pip install (numpy and
 * scipy wheels for CPython 3.12 on x86_64, about 57 MB) through the Node
 * cache at `CACHE_PATH`, timed, with the bytes the Pod's interfaces received
 * meanwhile and the cache's size before and after; scipy's determinant of a
 * fixed matrix proves the install works. Without `--cache` the path is the
 * container's own. It holds 30 s so its replica is observed running.
 */
const CACHE_PATH = '/cache';
const PIP_LOCK = [
  'numpy==2.1.3 --hash=sha256:2312b2aa89e1f43ecea6da6ea9a810d06aae08321609d8dc0d0eda6d946a541b',
  'scipy==1.14.1 --hash=sha256:8f9ea80f2e65bdaa0b7627fb00cbeb2daf163caa015e59b7516395fe3bd1e066',
].join('\n');
const CACHE_INSTALL = `
import os, subprocess, sys, time
def size(p): return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(p) for f in fs)
def rx(): return sum(int(open(f"/sys/class/net/{i}/statistics/rx_bytes").read()) for i in os.listdir("/sys/class/net") if i != "lo")
open("/tmp/lock.txt", "w").write(${JSON.stringify(PIP_LOCK)})
before, received, start = size("${CACHE_PATH}"), rx(), time.monotonic()
subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--no-deps", "--require-hashes", "--only-binary=:all:", "--disable-pip-version-check", "--root-user-action=ignore", "--cache-dir", "${CACHE_PATH}", "--target", "/tmp/site", "-r", "/tmp/lock.txt"], check=True)
install_ms, fetched = round((time.monotonic() - start) * 1000), rx() - received
sys.path.insert(0, "/tmp/site")
import numpy, scipy, scipy.linalg
assert (numpy.__version__, scipy.__version__) == ("2.1.3", "1.14.1"), (numpy.__version__, scipy.__version__)
assert abs(scipy.linalg.det([[2.0, 1.0], [1.0, 3.0]]) - 5) < 1e-9
for key, value in [("CACHE_BEFORE", before), ("CACHE_AFTER", size("${CACHE_PATH}")), ("INSTALL_MS", install_ms), ("FETCHED_BYTES", fetched)]: print(f"{key}={value}", flush=True)
time.sleep(30)
`;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool check: ${message}`);
}

const metaJson = (value: unknown) => JSON.stringify(value);

/** The `Key=value` lines of a host shell's or a Job's output. */
export function shellValues(log: string): Record<string, string> {
  return Object.fromEntries(
    log
      .split('\n')
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

const IN_HOST = 'nsenter -t 1 -m -u -i -n -p --';

/**
 * The kubelet client key's digest. K3s rewrites the certificate on every
 * start but signs it for the key it finds, so the key is what the restart check keeps.
 */
const KUBELET_KEY = `$(${IN_HOST} sha256sum /var/lib/rancher/k3s/agent/client-kubelet.key | cut -d' ' -f1)`;

/** The k3s agent's PID and kubelet client key, before and after a restart. */
export const RESTART_SCRIPT = [
  'set -e',
  `echo PID_BEFORE=$(${IN_HOST} systemctl show -p MainPID --value k3s-agent)`,
  `echo KEY_BEFORE=${KUBELET_KEY}`,
  `${IN_HOST} systemctl restart k3s-agent`,
  `echo PID_AFTER=$(${IN_HOST} systemctl show -p MainPID --value k3s-agent)`,
  `echo KEY_AFTER=${KUBELET_KEY}`,
].join('\n');

/**
 * Reboots the host from boot `bootId` only, so a kubelet that reruns the Pod
 * after the reboot doesn't reboot it again. The check never reads its end:
 * the boot ID changing is the evidence.
 */
export const rebootScript = (bootId: string) =>
  `test "$(cat /proc/sys/kernel/random/boot_id)" = "${bootId}" && ${IN_HOST} systemctl reboot`;

/** `anycloud-gpu-fabric.service`: loaded, and its run succeeded. */
export const FABRIC_SCRIPT = `${IN_HOST} systemctl show anycloud-gpu-fabric -p LoadState -p Result -p ExecMainStatus`;

/**
 * Holds nearly all of its GPU's free memory through libcuda, which the
 * NVIDIA toolkit injects, and keeps it: the co-located Job of the GPU-probe
 * check's finding 3. Prints `HELD=<bytes>` and `TOTAL=<bytes>`.
 */
export const HOLD_GPU_MEMORY = `
import ctypes, sys, time
cuda = ctypes.CDLL("libcuda.so.1")
def ok(r, what):
    if r != 0:
        print(f"{what} CUresult {r}", flush=True); sys.exit(1)
ok(cuda.cuInit(0), "cuInit")
dev = ctypes.c_int(); ok(cuda.cuDeviceGet(ctypes.byref(dev), 0), "cuDeviceGet")
ctx = ctypes.c_void_p(); ok(cuda.cuCtxCreate_v2(ctypes.byref(ctx), 0, dev), "cuCtxCreate")
free = ctypes.c_size_t(); total = ctypes.c_size_t()
ok(cuda.cuMemGetInfo_v2(ctypes.byref(free), ctypes.byref(total)), "cuMemGetInfo")
size = free.value - 32 * 1024 * 1024
ptr = ctypes.c_uint64(); ok(cuda.cuMemAlloc_v2(ctypes.byref(ptr), ctypes.c_size_t(size)), "cuMemAlloc")
print(f"HELD={size}", flush=True); print(f"TOTAL={total.value}", flush=True)
time.sleep(3600)
`;

/** A Job that allocates past any share until its memory limit stops it. */
const MEMORY_HOG =
  'b = []\nwhile True:\n    b.append(bytearray(64 * 1024 * 1024))';

const TERMINAL: readonly string[] = [
  WorkloadState.Completed,
  WorkloadState.Errored,
  WorkloadState.Failed,
  WorkloadState.Terminated,
  WorkloadState.Invalid,
];

const eventsMatching = (job: PoolJob, state: WorkloadState, text: string) =>
  job.events.filter((e) => e.state === state && e.text.includes(text));

const replicaPods = (job: PoolJob) => [
  ...new Set(
    job.events
      .filter((e) => e.state === WorkloadState.Syncing && e.podUid)
      .map((e) => e.podUid!),
  ),
];

/**
 * The selected checks against the journey's pool, in a fixed order; the
 * entry hand-off runs inside the upgrade instead (`startEntryHandoff`).
 */
export class PoolChecks {
  readonly #d: PoolCheckDependencies;

  constructor(dependencies: PoolCheckDependencies) {
    this.#d = dependencies;
  }

  async #record<T>(name: string, value: T): Promise<T> {
    await this.#d.port.record(`pool-check-${name}`, value);
    this.#d.progress.mark(`pool check ${name}: passed`);
    return value;
  }

  /**
   * Once the Node's bootstrap token is gone, a k3s-agent restart and
   * then a reboot each bring the same Node back Ready from the same VM. A
   * kubelet Lease renewed after each proves the agent authenticated again,
   * a new boot ID proves the reboot, and the pool's instances are unchanged.
   */
  async agentRestart(nodePoolId: string) {
    const { port, wait, clock } = this.#d;
    const node = (await port.nodes(nodePoolId)).find((n) => n.ready);
    invariant(
      node?.attempt,
      `node pool ${nodePoolId} has no Ready Node with an attempt`,
    );
    const instances = await port.instances(nodePoolId);
    await wait.for(
      `Node ${node.name}'s bootstrap token deleted`,
      () => port.bootstrapTokenAttempts(nodePoolId),
      {
        timeoutMs: REJOIN_MS,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (attempts) =>
          attempts.includes(node.attempt!)
            ? `token for attempt ${node.attempt!} remains`
            : undefined,
      },
    );
    const rejoined = async (
      since: number,
      timeoutMs: number,
      extra: (n: PoolNode) => string | undefined,
    ) => {
      const back = await wait.for(
        `Node ${node.name} Ready again since ${String(since)}`,
        async () =>
          (await port.nodes(nodePoolId)).find((n) => n.name === node.name),
        {
          timeoutMs,
          intervalMs: 10_000,
          probeError: 'fail',
          reject: (n) =>
            n ? undefined : `Node ${node.name} is gone: replaced`,
          unmet: (n) =>
            !n!.ready
              ? 'NotReady'
              : n!.attempt !== node.attempt
                ? `attempt ${String(n!.attempt)}, not ${node.attempt!}`
                : (n!.leaseRenewedAt ?? 0) < since + LEASE_MARGIN_MS
                  ? `Lease last renewed ${String(n!.leaseRenewedAt)}`
                  : extra(n!),
        },
      );
      return { node: back!, readyAfterMs: clock.now() - since };
    };

    const restartLog = await port.hostShell(node.name, RESTART_SCRIPT);
    const restartedAt = clock.now();
    const restart = shellValues(restartLog);
    invariant(
      restart.PID_BEFORE &&
        restart.PID_AFTER &&
        restart.PID_AFTER !== '0' &&
        restart.PID_AFTER !== restart.PID_BEFORE,
      `k3s-agent on ${node.name} did not restart: ${restartLog}`,
    );
    invariant(
      restart.KEY_BEFORE && restart.KEY_AFTER === restart.KEY_BEFORE,
      `k3s-agent on ${node.name} did not keep its kubelet client key: ${restartLog}`,
    );
    const afterRestart = await rejoined(
      restartedAt,
      REJOIN_MS,
      () => undefined,
    );

    // Awaited by its boot ID changing and the Node Ready again, not a delay.
    const rebootAt = clock.now();
    const removeReboot = await port.startHostShell(
      node.name,
      rebootScript(node.bootId),
    );
    const afterReboot = await rejoined(rebootAt, REBOOT_REJOIN_MS, (n) =>
      n.bootId === node.bootId ? `boot ID still ${node.bootId}` : undefined,
    ).finally(removeReboot);
    const instancesAfter = await port.instances(nodePoolId);
    invariant(
      instancesAfter.length === instances.length &&
        instancesAfter.every((id) => instances.includes(id)),
      `node pool ${nodePoolId}'s instances changed from ${instances.join(', ')} to ${instancesAfter.join(', ')}`,
    );
    return this.#record('agent-restart', {
      node: node.name,
      attempt: node.attempt,
      instances,
      restart: {
        pidBefore: restart.PID_BEFORE,
        pidAfter: restart.PID_AFTER,
        readyAfterMs: afterRestart.readyAfterMs,
      },
      reboot: {
        bootIdBefore: node.bootId,
        bootIdAfter: afterReboot.node.bootId,
        readyAfterMs: afterReboot.readyAfterMs,
      },
    });
  }

  /**
   * Before the upgrade: the pool Service (started on the released
   * API) answers through the edge, then a request every 250 ms runs until
   * the hand-off's `stop`, after every Node from the release is replaced.
   */
  async startEntryHandoff(serviceId: string): Promise<EntryHandoff> {
    const { url, ip } = await this.#d.port.publishedService(serviceId);
    invariant(ip, `Service ${serviceId}'s record names no entry IP`);
    return new EntryHandoff(this.#d, serviceId, url, ip);
  }

  /**
   * RFC 0049 C27, on a one-Node pool: a pool Job claimed on `fromRelease`'s
   * runner before the upgrade, and a second of the same shape queued behind
   * it, since each takes the Node's GPUs, or more than half its vCPUs on a
   * CPU pool (a GPU pool refuses a Job without `--gpus`). `finish`, called once the
   * upgrade is done, proves the first was still running then and completed
   * once on the replica it started on, with its outputs and the log lines
   * from both sides; and that a replica on `fromRelease`'s runner ran the
   * second, wherever the surge-first Node replacement put it. The second's
   * replica is read every 2 s from its submission: on the upgrade's spare
   * Node it can start and end before `finish` (runs 42283992171, 42283995900).
   */
  async startJobThroughUpgrade(nodePoolId: string, fromRelease: string) {
    const { port, policy, clock } = this.#d;
    invariant(
      policy.gpusPerNode || policy.poolVCPUs,
      "pool-job-upgrade needs the pool's GPUs or vCPUs",
    );
    const outputBucket = await port.stageInput(1);
    const cpus = policy.gpusPerNode
      ? undefined
      : (policy.poolVCPUs! / 2 + 0.1).toFixed(1);
    const shape: Omit<PoolJobSpec, 'command'> = {
      image: CHECK_IMAGE,
      ...(cpus ? { cpus } : { gpus: policy.gpusPerNode }),
      outputBucket,
    };
    const size = cpus ? `${cpus} CPUs` : `${String(policy.gpusPerNode)} GPUs`;
    const first = await port.submitJob('upgrade', nodePoolId, {
      ...shape,
      command: [
        'sh',
        '-c',
        `echo ${UPGRADE_JOB_STARTED} | tee /mnt/output/before; sleep ${String(UPGRADE_JOB_SECONDS)}; echo ${UPGRADE_JOB_FINISHED} | tee /mnt/output/after`,
      ],
    });
    const started = replicaPods(await this.#running(first));
    const queued = await port.submitJob('upgrade-queued', nodePoolId, {
      ...shape,
      command: [
        'sh',
        '-c',
        `sleep 60; echo ${UPGRADE_JOB_QUEUED} | tee /mnt/output/queued`,
      ],
    });
    // The pool is fixed-size, so nothing adds a Node for it before the upgrade.
    invariant(
      replicaPods(await port.job(queued)).length === 0,
      `Job ${queued} was claimed beside ${first}: the Node fits two replicas of ${size}`,
    );
    const upgradeStarted = clock.now();
    const firstNode =
      (await port.pods(nodePoolId)).find((p) => p.uid === started[0])
        ?.nodeName ?? null;
    // The queued Job runs, and may end, while the first still runs.
    let queuedRunner: PoolPod | undefined;
    const observeQueued = async () => {
      if (queuedRunner) return;
      const [uid] = replicaPods(await port.job(queued));
      // The poll and `finish` both read it; a later miss keeps an earlier find.
      const replica = uid
        ? (await port.pods(nodePoolId)).find((p) => p.uid === uid)
        : undefined;
      queuedRunner ??= replica;
    };
    let stopped = false;
    const watching = this.#d.wait
      .for(
        `pool check Job ${queued}'s replica`,
        () => (stopped ? Promise.resolve() : observeQueued()),
        {
          timeoutMs: policy.workloadMs,
          intervalMs: 2_000,
          probeError: retryTransientProbeError,
          unmet: () => (stopped || queuedRunner ? undefined : 'not claimed'),
        },
      )
      .then(
        () => undefined,
        (error: unknown) => errorMessage(error),
      );
    return {
      finish: async () => {
        const upgradeMs = clock.now() - upgradeStarted;
        const after = await port.job(first);
        invariant(
          after.state === WorkloadState.Running,
          `Job ${first} was ${after.state} when the upgrade finished, ${String(upgradeMs)} ms after it was claimed; it must still run (it sleeps ${String(UPGRADE_JOB_SECONDS)} s)`,
        );
        const end = await this.#terminal(first, observeQueued);
        const replicas = replicaPods(end);
        invariant(
          end.state === WorkloadState.Completed,
          `Job ${first} ended ${end.state}: ${metaJson(end.events)}`,
        );
        invariant(
          replicas.length === 1 && replicas[0] === started[0],
          `Job ${first} ran on replicas ${replicas.join(', ')}, not once on ${started.join(', ')}`,
        );
        invariant(
          !end.events.some((e) => e.state === WorkloadState.Retrying),
          `Job ${first} retried: ${metaJson(end.events)}`,
        );
        const log = await port.jobLog(first);
        invariant(
          log.includes(UPGRADE_JOB_STARTED) &&
            log.includes(UPGRADE_JOB_FINISHED),
          `Job ${first}'s log tail lacks a line from before or after the upgrade: ${log}`,
        );
        const queuedEnd = await this.#terminal(queued, observeQueued);
        invariant(
          queuedEnd.state === WorkloadState.Completed,
          `Job ${queued} ended ${queuedEnd.state}: ${metaJson(queuedEnd.events)}`,
        );
        stopped = true;
        const watchError = await watching;
        invariant(
          queuedRunner?.runnerImage?.endsWith(`:${fromRelease}`),
          `Job ${queued} ran on replica ${String(queuedRunner?.uid)} with runner ${String(queuedRunner?.runnerImage)}, not ${fromRelease}'s${watchError ? ` (${watchError})` : ''}`,
        );
        for (const [key, line] of [
          [`${first}/before`, UPGRADE_JOB_STARTED],
          [`${first}/after`, UPGRADE_JOB_FINISHED],
          [`${queued}/queued`, UPGRADE_JOB_QUEUED],
        ] as const) {
          const output = await port.readOutput(outputBucket, key);
          invariant(
            output.trim() === line,
            `output ${key} is ${JSON.stringify(output)}, not ${line}`,
          );
        }
        return this.#record('pool-job-upgrade', {
          first,
          queued,
          replica: started[0],
          queuedReplica: queuedRunner?.uid,
          node: firstNode,
          queuedNode: queuedRunner?.nodeName,
          // The pool has one Node, so another one is the upgrade's spare.
          queuedOnSpare: queuedRunner?.nodeName !== firstNode,
          upgradeMs,
          events: end.events,
        });
      },
    };
  }

  /**
   * A Job through the hosted API until a terminal state; `observe` runs on
   * each read. Then terminated, so its deferred cleanup never calls a hosted
   * API the journey already deleted (HTTP 530, run 40815343132).
   */
  async #terminal(
    id: string,
    observe: () => Promise<void> = () => Promise.resolve(),
  ) {
    const end = await this.#d.wait.for(
      `pool check Job ${id} to end`,
      async () => {
        await observe();
        return this.#d.port.job(id);
      },
      {
        timeoutMs: this.#d.policy.workloadMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (job) => (TERMINAL.includes(job.state) ? undefined : job.state),
      },
    );
    await this.#d.port.terminateJob(id);
    return end;
  }

  async #running(id: string) {
    return this.#d.wait.for(
      `pool check Job ${id} running on a replica`,
      () => this.#d.port.job(id),
      {
        timeoutMs: this.#d.policy.workloadMs,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: (job) =>
          TERMINAL.includes(job.state) ? `ended ${job.state}` : undefined,
        unmet: (job) =>
          job.state === WorkloadState.Running && replicaPods(job).length > 0
            ? undefined
            : job.state,
      },
    );
  }

  async #pod(nodePoolId: string, uid: string): Promise<PoolPod> {
    const pod = (await this.#d.port.pods(nodePoolId)).find(
      (p) => p.uid === uid,
    );
    invariant(
      pod,
      `replica Pod ${uid} is not in node pool ${nodePoolId}'s namespace`,
    );
    return pod;
  }

  /**
   * On CPU pools with `--disk-size 100`: a default Job requests 1 CPU
   * and a memory limit equal to its request, and its disk share holds 3 GiB
   * written and a 1.5 GB input; a default Job past its memory is OOMKilled
   * beside a neighbour that keeps running, and so is a privileged one;
   * more default Jobs than a Node's vCPUs leave a replica
   * Unschedulable and the pool buys a Node; and a
   * 1 GiB type's Node allocates more memory than a default replica asks.
   */
  async cpuDefaults() {
    const { port, policy, wait } = this.#d;
    const cpu = policy.cpu;
    invariant(cpu, 'cpu-defaults needs a CPU pool type');
    const [nodePoolId, smallPoolId] = await Promise.all([
      port.createPool('cpu-defaults', {
        vmTypes: [cpu.vmType],
        minVms: 1,
        maxVms: 2,
        diskSizeGb: 100,
        privilegedJobs: true,
      }),
      port.createPool('cpu-small', {
        vmTypes: [cpu.smallVmType],
        minVms: 1,
        maxVms: 1,
      }),
    ]);

    // Disk: 3 GiB written and a 1.5 GB input inside the replica's share.
    const inputBucket = await port.stageInput(DISK_INPUT_BYTES);
    const diskJob = await port.submitJob('cpu-disk', nodePoolId, {
      image: CHECK_IMAGE,
      inputBucket,
      command: [
        'sh',
        '-c',
        `set -e; test "$(du -sb /mnt/input | cut -f1)" -ge ${String(DISK_INPUT_BYTES)}; dd if=/dev/zero of=/tmp/fill bs=1M count=${String(DISK_WRITE_BYTES / 1024 ** 2)}; sync; sleep 60`,
      ],
    });
    const diskRunning = await this.#running(diskJob);
    const pod = await this.#pod(nodePoolId, replicaPods(diskRunning)[0]);
    const diskEnd = await this.#terminal(diskJob);
    invariant(
      diskEnd.state === WorkloadState.Completed,
      `the default disk Job ended ${diskEnd.state}: ${metaJson(diskEnd.events.at(-1))}`,
    );
    invariant(
      pod.cpuRequestMilli === 1000,
      `a default replica requests ${String(pod.cpuRequestMilli)}m CPU, not 1`,
    );
    invariant(
      pod.memoryRequestBytes !== null &&
        pod.memoryRequestBytes === pod.memoryLimitBytes,
      `a default replica's memory limit ${String(pod.memoryLimitBytes)} is not its request ${String(pod.memoryRequestBytes)}`,
    );
    invariant(
      (pod.ephemeralStorageRequestBytes ?? 0) >=
        DISK_WRITE_BYTES + DISK_INPUT_BYTES,
      `a default replica's disk share ${String(pod.ephemeralStorageRequestBytes)} cannot hold its Job's 3 GiB and 1.5 GB input`,
    );

    // Memory: two default Jobs on one Node; the one past its share is OOMKilled.
    const diskNode = (await port.nodes(nodePoolId)).find(
      (n) => n.name === pod.nodeName,
    );
    invariant(
      diskNode && diskNode.allocatableMemoryBytes >= 2 * pod.memoryRequestBytes,
      `${cpu.vmType}'s allocatable memory ${String(diskNode?.allocatableMemoryBytes)} can't hold two default replicas of ${String(pod.memoryRequestBytes)}`,
    );
    const neighbour = await port.submitJob('cpu-neighbour', nodePoolId, {
      image: CHECK_IMAGE,
      command: ['sleep', '1800'],
    });
    const neighbourPod = replicaPods(await this.#running(neighbour))[0];
    const hog = await port.submitJob('cpu-hog', nodePoolId, {
      image: CHECK_IMAGE,
      command: ['python3', '-c', MEMORY_HOG],
    });
    // Where each replica runs, read while they exist.
    const placed = new Map<string, string>();
    const hogEnd = await this.#terminal(hog, async () => {
      for (const p of await port.pods(nodePoolId))
        if (p.nodeName) placed.set(p.uid, p.nodeName);
    });
    const hogPod = replicaPods(hogEnd)[0];
    const node = placed.get(neighbourPod);
    invariant(
      node && hogPod && placed.get(hogPod) === node,
      `inconclusive: the memory Jobs' replicas ${String(hogPod)} and ${neighbourPod} did not share a Node`,
    );
    const oom = hogEnd.events.find((e) => /OOMKilled/u.test(e.text));
    invariant(
      hogEnd.state === WorkloadState.Errored && oom,
      `the Job past its memory share ended ${hogEnd.state} without OOMKilled: ${metaJson(hogEnd.events.at(-1))}`,
    );
    const kept = await port.job(neighbour);
    invariant(
      kept.state === WorkloadState.Running &&
        replicaPods(kept).length === 1 &&
        (await port.pods(nodePoolId)).some(
          (p) => p.uid === neighbourPod && p.phase === 'Running',
        ),
      `the neighbour Job did not keep running on its replica ${neighbourPod}: ${kept.state}`,
    );
    await port.terminateJob(neighbour);
    // A privileged replica shares the host's cgroup namespace, whose
    // root has no memory.events; the runner must still see its Job's OOM.
    const privilegedHog = await port.submitJob('cpu-hog-priv', nodePoolId, {
      image: CHECK_IMAGE,
      command: ['python3', '-c', MEMORY_HOG],
      privileged: true,
    });
    const privilegedEnd = await this.#terminal(privilegedHog);
    const privilegedOom = privilegedEnd.events.find((e) =>
      /OOMKilled/u.test(e.text),
    );
    invariant(
      privilegedEnd.state === WorkloadState.Errored && privilegedOom,
      `the privileged Job past its memory share ended ${privilegedEnd.state} without OOMKilled: ${metaJson(privilegedEnd.events.at(-1))}`,
    );

    // Scale-out: one more default Job than a Node's vCPUs.
    const jobIds: string[] = [];
    for (let i = 0; i <= cpu.vCPUs; i += 1) {
      jobIds.push(
        await port.submitJob(`cpu-scale-${String(i)}`, nodePoolId, {
          image: CHECK_IMAGE,
          command: ['sleep', '1800'],
        }),
      );
    }
    let unschedulablePod = '';
    const scaled = await wait.for(
      `node pool ${nodePoolId} to scale out for ${String(jobIds.length)} default Jobs`,
      async () => {
        const current = await port.pods(nodePoolId);
        unschedulablePod ||= current.find((p) => p.unschedulable)?.name ?? '';
        return { pods: current, instances: await port.instances(nodePoolId) };
      },
      {
        timeoutMs: policy.nodePoolMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ pods: current, instances }) => {
          const nodes = new Set(
            current
              .filter(
                (p) => p.phase === 'Running' && p.cpuRequestMilli === 1000,
              )
              .map((p) => p.nodeName),
          );
          return unschedulablePod && instances.length === 2 && nodes.size === 2
            ? undefined
            : `${String(instances.length)} instances, replicas running on ${String(nodes.size)} Nodes, unschedulable seen: ${String(Boolean(unschedulablePod))}`;
        },
      },
    );
    for (const id of jobIds) await port.terminateJob(id);

    // Small Node: a default replica fits a 1 GiB type's allocatable memory.
    const smallJob = await port.submitJob('cpu-small', smallPoolId, {
      image: CHECK_IMAGE,
      command: ['sleep', '60'],
    });
    const smallPod = await this.#pod(
      smallPoolId,
      replicaPods(await this.#running(smallJob))[0],
    );
    const smallEnd = await this.#terminal(smallJob);
    const smallNode = (await port.nodes(smallPoolId)).find(
      (n) => n.name === smallPod.nodeName,
    );
    invariant(
      smallEnd.state === WorkloadState.Completed,
      `a default Job on ${cpu.smallVmType} ended ${smallEnd.state}`,
    );
    invariant(
      smallNode &&
        smallPod.memoryRequestBytes !== null &&
        smallNode.allocatableMemoryBytes > smallPod.memoryRequestBytes,
      `${cpu.smallVmType}'s allocatable memory ${String(smallNode?.allocatableMemoryBytes)} is not above a default replica's ${String(smallPod.memoryRequestBytes)}`,
    );
    await Promise.all([
      port.deletePool(nodePoolId),
      port.deletePool(smallPoolId),
    ]);
    return this.#record('cpu-defaults', {
      nodePoolId,
      disk: { jobId: diskJob, inputBucket, pod },
      memory: {
        hogJobId: hog,
        neighbourJobId: neighbour,
        node,
        oomEvent: oom.text,
        privilegedHogJobId: privilegedHog,
        privilegedOomEvent: privilegedOom.text,
      },
      scaleOut: {
        jobIds,
        unschedulablePod,
        instances: scaled.instances,
        nodes: [...new Set(scaled.pods.map((p) => p.nodeName ?? ''))].filter(
          Boolean,
        ),
      },
      smallNode: {
        nodePoolId: smallPoolId,
        vmType: cpu.smallVmType,
        jobId: smallJob,
        allocatableMemoryBytes: smallNode.allocatableMemoryBytes,
        memoryRequestBytes: smallPod.memoryRequestBytes,
      },
    });
  }

  /**
   * The CPU cold-start record on a pool of its own, the same Job on any
   * release so runs compare by version, with no bound on any duration; a
   * missing time fails the check. `features` is whether the API under test
   * has RFC 0049 C11, C12 and C22 (every release after 0.1.72). With them
   * the pool starts at `--min-vms 0` and the Job scales it from zero (C22),
   * so its Pod waits for the Node and the record has a `total`; the Node
   * joins knowing the Job's image, so `imagePull.alreadyPresent` shows C11's
   * pre-pull; and the Job installs through `--cache`, then runs again on that
   * Node and must find exactly what the first left (C12). Without them the
   * pool starts with its one Node and the Job runs once on it, with no
   * `total`.
   */
  async cpuColdStart(features: boolean) {
    const { port, policy } = this.#d;
    const cpu = policy.cpu;
    invariant(cpu, 'cpu-cold-start needs a CPU pool type');
    const nodePoolId = await port.createPool('cold-start', {
      vmTypes: [cpu.vmType],
      minVms: features ? 0 : 1,
      maxVms: 1,
    });
    if (features) {
      const instances = await port.instances(nodePoolId);
      invariant(
        !instances.length,
        `the --min-vms 0 pool ${nodePoolId} started with ${instances.join(', ')}`,
      );
    }
    const cold = await this.#cacheJob(
      nodePoolId,
      'cache-cold',
      features,
      features,
    );
    invariant(
      cold.cache.cacheBytesBefore === 0 && cold.cache.cacheBytesAfter > 0,
      `the cold cache Job found ${String(cold.cache.cacheBytesBefore)} bytes and left ${String(cold.cache.cacheBytesAfter)}`,
    );
    const warm = features
      ? await this.#cacheJob(nodePoolId, 'cache-warm', true, false)
      : undefined;
    invariant(
      !warm || warm.coldStart.node === cold.coldStart.node,
      `the warm cache Job ran on ${String(warm?.coldStart.node)}, not the cold one's Node ${cold.coldStart.node}`,
    );
    invariant(
      !warm || warm.cache.cacheBytesBefore === cold.cache.cacheBytesAfter,
      `the warm cache Job found ${String(warm?.cache.cacheBytesBefore)} bytes, not the ${String(cold.cache.cacheBytesAfter)} the cold one left`,
    );
    await port.deletePool(nodePoolId);
    return this.#record('cpu-cold-start', {
      features,
      image: CHECK_IMAGE,
      vmType: cpu.vmType,
      nodePoolId,
      coldStart: cold.coldStart,
      cache: { cold: cold.cache, ...(warm ? { warm: warm.cache } : {}) },
    });
  }

  /**
   * The cache-heavy Job, through `--cache` when the API has C12, with its
   * replica's start read while it runs; `podWaitedForNode` as in
   * `cpuColdStartRecord`.
   */
  async #cacheJob(
    nodePoolId: string,
    label: string,
    features: boolean,
    podWaitedForNode: boolean,
  ) {
    const { port } = this.#d;
    const jobId = await port.submitJob(label, nodePoolId, {
      image: CHECK_IMAGE,
      ...(features ? { caches: [`pip:${CACHE_PATH}`] } : {}),
      command: ['python3', '-c', CACHE_INSTALL],
    });
    const running = await this.#running(jobId);
    const podUid = replicaPods(running)[0];
    const coldStart = cpuColdStartRecord(
      jobId,
      podUid,
      await port.coldStart(nodePoolId, podUid),
      running.events.find((e) => e.state === WorkloadState.Running)?.at,
      podWaitedForNode,
    );
    const end = await this.#terminal(jobId);
    invariant(
      end.state === WorkloadState.Completed,
      `the cache Job ${jobId} ended ${end.state}: ${metaJson(end.events.at(-1))}`,
    );
    const values = shellValues(await port.jobLog(jobId));
    const read = (key: string) => {
      const value = Number(values[key] ?? NaN);
      invariant(
        Number.isFinite(value),
        `the cache Job ${jobId} logged no ${key}`,
      );
      return value;
    };
    return {
      coldStart,
      cache: {
        jobId,
        installMs: read('INSTALL_MS'),
        fetchedBytes: read('FETCHED_BYTES'),
        cacheBytesBefore: read('CACHE_BEFORE'),
        cacheBytesAfter: read('CACHE_AFTER'),
      },
    };
  }

  /**
   * The GPU-probe check, on a GPU pool (the journey's, or one of its own on a CPU journey):
   * the fabric gate's unit succeeded and a GPU Job completes; a Job that
   * prints a missing-GPU line has its Node checked, reruns once in a new Pod
   * and ends Errored with the passing verdict; the Node is never cordoned or
   * labelled, and no check Pod is left. On a Node with two GPUs, a Job
   * holding nearly all of one GPU's memory must not make the check call the
   * Node unusable.
   */
  async poolGpuProbe(journeyPoolId: string) {
    const { port, policy } = this.#d;
    const own = policy.gpusPerNode === 0;
    invariant(
      !own || policy.gpuPool,
      'pool-gpu-probe on a CPU journey pool needs a GPU pool type',
    );
    const nodePoolId = own
      ? await port.createPool('gpu-probe', {
          vmTypes: [policy.gpuPool!.vmType],
          minVms: 1,
          maxVms: 1,
          region: policy.gpuPool!.region,
        })
      : journeyPoolId;
    const gpus = own ? policy.gpuPool!.gpusPerNode : policy.gpusPerNode;
    const [node] = (await port.nodes(nodePoolId)).filter((n) => n.ready);
    invariant(node, `GPU pool ${nodePoolId} has no Ready Node`);
    const fabric = shellValues(await port.hostShell(node.name, FABRIC_SCRIPT));
    invariant(
      fabric.LoadState === 'loaded' &&
        fabric.Result === 'success' &&
        fabric.ExecMainStatus === '0',
      `anycloud-gpu-fabric.service on ${node.name} did not succeed: ${metaJson(fabric)}`,
    );
    const gpuJobId = await port.submitJob('gpu-ok', nodePoolId, {
      image: CHECK_IMAGE,
      gpus: 1,
      command: ['sh', '-c', 'nvidia-smi -L | grep "^GPU 0:"'],
    });
    const gpuJob = await this.#terminal(gpuJobId);
    invariant(
      gpuJob.state === WorkloadState.Completed,
      `a GPU Job on ${nodePoolId} ended ${gpuJob.state}: ${metaJson(gpuJob.events.at(-1))}`,
    );

    const pass = await this.#rerun(nodePoolId, 'gpu-pass', true);
    let coLocated = null;
    if (gpus >= 2) {
      const holderJobId = await port.submitJob('gpu-hold', nodePoolId, {
        image: CHECK_IMAGE,
        gpus: 1,
        command: ['python3', '-c', HOLD_GPU_MEMORY],
      });
      await this.#running(holderJobId);
      const held = await this.#d.wait.for(
        `Job ${holderJobId} holding its GPU's memory`,
        async () => ({
          job: await port.job(holderJobId),
          log: shellValues(await port.jobLog(holderJobId)),
        }),
        {
          timeoutMs: policy.workloadMs,
          intervalMs: 5_000,
          probeError: 'fail',
          reject: ({ job }) =>
            job.state === WorkloadState.Running
              ? undefined
              : `ended ${job.state}`,
          unmet: ({ log }) => (log.HELD ? undefined : 'no HELD line yet'),
        },
      );
      coLocated = {
        ...(await this.#rerun(nodePoolId, 'gpu-coloc', false)),
        holderJobId,
        held: `${held.log.HELD} of ${held.log.TOTAL ?? '?'} bytes`,
      };
      await port.terminateJob(holderJobId);
    }
    if (own) await port.deletePool(nodePoolId);
    else await this.#gpusReleased(nodePoolId);
    return this.#record('pool-gpu-probe', {
      nodePoolId,
      ownPool: own,
      fabric,
      gpuJobId,
      pass,
      coLocated,
    });
  }

  /**
   * One missing-GPU Job and the Node check its report runs. `passes`: the
   * capped end names a passing check; otherwise (a co-located Job holds its
   * GPU's memory) it may name either verdict but never an unusable Node.
   */
  async #rerun(nodePoolId: string, label: string, passes: boolean) {
    const { port, clock } = this.#d;
    const jobId = await port.submitJob(label, nodePoolId, {
      image: CHECK_IMAGE,
      gpus: 1,
      command: ['sh', '-c', `echo "${MISSING_GPU_LINE}"; exit 1`],
    });
    const checks = new Map<string, { createdAt: number; lastSeen: number }>();
    const marked: string[] = [];
    const observe = async () => {
      const [pods, nodes] = await Promise.all([
        port.pods(nodePoolId),
        port.nodes(nodePoolId),
      ]);
      for (const pod of pods.filter((p) => GPU_CHECK_POD.test(p.name))) {
        checks.set(pod.name, {
          createdAt: checks.get(pod.name)?.createdAt ?? pod.createdAt,
          lastSeen: clock.now(),
        });
      }
      for (const n of nodes.filter((n) => n.unschedulable || n.unusableGpu))
        marked.push(n.name);
    };
    const end = await this.#terminal(jobId, observe);
    await observe();
    const record = {
      jobId,
      replicaPods: replicaPods(end),
      errored:
        eventsMatching(end, WorkloadState.Errored, '').at(-1)?.text ?? '',
      checks: [...checks].map(([name, { createdAt, lastSeen }]) => ({
        name,
        seenForMs: lastSeen - createdAt,
      })),
    };
    await port.record(`pool-check-${label}-observed`, {
      ...record,
      marked,
      events: end.events,
    });
    invariant(
      marked.length === 0,
      `the check cordoned or labelled Node ${marked.join(', ')} for a Job whose GPU is fine`,
    );
    invariant(
      eventsMatching(end, WorkloadState.Retrying, POOL_RETRY_ELSEWHERE)
        .length === 0,
      `Job ${jobId} was retried on another Node: its Node was called unusable`,
    );
    invariant(
      eventsMatching(end, WorkloadState.Retrying, POOL_RERUN).length === 1,
      `Job ${jobId} did not rerun once in a new Pod: ${metaJson(end.events)}`,
    );
    invariant(
      end.state === WorkloadState.Errored,
      `Job ${jobId} ended ${end.state} after its rerun`,
    );
    invariant(
      !passes || record.errored.includes(POOL_CHECK_PASSED),
      `Job ${jobId}'s end does not name a passing GPU check: ${record.errored}`,
    );
    const [first, second] = record.replicaPods;
    invariant(
      first && second && first !== second,
      `Job ${jobId}'s rerun did not run in a new Pod: ${record.replicaPods.join(', ')}`,
    );
    invariant(
      !(await port.pods(nodePoolId)).some((p) => p.uid === first),
      `Job ${jobId}'s first replica ${first} was not deleted`,
    );
    const slow = record.checks.find((c) => c.seenForMs > GPU_CHECK_BOUND_MS);
    invariant(
      !slow,
      `GPU check ${slow?.name ?? ''} ran ${String(slow?.seenForMs)} ms, over its 60 s bound`,
    );
    await this.#d.wait.for(
      `no GPU check Pod left in node pool ${nodePoolId}`,
      () => port.pods(nodePoolId),
      {
        timeoutMs: 60_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (pods) => {
          const left = pods.filter((p) => GPU_CHECK_POD.test(p.name));
          return left.length
            ? `left: ${left.map((p) => p.name).join(', ')}`
            : undefined;
        },
      },
    );
    return record;
  }

  /** The journey's own workloads need the pool's GPUs back. */
  async #gpusReleased(nodePoolId: string): Promise<void> {
    await this.#d.wait.for(
      `node pool ${nodePoolId}'s check replicas gone`,
      () => this.#d.port.pods(nodePoolId),
      {
        timeoutMs: this.#d.policy.workloadMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (pods) => {
          const left = pods.filter(
            (p) =>
              p.gpus > 0 && (p.phase === 'Running' || p.phase === 'Pending'),
          );
          return left.length
            ? `still running: ${left.map((p) => p.name).join(', ')}`
            : undefined;
        },
      },
    );
  }

  /**
   * RFC 0049 C32 on a pool of its own with `--user-namespace-jobs` and
   * `--require-nested-virtualization`: its `--cache` refusal; the Node's handler,
   * `/dev/kvm` mode, cgroup2 mount (no `memory_localevents`) and K3s's
   * containerd default spec, equal to the base spec but for `/sys` and
   * rlimits. Then the probe as root and through `sudo -n`, from images
   * without their own evacuation (`user-namespace-probe.ts`), and a
   * non-root image without sudo, whose user owns its cgroup and delegates it
   * itself. A write of an
   * existing file in each `/sys` submount must be denied; reads are only
   * recorded.
   */
  async userNamespace() {
    const { port, policy } = this.#d;
    const c32 = policy.userNamespace;
    invariant(c32, 'user-namespace needs its pool type and images');
    const [rootImage, sudoImage, noSudoImage] = c32.images;
    const nodePoolId = await port.createPool('userns', {
      vmTypes: [c32.vmType],
      minVms: 1,
      maxVms: 1,
      diskSizeGb: 100,
      userNamespaceJobs: true,
      requireNestedVirtualization: true,
    });
    const job = (label: string, image: string, spec: Partial<PoolJobSpec>) =>
      port.submitJob(`userns-${label}`, nodePoolId, {
        image,
        command: ['true'],
        memory: '6g',
        bind: '/var/lib/docker',
        ...spec,
      });
    await job('cache', rootImage, {
      caches: ['c32:/cache'],
      refused: 'does not accept --cache',
    });

    const node = (await port.nodes(nodePoolId)).find((n) => n.ready);
    invariant(node, `node pool ${nodePoolId} has no Ready Node`);
    const host = shellValues(
      await port.hostShell(
        node.name,
        [
          `echo SPEC=$(${IN_HOST} k3s ctr oci spec | tr -d '\\n')`,
          `echo CGROUP2=$(${IN_HOST} awk '$3 == "cgroup2" { print $4 }' /proc/mounts)`,
          `echo KVM=$(${IN_HOST} stat -c %a /dev/kvm)`,
          `echo HANDLER=$(${IN_HOST} k3s crictl info | grep -c '"anycloud-userns"')`,
        ].join('\n'),
      ),
    );
    const { SPEC: spec, ...facts } = host;
    const drift = baseSpecDrift(
      JSON.parse(spec ?? '{}') as Record<string, unknown>,
      c32.baseSpec,
    );
    invariant(
      !drift &&
        Number(facts.HANDLER) > 0 &&
        facts.KVM === '666' &&
        facts.CGROUP2?.includes('nsdelegate') &&
        !facts.CGROUP2.includes('memory_localevents'),
      `the Node is not C32's, or K3s's containerd default spec drifted from USER_NAMESPACE_BASE_SPEC (re-capture it from 'ctr oci spec'): ${metaJson({ facts, drift })}`,
    );

    const marker = `c32-victim-${String(this.#d.clock.now())}`;
    const removeVictim = await port.victim(node.name, marker);
    try {
      const probe = (end: 'oom' | 'limit') =>
        userNamespaceProbe(end, c32.k3sImage, marker);
      const ids = [
        await job('root', rootImage, { command: probe('oom') }),
        await job('sudo', sudoImage, { command: probe('limit') }),
        await job('no-sudo', noSudoImage, { memory: '1g' }),
      ];
      const [root, sudo, ...noSudo] = await Promise.all(
        ids.map((id) => this.#terminal(id)),
      );
      // A replica that can't delegate its cgroup ends its Jobs unclaimed;
      // its events say why, where the log would only say it never started.
      for (const [index, end] of [root, sudo, ...noSudo].entries()) {
        invariant(
          end.events.some((e) => e.state === WorkloadState.Running),
          `user-namespace Job ${ids[index]} never started: ${metaJson(end.events.slice(-3))}`,
        );
      }
      const values = [
        shellValues(await port.jobLog(ids[0])),
        shellValues(await port.jobLog(ids[1])),
      ] as const;
      const oomKilled = (end: PoolJob) =>
        end.events.some((e) => /OOMKilled/u.test(e.text));
      for (const seen of values) {
        const denied = Object.entries(seen).filter(([k]) =>
          /^(SYSFS_WRITE_|SUBMOUNT_WRITE_|HOST_DISK)|_MAX_WRITE$/u.test(k),
        );
        const expected = `DOCKERD=ok DOCKER_RUN=ok DOCKER_RUN_MEMORY=${String(64 * 1024 ** 2)} INNER_PRIVILEGED=ok DOCKER_BUILD=ok BUILDX=ok COMPOSE=network:compose-ok,port:compose-ok NESTED_K3S=nested-ok KVM=ok METADATA=000 KUBELET_CREDENTIAL=none VICTIM_ENV=0 VICTIM_FILES=0`;
        invariant(
          expected
            .split(' ')
            .every((kv) =>
              Object.entries(seen).some((e) => e.join('=') === kv),
            ) &&
            ![seen.KUBELET_ANONYMOUS, seen.API_SECRETS].includes('200') &&
            denied.some(([k]) => k.startsWith('SUBMOUNT_WRITE_')) &&
            denied.length > 5 &&
            denied.every(([, v]) => v === 'denied'),
          `a user-namespace Job's engines failed, or it reached the Node, a neighbour or its limits: ${metaJson(seen)}`,
        );
      }
      invariant(
        root.state === WorkloadState.Errored &&
          oomKilled(root) &&
          values[0].CHILD_MEMORY_MAX === 'ok' &&
          values[0].CHILD_EXIT === '137' &&
          sudo.state === WorkloadState.Errored &&
          !oomKilled(sudo) &&
          values[1].INNER_EXIT === '137' &&
          sudo.events.some((e) => e.text.includes('Exited with code 3')),
        `only the Job's own --memory must end it OOMKilled: ${metaJson([root, sudo].map((e) => e.events.at(-1)))}`,
      );
      // The image's user owns its cgroup, so it delegates without sudo.
      invariant(
        noSudo.every((end) => end.state === WorkloadState.Completed),
        `the image without sudo must run its Jobs as its own user: ${metaJson(noSudo.map((e) => e.events.at(-1)))}`,
      );
      return await this.#record('user-namespace', { facts, ids, values });
    } finally {
      await removeVictim();
    }
  }
}

/**
 * The entry-handoff check's request loop through the upgrade's Node replacements. Every
 * request must succeed, and the record must have moved to a new entry: on a
 * pool whose every Node is replaced, the entry hand-off happened under the
 * loop.
 */
export class EntryHandoff {
  readonly #d: Pick<
    PoolCheckDependencies,
    'port' | 'progress' | 'clock' | 'wait'
  >;
  readonly #serviceId: string;
  readonly #url: string;
  readonly #started: number;
  readonly #entries: { ip: string; atMs: number }[];
  readonly #stopRequests: () => Promise<HostedHealthRecord>;
  #recorded = false;

  constructor(
    dependencies: Pick<
      PoolCheckDependencies,
      'port' | 'progress' | 'clock' | 'wait'
    >,
    serviceId: string,
    url: string,
    ip: string,
  ) {
    this.#d = dependencies;
    this.#serviceId = serviceId;
    this.#url = url;
    this.#started = dependencies.clock.now();
    this.#entries = [{ ip, atMs: 0 }];
    this.#stopRequests = dependencies.port.watchRequests(url);
  }

  get serviceId(): string {
    return this.#serviceId;
  }

  /** Notes a new entry IP, with when it was first seen. */
  async observe(): Promise<void> {
    const ip = await this.#d.port.entryIp(this.#serviceId);
    if (ip && ip !== this.#entries.at(-1)!.ip) {
      this.#entries.push({ ip, atMs: this.#d.clock.now() - this.#started });
      this.#d.progress.mark(`entry hand-off: ${this.#serviceId} now at ${ip}`);
    }
  }

  async stop() {
    const requests = await this.#stopRequests();
    // The last status read can stall with the hosted API as the earlier ones
    // can (run 40934365017); the requests' own counts are already final.
    await this.#d.wait.for(
      `entry hand-off ${this.#serviceId}: final entry read`,
      () => this.observe(),
      {
        timeoutMs: 60_000,
        intervalMs: 15_000,
        probeError: retryTransientProbeError,
        unmet: () => undefined,
      },
    );
    const url = this.#url;
    const record = await this.#record(requests);
    invariant(requests.requests > 0, `no request reached ${url}`);
    invariant(
      requests.failed === 0,
      `${String(requests.failed)} of ${String(requests.requests)} requests to ${url} failed through the Node replacements (longest gap ${String(requests.longestGapMs)} ms): ${JSON.stringify({ failures: requests.failures, dns: requests.dns })}`,
    );
    invariant(
      this.#entries.length > 1,
      `the record for ${url} stayed at ${this.#entries[0].ip}: no entry hand-off happened under the loop`,
    );
    this.#d.progress.mark('pool check entry-handoff: passed');
    return record;
  }

  /**
   * Idempotent: after `stop`, or on a failure before it, when it records the
   * loop's counts so far.
   */
  async cancel(): Promise<void> {
    const requests = await this.#stopRequests();
    if (!this.#recorded) await this.#record(requests);
  }

  async #record(requests: HostedHealthRecord) {
    const record = {
      serviceId: this.#serviceId,
      url: this.#url,
      requests,
      entries: this.#entries,
    };
    await this.#d.port.record('pool-check-entry-handoff', record);
    this.#recorded = true;
    return record;
  }
}
