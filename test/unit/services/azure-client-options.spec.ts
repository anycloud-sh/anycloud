import { describe, it, expect, vi } from 'vitest';
import {
  createPipelineRequest,
  createHttpHeaders,
  type PipelineResponse,
  type SendRequest,
} from '@azure/core-rest-pipeline';
import { armClientOptions } from '../../../src/api/services/azure-client-options';

function timeoutPolicyConfig() {
  const { additionalPolicies } = armClientOptions();
  if (!additionalPolicies || additionalPolicies.length !== 1) {
    throw new Error('expected exactly one additional policy');
  }
  return additionalPolicies[0];
}

function makeNext(): SendRequest {
  return vi.fn(
    async (request): Promise<PipelineResponse> => ({
      request,
      status: 200,
      headers: createHttpHeaders(),
    }),
  );
}

describe('armClientOptions', () => {
  it('registers the timeout policy per call', () => {
    const config = timeoutPolicyConfig();
    expect(config.position).toBe('perCall');
    expect(config.policy.name).toBe('anycloudArmRequestTimeout');
  });

  it('applies a timeout to requests that have none', async () => {
    const request = createPipelineRequest({ url: 'https://example.com' });
    expect(request.timeout).toBe(0);

    await timeoutPolicyConfig().policy.sendRequest(request, makeNext());

    expect(request.timeout).toBe(60_000);
  });

  it('preserves an explicit request timeout', async () => {
    const request = createPipelineRequest({
      url: 'https://example.com',
      timeout: 1234,
    });

    await timeoutPolicyConfig().policy.sendRequest(request, makeNext());

    expect(request.timeout).toBe(1234);
  });
});
