import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { SYSTEM_RELEASE_NAMESPACE } from '../../../shared/system-release.js';
import { withRetry } from '../../../shared/utils.js';
import { log } from '../logger.js';
import { kubernetesRequestOptions } from './request-options.js';

/** The API Pod's ServiceAccount (charts/anycloud-api/templates/rbac.yaml). */
const API_SERVICE_ACCOUNT = 'anycloud-api';

/** The `sub` of the API's tokens, which every role connection trusts. */
export const API_SERVICE_ACCOUNT_SUBJECT = `system:serviceaccount:${SYSTEM_RELEASE_NAMESPACE}:${API_SERVICE_ACCOUNT}`;

/**
 * A ServiceAccount with no other use or permission, whose token every role
 * connection's trust must refuse (RFC 0047 § Save-time check).
 */
export const TRUST_PROBE_SERVICE_ACCOUNT = 'anycloud-trust-probe';

// Kubernetes' shortest lifetime: each cloud reads the token once, at the
// exchange, and a session outlives it.
const TOKEN_SECONDS = 600;

// A K3s server restart, such as a signing-key rotation, refuses or resets
// connections to the API server until it listens again, usually within a
// minute. Waits of 1, 2, 4, then 8 s across 18 attempts ride out about two
// minutes of that, so a Job's admission or storage setup doesn't fail on it
// and spend a retry, and a lasting outage still fails well inside the
// 15-minute provisioning step. A TokenRequest stores nothing, so repeating
// one is safe; any other failure is thrown at once.
const API_SERVER_RESTART_RETRY = {
  maxAttempts: 18,
  waitMs: 1_000,
  maxWaitMs: 8_000,
  jitter: false,
  shouldRetry: (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET';
  },
} as const;

/**
 * Tokens for one of the API's ServiceAccounts, each bound to one audience
 * (TokenRequest), which role connections exchange for cloud sessions.
 */
export function createApiServiceAccountTokens(
  kubeConfig: KubeConfig,
  serviceAccount = API_SERVICE_ACCOUNT,
): (audience: string, signal?: AbortSignal) => Promise<string> {
  const core = kubeConfig.makeApiClient(CoreV1Api);
  return async (audience, signal) => {
    const { status } = await withRetry(
      () =>
        core.createNamespacedServiceAccountToken(
          {
            name: serviceAccount,
            namespace: SYSTEM_RELEASE_NAMESPACE,
            body: {
              spec: { audiences: [audience], expirationSeconds: TOKEN_SECONDS },
            },
          },
          kubernetesRequestOptions(signal),
        ),
      `TokenRequest for ${serviceAccount}`,
      {
        ...API_SERVER_RESTART_RETRY,
        signal,
        onRetry: (attempt, maxAttempts, error, waitMs) =>
          log.warn('Kubernetes API server unreachable for a TokenRequest', {
            serviceAccount,
            code: (error as { code?: unknown } | null)?.code,
            attempt,
            maxAttempts,
            waitMs,
          }),
      },
    );
    if (!status?.token)
      throw new Error('Kubernetes returned a TokenRequest without a token');
    return status.token;
  };
}

/** This API's own tokens; only a self-hosted API runs in a cluster. */
export function apiServiceAccountToken(
  audience: string,
  signal?: AbortSignal,
): Promise<string> {
  return inClusterTokens(API_SERVICE_ACCOUNT)(audience, signal);
}

/** Tokens for the trust probe, from the API's own cluster. */
export function trustProbeServiceAccountToken(
  audience: string,
  signal?: AbortSignal,
): Promise<string> {
  return inClusterTokens(TRUST_PROBE_SERVICE_ACCOUNT)(audience, signal);
}

function inClusterTokens(serviceAccount: string) {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();
  return createApiServiceAccountTokens(kubeConfig, serviceAccount);
}
