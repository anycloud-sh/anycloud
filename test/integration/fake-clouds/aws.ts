import type { AWSStsPersona } from '../credentials-onboarding/personas.js';
import {
  readRequestBody,
  respondUnhandled,
  respondXml,
  startHttpFake,
  type FakeCloudServer,
} from './support.js';

function signingAccessKeyId(authorization: string | undefined): string | null {
  return authorization?.match(/Credential=([^/]+)\//)?.[1] ?? null;
}

/**
 * Fake STS query endpoint. Serves only GetCallerIdentity — the deploy-time
 * credential validation call — replaying the rejection persona for the key
 * it pins. Any other key or action fails loudly.
 */
export function startFakeSts(persona: AWSStsPersona): Promise<FakeCloudServer> {
  return startHttpFake(async (request, response, _url, calls) => {
    const body = await readRequestBody(request);
    const action = new URLSearchParams(body).get('Action');
    calls[calls.length - 1] = `${request.method} Action=${action ?? ''}`;
    const signer = signingAccessKeyId(request.headers.authorization);
    if (signer !== persona.accessKeyId) {
      respondUnhandled(response, `STS signed by unexpected key ${signer}`);
      return;
    }
    if (request.method !== 'POST' || action !== persona.action) {
      respondUnhandled(response, `STS ${request.method} Action=${action}`);
      return;
    }
    respondXml(
      response,
      persona.httpStatus,
      `<?xml version="1.0" encoding="UTF-8"?>\n<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${persona.errorCode}</Code><Message>${persona.errorMessage}</Message></Error><RequestId>lifecycle-fake-sts</RequestId></ErrorResponse>`,
    );
  });
}

/**
 * Fake S3 endpoint for the green bucket-listing journey. The SDK selects
 * path-style addressing automatically for IP-literal endpoints, so every
 * request lands on this one server. Serves ListBuckets only.
 */
export function startFakeS3(options: {
  bucketName: string;
  /** The only access key the fake accepts requests signed with. */
  accessKeyId: string;
}): Promise<FakeCloudServer> {
  return startHttpFake((request, response, url) => {
    const signer = signingAccessKeyId(request.headers.authorization);
    if (signer !== options.accessKeyId) {
      respondUnhandled(response, `S3 signed by unexpected key ${signer}`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      respondXml(
        response,
        200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>lifecycle-fake</ID><DisplayName>lifecycle-fake</DisplayName></Owner><Buckets><Bucket><Name>${options.bucketName}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`,
      );
      return;
    }
    respondUnhandled(response, `S3 ${request.method} ${url.pathname}`);
  });
}
