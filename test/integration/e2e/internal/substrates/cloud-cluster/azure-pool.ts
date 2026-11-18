import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ClientSecretCredential } from '@azure/identity';

import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';

interface AzureTagged {
  readonly name?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

type AzureList<T = AzureTagged> = (resourceGroup: string) => AsyncIterable<T>;

/** The ARM calls the inventory makes, as plain functions of the resource group. */
export interface AzurePoolClients {
  readonly vms: AzureList<
    AzureTagged & { readonly provisioningState?: string }
  >;
  readonly disks: AzureList;
  readonly nics: AzureList;
  readonly publicIps: AzureList;
  readonly nsgs: AzureList;
  readonly vnets: AzureList;
}

/**
 * An Azure management VM's inventory: its VM and networking live in the
 * product's shared regional resource group `anycloud-<region>`, tagged
 * `anycloud_resource=<scope>` (`gateways/azure.ts`). Only tagged resources
 * are read; the group is shared.
 */
export class AzurePoolInventory {
  readonly #resourceGroup: string;
  readonly #clients: AzurePoolClients;

  constructor(
    credential: CloudCredential,
    region: string,
    clients?: AzurePoolClients,
  ) {
    if (credential.cloudProvider !== CloudType.Azure) {
      throw new Error('An Azure node pool needs an Azure credential');
    }
    this.#resourceGroup = `anycloud-${region}`;
    if (clients) {
      this.#clients = clients;
    } else {
      const identity = new ClientSecretCredential(
        credential.directoryId,
        credential.applicationId,
        credential.secret,
      );
      const compute = new ComputeManagementClient(
        identity,
        credential.subscriptionId,
      );
      const network = new NetworkManagementClient(
        identity,
        credential.subscriptionId,
      );
      this.#clients = {
        vms: (group) => compute.virtualMachines.list(group),
        disks: (group) => compute.disks.listByResourceGroup(group),
        nics: (group) => network.networkInterfaces.list(group),
        publicIps: (group) => network.publicIPAddresses.list(group),
        nsgs: (group) => network.networkSecurityGroups.list(group),
        vnets: (group) => network.virtualNetworks.list(group),
      };
    }
  }

  async #tagged<T extends AzureTagged>(
    list: AzureList<T>,
    scope: string,
  ): Promise<T[]> {
    const found: T[] = [];
    try {
      for await (const resource of list(this.#resourceGroup)) {
        if (resource.name && resource.tags?.anycloud_resource === scope)
          found.push(resource);
      }
    } catch (error) {
      // No regional group yet: nothing of the pool exists.
      if ((error as { code?: string }).code !== 'ResourceGroupNotFound')
        throw error;
    }
    return found;
  }

  /** VM names of the pool, without the ones already being deleted. */
  async liveInstances(scope: string): Promise<string[]> {
    return (await this.#tagged(this.#clients.vms, scope))
      .filter((vm) => vm.provisioningState !== 'Deleting')
      .map((vm) => String(vm.name));
  }

  /** Disks and networking the product tagged for the pool, as `<kind>/<name>`. */
  async networkLeftovers(scope: string): Promise<string[]> {
    const c = this.#clients;
    const kinds = [
      ['disk', c.disks],
      ['nic', c.nics],
      ['public-ip', c.publicIps],
      ['nsg', c.nsgs],
      ['vnet', c.vnets],
    ] as const;
    const found: string[] = [];
    for (const [kind, list] of kinds) {
      for (const resource of await this.#tagged(list, scope))
        found.push(`${kind}/${String(resource.name)}`);
    }
    return found;
  }
}
