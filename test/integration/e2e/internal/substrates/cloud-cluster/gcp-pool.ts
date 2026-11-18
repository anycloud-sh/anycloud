import { FirewallsClient, InstancesClient } from '@google-cloud/compute';

import { sanitizeGCPLabel } from '../../../../../../src/api/services/gateways/gcp.js';
import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';

interface GcpNamed {
  readonly name?: string | null;
}

/** The Compute calls the inventory makes, in the shape the SDK clients satisfy. */
export interface GcpComputeClients {
  readonly instances: {
    aggregatedListAsync(request: {
      readonly project: string;
      readonly filter?: string;
      readonly returnPartialSuccess?: boolean;
    }): AsyncIterable<
      readonly [
        string,
        {
          readonly instances?:
            | readonly (GcpNamed & { readonly zone?: string | null })[]
            | null;
        },
      ]
    >;
  };
  readonly firewalls: {
    listAsync(request: {
      readonly project: string;
    }): AsyncIterable<
      GcpNamed & { readonly targetTags?: readonly string[] | null }
    >;
  };
}

/**
 * A GCP management VM's inventory: its instance is labelled
 * `anycloud_resource=<scope>` and its firewall rules carry the scope as their
 * target tag (`gateways/gcp.ts`). Compute SDK reads as in
 * `ci/cleanup/gcp.ts`; no kubeconfig, no installer.
 */
export class GcpPoolInventory {
  readonly #project: string;
  readonly #clients: GcpComputeClients;

  constructor(credential: CloudCredential, clients?: GcpComputeClients) {
    if (credential.cloudProvider !== CloudType.GCP) {
      throw new Error('A GCP node pool needs a GCP credential');
    }
    this.#project = credential.projectId;
    const options = {
      projectId: credential.projectId,
      credentials: {
        private_key: credential.privateKey,
        client_email: credential.clientEmail,
      },
    };
    this.#clients = clients ?? {
      instances: new InstancesClient(options),
      firewalls: new FirewallsClient(options),
    };
  }

  async #instances(scope: string) {
    const found = [];
    for await (const [, list] of this.#clients.instances.aggregatedListAsync({
      project: this.#project,
      filter: `labels.anycloud_resource=${sanitizeGCPLabel(scope)} AND status!=TERMINATED`,
      returnPartialSuccess: true,
    })) {
      found.push(...(list.instances ?? []));
    }
    return found;
  }

  /** Live instances of the pool, as `<zone>/<name>`. */
  async liveInstances(scope: string): Promise<string[]> {
    return (await this.#instances(scope)).flatMap((instance) =>
      instance.name
        ? [`${instance.zone?.split('/').pop() ?? '?'}/${instance.name}`]
        : [],
    );
  }

  /** Firewall rules the product created for the pool. */
  async networkLeftovers(scope: string): Promise<string[]> {
    const found: string[] = [];
    for await (const firewall of this.#clients.firewalls.listAsync({
      project: this.#project,
    })) {
      if (firewall.name && firewall.targetTags?.includes(scope)) {
        found.push(`firewall/${firewall.name}`);
      }
    }
    return found;
  }
}
