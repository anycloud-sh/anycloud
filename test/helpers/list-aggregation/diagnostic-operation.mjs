import { performance } from 'node:perf_hooks';

/** Observe synchronous operations only in separately declared diagnostic runs. */
export function observeOperation(probe, name, probeId, operation) {
  if (!probe) return operation();
  const startedAtMs = performance.now();
  const cpuBefore = process.cpuUsage();
  try {
    return operation();
  } finally {
    const endedAtMs = performance.now();
    const cpu = process.cpuUsage(cpuBefore);
    probe.write('operation', {
      name,
      probeId,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      cpu,
    });
  }
}

/** Observe the public oRPC serializer once, including its recursive conversion. */
export function observeResponseSerialization(Serializer, current, probe) {
  const original = Serializer.prototype.serialize;
  let observing = false;
  Serializer.prototype.serialize = function (...args) {
    if (observing) return original.apply(this, args);
    const owner = current();
    if (!owner) return original.apply(this, args);
    observing = true;
    try {
      return observeOperation(probe, 'response-serialize', owner.id, () =>
        original.apply(this, args),
      );
    } finally {
      observing = false;
    }
  };
  return () => {
    Serializer.prototype.serialize = original;
  };
}
