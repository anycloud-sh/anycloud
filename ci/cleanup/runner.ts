/**
 * Shared orchestration for the per-cloud CI cleanup scripts.
 *
 * Each cleanup script discovers its own credentials and units (regions / zones)
 * and hands a per-unit cleanup closure to runCloudCleanup. This module owns
 * everything those scripts used to duplicate: the per-unit fan-out, a hard
 * per-unit timeout, an optional account-wide pass, result aggregation, the
 * "Warning: N errors" summary, and process.exit.
 */
import { withTimeout } from '../../src/shared/utils';
import type {
  ResourceSweepError,
  ResourceSweepResult,
} from '../../src/api/services/gateways/resource-sweeper';

// Per-unit (and account-wide) hard ceiling. A healthy region/zone finishes in
// well under a minute and the slowest legitimate per-unit step (AWS's
// security-group delete safety-net) is ~5 min, so 7 min only ever trips on a
// genuinely unreachable/stalled endpoint. Without it, one unit whose cloud SDK
// retries against a black-holed or wedged endpoint (none of these SDKs set a
// connection timeout) makes the Promise.all barrier below never resolve, so the
// script never reaches process.exit(0) and the CI job hangs for hours.
const UNIT_CLEANUP_TIMEOUT_MS = 7 * 60 * 1000;

export interface AccountWideTask {
  /** Resource word used in the summary, e.g. 'bucket' or 'container'. */
  label: string;
  run: () => Promise<ResourceSweepResult>;
}

export interface RunCloudCleanupOptions {
  /** Provider name for log lines, e.g. 'AWS'. */
  cloud: string;
  /** Units to fan out over: regions, zones, or a single-element list. */
  units: string[];
  /** What a unit is called in logs/summary. Defaults to 'region'. */
  unitLabel?: string;
  /**
   * Clean exactly one unit. Must resolve to a ResourceSweepResult — gateways fold
   * their own failures into result.errors rather than throwing.
   */
  cleanupUnit: (unit: string) => Promise<ResourceSweepResult>;
  /** Optional account-global pass (AWS buckets / Azure containers). */
  accountWide?: AccountWideTask;
  /** Override the per-unit deadline. Primarily for tests; defaults to 7 min. */
  timeoutMs?: number;
  /**
   * Exit non-zero when a sweep ran but left a resource behind. Off by default:
   * the cloud sweeps are best-effort safety nets whose failures are expected to
   * be transient. Opt in where cleanup is itself under test and a survivor is a
   * real regression signal.
   *
   * Deliberately scoped to resources, not to the sweep itself: a unit that
   * threw or timed out never got to enumerate anything, so failing on it would
   * turn an unreachable endpoint at teardown into the same red as a genuine
   * leak. Those still print in the summary.
   */
  failOnErrors?: boolean;
}

const minutes = (ms: number) => ms / 60_000;

/**
 * A sweep's outcome plus whether it actually got to run. `ranToCompletion` is
 * false only for runner-synthesized failures (the body threw, or the deadline
 * won), which is what separates "could not sweep" from "swept, resource stayed".
 */
interface CleanupOutcome {
  result: ResourceSweepResult;
  ranToCompletion: boolean;
}

// Run a cleanup body under the shared deadline. The bodies below never reject
// (their inner try/catch folds failures into a ResourceSweepResult), so withTimeout
// rejects ONLY when the deadline wins — i.e. the endpoint never answered.
// Convert that into one error row so it lands in the summary instead of wedging
// the Promise.all barrier.
function guarded(
  body: Promise<CleanupOutcome>,
  what: string,
  timeoutMs: number,
  onTimeout: ResourceSweepError,
): Promise<CleanupOutcome> {
  return withTimeout(body, timeoutMs, what).catch(() => ({
    result: {
      vmIds: [],
      otherResources: [],
      errors: [onTimeout],
    },
    ranToCompletion: false,
  }));
}

export async function runCloudCleanup(
  opts: RunCloudCleanupOptions,
): Promise<void> {
  const { cloud, units, cleanupUnit, accountWide } = opts;
  const unitLabel = opts.unitLabel ?? 'region';
  const timeoutMs = opts.timeoutMs ?? UNIT_CLEANUP_TIMEOUT_MS;

  console.log(
    `Running ${cloud} cleanup across ${units.length} ${unitLabel}(s)...`,
  );

  const unitPromises = units.map((unit) =>
    guarded(
      (async (): Promise<CleanupOutcome> => {
        console.log(`Starting cleanup for ${unitLabel}: ${unit}`);
        try {
          const result = await cleanupUnit(unit);
          console.log(
            `  ${unit}: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
          );
          return { result, ranToCompletion: true };
        } catch (error) {
          console.error(`  ${unit}: cleanup failed:`, error);
          return {
            result: {
              vmIds: [],
              otherResources: [],
              errors: [
                {
                  resourceType: unitLabel,
                  resourceId: unit,
                  error: String(error),
                },
              ],
            },
            ranToCompletion: false,
          };
        }
      })(),
      `cleanup for ${unitLabel} ${unit}`,
      timeoutMs,
      {
        resourceType: unitLabel,
        resourceId: unit,
        error: `cleanup timed out after ${minutes(timeoutMs)}m (${unitLabel} endpoint unreachable?)`,
      },
    ).then((outcome) => ({ unit, ...outcome })),
  );

  const accountWidePromise: Promise<
    ({ unit: string } & CleanupOutcome) | null
  > = accountWide
    ? guarded(
        (async (): Promise<CleanupOutcome> => {
          console.log(`Starting account-wide ${accountWide.label} cleanup...`);
          try {
            const result = await accountWide.run();
            console.log(
              `  removed ${result.otherResources.length} ${accountWide.label}s account-wide`,
            );
            return { result, ranToCompletion: true };
          } catch (error) {
            console.error(
              `  account-wide ${accountWide.label} cleanup failed:`,
              error,
            );
            return {
              result: {
                vmIds: [],
                otherResources: [],
                errors: [
                  {
                    resourceType: accountWide.label,
                    resourceId: 'cleanup-pass',
                    error: String(error),
                  },
                ],
              },
              ranToCompletion: false,
            };
          }
        })(),
        `account-wide ${accountWide.label} cleanup`,
        timeoutMs,
        {
          resourceType: accountWide.label,
          resourceId: 'cleanup-pass',
          error: `${accountWide.label} cleanup timed out after ${minutes(timeoutMs)}m`,
        },
      ).then((outcome) => ({ unit: 'account-wide', ...outcome }))
    : Promise.resolve(null);

  const [unitOutcomes, accountOutcome] = await Promise.all([
    Promise.all(unitPromises),
    accountWidePromise,
  ]);

  const outcomes = accountOutcome
    ? [...unitOutcomes, accountOutcome]
    : unitOutcomes;

  const totalVMs = outcomes.reduce((sum, o) => sum + o.result.vmIds.length, 0);
  const totalOther = outcomes.reduce(
    (sum, o) => sum + o.result.otherResources.length,
    0,
  );
  const allErrors = outcomes.flatMap((o) =>
    o.result.errors.map((error) => ({ unit: o.unit, error })),
  );
  // Only a sweep that enumerated its resources can prove one survived.
  const survivors = outcomes
    .filter((o) => o.ranToCompletion)
    .reduce((sum, o) => sum + o.result.errors.length, 0);

  console.log(
    `\n${cloud} cleanup complete: removed ${totalVMs} VMs, ${totalOther} other resources across ${units.length} ${unitLabel}(s)`,
  );

  if (allErrors.length > 0) {
    console.log(
      `\nWarning: ${allErrors.length} errors occurred during cleanup:`,
    );
    allErrors.forEach(({ unit, error }) => {
      console.log(
        `  - [${unit}] ${error.resourceType} ${error.resourceId}: ${error.error}`,
      );
    });
  }

  process.exit(opts.failOnErrors && survivors > 0 ? 1 : 0);
}
