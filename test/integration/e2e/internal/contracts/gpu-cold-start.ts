/**
 * A pool Node's and its replica Pod's start, read natively (epoch ms). The
 * GPU time is the device plugin container's start on the Node: Kubernetes
 * keeps no time for `nvidia.com/gpu` turning allocatable, and the plugin
 * registers the devices as it starts; null on a CPU Node. `vmLaunchedAtMs`
 * is null on Lambda, whose API reports no launch time.
 */
export interface PoolColdStartTimes {
  readonly node: string;
  readonly vmLaunchedAtMs: number | null;
  readonly nodeCreatedAtMs: number;
  readonly nodeReadyAtMs: number;
  readonly gpuPluginStartedAtMs: number | null;
  readonly podScheduledAtMs: number;
  /**
   * kubelet's `Pulled` Event for the workload container: when, the pull's own
   * time, and whether the Node already had the image. Null once the Event is
   * gone (Events expire after an hour).
   */
  readonly imagePull: {
    readonly atMs: number;
    readonly elapsedMs: number;
    readonly alreadyPresent: boolean;
  } | null;
  /** The same for the `runner-install` init container's API image. */
  readonly runnerImagePull: PoolColdStartTimes['imagePull'];
  readonly containerStartedAtMs: number;
}

/** One Node's way from its VM to the receiver's first claim. */
export interface GpuColdStartRecord extends PoolColdStartTimes {
  readonly podUid: string;
  /** The receiver's `AC_TIMING` marks, by name. */
  readonly marks: Readonly<Record<string, number>>;
  /**
   * `<from>-><to>` between consecutive points, and `total` from the first
   * (`durations`); without `podWaitedForNode`, no `total` or
   * `gpu_plugin_started->pod_scheduled`.
   */
  readonly durationsMs: Readonly<Record<string, number>>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The receiver's own marks for each workload (fixtures/*.py). */
const WORKLOAD_MARKS = {
  mace: ['torch_imported', 'calculator_ready', 'warm_inference_done'],
  voice: ['model_loaded', 'warm_first_chunk', 'warm_done'],
} as const;

/** Native points, then the receiver's: the order a cold start passes them. */
const ORDER = [
  'vm_launched',
  'node_created',
  'node_ready',
  'gpu_plugin_started',
  'pod_scheduled',
  'container_started',
  'process_start',
  ...WORKLOAD_MARKS.mace,
  ...WORKLOAD_MARKS.voice,
  'work_loaded',
  'first_claim',
] as const;

/**
 * `<from>-><to>` between the consecutive known points in `order`, and
 * `total` from the first to the last. Without `podWaitedForNode`, no `total`
 * and no step into `pod_scheduled`: the Pod came after the journey's own
 * stages, not the Node's boot.
 */
function durations(
  order: readonly string[],
  points: Readonly<Record<string, number | null>>,
  podWaitedForNode: boolean,
): Record<string, number> {
  const known = order.filter((name) => typeof points[name] === 'number');
  const at = (name: string) => points[name]!;
  const durationsMs: Record<string, number> = podWaitedForNode
    ? { total: at(known.at(-1)!) - at(known[0]) }
    : {};
  for (const [index, name] of known.entries()) {
    if (!index || (!podWaitedForNode && name === 'pod_scheduled')) continue;
    durationsMs[`${known[index - 1]}->${name}`] =
      at(name) - at(known[index - 1]);
  }
  return durationsMs;
}

export function coldStartRecord(
  workload: keyof typeof WORKLOAD_MARKS,
  podUid: string,
  times: PoolColdStartTimes,
  marks: Readonly<Record<string, number>>,
  podWaitedForNode: boolean,
): GpuColdStartRecord {
  const missing = [
    'process_start',
    ...WORKLOAD_MARKS[workload],
    'work_loaded',
    'first_claim',
  ].filter((name) => typeof marks[name] !== 'number');
  invariant(
    !missing.length,
    `the ${workload} receiver on Pod ${podUid} logged no ${missing.join(', ')} mark`,
  );
  const durationsMs = durations(
    ORDER,
    {
      vm_launched: times.vmLaunchedAtMs,
      node_created: times.nodeCreatedAtMs,
      node_ready: times.nodeReadyAtMs,
      gpu_plugin_started: times.gpuPluginStartedAtMs,
      pod_scheduled: times.podScheduledAtMs,
      container_started: times.containerStartedAtMs,
      ...marks,
    },
    podWaitedForNode,
  );
  return { ...times, podUid, marks, durationsMs };
}

/** One CPU pool Node's way from its VM to a Job running on it (`cpu-cold-start`). */
export interface CpuColdStartRecord extends PoolColdStartTimes {
  readonly jobId: string;
  readonly podUid: string;
  /** The Job's first `running` event. */
  readonly jobRunningAtMs: number;
  /** As in `GpuColdStartRecord`, ending at `job_running`. */
  readonly durationsMs: Readonly<Record<string, number>>;
}

const CPU_ORDER = [
  'vm_launched',
  'node_created',
  'node_ready',
  'pod_scheduled',
  'image_pulled',
  'container_started',
  'job_running',
] as const;

export function cpuColdStartRecord(
  jobId: string,
  podUid: string,
  times: PoolColdStartTimes,
  jobRunningAtMs: number | undefined,
  podWaitedForNode: boolean,
): CpuColdStartRecord {
  invariant(
    times.imagePull,
    `Pod ${podUid} of Job ${jobId} has no Pulled event for its image`,
  );
  invariant(jobRunningAtMs !== undefined, `Job ${jobId} has no running event`);
  invariant(
    times.vmLaunchedAtMs !== null,
    `Node ${times.node} has no VM launch time`,
  );
  const durationsMs = durations(
    CPU_ORDER,
    {
      vm_launched: times.vmLaunchedAtMs,
      node_created: times.nodeCreatedAtMs,
      node_ready: times.nodeReadyAtMs,
      pod_scheduled: times.podScheduledAtMs,
      image_pulled: times.imagePull.atMs,
      container_started: times.containerStartedAtMs,
      job_running: jobRunningAtMs,
    },
    podWaitedForNode,
  );
  return { ...times, jobId, podUid, jobRunningAtMs, durationsMs };
}
