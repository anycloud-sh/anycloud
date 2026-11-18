import assert from 'node:assert/strict';

// Keep the nominal phase offset: subtracting absolute floating-point clocks can
// move an exact recovery-window boundary to the wrong side of the cutoff.
export function scheduledArrival(phaseStart, index, rate) {
  const phaseElapsedMs = (index * 1000) / rate;
  return { due: phaseStart + phaseElapsedMs, phaseElapsedMs };
}

export function arrivalDisposition({
  now,
  due,
  maximumLagMs,
  inFlight,
  maximumInFlight,
}) {
  if (now - due > maximumLagMs) return 'scheduling-skipped';
  if (inFlight >= maximumInFlight) return 'admission-skipped';
  return 'admitted';
}

export function deadlineMiss(record, timeoutMs) {
  return record.outcome === 'timeout' || (record.elapsedMs ?? 0) > timeoutMs;
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarizeRequests(records, timeoutMs) {
  const count = (outcome) =>
    records.filter((record) => record.outcome === outcome).length;
  const skipped = count('scheduling-skipped') + count('admission-skipped');
  const admitted = records.filter(
    (record) => !record.outcome.endsWith('-skipped'),
  );
  const successful = admitted.filter((record) => record.outcome === 'success');
  const unfinished = admitted.filter(
    (record) => record.outcome === 'unfinished',
  ).length;
  assert.equal(records.length, skipped + admitted.length);
  assert.equal(
    admitted.length,
    successful.length +
      count('timeout') +
      count('http-error') +
      count('transport-error') +
      count('body-limit') +
      unfinished,
  );
  return {
    offered: records.length,
    admitted: admitted.length,
    completed: successful.length,
    timedOut: count('timeout'),
    deadlineMisses: admitted.filter((record) => deadlineMiss(record, timeoutMs))
      .length,
    httpErrors: count('http-error'),
    transportErrors: count('transport-error'),
    bodyLimits: count('body-limit'),
    schedulingSkipped: count('scheduling-skipped'),
    admissionSkipped: count('admission-skipped'),
    unfinished,
    p50Ms: percentile(
      successful.map((record) => record.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      successful.map((record) => record.elapsedMs),
      0.95,
    ),
    p99Ms: percentile(
      successful.map((record) => record.elapsedMs),
      0.99,
    ),
    maxMs: successful.length
      ? Math.max(...successful.map((record) => record.elapsedMs))
      : null,
    responseBytes: successful.reduce((sum, record) => sum + record.bytes, 0),
    maxOfferDelayMs: records.length
      ? Math.max(...records.map((record) => record.offerDelayMs))
      : null,
  };
}
