import type { LambdaApiErrorPersona } from '../credentials-onboarding/personas.js';
import {
  respondJson,
  respondUnhandled,
  startHttpFake,
  type FakeCloudServer,
} from './support.js';

/**
 * Fake Lambda cloud API. Serves only the ssh-keys listing that deploy-time
 * validation issues, replaying the persona for its pinned method and path.
 */
export function startFakeLambda(options: {
  reject: LambdaApiErrorPersona;
}): Promise<FakeCloudServer> {
  const persona = options.reject;
  const expectedAuthorization = `Basic ${Buffer.from(`${persona.apiKey}:`).toString('base64')}`;
  return startHttpFake((request, response, url) => {
    if (request.headers.authorization !== expectedAuthorization) {
      respondUnhandled(response, 'Lambda request without the pinned API key');
      return;
    }
    if (request.method === persona.method && url.pathname === persona.path) {
      respondJson(response, persona.httpStatus, persona.body);
      return;
    }
    respondUnhandled(response, `Lambda ${request.method} ${url.pathname}`);
  });
}
