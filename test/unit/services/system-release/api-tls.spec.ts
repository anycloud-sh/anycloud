import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import {
  apiTlsKeyAndCsr,
  apiTlsObjects,
  apiTlsProbeCommand,
  samePem,
} from '../../../../src/api/services/system-release/api-tls.js';
import {
  API_TLS_CA_SECRET,
  API_TLS_SECRET,
} from '../../../../src/shared/system-release.js';
import { csrSubjectAltNames } from '../../../../worker/src/api-tls.js';

const HOST = 'api-1-abcd.anycloud.sh';

describe('API origin TLS material', () => {
  it('requests exactly the hostname with the key it keeps, as the DNS Worker checks', () => {
    const { key, csr } = apiTlsKeyAndCsr(HOST);
    expect(csrSubjectAltNames(csr)).toEqual([HOST]);
    const publicKey = forge.pki.certificationRequestFromPem(csr)
      .publicKey as forge.pki.rsa.PublicKey;
    expect(publicKey.n.bitLength()).toBe(2048);
    expect(
      (forge.pki.privateKeyFromPem(key) as forge.pki.rsa.PrivateKey).n.equals(
        publicKey.n,
      ),
    ).toBe(true);
  });

  it('writes only the certificate Secret, and removes any origin pull CA, until origin pulls are configured', () => {
    expect(
      apiTlsObjects({ key: 'K', certificate: 'C', originPullCa: null }),
    ).toEqual({
      apply: [
        {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: API_TLS_SECRET, namespace: 'anycloud-system' },
          type: 'kubernetes.io/tls',
          stringData: { 'tls.key': 'K', 'tls.crt': 'C' },
        },
      ],
      // The option first: it must never name a missing CA.
      remove: [
        {
          apiVersion: 'traefik.io/v1alpha1',
          kind: 'TLSOption',
          metadata: { name: 'default', namespace: 'anycloud-system' },
        },
        {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: API_TLS_CA_SECRET, namespace: 'anycloud-system' },
        },
      ],
    });
  });

  it("requires Cloudflare's client certificate once the Worker hands out the CA", () => {
    const { apply, remove } = apiTlsObjects({
      key: 'K',
      certificate: 'C',
      originPullCa: 'CA',
    });
    expect(remove).toEqual([]);
    expect(apply.map((object) => object.metadata.name)).toEqual([
      API_TLS_SECRET,
      API_TLS_CA_SECRET,
      'default',
    ]);
    expect(apply[0]).toMatchObject({
      stringData: { 'tls.key': 'K', 'tls.crt': 'C' },
    });
    expect(apply[1]).toMatchObject({ stringData: { 'ca.crt': 'CA' } });
    expect(apply[2]).toMatchObject({
      kind: 'TLSOption',
      spec: {
        minVersion: 'VersionTLS12',
        clientAuth: {
          secretNames: [API_TLS_CA_SECRET],
          clientAuthType: 'RequireAndVerifyClientCert',
        },
      },
    });
  });

  it('probes the certificate served for the hostname on the VM', () => {
    expect(apiTlsProbeCommand(HOST)).toContain(
      `-connect 127.0.0.1:443 -servername ${HOST}`,
    );
    expect(samePem('-----A-----\nabc\ndef\n', '-----A-----\r\nabcdef')).toBe(
      true,
    );
    expect(samePem('-----A-----\nabc', '-----A-----\nabd')).toBe(false);
  });
});
