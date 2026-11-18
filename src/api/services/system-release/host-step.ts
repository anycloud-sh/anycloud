import type {
  BatchV1Api,
  CoreV1Api,
  V1Job,
  V1Pod,
} from '@kubernetes/client-node';

import { KUBERNETES_STEP_ID_PATTERN } from '../../../shared/api-contract/system-release-schemas.js';
import {
  MANAGEMENT_NODE_NAME,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../../shared/system-release.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from '../kubernetes/managed-resources.js';
import { CONTROL_PLANE_TAINT_KEY } from '../../../shared/system-release.js';

/**
 * Host steps (RFC 0049 C26 (b)): the hosted API runs a root script on the
 * management host with no SSH. A one-shot Job, pinned to the management Node
 * by name and tolerating its taint, runs an API image privileged with the
 * host's PID namespace. It enters the host's mount namespace with
 * `nsenter -t 1 -m` and hands the script to a transient systemd unit, so a
 * K3s restart the script makes can't kill the process making it. The Pod
 * waits for the unit's result file and reports it as its termination
 * message, which the API reads from the Pod's status.
 *
 * This is anycloud's own system Job on the management Node, not a workload:
 * release 3's removal of privileged workloads guards workload
 * records, and the user-namespace admission policy (C32) matches only Pods
 * on its runtime class, so neither applies to it.
 */

/**
 * The step a host-step Job runs; its Pod renders the script from its own
 * image, so a K3s step applies the configuration of the release it moves to.
 * Signing-key steps join as further kinds.
 */
type HostStep = { kind: 'kubernetes'; publicIp: string; issuerUrl: string };

type HostStepKind = HostStep['kind'];

export interface HostStepRequest {
  /** Unique per run: a poll or retry with the same id observes the same run. */
  id: string;
  image: string;
  step: HostStep;
}

/** A finished step's exit code and the tail of its output. */
export interface HostStepResult {
  code: number;
  output: string;
}

export type HostStepObservation =
  | {
      state: 'running';
      id: string;
      startedAt: string | null;
      /** What a Pod that hasn't started waits on, such as an image pull. */
      waiting: string | null;
    }
  | {
      state: 'finished';
      id: string;
      startedAt: string | null;
      finishedAt: string | null;
      result: HostStepResult;
    }
  /** The Pod ended without a result: its image, its node or the Job deadline. */
  | {
      state: 'failed';
      id: string;
      startedAt: string | null;
      finishedAt: string | null;
      reason: string;
    };

/** Run a host script and observe its result: the port host steps go through. */
export interface HostStepExecutor {
  /** Start the run (idempotent by id) and report where it is. */
  run(request: HostStepRequest): Promise<HostStepObservation>;
  /** A run by id; null when it was never started or is no longer kept. */
  get(kind: HostStepKind, id: string): Promise<HostStepObservation | null>;
  /** The most recent run of a kind, or null when none is kept. */
  latest(kind: HostStepKind): Promise<HostStepObservation | null>;
}

const HOST_STEP_NAMESPACE = SYSTEM_RELEASE_NAMESPACE;
const HOST_STEP_KIND_LABEL = 'anycloud.sh/host-step';
const HOST_STEP_ID_LABEL = 'anycloud.sh/host-step-id';
const HOST_STEP_ID_PATTERN = KUBERNETES_STEP_ID_PATTERN;
/** Where the step's Pod program is in every API image from 0.1.74. */
export const HOST_STEP_ENTRYPOINT = './dist/api/host-step.js';
export const HOST_STEP_ENV = {
  kind: 'ANYCLOUD_HOST_STEP',
  unit: 'ANYCLOUD_HOST_STEP_UNIT',
  publicIp: 'ANYCLOUD_MANAGEMENT_PUBLIC_IP',
  issuerUrl: 'ANYCLOUD_ISSUER_URL',
} as const;
/** Past the step's own 5-minute readiness wait, with room for an image pull. */
const HOST_STEP_DEADLINE_SECONDS = 15 * 60;
/**
 * Bounds the unit, so a hung step frees its lock. The K3s step ends itself
 * within 13 minutes plus one readiness poll, unless K3s's own start and
 * restart both run to their unit's timeouts; then this limit ends it.
 */
const HOST_STEP_UNIT_MAX_SECONDS = 14 * 60;
/** Kept a week, so `api status` reports the last K3s step. */
const HOST_STEP_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The kubelet keeps at most 4096 bytes of a termination message. */
const HOST_STEP_OUTPUT_BYTES = 3_000;

function hostStepJobName(kind: HostStepKind, id: string): string {
  if (!HOST_STEP_ID_PATTERN.test(id)) {
    throw new Error('A host step id is 8 to 32 lowercase letters or digits');
  }
  return `anycloud-host-${kind}-${id}`;
}

export function hostStepJob(request: HostStepRequest): V1Job {
  const name = hostStepJobName(request.step.kind, request.id);
  const labels = {
    'app.kubernetes.io/managed-by': 'anycloud',
    [HOST_STEP_KIND_LABEL]: request.step.kind,
    [HOST_STEP_ID_LABEL]: request.id,
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: HOST_STEP_NAMESPACE, labels },
    spec: {
      // A second Pod finds the first one's unit and waits for its result.
      backoffLimit: 1,
      activeDeadlineSeconds: HOST_STEP_DEADLINE_SECONDS,
      ttlSecondsAfterFinished: HOST_STEP_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          // The management Node by name, which no other Node can claim
          // (RFC 0049 § Isolation), so an unlabelled one is reached too.
          nodeName: MANAGEMENT_NODE_NAME,
          tolerations: [
            {
              key: CONTROL_PLANE_TAINT_KEY,
              operator: 'Exists',
              effect: 'NoSchedule',
            },
          ],
          hostPID: true,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          containers: [
            {
              name: 'host-step',
              image: request.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['node', HOST_STEP_ENTRYPOINT],
              env: [
                { name: HOST_STEP_ENV.kind, value: request.step.kind },
                { name: HOST_STEP_ENV.unit, value: name },
                { name: HOST_STEP_ENV.publicIp, value: request.step.publicIp },
                {
                  name: HOST_STEP_ENV.issuerUrl,
                  value: request.step.issuerUrl,
                },
              ],
              securityContext: { privileged: true },
              terminationMessagePolicy: 'File',
              resources: {
                requests: { cpu: '10m', memory: '64Mi' },
                limits: { memory: '256Mi' },
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * The runner, as root in the host's mount namespace: `$1` names the unit,
 * stdin is the script. A second Pod of the same step finds the unit running
 * or its result kept, and only waits. The result files live in `/run`, so a
 * reboot clears them with the unit.
 */
export const HOST_STEP_RUNNER = `set -eu
umask 077
unit=$1
dir=/run/anycloud-host-steps
mkdir -p "$dir"
out=$dir/$unit.out
code=$dir/$unit.code
if [ ! -e "$code" ]; then
  if ! systemctl is-active --quiet "$unit.service"; then
    cat > "$dir/$unit.sh"
    systemctl reset-failed "$unit.service" 2>/dev/null || true
    systemd-run --quiet --collect --unit="$unit" -p RuntimeMaxSec=${HOST_STEP_UNIT_MAX_SECONDS} -- /bin/bash -c '/bin/bash "$1/$2.sh" > "$1/$2.out.tmp" 2>&1 && s=0 || s=$?; mv -f "$1/$2.out.tmp" "$1/$2.out"; echo "$s" > "$1/$2.code.tmp"; mv -f "$1/$2.code.tmp" "$1/$2.code"' host-step "$dir" "$unit"
  fi
  while [ ! -e "$code" ]; do
    if ! systemctl is-active --quiet "$unit.service" && [ ! -e "$code" ]; then
      echo "host step unit $unit ended without a result" >&2
      exit 70
    fi
    sleep 2
  done
fi
echo "code=$(cat "$code")"
tail -c ${HOST_STEP_OUTPUT_BYTES} "$out"`;

/** The runner's report: `code=<n>` and then the output's tail. */
export function parseHostStepReport(report: string): HostStepResult | null {
  const match = /^code=(\d+)\n?/.exec(report);
  if (!match) return null;
  return { code: Number(match[1]), output: report.slice(match[0].length) };
}

function terminated(pod: V1Pod) {
  return pod.status?.containerStatuses?.find(
    (status) => status.name === 'host-step',
  )?.state?.terminated;
}

export function observeHostStep(
  job: V1Job,
  pods: readonly V1Pod[],
): HostStepObservation {
  const id = job.metadata?.labels?.[HOST_STEP_ID_LABEL] ?? '';
  const startedAt = job.status?.startTime?.toISOString() ?? null;
  // A Pod that reported a result is the answer, whatever its exit status.
  for (const pod of pods) {
    const state = terminated(pod);
    const result = state?.message ? parseHostStepReport(state.message) : null;
    if (result) {
      return {
        state: 'finished',
        id,
        startedAt,
        finishedAt: state?.finishedAt?.toISOString() ?? null,
        result,
      };
    }
  }
  const failed = job.status?.conditions?.find(
    (condition) => condition.type === 'Failed' && condition.status === 'True',
  );
  const waitingState = pods
    .flatMap((pod) => pod.status?.containerStatuses ?? [])
    .map((status) => status.state?.waiting)
    .find((state) => state?.reason && state.reason !== 'ContainerCreating');
  const waiting = waitingState
    ? [waitingState.reason, waitingState.message]
        .filter(Boolean)
        .join(': ')
        .slice(0, 500)
    : null;
  if (!failed) return { state: 'running', id, startedAt, waiting };
  const lastMessage = pods
    .map((pod) => terminated(pod)?.message?.trim())
    .find(Boolean);
  return {
    state: 'failed',
    id,
    startedAt,
    finishedAt: failed.lastTransitionTime?.toISOString() ?? null,
    reason: [failed.reason, failed.message, lastMessage ?? waiting]
      .filter(Boolean)
      .join(': ')
      .slice(0, 500),
  };
}

/** The executor on the API's in-cluster clients. */
export function createHostStepExecutor(clients: {
  batch: Pick<
    BatchV1Api,
    'readNamespacedJob' | 'createNamespacedJob' | 'listNamespacedJob'
  >;
  core: Pick<CoreV1Api, 'listNamespacedPod'>;
}): HostStepExecutor {
  const namespace = HOST_STEP_NAMESPACE;
  async function observe(job: V1Job): Promise<HostStepObservation> {
    const pods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: `batch.kubernetes.io/job-name=${job.metadata?.name ?? ''}`,
    });
    return observeHostStep(job, pods.items);
  }
  return {
    async run(request) {
      const name = hostStepJobName(request.step.kind, request.id);
      try {
        return await observe(
          await clients.batch.createNamespacedJob({
            namespace,
            body: hostStepJob(request),
          }),
        );
      } catch (error) {
        // A poll after the first one finds its Job.
        if (!isKubernetesConflictError(error)) throw error;
        return observe(
          await clients.batch.readNamespacedJob({ name, namespace }),
        );
      }
    },
    async get(kind, id) {
      try {
        return await observe(
          await clients.batch.readNamespacedJob({
            name: hostStepJobName(kind, id),
            namespace,
          }),
        );
      } catch (error) {
        if (isKubernetesNotFoundError(error)) return null;
        throw error;
      }
    },
    async latest(kind) {
      const { items } = await clients.batch.listNamespacedJob({
        namespace,
        labelSelector: `${HOST_STEP_KIND_LABEL}=${kind}`,
      });
      const newest = items
        .slice()
        .sort(
          (a, b) =>
            (b.metadata?.creationTimestamp?.getTime() ?? 0) -
            (a.metadata?.creationTimestamp?.getTime() ?? 0),
        )[0];
      return newest ? observe(newest) : null;
    },
  };
}
