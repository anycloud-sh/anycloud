/**
 * The credential auth-failure policy: durably mark a stored credential whose
 * secret a provider positively rejects, and alert about it once per cooldown.
 */

import {
  getCredentialSecretStore,
  getNotificationsStore,
} from './persistence.js';
import {
  canClassifyTerminalAuthError,
  CloudCompute,
} from './gateways/cloud.js';
import { sendToNotifiers } from './notify.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import { CloudFailureDiagnosis } from '../../shared/cloud.js';
import { TemporalGate } from '../../shared/utils.js';

/** The durable auth-failed mark this policy sets. */
interface CredentialHealth {
  markCredentialAuthFailed(credentialId: string): Promise<void>;
}

// Alert (at most once per credential per cooldown) that a stored credential is
// failing authentication, so a rotated/expired secret surfaces instead of a
// silent retry loop. Debounced in-memory — a restart may re-alert once, which
// beats adding a table just to dedupe an alert.
const CREDENTIAL_INVALID_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6h
const credentialInvalidAlerts = new TemporalGate<string>();

/** @internal — for testing only */
export function _resetCredentialInvalidAlerts(): void {
  credentialInvalidAlerts.clear();
}

async function maybeNotifyCredentialInvalid(
  credentialId: string,
  cloudProvider: string,
): Promise<void> {
  if (credentialInvalidAlerts.isClosed(credentialId)) return;
  const notifiers = loadNotifiers(await getNotificationsStore().loadConfig());
  if (notifiers.length === 0) return;
  const sent = await sendToNotifiers(
    notifiers,
    `A ${cloudProvider} credential is failing authentication (invalid client secret). ` +
      'Deploys and cleanup using it are paused. Run `anycloud credentials list` to find it, ' +
      're-enter a valid secret, then resubmit affected work.',
  );
  if (sent) {
    credentialInvalidAlerts.closeFor(
      credentialId,
      CREDENTIAL_INVALID_ALERT_COOLDOWN_MS,
    );
  }
}

/**
 * On a *terminal* auth failure, durably mark the credential invalid (persisted +
 * in-process) so cleanup pauses and health reporting can surface it, and alert
 * once.
 *
 * `BadCredential` is a coarse bucket that also holds transient/recoverable auth
 * errors (host clock skew, a stale/expired token). Those must NOT durably strand
 * a valid credential — only a provider that can positively identify a genuinely
 * invalid/expired secret (`isTerminalAuthError`) triggers the durable mark; every
 * other auth failure follows the ordinary retry policy.
 */
export async function markCredentialOnAuthFailure(
  diagnosis: CloudFailureDiagnosis,
  error: unknown,
  compute: CloudCompute,
  credentialId: string,
  cloudProvider: string,
): Promise<void> {
  if (diagnosis !== CloudFailureDiagnosis.BadCredential) return;
  if (
    !canClassifyTerminalAuthError(compute) ||
    !compute.isTerminalAuthError(error)
  ) {
    return;
  }
  const health: CredentialHealth = getCredentialSecretStore();
  await health.markCredentialAuthFailed(credentialId);
  await maybeNotifyCredentialInvalid(credentialId, cloudProvider);
}
