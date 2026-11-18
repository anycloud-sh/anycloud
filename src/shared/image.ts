/** GHCR checks only the token, so every pull logs in under this name. */
export const GHCR_TOKEN_USERNAME = 'x-access-token';

export enum ImageVerdict {
  Ok = 'ok',
  NoAmd64 = 'no_amd64',
  NotFound = 'not_found',
  Unauthorized = 'unauthorized',
  Unknown = 'unknown',
}

export enum ImageInspectionFailureReason {
  GhcrTokenExchangeFailed = 'ghcr_token_exchange_failed',
  /** GHCR refused an anonymous pull and the caller sent no GitHub sign-in. */
  GhcrSignInRequired = 'ghcr_sign_in_required',
}

export enum ImageRuntime {
  Cuda = 'cuda',
  Rocm = 'rocm',
  Unknown = 'unknown',
}

/** Structured pull telemetry persisted on the Downloading workload event, or
 * for a Job on a Deployment its replica's pull (`kubelet`) on its claim event. */
export interface ImagePullTelemetry {
  schemaVersion: 1;
  method: 'containerd-transfer' | 'docker' | 'docker-fallback' | 'kubelet';
  outcome: 'succeeded' | 'failed';
  elapsedMs: number;
  reason?: string;
  containerdVersion?: string;
  snapshotter?: string;
  /** Bytes the VM's network interfaces received while the final pull command
   * ran; the timings below are from the same samples. */
  bytesFetched?: number;
  /** From the command's start to its last byte (99.5% of `bytesFetched`). */
  timeToLastByteMs?: number;
  /** From the last byte to the command's exit: the unpack that outlasted the
   * download. Unpacking that overlapped the download is not in it. */
  unpackTailMs?: number;
  /** kubelet found the image already on the Node and pulled nothing. */
  alreadyPresent?: boolean;
}

function isOptionalCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

export function isImagePullTelemetry(
  value: unknown,
): value is ImagePullTelemetry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const telemetry = value as Record<string, unknown>;
  return (
    telemetry.schemaVersion === 1 &&
    (telemetry.method === 'containerd-transfer' ||
      telemetry.method === 'docker' ||
      telemetry.method === 'docker-fallback' ||
      telemetry.method === 'kubelet') &&
    (telemetry.outcome === 'succeeded' || telemetry.outcome === 'failed') &&
    typeof telemetry.elapsedMs === 'number' &&
    Number.isFinite(telemetry.elapsedMs) &&
    telemetry.elapsedMs >= 0 &&
    (telemetry.reason === undefined || typeof telemetry.reason === 'string') &&
    (telemetry.containerdVersion === undefined ||
      typeof telemetry.containerdVersion === 'string') &&
    (telemetry.snapshotter === undefined ||
      typeof telemetry.snapshotter === 'string') &&
    isOptionalCount(telemetry.bytesFetched) &&
    isOptionalCount(telemetry.timeToLastByteMs) &&
    isOptionalCount(telemetry.unpackTailMs) &&
    (telemetry.alreadyPresent === undefined ||
      typeof telemetry.alreadyPresent === 'boolean')
  );
}

export function imagePullTelemetryFromError(
  error: unknown,
): ImagePullTelemetry | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const telemetry = (error as { imagePull?: unknown }).imagePull;
  return isImagePullTelemetry(telemetry) ? telemetry : undefined;
}
