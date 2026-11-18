import type { GcpComputeErrorPersona } from '../credentials-onboarding/personas.js';
import {
  respondJson,
  respondUnhandled,
  startHttpFake,
  type FakeCloudServer,
} from './support.js';

/**
 * Fake GCP compute endpoint. Runs behind GCP_API_ENDPOINT plus a non-default
 * GOOGLE_CLOUD_UNIVERSE_DOMAIN, so the client authenticates with self-signed
 * bearer tokens and never contacts a token service. Serves only the
 * instances listing that deploy-time validation issues, replaying the
 * persona for its pinned method and path; a request without a bearer token
 * or against any other path fails loudly.
 */
function selfSignedTokenIssuer(authorization: string | undefined): string {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  if (!payload) return '';
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const issuer =
      claims !== null && typeof claims === 'object' && 'iss' in claims
        ? claims.iss
        : undefined;
    return typeof issuer === 'string' ? issuer : '';
  } catch {
    return '';
  }
}

export function startFakeGcpCompute(options: {
  reject: GcpComputeErrorPersona;
  /** Service account whose self-signed tokens the fake accepts. */
  clientEmail: string;
}): Promise<FakeCloudServer> {
  const persona = options.reject;
  return startHttpFake((request, response, url) => {
    if (
      request.method === persona.method &&
      url.pathname.endsWith(persona.pathSuffix)
    ) {
      const issuer = selfSignedTokenIssuer(request.headers.authorization);
      if (issuer !== options.clientEmail) {
        respondUnhandled(
          response,
          `GCP token issued by unexpected account ${issuer || '(none)'}`,
        );
        return;
      }
      respondJson(response, persona.httpStatus, persona.body);
      return;
    }
    respondUnhandled(response, `GCP ${request.method} ${url.pathname}`);
  });
}
