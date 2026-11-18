import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';

const API = 'https://cloud.lambda.ai/api/v1';

interface LambdaInstance {
  readonly id: string;
  readonly status: string;
  readonly tags?: readonly { key: string; value: string }[];
}

/**
 * The Lambda side of a cross-cloud run: the cluster stays on AWS; the node
 * pool's VMs are Lambda instances tagged `anycloud:resource=<pool id>` and its
 * firewall ruleset is named `anycloud-<pool id>` (`gateways/lambda.ts`). Reads
 * Lambda's public API directly, never the product gateway.
 */
export class LambdaPoolInventory {
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(credential: CloudCredential, fetcher: typeof fetch = fetch) {
    if (credential.cloudProvider !== CloudType.Lambda) {
      throw new Error('A Lambda node pool needs a Lambda credential');
    }
    this.#authorization = `Basic ${Buffer.from(`${credential.apiKey}:`).toString('base64')}`;
    this.#fetch = fetcher;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: this.#authorization,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Lambda ${method} ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Instance ids of the pool that Lambda has not yet reported terminated. */
  async liveInstances(nodePoolId: string): Promise<string[]> {
    const found: string[] = [];
    let token: string | null | undefined;
    do {
      const page = await this.#request<{
        data: LambdaInstance[];
        page_token?: string | null;
      }>(
        'GET',
        token
          ? `/instances?page_token=${encodeURIComponent(token)}`
          : '/instances',
      );
      for (const instance of page.data) {
        if (
          instance.status !== 'terminated' &&
          instance.tags?.some(
            (tag) =>
              tag.key === 'anycloud:resource' && tag.value === nodePoolId,
          )
        ) {
          found.push(instance.id);
        }
      }
      token = page.page_token;
    } while (token);
    return found;
  }

  /** Firewall rulesets the product created for the pool, in any region. */
  async networkLeftovers(nodePoolId: string): Promise<string[]> {
    const { data } = await this.#request<{
      data: { id: string; name: string }[];
    }>('GET', '/firewall-rulesets');
    return data
      .filter((ruleset) => ruleset.name === `anycloud-${nodePoolId}`)
      .map((ruleset) => `ruleset/${ruleset.id}`);
  }

  /** Terminate one instance natively; the controller must observe the loss. */
  async terminateInstance(instanceId: string): Promise<void> {
    await this.#request('POST', '/instance-operations/terminate', {
      instance_ids: [instanceId],
    });
  }
}
