import { describe, expect, it } from 'vitest';

import { resolveFirewallPlan } from '../../../src/api/services/firewall-plan.js';

const DENYING = {
  emitsScopeDeny: true,
  splitsSourceRangesByIpFamily: true,
} as const;
const DEFAULT_DENY = {
  emitsScopeDeny: false,
  splitsSourceRangesByIpFamily: true,
} as const;
const UNSPLIT = {
  emitsScopeDeny: false,
  splitsSourceRangesByIpFamily: false,
} as const;

describe('resolveFirewallPlan', () => {
  it('leaves an ordinary workload at provider-default priority', () => {
    expect(
      resolveFirewallPlan(
        {
          ingress: [
            {
              protocol: 'tcp',
              port: 22,
              sourceRanges: ['0.0.0.0/0'],
              description: 'SSH',
            },
          ],
        },
        DENYING,
      ),
    ).toEqual([
      {
        kind: 'allow',
        protocol: 'tcp',
        port: 22,
        priorityClass: 'default',
        nameSuffix: '',
        sourceRanges: ['0.0.0.0/0'],
        description: 'SSH',
      },
    ]);
  });

  // An earlier defect: a denying spec must elevate every public allow above
  // the deny, or the deny (at a stronger priority) silences the allows.
  it('elevates public allows and appends the deny pair when public ingress is denied', () => {
    const plan = resolveFirewallPlan(
      {
        ingress: [
          { protocol: 'tcp', port: 22, sourceRanges: ['203.0.113.0/24'] },
        ],
        denyPublicIngress: true,
      },
      DENYING,
    );

    expect(plan.map((rule) => [rule.kind, rule.priorityClass])).toEqual([
      ['allow', 'scope-allow'],
      ['deny', 'scope-deny'],
      ['deny', 'scope-deny'],
    ]);
    // Another earlier defect: the everywhere-deny must split by address family.
    expect(plan.slice(-2)).toEqual([
      expect.objectContaining({
        nameSuffix: '',
        sourceRanges: ['0.0.0.0/0'],
        port: 'all',
        protocol: 'all',
      }),
      expect.objectContaining({
        nameSuffix: '-ipv6',
        sourceRanges: ['::/0'],
      }),
    ]);
  });

  it('splits mixed-family source ranges into one rule per family', () => {
    expect(
      resolveFirewallPlan(
        {
          ingress: [
            {
              protocol: 'tcp',
              port: 80,
              sourceRanges: ['0.0.0.0/0', '::/0', '198.51.100.0/24'],
            },
          ],
        },
        DENYING,
      ),
    ).toEqual([
      expect.objectContaining({
        nameSuffix: '',
        sourceRanges: ['0.0.0.0/0', '198.51.100.0/24'],
      }),
      expect.objectContaining({ nameSuffix: '-ipv6', sourceRanges: ['::/0'] }),
    ]);
  });

  it('emits no deny pair and no elevation on a default-deny substrate', () => {
    const plan = resolveFirewallPlan(
      {
        ingress: [{ protocol: 'tcp', port: 22, sourceRanges: ['0.0.0.0/0'] }],
        denyPublicIngress: true,
      },
      DEFAULT_DENY,
    );

    expect(plan.filter((rule) => rule.kind === 'deny')).toEqual([]);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.priorityClass).toBe('default');
  });

  it('resolves a deny-only spec to just the deny pair', () => {
    const plan = resolveFirewallPlan(
      { ingress: [], denyPublicIngress: true },
      DENYING,
    );
    expect(plan.map((rule) => [rule.kind, rule.sourceRanges])).toEqual([
      ['deny', ['0.0.0.0/0']],
      ['deny', ['::/0']],
    ]);
  });

  it('resolves an empty spec to no rules at all on a default-deny substrate', () => {
    expect(
      resolveFirewallPlan(
        { ingress: [], denyPublicIngress: true },
        DEFAULT_DENY,
      ),
    ).toEqual([]);
  });

  it('keeps mixed-family ranges in one rule when the provider takes them', () => {
    expect(
      resolveFirewallPlan(
        {
          ingress: [
            {
              protocol: 'tcp',
              port: 80,
              sourceRanges: ['0.0.0.0/0', '::/0', '198.51.100.0/24'],
            },
          ],
        },
        UNSPLIT,
      ),
    ).toEqual([
      expect.objectContaining({
        nameSuffix: '',
        sourceRanges: ['0.0.0.0/0', '::/0', '198.51.100.0/24'],
      }),
    ]);
  });

  it('deduplicates identical public rules before splitting', () => {
    const rule = {
      protocol: 'tcp' as const,
      port: 22,
      sourceRanges: ['0.0.0.0/0'],
    };
    expect(
      resolveFirewallPlan({ ingress: [rule, { ...rule }] }, DENYING),
    ).toHaveLength(1);
  });
});
