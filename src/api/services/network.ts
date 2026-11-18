import type { IngressRule, IngressSpec } from './entities.js';
import { type CloudType } from '../../shared/cloud.js';
import { CLOUDFLARE_IP_RANGES } from '../../shared/cloudflare-ips.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';

export const SSH_PORT = 22;
export const SERVICE_PUBLIC_PORT = 80;
export const SERVICE_CONTAINER_PORT = 8088;

// Shared message for the "this cloud can't take public HTTP ingress" rejection,
// raised both at validation time (InvalidAnycloudConfigError) and as a runtime
// gateway guard (DeployError). Kept in one place so the wording can't drift.
export function ingressUnsupportedMessage(provider: CloudType): string {
  return `${provider} does not support service workloads with public HTTP ingress`;
}

const PUBLIC_SOURCE_RANGES = ['0.0.0.0/0'];

export function resolveServiceContainerPort(
  env: Record<string, string> | null | undefined,
): number {
  const raw = env?.PORT;
  if (raw === undefined) return SERVICE_CONTAINER_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidAnycloudConfigError(
      'PORT must be an integer between 1 and 65535 for service workloads',
    );
  }

  return port;
}

export function buildJobIngressSpec(
  ipWhitelist: string[] = [],
  refusesNetworkPeers = false,
): IngressSpec {
  return {
    ...(refusesNetworkPeers && { refusesNetworkPeers }),
    ingress: [
      {
        protocol: 'tcp',
        port: SSH_PORT,
        sourceRanges:
          ipWhitelist.length > 0 ? ipWhitelist : PUBLIC_SOURCE_RANGES,
        description: 'SSH',
      },
    ],
  };
}

export function buildServeIngressSpec(ipWhitelist: string[] = []): IngressSpec {
  return {
    ingress: [
      ...buildJobIngressSpec(ipWhitelist).ingress,
      {
        protocol: 'tcp',
        port: SERVICE_PUBLIC_PORT,
        sourceRanges: [...CLOUDFLARE_IP_RANGES],
        description: 'HTTP',
      },
    ],
  };
}

/**
 * Public SSH and nothing else: the default Job and VM spec, which every such
 * workload shares, so GCP and Azure give it one standing rule set per network
 * instead of one per workload.
 */
export function isSharedJobIngress(spec: IngressSpec): boolean {
  const [rule, ...rest] = spec.ingress;
  return (
    rest.length === 0 &&
    rule?.protocol === 'tcp' &&
    rule.port === SSH_PORT &&
    rule.sourceRanges.length === PUBLIC_SOURCE_RANGES.length &&
    rule.sourceRanges.every((range, i) => range === PUBLIC_SOURCE_RANGES[i]) &&
    !spec.denyPublicIngress
  );
}

export function hasNonSshIngress(spec: IngressSpec): boolean {
  return spec.ingress.some(
    (rule) => rule.protocol !== 'tcp' || rule.port !== SSH_PORT,
  );
}

export function hasHttpIngress(spec: IngressSpec): boolean {
  return spec.ingress.some(
    (rule) => rule.protocol === 'tcp' && rule.port === SERVICE_PUBLIC_PORT,
  );
}

export function uniqueIngressRules(spec: IngressSpec): IngressRule[] {
  const seen = new Set<string>();
  return spec.ingress.filter((rule) => {
    const key = `${rule.protocol}:${rule.port}:${rule.sourceRanges.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
