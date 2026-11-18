import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORPCError } from '@orpc/client';
import type { KubernetesStep } from '../../shared/api-contract/system-release-schemas.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';

const POLL_MS = 5_000;
/** Past the host-step Job's own 15-minute deadline. */
const STEP_TIMEOUT_MS = 20 * 60_000;
const REFUSALS = ['SYSTEM_RELEASE_REFUSED', 'SYSTEM_RELEASE_UNAVAILABLE'];

/**
 * RFC 0049 C26 (b): the hosted API labels the management Node and brings
 * K3s's server configuration to the release `image` names. Errors other than
 * a refusal are retried until the deadline: the API answers through K3s,
 * which may be restarting. Null when the API already carries the image or
 * predates the step.
 */
export async function runKubernetesStep(
  release: Pick<ApiClient['systemRelease'], 'kubernetes'>,
  image: string,
  report: (message: string) => void,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<KubernetesStep | null> {
  const { pollMs = POLL_MS, timeoutMs = STEP_TIMEOUT_MS } = options;
  const id = randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  let answered = false;
  let lastError = 'no answer yet';
  for (;;) {
    try {
      const { step } = await release.kubernetes({ id, image });
      answered = true;
      if (!step || step.state === 'succeeded') return step;
      if (step.state === 'failed') {
        throw new KubernetesStepFailedError(step);
      }
      if (!reported) {
        report('Reconfiguring K3s on the management host...');
        reported = true;
      }
      if (step.reason) lastError = step.reason;
    } catch (error) {
      if (error instanceof KubernetesStepFailedError) throw error;
      if (error instanceof ORPCError) {
        // An API from before the step has no route for it; once it has
        // answered, a 404 is the edge while K3s restarts.
        if (
          !answered &&
          (error.status === 404 || error.code === 'CLIENT_VERSION_MISMATCH')
        ) {
          return null;
        }
        if (REFUSALS.includes(error.code)) throw error;
      }
      lastError = (error as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The K3s step did not report within ${Math.round(timeoutMs / 60_000)} minutes (last: ${lastError}). The hosted API upgrade was not requested; run anycloud api upgrade again.`,
      );
    }
    await sleep(pollMs);
  }
}

export class KubernetesStepFailedError extends Error {
  constructor(readonly step: KubernetesStep) {
    super(
      `The K3s step failed: ${step.reason ?? 'no reason reported'}. The hosted API upgrade was not requested; "anycloud api status" shows the step, and anycloud api upgrade runs it again.`,
    );
    this.name = 'KubernetesStepFailedError';
  }
}
