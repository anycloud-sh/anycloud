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
            | readonly (GcpNamed & {
                readonly zone?: string | null;
                readonly creationTimestamp?: string | null;
              })[]
            | null;
        },
      ]
    >;
    delete(request: {
      readonly project: string;
      readonly zone: string;
      readonly instance: string;
    }): Promise<unknown>;
    get(request: {
      readonly project: string;
      readonly zone: string;
      readonly instance: string;
    }): Promise<
      readonly [
        {
          readonly scheduling?: {
            readonly provisioningModel?: string | null;
            readonly instanceTerminationAction?: string | null;
          } | null;
        },
        ...unknown[],
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
 * The GCP side of a cross-cloud run: the cluster stays on AWS; the node pool's
 * VMs are GCP instances labelled `anycloud_resource=<pool id>` and its
 * firewall rules carry the pool id as their target tag (`gateways/gcp.ts`).
 * Compute SDK reads as in `ci/cleanup/gcp.ts`; no kubeconfig, no installer.
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

  async #instances(nodePoolId: string) {
    const found = [];
    for await (const [, list] of this.#clients.instances.aggregatedListAsync({
      project: this.#project,
      filter: `labels.anycloud_resource=${sanitizeGCPLabel(nodePoolId)} AND status!=TERMINATED`,
      returnPartialSuccess: true,
    })) {
      found.push(...(list.instances ?? []));
    }
    return found;
  }

  /** Live instances of the pool, as `<zone>/<name>`. */
  async liveInstances(nodePoolId: string): Promise<string[]> {
    return (await this.#instances(nodePoolId)).flatMap((instance) =>
      instance.name
        ? [`${instance.zone?.split('/').pop() ?? '?'}/${instance.name}`]
        : [],
    );
  }

  /** Launch times (epoch ms) of the pool's live instances. */
  async instanceLaunches(nodePoolId: string): Promise<number[]> {
    return (await this.#instances(nodePoolId)).flatMap((instance) =>
      instance.creationTimestamp
        ? [Date.parse(instance.creationTimestamp)]
        : [],
    );
  }

  /** Firewall rules the product created for the pool. */
  async networkLeftovers(nodePoolId: string): Promise<string[]> {
    const found: string[] = [];
    for await (const firewall of this.#clients.firewalls.listAsync({
      project: this.#project,
    })) {
      if (firewall.name && firewall.targetTags?.includes(nodePoolId)) {
        found.push(`firewall/${firewall.name}`);
      }
    }
    return found;
  }

  /** A `<zone>/<name>` spot instance's preemption action; null when not spot. */
  async spotEviction(instance: string): Promise<string | null> {
    const [zone, name] = instance.split('/');
    const [found] = await this.#clients.instances.get({
      project: this.#project,
      zone: String(zone),
      instance: String(name),
    });
    return found.scheduling?.provisioningModel === 'SPOT'
      ? (found.scheduling.instanceTerminationAction ?? null)
      : null;
  }

  /** Terminate one `<zone>/<name>` instance natively; the controller must observe the loss. */
  async terminateInstance(instance: string): Promise<void> {
    const [zone, name] = instance.split('/');
    if (!zone || !name) {
      throw new Error(`GCP instance ${instance} is not <zone>/<name>`);
    }
    await this.#clients.instances.delete({
      project: this.#project,
      zone,
      instance: name,
    });
  }
}
