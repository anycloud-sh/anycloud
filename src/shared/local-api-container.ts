import { spawnSync } from 'child_process';

export const LOCAL_API_CONTAINER_NAME = 'anycloud-api';
export const LOCAL_API_CONTAINER_PORT = 8080;
export const LOCAL_API_VERSION_LABEL = 'sh.anycloud.version';
export const LOCAL_API_INSPECT_TIMEOUT_MS = 2000;
/**
 * `api start` exit code for a container still running but not yet healthy:
 * the timeout code of `anycloud wait`, as nothing failed and it keeps going.
 */
export const LOCAL_API_STILL_STARTING_EXIT_CODE = 4;

const LOCAL_API_INSPECT_FORMAT =
  '{{json .State.Running}}\t{{json .NetworkSettings.Ports}}';

type LocalApiContainerInspectionFailure =
  | 'missing'
  | 'unavailable'
  | 'timeout'
  | 'malformed';

/**
 * One snapshot of the local API container state and mapped host port.
 *
 * `running` deliberately remains independent from `hostPort`: Docker can
 * report a running container whose port mapping is absent or malformed. CLI
 * preflight should still recognize that the container exists, while URL
 * resolution falls back to the conventional localhost port.
 */
export interface LocalApiContainerInspection {
  running: boolean;
  hostPort: number | null;
  failure?: LocalApiContainerInspectionFailure;
}

function parseHostPort(raw: string): number | null {
  const port = Number(raw.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function localApiUrlForPort(port: number): string {
  return `http://localhost:${port}`;
}

function failedInspection(
  failure: LocalApiContainerInspectionFailure,
): LocalApiContainerInspection {
  return { running: false, hostPort: null, failure };
}

function inspectTimedOut(result: {
  error?: Error;
  signal?: NodeJS.Signals | null;
}): boolean {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ETIMEDOUT';
}

function dockerUnavailable(stderr: string): boolean {
  return /cannot connect to (the )?docker daemon|error during connect|is the docker daemon running|permission denied/i.test(
    stderr,
  );
}

function parseInspectionOutput(raw: string): LocalApiContainerInspection {
  const separator = raw.indexOf('\t');
  if (separator === -1) return failedInspection('malformed');

  let running: unknown;
  let ports: unknown;
  try {
    running = JSON.parse(raw.slice(0, separator));
    ports = JSON.parse(raw.slice(separator + 1).trim());
  } catch {
    return failedInspection('malformed');
  }

  if (typeof running !== 'boolean') return failedInspection('malformed');
  if (ports === null || ports === undefined) {
    return { running, hostPort: null };
  }
  if (typeof ports !== 'object' || Array.isArray(ports)) {
    return { running, hostPort: null, failure: 'malformed' };
  }

  const bindings = (ports as Record<string, unknown>)[
    `${LOCAL_API_CONTAINER_PORT}/tcp`
  ];
  if (bindings === null || bindings === undefined) {
    return { running, hostPort: null };
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return Array.isArray(bindings)
      ? { running, hostPort: null }
      : { running, hostPort: null, failure: 'malformed' };
  }

  const first = bindings[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return { running, hostPort: null, failure: 'malformed' };
  }
  const rawPort = (first as Record<string, unknown>).HostPort;
  if (typeof rawPort !== 'string') {
    return { running, hostPort: null, failure: 'malformed' };
  }
  const hostPort = parseHostPort(rawPort);
  return hostPort === null
    ? { running, hostPort: null, failure: 'malformed' }
    : { running, hostPort };
}

/** Inspect running state and mapped port with one bounded Docker subprocess. */
export function inspectLocalApiContainer(): LocalApiContainerInspection {
  const result = spawnSync(
    'docker',
    ['inspect', '--format', LOCAL_API_INSPECT_FORMAT, LOCAL_API_CONTAINER_NAME],
    { encoding: 'utf-8', timeout: LOCAL_API_INSPECT_TIMEOUT_MS },
  );
  if (inspectTimedOut(result)) return failedInspection('timeout');
  if (result.error) return failedInspection('unavailable');
  if (result.status !== 0) {
    return failedInspection(
      dockerUnavailable(String(result.stderr ?? ''))
        ? 'unavailable'
        : 'missing',
    );
  }
  if (typeof result.stdout !== 'string') return failedInspection('malformed');
  return parseInspectionOutput(result.stdout.trim());
}

export function isLocalApiContainerRunning(): boolean {
  return inspectLocalApiContainer().running;
}

export function getLocalApiContainerHostPort(): number | null {
  return inspectLocalApiContainer().hostPort;
}

export function getLocalApiContainerVersion(): string | null {
  const result = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      `{{index .Config.Labels "${LOCAL_API_VERSION_LABEL}"}}`,
      LOCAL_API_CONTAINER_NAME,
    ],
    { encoding: 'utf-8', timeout: 5000 },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}
