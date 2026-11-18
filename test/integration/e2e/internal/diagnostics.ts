import path from 'node:path';

import {
  E2E_FIXTURE_RECORD_ARTIFACT,
  E2EFixtureRecordSchema,
  type E2EFixtureRecord,
} from '../../helpers/e2e-fixture-record.js';
import type { ApiClient } from './api.js';
import type { ArtifactStore } from './artifacts.js';
import type { TrackedWorkloadKernel } from './workloads.js';
import type { RemoteExecutor } from './remote.js';
import { errorMessage } from './types.js';

type WorkloadEvidence = E2EFixtureRecord['workloads'][number];
type DiagnosticError = E2EFixtureRecord['diagnosticErrors'][number];

interface CapturedEvidence {
  readonly workloads: WorkloadEvidence[];
  readonly diagnosticErrors: DiagnosticError[];
}

export interface FailureDiagnosticsOptions {
  readonly api: Pick<ApiClient, 'lookupStatus'>;
  readonly artifacts: Pick<ArtifactStore, 'json' | 'text'>;
  readonly kernel: Pick<TrackedWorkloadKernel, 'trackedWorkloadIds'>;
  readonly remote: Pick<RemoteExecutor, 'run'>;
  readonly runId: string;
  readonly testName: string;
}

function safeWorkloadId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`Unsafe diagnostic workload ID: ${value}`);
  }
  return value;
}

function dockerDiagnosticCommand(workloadId: string): string {
  return [
    "printf '%s\\n' '=== Docker container state ==='",
    `docker ps -a --no-trunc --format '{{.ID}}\\t{{.Image}}\\t{{.Status}}\\t{{.Names}}'`,
    `printf '%s\\n' '=== docker inspect ${workloadId} ==='`,
    `docker inspect --format '{{json .State}}' '${workloadId}'`,
    `printf '%s\\n' '=== docker logs --tail 200 ${workloadId} ==='`,
    `docker logs --tail 200 '${workloadId}'`,
  ].join('; ');
}

export class FailureDiagnostics {
  readonly #api: FailureDiagnosticsOptions['api'];
  readonly #artifacts: FailureDiagnosticsOptions['artifacts'];
  readonly #kernel: FailureDiagnosticsOptions['kernel'];
  readonly #remote: FailureDiagnosticsOptions['remote'];
  readonly #runId: string;
  readonly #testName: string;

  constructor(options: FailureDiagnosticsOptions) {
    this.#api = options.api;
    this.#artifacts = options.artifacts;
    this.#kernel = options.kernel;
    this.#remote = options.remote;
    this.#runId = options.runId;
    this.#testName = options.testName;
  }

  // Written on every finalized lifecycle so that a failed run without a record
  // is distinguishable from a run whose fixture captured nothing.
  async capture(primaryErrors: readonly unknown[]): Promise<void> {
    const failures = primaryErrors.map(errorMessage);
    const evidence =
      failures.length > 0
        ? await this.#captureWorkloads()
        : { workloads: [], diagnosticErrors: [] };

    const record = E2EFixtureRecordSchema.parse({
      version: 1,
      testName: this.#testName,
      runId: this.#runId,
      outcome: failures.length > 0 ? 'failed' : 'passed',
      failures,
      workloads: evidence.workloads,
      diagnosticErrors: evidence.diagnosticErrors,
    });
    await this.#artifacts.json(E2E_FIXTURE_RECORD_ARTIFACT, record);
  }

  async #captureWorkloads(): Promise<CapturedEvidence> {
    const workloads: WorkloadEvidence[] = [];
    const diagnosticErrors: DiagnosticError[] = [];

    for (const id of this.#kernel.trackedWorkloadIds()) {
      const artifacts: string[] = [];
      let status: WorkloadEvidence['status'] = 'error';

      try {
        const lookup = await this.#api.lookupStatus(id, true);
        status = lookup.kind === 'absent' ? 'absent' : 'found';
        if (lookup.kind === 'found') {
          artifacts.push(
            path.basename(
              await this.#artifacts.json(
                `diagnostic-status-${id}`,
                lookup.status,
              ),
            ),
          );
        }
      } catch (error) {
        diagnosticErrors.push({
          workloadId: id,
          operation: 'verbose status',
          error: errorMessage(error),
        });
      }

      // A confirmed-absent workload has no host left to inspect.
      if (status !== 'absent') {
        try {
          const workloadId = safeWorkloadId(id);
          const result = await this.#remote.run(
            workloadId,
            'vm',
            dockerDiagnosticCommand(workloadId),
            { timeoutMs: 90_000 },
          );
          artifacts.push(
            path.basename(
              await this.#artifacts.text(
                `diagnostic-docker-${id}`,
                result.combined,
              ),
            ),
          );
        } catch (error) {
          diagnosticErrors.push({
            workloadId: id,
            operation: 'remote Docker diagnostics',
            error: errorMessage(error),
          });
        }
      }

      workloads.push({ id, status, artifacts });
    }

    return { workloads, diagnosticErrors };
  }
}
