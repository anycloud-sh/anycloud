const TERMINAL_WORKLOAD_STATES = new Set([
  'completed',
  'failed',
  'errored',
  'invalid',
  'terminated',
]);

const RETRYABLE_STATUS_CODES = new Set([
  400, 404, 409, 429, 500, 502, 503, 504,
]);

export class WorkloadStatusHttpError extends Error {
  constructor(status, message) {
    super(`Workload status returned HTTP ${status}: ${message}`);
    this.name = 'WorkloadStatusHttpError';
    this.status = status;
    this.retryable = RETRYABLE_STATUS_CODES.has(status);
  }
}

export class TerminalWorkloadWithoutMarkerError extends Error {
  constructor(workloadId, state) {
    super(
      `Workload ${workloadId} reached terminal state "${state}" before the expected first-inference marker`,
    );
    this.name = 'TerminalWorkloadWithoutMarkerError';
    this.state = state;
  }
}

export function isTerminalWorkloadState(state) {
  return typeof state === 'string' && TERMINAL_WORKLOAD_STATES.has(state);
}

export async function requireWorkloadStillActive({
  apiUrl,
  workloadId,
  accessToken,
  version,
  fetchImpl = globalThis.fetch,
  signal = undefined,
}) {
  const response = await fetchImpl(
    `${apiUrl}/v1/workloads/${encodeURIComponent(workloadId)}`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'AnyCloud-Client-Version': version,
      },
      signal,
    },
  );

  if (!response.ok) {
    const message = String(await response.text())
      .replace(/\s+/g, ' ')
      .slice(0, 240);
    throw new WorkloadStatusHttpError(response.status, message);
  }

  const payload = await response.json();
  const state = payload?.workload?.state;
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('Workload status response is missing workload.state');
  }
  if (isTerminalWorkloadState(state)) {
    throw new TerminalWorkloadWithoutMarkerError(workloadId, state);
  }
  return state;
}
