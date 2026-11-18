/**
 * Process-local ownership for all in-flight workload work.
 *
 * Pipeline owners and their child provider/runtime operations share this
 * registry. A deadline may stop a foreground caller from waiting, but it does
 * not stop the underlying work, so the workload remains fenced until every
 * registered promise settles.
 */
const workloadWork = new Map<string, Set<Promise<void>>>();

export function trackWorkloadWork<T>(
  workloadId: string,
  work: Promise<T>,
): void {
  let workSet = workloadWork.get(workloadId);
  if (!workSet) {
    workSet = new Set();
    workloadWork.set(workloadId, workSet);
  }

  const remove = (trackedWork: Promise<void>) => {
    workSet.delete(trackedWork);
    if (workSet.size === 0 && workloadWork.get(workloadId) === workSet) {
      workloadWork.delete(workloadId);
    }
  };

  // Supplying both handlers observes a rejected operation while making the
  // registry promise itself always fulfill. The original promise is unchanged
  // and still delivers its result or error to its caller.
  const tracked: Promise<void> = Promise.resolve(work).then(
    () => remove(tracked),
    () => remove(tracked),
  );
  workSet.add(tracked);
}

export function hasWorkloadWork(workloadId: string): boolean {
  return (workloadWork.get(workloadId)?.size ?? 0) > 0;
}

export function activeWorkloadWorkCount(): number {
  return workloadWork.size;
}

/**
 * Test synchronization for observed registrations, including work registered
 * while earlier work settles. It does not prevent later registration.
 * Production code fences with hasWorkloadWork instead of waiting.
 */
export async function drainWorkloadWork(workloadId: string): Promise<void> {
  let workSet = workloadWork.get(workloadId);
  while (workSet && workSet.size > 0) {
    await Promise.all([...workSet]);
    workSet = workloadWork.get(workloadId);
  }
}
