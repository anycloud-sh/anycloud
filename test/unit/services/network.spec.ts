import { describe, expect, it } from 'vitest';
import {
  SERVICE_CONTAINER_PORT,
  SERVICE_PUBLIC_PORT,
  SSH_PORT,
  buildJobIngressSpec,
  buildServeIngressSpec,
  hasHttpIngress,
  hasNonSshIngress,
  isSharedJobIngress,
  resolveServiceContainerPort,
  uniqueIngressRules,
} from '../../../src/api/services/network';
import { CLOUDFLARE_IP_RANGES } from '../../../src/shared/cloudflare-ips';

describe('ingress specs', () => {
  it('builds job networking with SSH limited to the caller whitelist', () => {
    expect(buildJobIngressSpec(['10.0.0.0/8'])).toEqual({
      ingress: [
        {
          protocol: 'tcp',
          port: SSH_PORT,
          sourceRanges: ['10.0.0.0/8'],
          description: 'SSH',
        },
      ],
    });
  });

  it('shares only public SSH', () => {
    expect(isSharedJobIngress(buildJobIngressSpec())).toBe(true);
    // A VM Job's spec asks for the Jobs network and still shares SSH.
    expect(buildJobIngressSpec()).not.toHaveProperty('jobNetwork');
    expect(buildJobIngressSpec([], true).jobNetwork).toBe(true);
    expect(isSharedJobIngress(buildJobIngressSpec([], true))).toBe(true);
    expect(isSharedJobIngress(buildJobIngressSpec(['10.0.0.0/8']))).toBe(false);
    expect(isSharedJobIngress(buildServeIngressSpec())).toBe(false);
    expect(
      isSharedJobIngress({ ...buildJobIngressSpec(), denyPublicIngress: true }),
    ).toBe(false);
  });

  it('builds serve networking with whitelisted SSH and Cloudflare HTTP', () => {
    const spec = buildServeIngressSpec(['10.0.0.0/8']);

    expect(spec.ingress).toEqual([
      {
        protocol: 'tcp',
        port: SSH_PORT,
        sourceRanges: ['10.0.0.0/8'],
        description: 'SSH',
      },
      {
        protocol: 'tcp',
        port: SERVICE_PUBLIC_PORT,
        sourceRanges: [...CLOUDFLARE_IP_RANGES],
        description: 'HTTP',
      },
    ]);
    expect(hasNonSshIngress(spec)).toBe(true);
    expect(hasHttpIngress(spec)).toBe(true);
  });

  it('deduplicates ingress by protocol, port, and source range', () => {
    const spec = {
      ingress: [
        ...buildServeIngressSpec().ingress,
        ...buildServeIngressSpec().ingress,
      ],
    };

    expect(uniqueIngressRules(spec).map((rule) => rule.port)).toEqual([
      SSH_PORT,
      SERVICE_PUBLIC_PORT,
    ]);
  });

  it('resolves the default serve container port', () => {
    expect(resolveServiceContainerPort(undefined)).toBe(SERVICE_CONTAINER_PORT);
    expect(resolveServiceContainerPort(null)).toBe(SERVICE_CONTAINER_PORT);
    expect(resolveServiceContainerPort({})).toBe(SERVICE_CONTAINER_PORT);
  });

  it('resolves a custom serve container port from env', () => {
    expect(resolveServiceContainerPort({ PORT: '9000' })).toBe(9000);
  });

  it('rejects invalid serve container ports', () => {
    for (const PORT of ['0', '65536', '3.14', 'not-a-port', '']) {
      expect(() => resolveServiceContainerPort({ PORT })).toThrow(
        'PORT must be an integer between 1 and 65535 for service workloads',
      );
    }
  });
});
