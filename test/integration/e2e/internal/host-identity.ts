import { createHash } from 'node:crypto';
import net from 'node:net';

import type { ArtifactStore } from './artifacts.js';
import type { ProcessRunner } from './process.js';
import { isRecord, type CommandResult } from './types.js';
import type { Waiter } from './wait.js';

const CAPTURE_TIMEOUT_MS = 30_000;
const KEYSCAN_TIMEOUT_SECONDS = 3;
const KEYSCAN_PROCESS_TIMEOUT_MS = 5_000;
const TCP_PROBE_TIMEOUT_MS = 1_500;
const SNAPSHOT_VERSION = 1 as const;

const fingerprintPattern =
  /^(?:ecdsa-|sk-|ssh-)[A-Za-z0-9@._+-]+ SHA256:[A-Za-z0-9+/]+$/u;
const keyTypePattern = /^(?:ecdsa-|sk-|ssh-)[A-Za-z0-9@._+-]+$/u;

export interface SshHostEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface CapturedSshHostIdentity {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly endpoint: SshHostEndpoint;
  readonly fingerprints: readonly string[];
  readonly capturedAt: number;
}

export type SshHostEndpointObservation =
  | {
      readonly kind: 'fingerprints';
      readonly fingerprints: readonly string[];
    }
  | {
      readonly kind: 'unreachable';
      readonly reason:
        | 'connection-refused'
        | 'connection-reset'
        | 'connection-timeout'
        | 'host-unreachable';
    }
  | {
      readonly kind: 'inconclusive';
      readonly reason:
        | 'network-error'
        | 'ssh-handshake-empty'
        | 'ssh-handshake-malformed'
        | 'ssh-handshake-timeout';
      readonly detail?: string;
    };

export type SshHostIdentityObservation =
  | {
      readonly kind: 'same';
      readonly fingerprints: readonly string[];
      readonly observedAt: number;
    }
  | {
      readonly kind: 'different';
      readonly fingerprints: readonly string[];
      readonly observedAt: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly reason: Extract<
        SshHostEndpointObservation,
        { kind: 'unreachable' }
      >['reason'];
      readonly observedAt: number;
    }
  | {
      readonly kind: 'inconclusive';
      readonly reason: Extract<
        SshHostEndpointObservation,
        { kind: 'inconclusive' }
      >['reason'];
      readonly detail?: string;
      readonly observedAt: number;
    };

export interface SshHostIdentityTransport {
  observe(endpoint: SshHostEndpoint): Promise<SshHostEndpointObservation>;
}

export interface HostIdentityCapability {
  capture(
    label: string,
    endpoint: SshHostEndpoint,
  ): Promise<CapturedSshHostIdentity>;
  observe(
    captured: CapturedSshHostIdentity,
  ): Promise<SshHostIdentityObservation>;
}

export type SshKeyscanParseResult =
  | {
      readonly kind: 'fingerprints';
      readonly fingerprints: readonly string[];
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed'; readonly line: string };

type TcpObservation =
  | { readonly kind: 'open' }
  | Extract<
      SshHostEndpointObservation,
      { kind: 'unreachable' | 'inconclusive' }
    >;

function isFingerprintArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (candidate): candidate is string =>
        typeof candidate === 'string' && fingerprintPattern.test(candidate),
    )
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validatedEndpoint(endpoint: SshHostEndpoint): SshHostEndpoint {
  const { host, port } = endpoint;
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 255 ||
    host !== host.trim() ||
    host.startsWith('-') ||
    [...host].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    throw new Error('SSH host identity requires a valid host');
  }
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      'SSH host identity requires a TCP port from 1 through 65535',
    );
  }
  return { host, port };
}

function decodedBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 === 1) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) return undefined;
  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  return canonical === value.replace(/=+$/u, '') ? decoded : undefined;
}

function fingerprint(keyType: string, encodedKey: string): string | undefined {
  if (!keyTypePattern.test(keyType)) return undefined;
  const decoded = decodedBase64(encodedKey);
  if (!decoded) return undefined;
  const digest = createHash('sha256')
    .update(decoded)
    .digest('base64')
    .replace(/=+$/u, '');
  return `${keyType} SHA256:${digest}`;
}

export function parseSshKeyscanOutput(output: string): SshKeyscanParseResult {
  const fingerprints = new Set<string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 3) return { kind: 'malformed', line };
    const normalized = fingerprint(fields[1], fields[2]);
    if (!normalized) return { kind: 'malformed', line };
    fingerprints.add(normalized);
  }
  if (fingerprints.size === 0) return { kind: 'empty' };
  return {
    kind: 'fingerprints',
    fingerprints: [...fingerprints].sort(),
  };
}

export function parseCapturedSshHostIdentity(
  value: unknown,
): CapturedSshHostIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['capturedAt', 'endpoint', 'fingerprints', 'version']) ||
    value.version !== SNAPSHOT_VERSION ||
    !isRecord(value.endpoint) ||
    !exactKeys(value.endpoint, ['host', 'port']) ||
    typeof value.endpoint.host !== 'string' ||
    typeof value.endpoint.port !== 'number' ||
    !isFingerprintArray(value.fingerprints) ||
    !Number.isSafeInteger(value.capturedAt) ||
    (value.capturedAt as number) < 0
  ) {
    throw new Error('SSH host identity snapshot is malformed or unsupported');
  }
  const endpoint = validatedEndpoint({
    host: value.endpoint.host,
    port: value.endpoint.port,
  });
  const originalFingerprints = value.fingerprints;
  const fingerprints = [...new Set(originalFingerprints)].sort();
  if (
    fingerprints.length !== originalFingerprints.length ||
    fingerprints.some(
      (candidate, index) => candidate !== originalFingerprints[index],
    )
  ) {
    throw new Error('SSH host identity fingerprints must be unique and sorted');
  }
  return {
    version: SNAPSHOT_VERSION,
    endpoint,
    fingerprints,
    capturedAt: value.capturedAt as number,
  };
}

function networkErrorDetail(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}: ${error.message}` : error.message;
}

async function observeTcpEndpoint(
  endpoint: SshHostEndpoint,
): Promise<TcpObservation> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (observation: TcpObservation): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(observation);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish({ kind: 'open' }));
    socket.once('timeout', () =>
      finish({ kind: 'unreachable', reason: 'connection-timeout' }),
    );
    socket.once('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        finish({ kind: 'unreachable', reason: 'connection-refused' });
      } else if (code === 'ECONNRESET') {
        finish({ kind: 'unreachable', reason: 'connection-reset' });
      } else if (code === 'EHOSTUNREACH') {
        finish({ kind: 'unreachable', reason: 'host-unreachable' });
      } else if (code === 'ETIMEDOUT') {
        finish({ kind: 'unreachable', reason: 'connection-timeout' });
      } else {
        finish({
          kind: 'inconclusive',
          reason: 'network-error',
          detail: networkErrorDetail(error),
        });
      }
    });
  });
}

function commandFailure(result: CommandResult): string {
  return [
    result.spawnError,
    result.signal ? `signal ${result.signal}` : undefined,
    result.exitCode === null ? undefined : `exit ${String(result.exitCode)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

export class OpenSshHostIdentityTransport implements SshHostIdentityTransport {
  readonly #runner: Pick<ProcessRunner, 'run'>;

  constructor(runner: Pick<ProcessRunner, 'run'>) {
    this.#runner = runner;
  }

  async observe(
    unvalidatedEndpoint: SshHostEndpoint,
  ): Promise<SshHostEndpointObservation> {
    const endpoint = validatedEndpoint(unvalidatedEndpoint);
    const tcp = await observeTcpEndpoint(endpoint);
    if (tcp.kind !== 'open') return tcp;

    const result = await this.#runner.run(
      'ssh-keyscan',
      [
        '-T',
        String(KEYSCAN_TIMEOUT_SECONDS),
        '-p',
        String(endpoint.port),
        endpoint.host,
      ],
      {
        label: 'ssh-host-keyscan',
        recordArtifact: false,
        timeoutMs: KEYSCAN_PROCESS_TIMEOUT_MS,
      },
    );
    if (result.spawnError) {
      throw new Error(`Could not execute ssh-keyscan: ${result.spawnError}`);
    }
    if (result.timedOut || result.aborted) {
      return { kind: 'inconclusive', reason: 'ssh-handshake-timeout' };
    }
    if (result.outputTruncated) {
      return {
        kind: 'inconclusive',
        reason: 'ssh-handshake-malformed',
        detail: 'ssh-keyscan output was truncated',
      };
    }

    const parsed = parseSshKeyscanOutput(result.stdout);
    if (parsed.kind === 'fingerprints') return parsed;
    if (parsed.kind === 'malformed') {
      return {
        kind: 'inconclusive',
        reason: 'ssh-handshake-malformed',
        detail: parsed.line,
      };
    }
    return {
      kind: 'inconclusive',
      reason: 'ssh-handshake-empty',
      detail: commandFailure(result) || undefined,
    };
  }
}

export function classifySshHostIdentity(
  captured: CapturedSshHostIdentity,
  current: SshHostEndpointObservation,
  observedAt: number,
): SshHostIdentityObservation {
  const snapshot = parseCapturedSshHostIdentity(captured);
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error('SSH host identity observation time is invalid');
  }
  if (current.kind === 'unreachable') {
    return { ...current, observedAt };
  }
  if (current.kind === 'inconclusive') {
    return { ...current, observedAt };
  }
  if (!isFingerprintArray(current.fingerprints)) {
    return {
      kind: 'inconclusive',
      reason: 'ssh-handshake-malformed',
      detail: 'transport returned invalid SSH host-key fingerprints',
      observedAt,
    };
  }
  const currentFingerprints = [...new Set(current.fingerprints)].sort();
  const original = new Set(snapshot.fingerprints);
  const same = currentFingerprints.some((candidate) => original.has(candidate));
  return {
    kind: same ? 'same' : 'different',
    fingerprints: currentFingerprints,
    observedAt,
  };
}

function describeEndpointObservation(
  observation: SshHostEndpointObservation,
): string {
  if (observation.kind === 'fingerprints') {
    return `${String(observation.fingerprints.length)} host-key fingerprint(s)`;
  }
  return observation.kind === 'inconclusive' && observation.detail
    ? `${observation.kind}: ${observation.reason} (${observation.detail})`
    : `${observation.kind}: ${observation.reason}`;
}

export class HostIdentityHarness implements HostIdentityCapability {
  readonly #transport: SshHostIdentityTransport;
  readonly #wait: Pick<Waiter, 'for'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #now: () => number;

  constructor(
    transport: SshHostIdentityTransport,
    wait: Pick<Waiter, 'for'>,
    artifacts: Pick<ArtifactStore, 'json'>,
    now: () => number = Date.now,
  ) {
    this.#transport = transport;
    this.#wait = wait;
    this.#artifacts = artifacts;
    this.#now = now;
  }

  async capture(
    label: string,
    unvalidatedEndpoint: SshHostEndpoint,
  ): Promise<CapturedSshHostIdentity> {
    const endpoint = validatedEndpoint(unvalidatedEndpoint);
    const observation = await this.#wait.for(
      `SSH host identity capture for ${label}`,
      () => this.#transport.observe(endpoint),
      {
        timeoutMs: CAPTURE_TIMEOUT_MS,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (candidate) =>
          candidate.kind === 'fingerprints'
            ? undefined
            : describeEndpointObservation(candidate),
      },
    );
    if (observation.kind !== 'fingerprints') {
      throw new Error(
        'SSH host identity capture completed without fingerprints',
      );
    }
    const snapshot: CapturedSshHostIdentity = {
      version: SNAPSHOT_VERSION,
      endpoint,
      fingerprints: [...observation.fingerprints].sort(),
      capturedAt: this.#now(),
    };
    const validated = parseCapturedSshHostIdentity(snapshot);
    await this.#artifacts.json(`${label}-ssh-host-identity`, validated);
    return validated;
  }

  async observe(
    captured: CapturedSshHostIdentity,
  ): Promise<SshHostIdentityObservation> {
    const snapshot = parseCapturedSshHostIdentity(captured);
    return classifySshHostIdentity(
      snapshot,
      await this.#transport.observe(snapshot.endpoint),
      this.#now(),
    );
  }
}
