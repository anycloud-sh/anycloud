import { errorMessage } from '../../shared/log-diagnostics.js';
import type {
  SelfDeleteInput,
  SelfDeleteStatus,
} from '../../shared/api-contract/system-release-schemas.js';
import type { CloudResourceSweeper } from './gateways/resource-sweeper.js';
import { dependentsRefusal, type ClusterDependents } from './cluster-errors.js';
import { planInstallationSweep } from './installation-sweep.js';

/**
 * The hosted API deletes its installation and itself last (RFC 0049 C26,
 * seed design): it refuses while anything could still be serving, takes
 * C28's final backup, answers, waits for its Workloads' cleanups, and asks
 * its cloud to delete its own stack, group or instance. The checkpoint
 * bucket is never its to delete: the CLI does, under `--delete-buckets`.
 */
export interface SelfDeleteDependencies {
  clusterId: string;
  /** Where it runs and its bucket, which the CLI needs before it asks. */
  installation: SelfDeleteStatus['installation'];
  /** Only the hosted API's owner may delete it; throws for anyone else. */
  requireOwner(actorId: string): Promise<void>;
  /** Node pools and VM Services or Jobs not yet ended; any refuses. */
  liveDependents(): Promise<ClusterDependents>;
  /** Null when no backup is configured: the final backup is `failed`. */
  backup: { run(reason: string): Promise<unknown> } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Ended Workloads whose cleanup (VMs, per-Job buckets, through the
   * Workload's own credential) hasn't committed; the reconciler runs it.
   */
  cleanupPending(): Promise<Array<{ id: string; error: string | null }>>;
  /**
   * AWS only: EC2 left over by the installation's tags, through the VM's
   * identity. Null where that identity can't list them (GCP, Azure).
   */
  sweeperFor: ((location?: string) => CloudResourceSweeper) | null;
  /** Delete the stack, group or instance this API runs on. */
  removeSelf(): Promise<void>;
  log: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
}

export class SelfDeleteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfDeleteRefusedError';
  }
}

export interface SelfDelete {
  request(actorId: string, input: SelfDeleteInput): Promise<SelfDeleteStatus>;
  status(): SelfDeleteStatus;
}

const CLEANUP_POLL_MS = 15_000;
const CLEANUP_WAIT_MS = 10 * 60_000;

export function createSelfDelete(deps: SelfDeleteDependencies): SelfDelete {
  let current: SelfDeleteStatus = {
    state: 'idle',
    installation: deps.installation,
    finalBackup: null,
    backedUpAt: null,
    deleted: [],
    remaining: [],
    error: null,
  };
  let started: Promise<SelfDeleteStatus> | null = null;

  async function refuseDependents(): Promise<void> {
    const refusal = dependentsRefusal(
      await deps.liveDependents(),
      deps.clusterId,
    );
    if (refusal) throw new SelfDeleteRefusedError(refusal);
  }

  /** Wait for the reconciler's Workload cleanups; what stays is reported. */
  async function awaitCleanups(): Promise<void> {
    const deadline = deps.now() + CLEANUP_WAIT_MS;
    let pending = await deps.cleanupPending();
    while (pending.length > 0 && deps.now() < deadline) {
      await deps.sleep(CLEANUP_POLL_MS);
      pending = await deps.cleanupPending();
    }
    // A credential gone or failing leaves its bucket; the delete goes on.
    current.remaining.push(
      ...pending.map(({ id, error }) => ({
        type: 'workload',
        id,
        location: null,
        ...(error && { error }),
      })),
    );
  }

  async function run(): Promise<void> {
    await awaitCleanups();
    // A pool or Workload admitted meanwhile would be orphaned: stop.
    await refuseDependents();
    if (deps.sweeperFor) {
      const sweeperFor = deps.sweeperFor;
      const plan = await planInstallationSweep({
        clusterId: deps.clusterId,
        sweeperFor: (location) => sweeperFor(location),
        // Nothing may still serve (refused above); ended VM-host VMs go.
        deleteWorkloadVms: true,
        // The cloud's delete of the stack takes those; the checkpoint bucket
        // only the CLI deletes, under --delete-buckets.
        keepManagement: { keepBucket: true },
      });
      const pass = await plan.resources({ dryRun: false });
      current.deleted.push(
        ...pass.vms.map(({ id, location }) => ({ type: 'vm', id, location })),
        ...pass.resources,
      );
      const failed = pass.errors.map(
        ({ resourceType, resourceId, location, error }) => ({
          type: resourceType,
          id: resourceId,
          location,
          error,
        }),
      );
      current.remaining.push(...failed);
      // A VM it failed to delete would bill on once no API knows of it: stop
      // here, still answering, so the CLI reports it and a re-run retries.
      if (failed.length > 0) {
        throw new Error(`${failed.length} resource(s) could not be deleted`);
      }
    }
    await refuseDependents();
    current = { ...current, state: 'removing' };
    await deps.removeSelf();
  }

  async function start(deleteBuckets: boolean): Promise<SelfDeleteStatus> {
    await refuseDependents();
    let finalBackup: SelfDeleteStatus['finalBackup'] = 'skipped';
    // A supplied bucket is kept whatever the flag, so it gets its backup.
    if (!deleteBuckets || !deps.installation.bucket.managed) {
      finalBackup = await (
        deps.backup?.run('cluster delete') ??
        Promise.reject(new Error('no backup is configured'))
      )
        .then(() => 'taken' as const)
        .catch((error: unknown) => {
          deps.log.warn('Final backup before self-delete failed', {
            id: 'system',
            error: errorMessage(error),
          });
          return 'failed' as const;
        });
    }
    current = {
      state: 'sweeping',
      installation: deps.installation,
      finalBackup,
      backedUpAt:
        finalBackup === 'taken' ? new Date(deps.now()).toISOString() : null,
      deleted: [],
      remaining: [],
      error: null,
    };
    void run().catch((error: unknown) => {
      current = { ...current, state: 'failed', error: errorMessage(error) };
      started = null;
      deps.log.warn('Self-delete failed', {
        id: 'system',
        error: errorMessage(error),
      });
    });
    return current;
  }

  return {
    async request(actorId, { clusterId, deleteBuckets }) {
      await deps.requireOwner(actorId);
      if (clusterId !== deps.clusterId) {
        throw new SelfDeleteRefusedError(
          `This hosted API runs cluster ${deps.clusterId}, not ${clusterId}`,
        );
      }
      // One delete at a time: a retried or concurrent request joins it.
      if (started) return started.then(() => current);
      started = start(deleteBuckets);
      return started.catch((error: unknown) => {
        started = null;
        throw error;
      });
    },
    status: () => current,
  };
}
