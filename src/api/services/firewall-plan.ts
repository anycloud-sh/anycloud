import { uniqueIngressRules } from './network.js';
import type { IngressSpec } from './entities.js';

/**
 * One fully resolved firewall rule: nothing is left for a gateway to decide.
 * Gateways transcribe rules into provider API calls; they do not compose
 * priorities, split address families, or infer scope-deny pairs. Composing
 * those per provider is how one call site omitted the scope priority
 * and its neighbour omitted the IP-family split — each thirty lines
 * from a correct copy of the same logic.
 */
export interface ResolvedFirewallRule {
  readonly kind: 'allow' | 'deny';
  readonly protocol: 'tcp' | 'udp' | 'all';
  readonly port: number | 'all';
  /** Providers with a flat allow space (GCP) map these to concrete priorities;
   * providers whose substrate is default-deny (Azure NSG) may ignore them. */
  readonly priorityClass: 'scope-allow' | 'scope-deny' | 'default';
  /** Distinguishes the per-family rule names (`''` | `'-ipv6'`). */
  readonly nameSuffix: '' | '-ipv6';
  readonly sourceRanges: readonly string[];
  readonly description?: string;
}

export interface ProviderFirewallTraits {
  /**
   * A provider whose substrate admits scope traffic by default-deny (Azure
   * NSG, AWS security groups) needs no explicit deny pair; a flat allow space
   * (GCP VPC) does.
   */
  readonly emitsScopeDeny: boolean;
  /**
   * GCP rejects mixed IPv4/IPv6 source ranges and Azure's single-prefix rule
   * shape cannot carry them, so those providers take one rule per address
   * family. AWS security-group permissions accept either, one range at a
   * time, so splitting would only reorder its calls.
   */
  readonly splitsSourceRangesByIpFamily: boolean;
}

interface SourceRangeGroup {
  readonly nameSuffix: '' | '-ipv6';
  readonly sourceRanges: readonly string[];
}

/**
 * Mixed IPv4/IPv6 source ranges are rejected by GCP and unsupported in one
 * Azure rule shape, so every rule is emitted once per address family present.
 */
function splitSourceRangesByIpFamily(
  sourceRanges: readonly string[],
): SourceRangeGroup[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const sourceRange of sourceRanges) {
    (sourceRange.includes(':') ? ipv6 : ipv4).push(sourceRange);
  }
  const groups: SourceRangeGroup[] = [];
  if (ipv4.length > 0) groups.push({ nameSuffix: '', sourceRanges: ipv4 });
  if (ipv6.length > 0) groups.push({ nameSuffix: '-ipv6', sourceRanges: ipv6 });
  return groups;
}

/** Allow rules always carry a concrete port; only the deny pair uses 'all'. */
export function numericRulePort(port: number | 'all'): number {
  if (port === 'all') {
    throw new Error('allow rules require a concrete port');
  }
  return port;
}

const EVERYWHERE = ['0.0.0.0/0', '::/0'];

/**
 * Compile network intent into the complete rule list for one resource scope:
 * public allows (elevated ahead of the deny when one exists), then the
 * scope-wide deny pair for providers that need one. Order is part of the
 * contract — transcribers create rules in plan order.
 */
export function resolveFirewallPlan(
  spec: IngressSpec,
  traits: ProviderFirewallTraits,
): ResolvedFirewallRule[] {
  const hasScopeDeny = traits.emitsScopeDeny && spec.denyPublicIngress === true;
  const plan: ResolvedFirewallRule[] = [];
  const rangeGroups = (sourceRanges: readonly string[]): SourceRangeGroup[] =>
    traits.splitsSourceRangesByIpFamily
      ? splitSourceRangesByIpFamily(sourceRanges)
      : [{ nameSuffix: '', sourceRanges }];
  for (const rule of uniqueIngressRules(spec)) {
    for (const group of rangeGroups(rule.sourceRanges)) {
      plan.push({
        kind: 'allow',
        protocol: rule.protocol,
        port: rule.port,
        priorityClass: hasScopeDeny ? 'scope-allow' : 'default',
        nameSuffix: group.nameSuffix,
        sourceRanges: group.sourceRanges,
        ...(rule.description === undefined
          ? {}
          : { description: rule.description }),
      });
    }
  }
  if (hasScopeDeny) {
    for (const group of rangeGroups(EVERYWHERE)) {
      plan.push({
        kind: 'deny',
        protocol: 'all',
        port: 'all',
        priorityClass: 'scope-deny',
        nameSuffix: group.nameSuffix,
        sourceRanges: group.sourceRanges,
      });
    }
  }
  return plan;
}
