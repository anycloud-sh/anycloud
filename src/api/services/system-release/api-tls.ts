import forge from 'node-forge';
import {
  API_TLS_CA_SECRET,
  API_TLS_SECRET,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../../shared/system-release.js';

/**
 * Origin TLS for the hosted API: Traefik serves the installation's
 * Cloudflare Origin CA certificate on 443. The key is generated here, on the
 * installation side, and goes only into the cluster Secret; the DNS Worker
 * sees the CSR. The chart's TLS IngressRoute names this Secret.
 */

type CertificationRequest = forge.pki.Certificate & {
  setAttributes(attributes: unknown[]): void;
};

/** A fresh RSA key and a CSR naming exactly the hostname (Origin CA's `origin-rsa`). */
export function apiTlsKeyAndCsr(hostname: string): {
  key: string;
  csr: string;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  // @types/node-forge types a CSR as a Certificate, without setAttributes.
  const request =
    forge.pki.createCertificationRequest() as CertificationRequest;
  request.publicKey = keys.publicKey;
  request.setSubject([{ name: 'commonName', value: hostname }]);
  request.setAttributes([
    {
      name: 'extensionRequest',
      extensions: [
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      ],
    },
  ]);
  request.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    csr: forge.pki.certificationRequestToPem(request),
  };
}

/**
 * The served certificate and its key, plus anycloud's origin pull CA when the
 * Worker hands one out: then Traefik's default TLS option (this Traefik only
 * serves the API) requires Cloudflare's client certificate, so another zone
 * pointed at the VM no longer reaches the API. Without a CA, both go: a stale
 * one would demand a client certificate Cloudflare no longer sends.
 */
export function apiTlsObjects(input: {
  key: string;
  certificate: string;
  originPullCa: string | null;
}) {
  const metadata = (name: string) => ({
    name,
    namespace: SYSTEM_RELEASE_NAMESPACE,
  });
  const caSecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: metadata(API_TLS_CA_SECRET),
  };
  const option = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'TLSOption',
    metadata: metadata('default'),
  };
  const served = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: metadata(API_TLS_SECRET),
    type: 'kubernetes.io/tls',
    stringData: { 'tls.key': input.key, 'tls.crt': input.certificate },
  };
  if (!input.originPullCa)
    return { apply: [served], remove: [option, caSecret] };
  return {
    apply: [
      served,
      { ...caSecret, stringData: { 'ca.crt': input.originPullCa } },
      {
        ...option,
        spec: {
          minVersion: 'VersionTLS12',
          clientAuth: {
            secretNames: [API_TLS_CA_SECRET],
            clientAuthType: 'RequireAndVerifyClientCert',
          },
        },
      },
    ],
    remove: [],
  };
}

/**
 * On the management VM: the certificate Traefik serves on 443 for the
 * hostname, as PEM. The handshake may then fail for want of a client
 * certificate; the server's certificate has been printed by then.
 */
export function apiTlsProbeCommand(hostname: string): string {
  return `echo | openssl s_client -connect 127.0.0.1:443 -servername ${hostname} 2>/dev/null | openssl x509`;
}

export function samePem(a: string, b: string): boolean {
  const body = (pem: string) => pem.replace(/\s+/g, '');
  return body(a) === body(b);
}
