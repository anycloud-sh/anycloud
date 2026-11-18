import type {
  JobGenerationAbsence,
  JobNativeCleanup,
} from './job-native-cleanup.js';
import {
  assertMutationAccepted,
  type WorkloadMutationTransport,
} from './workload-mutations.js';
import type { TrackedWorkloadRef } from './workloads.js';
import type { CommandResult } from './types.js';
import { isolatedJobEnvironment } from './transports/job-command.js';

/** One actual send per fence. A lost response never silently authorizes a replay. */
export async function submitJob(
  ref: TrackedWorkloadRef,
  args: readonly string[],
  dependencies: {
    readonly native: Pick<JobNativeCleanup, 'creationStarted' | 'capture'>;
    readonly mutations: Pick<WorkloadMutationTransport, 'runCliCreate'>;
  },
): Promise<void> {
  await dependencies.native.creationStarted(ref);
  await sendAndCapture(ref, 'Job submission', dependencies.native, () =>
    dependencies.mutations.runCliCreate(ref, args, {
      timeoutMs: 300_000,
      label: 'dedicated-job-submit',
      recordArtifact: false,
      env: isolatedJobEnvironment(),
    }),
  );
}

/** The same armed reference and its original absence receipt authorize one resubmission. */
export async function resubmitJob(
  ref: TrackedWorkloadRef,
  previousGeneration: JobGenerationAbsence,
  dependencies: {
    readonly native: Pick<JobNativeCleanup, 'creationStarted' | 'capture'>;
    readonly mutations: Pick<WorkloadMutationTransport, 'runCliResubmit'>;
  },
): Promise<void> {
  await dependencies.native.creationStarted(ref, undefined, previousGeneration);
  await sendAndCapture(
    ref,
    'Job resubmission',
    dependencies.native,
    async () => {
      const result = await dependencies.mutations.runCliResubmit(
        ref,
        ['resubmit', ref.id],
        {
          timeoutMs: 300_000,
          label: 'dedicated-job-resubmit',
          recordArtifact: false,
          env: isolatedJobEnvironment(),
        },
      );
      // The public command also handles per-Workload errors without a nonzero
      // process exit, so the accepted response must name this exact Workload.
      if (!result.combined.includes(`Workload ${ref.id} resubmitted`))
        throw new Error(
          'Job resubmission did not confirm the original Workload',
        );
      return result;
    },
  );
}

async function sendAndCapture(
  ref: TrackedWorkloadRef,
  operation: string,
  native: Pick<JobNativeCleanup, 'capture'>,
  send: () => Promise<CommandResult>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    const result = await send();
    assertMutationAccepted(result, operation);
    if (result.signal || result.outputTruncated)
      throw new Error(`${operation} did not produce a complete response`);
  } catch (error) {
    failures.push(error);
  }
  try {
    await native.capture(ref);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `${operation} and identity capture failed`,
    );
}
