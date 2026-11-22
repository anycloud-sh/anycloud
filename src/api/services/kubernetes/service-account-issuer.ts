import { KubeConfig, OpenidApi, WellKnownApi } from '@kubernetes/client-node';

/**
 * Where a hosted API serves its cluster's ServiceAccount issuer, at the
 * paths Kubernetes itself uses, so the K3s issuer is the API's public URL
 * (RFC 0047 § Issuer prerequisite, RFC 0049 C26 (e)).
 */
export const SERVICE_ACCOUNT_ISSUER_DISCOVERY_PATH =
  '/.well-known/openid-configuration';

export interface ServiceAccountIssuerDocuments {
  discovery(): Promise<unknown>;
  jwks(): Promise<unknown>;
}

/**
 * Read from the cluster on every request, so a rotated signing key is served
 * as soon as K3s signs with it. The default
 * `system:service-account-issuer-discovery` binding lets any ServiceAccount
 * read both. The generated client parses each JSON body.
 */
export function createServiceAccountIssuerDocuments(
  kubeConfig: KubeConfig,
): ServiceAccountIssuerDocuments {
  const wellKnown = kubeConfig.makeApiClient(WellKnownApi);
  const openid = kubeConfig.makeApiClient(OpenidApi);
  return {
    discovery: () => wellKnown.getServiceAccountIssuerOpenIDConfiguration(),
    jwks: () => openid.getServiceAccountIssuerOpenIDKeyset(),
  };
}

/** This API's own cluster; only a hosted API runs in one. */
export function inClusterServiceAccountIssuerDocuments(): ServiceAccountIssuerDocuments {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();
  return createServiceAccountIssuerDocuments(kubeConfig);
}
