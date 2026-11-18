import type { CommonClientOptions } from '@azure/core-client';
import type { PipelinePolicy } from '@azure/core-rest-pipeline';

// ARM requests carry no default timeout, so a stalled connection holds its
// promise tree (and everything it closes over) in memory indefinitely. This
// is a hang backstop per HTTP attempt, not a latency control; caller-level
// timeouts stay in charge of user-facing timing, and the SDK retry policy
// still retries failed attempts.
const ARM_REQUEST_TIMEOUT_MS = 60_000;

const requestTimeoutPolicy: PipelinePolicy = {
  name: 'anycloudArmRequestTimeout',
  sendRequest: (request, next) => {
    if (!request.timeout) {
      request.timeout = ARM_REQUEST_TIMEOUT_MS;
    }
    return next(request);
  },
};

/**
 * Options for ARM management clients (`@azure/arm-*`): every request gets a
 * timeout so no Azure read can hang forever. Pass as (or spread into) the
 * trailing options argument of the client constructor.
 */
export function armClientOptions(): CommonClientOptions {
  return {
    additionalPolicies: [{ policy: requestTimeoutPolicy, position: 'perCall' }],
  };
}
