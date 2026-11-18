import type {
  SaveSecretInput,
  SecretSummary,
} from '../../shared/api-contract/secrets-schemas.js';
import { SecretInUseError } from '../../shared/errors.js';
import { log } from './logger.js';

export interface SecretsDomain {
  list(signal?: AbortSignal): Promise<SecretSummary[]>;
  save(input: SaveSecretInput, signal?: AbortSignal): Promise<void>;
  delete(name: string, force: boolean, signal?: AbortSignal): Promise<void>;
}

/** The named-secret writes and metadata reads this domain performs. */
interface SecretStore {
  listSecrets(): Promise<SecretSummary[]>;
  saveSecret(name: string, values: Record<string, string>): Promise<void>;
  listRunningVmHostWorkloadIds(name: string): Promise<string[]>;
  deleteSecretIfNotReferenced(
    name: string,
    force: boolean,
  ): Promise<{ deleted: boolean; blocking: string[] }>;
}

export interface SecretsDomainDependencies {
  store: SecretStore;
  /** Wake a Workload's poll, which writes the Secret's new files. */
  requestPoll(workloadId: string): Promise<void>;
}

export function createSecretsDomain(
  dependencies: SecretsDomainDependencies,
): SecretsDomain {
  return {
    async list(signal) {
      signal?.throwIfAborted();
      const secrets = await dependencies.store.listSecrets();
      signal?.throwIfAborted();
      return secrets;
    },

    async save(input, signal) {
      signal?.throwIfAborted();
      await dependencies.store.saveSecret(input.name, input.values);
      // Delivery never delays or fails the save; the 30-second poll retries.
      void dependencies.store
        .listRunningVmHostWorkloadIds(input.name)
        .then((ids) => Promise.all(ids.map(dependencies.requestPoll)))
        .catch((error: unknown) =>
          log.warn('Waking Secret file delivery failed', {
            secret: input.name,
            error,
          }),
        );
      signal?.throwIfAborted();
    },

    async delete(name, force, signal) {
      signal?.throwIfAborted();
      const { blocking } = await dependencies.store.deleteSecretIfNotReferenced(
        name,
        force,
      );
      signal?.throwIfAborted();
      if (blocking.length > 0) throw new SecretInUseError(name, blocking);
    },
  };
}
