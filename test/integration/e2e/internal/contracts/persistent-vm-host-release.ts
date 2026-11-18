import type { ArtifactStore } from '../artifacts.js';
import type {
  CapturedSshHostIdentity,
  HostIdentityCapability,
  SshHostIdentityObservation,
} from '../host-identity.js';
import type { Waiter } from '../wait.js';
import { errorMessage } from '../types.js';

const REQUIRED_UNREACHABLE_OBSERVATIONS = 2;

interface ReleaseAttempt {
  readonly observation: SshHostIdentityObservation;
  readonly consecutiveUnreachable: number;
}

export interface SshHostReleaseEvidence {
  readonly version: 1;
  readonly endpoint: CapturedSshHostIdentity['endpoint'];
  readonly originalFingerprints: readonly string[];
  readonly outcome: 'endpoint-unreachable' | 'identity-changed';
  readonly observation: SshHostIdentityObservation;
}

export interface PersistentVmHostReleaseDependencies {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly hostIdentity: HostIdentityCapability;
  readonly wait: Pick<Waiter, 'for'>;
}

function describeReleaseAttempt(attempt: ReleaseAttempt): string {
  const { observation } = attempt;
  if (observation.kind === 'same' || observation.kind === 'different') {
    return `${observation.kind} SSH host identity`;
  }
  if (observation.kind === 'unreachable') {
    return `${observation.reason} (${String(attempt.consecutiveUnreachable)}/${String(REQUIRED_UNREACHABLE_OBSERVATIONS)} stable observations)`;
  }
  return observation.detail
    ? `${observation.reason}: ${observation.detail}`
    : observation.reason;
}

function releasePollInterval(timeoutMs: number): number {
  return Math.min(5_000, Math.max(1, Math.floor(timeoutMs / 10)));
}

export async function waitForPersistentVmHostRelease(
  dependencies: PersistentVmHostReleaseDependencies,
  label: string,
  captured: CapturedSshHostIdentity,
  timeoutMs: number,
): Promise<SshHostReleaseEvidence> {
  const timeline: SshHostIdentityObservation[] = [];
  let consecutiveUnreachable = 0;
  try {
    const accepted = await dependencies.wait.for(
      `original SSH host release for ${label}`,
      async (): Promise<ReleaseAttempt> => {
        const observation = await dependencies.hostIdentity.observe(captured);
        timeline.push(observation);
        consecutiveUnreachable =
          observation.kind === 'unreachable' ? consecutiveUnreachable + 1 : 0;
        return { observation, consecutiveUnreachable };
      },
      {
        timeoutMs,
        intervalMs: releasePollInterval(timeoutMs),
        probeError: 'fail',
        unmet: (attempt) =>
          attempt.observation.kind === 'different' ||
          (attempt.observation.kind === 'unreachable' &&
            attempt.consecutiveUnreachable >= REQUIRED_UNREACHABLE_OBSERVATIONS)
            ? undefined
            : describeReleaseAttempt(attempt),
      },
    );
    const evidence: SshHostReleaseEvidence = {
      version: 1,
      endpoint: captured.endpoint,
      originalFingerprints: captured.fingerprints,
      outcome:
        accepted.observation.kind === 'different'
          ? 'identity-changed'
          : 'endpoint-unreachable',
      observation: accepted.observation,
    };
    await dependencies.artifacts.json(`${label}-ssh-host-release`, {
      ...evidence,
      timeline,
    });
    return evidence;
  } catch (error) {
    await dependencies.artifacts.json(`${label}-ssh-host-release`, {
      version: 1,
      endpoint: captured.endpoint,
      originalFingerprints: captured.fingerprints,
      outcome: 'not-observed',
      error: errorMessage(error),
      timeline,
    });
    throw error;
  }
}
