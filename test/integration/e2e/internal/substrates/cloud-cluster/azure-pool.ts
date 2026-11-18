import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ClientSecretCredential } from '@azure/identity';

import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';

interface AzureTagged {
  readonly name?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

/** Bounds the native VM delete that stands in for host loss. */
const VM_DELETE_TIMEOUT_MS = 10 * 60_000;

type AzureList<T = AzureTagged> = (resourceGroup: string) => AsyncIterable<T>;

/** The ARM calls the inventory makes, as plain functions of the resource group. */
export interface AzurePoolClients {
  readonly vms: AzureList<
    AzureTagged & {
      readonly provisioningState?: string;
      readonly priority?: string;
      readonly evictionPolicy?: string;
      readonly timeCreated?: Date;
    }
  >;
  readonly deleteVm: (group: string, vm: string) => Promise<unknown>;
  readonly disks: AzureList;
  readonly nics: AzureList;
  readonly publicIps: AzureList;
  readonly nsgs: AzureList;
  readonly vnets: AzureList;
}

/**
 * The Azure side of a cross-cloud run: the cluster stays on AWS; the node
 * pool's VMs and networking live in the product's shared regional resource
 * group `anycloud-<region>`, tagged `anycloud_resource=<pool id>`
 * (`gateways/azure.ts`). Only tagged resources are read; the group is shared.
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
        deleteVm: (group, vm) =>
          compute.virtualMachines.beginDeleteAndWait(group, vm, {
            abortSignal: AbortSignal.timeout(VM_DELETE_TIMEOUT_MS),
          }),
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
    nodePoolId: string,
  ): Promise<T[]> {
    const found: T[] = [];
    try {
      for await (const resource of list(this.#resourceGroup)) {
        if (resource.name && resource.tags?.anycloud_resource === nodePoolId)
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
  async liveInstances(nodePoolId: string): Promise<string[]> {
    return (await this.#tagged(this.#clients.vms, nodePoolId))
      .filter((vm) => vm.provisioningState !== 'Deleting')
      .map((vm) => String(vm.name));
  }

  /** Creation times (epoch ms) of the pool's VMs. */
  async instanceLaunches(nodePoolId: string): Promise<number[]> {
    return (await this.#tagged(this.#clients.vms, nodePoolId)).flatMap((vm) =>
      vm.timeCreated ? [new Date(vm.timeCreated).getTime()] : [],
    );
  }

  /** A spot VM's eviction policy; null when not spot. */
  async spotEviction(name: string): Promise<string | null> {
    for await (const vm of this.#clients.vms(this.#resourceGroup)) {
      if (vm.name === name)
        return vm.priority === 'Spot' ? (vm.evictionPolicy ?? null) : null;
    }
    return null;
  }

  /** Disks and networking the product tagged for the pool, as `<kind>/<name>`. */
  async networkLeftovers(nodePoolId: string): Promise<string[]> {
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
      for (const resource of await this.#tagged(list, nodePoolId))
        found.push(`${kind}/${String(resource.name)}`);
    }
    return found;
  }

  /**
   * Delete one VM natively; the controller must observe the loss. Azure
   * deletes its OS disk with it (the product sets deleteOption: Delete).
   */
  async terminateInstance(name: string): Promise<void> {
    await this.#clients.deleteVm(this.#resourceGroup, name);
  }
}
