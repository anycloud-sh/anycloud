import type { PublicCloudServeProfile } from '../targets/serve-types.js';
import { publicServeUrl } from '../targets/serve-types.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import { gpuServeCommand } from './serve-workload.js';
import { serveInvariant, type ReadyServe } from './serve.js';

export interface GpuServeEvidence {
  readonly ref: TrackedWorkloadRef;
  readonly url: string;
  readonly devices: readonly string[];
}

/** A named extension over the same live Service that proved the baseline. */
export function qualifyReadyGpuServe(
  service: ReadyServe,
  profile: PublicCloudServeProfile,
): GpuServeEvidence {
  const observation = service.readyObservation;
  const stored = service.readyStatus.workload;
  serveInvariant(profile.gpus === 'all', 'GPU Service omitted --gpus all');
  serveInvariant(
    service.submission.image === 'python:3.12-slim' &&
      JSON.stringify(service.submission.command) ===
        JSON.stringify(gpuServeCommand()),
    'GPU Service must enumerate devices successfully before starting its server',
  );
  serveInvariant(
    stored.image === service.submission.image &&
      JSON.stringify(stored.command) ===
        JSON.stringify(service.submission.command) &&
      stored.dockerOptions?.gpus === 'all' &&
      (profile.runtime === undefined ||
        stored.dockerOptions.runtime === profile.runtime),
    'GPU Service did not persist its selected image, command, or GPU runtime',
  );
  serveInvariant(
    observation.kind === 'public-cloud' &&
      observation.provider === profile.provider &&
      observation.statusCode === 200 &&
      observation.url === publicServeUrl(service.ref.id),
    'GPU Service evidence came from another public endpoint or provider',
  );
  const devices = observation.responseBody
    .split(/\r?\n/u)
    .filter((line) => /^GPU \d+: \S.+/u.test(line));
  serveInvariant(
    devices.length > 0,
    'GPU Service HTTPS response omitted nvidia-smi -L device evidence',
  );
  return Object.freeze({
    ref: service.ref,
    url: observation.url,
    devices: Object.freeze(devices),
  });
}
