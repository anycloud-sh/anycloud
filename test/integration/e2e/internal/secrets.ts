import type { ApiClient } from './api.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';

interface OwnedSecret {
  readonly controller: ApiClient['controller'];
  registration?: CleanupRegistration;
}

export class SecretManager {
  readonly #api: Pick<
    ApiClient,
    'controller' | 'createSecret' | 'deleteSecret'
  >;
  readonly #cleanupApi: Pick<ApiClient, 'controller' | 'deleteSecret'>;
  readonly #cleanup: CleanupStack;
  readonly #tracked = new Map<string, OwnedSecret>();

  constructor(
    api: Pick<ApiClient, 'controller' | 'createSecret' | 'deleteSecret'>,
    cleanup: CleanupStack,
    cleanupApi: Pick<ApiClient, 'controller' | 'deleteSecret'> = api,
  ) {
    this.#api = api;
    this.#cleanupApi = cleanupApi;
    this.#cleanup = cleanup;
  }

  async create(
    name: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    let owned = this.#tracked.get(name);
    if (!owned?.registration) {
      owned = { controller: Object.freeze({ ...this.#api.controller }) };
      this.#assertController(owned.controller);
      const original = owned;
      owned.registration = this.#cleanup.defer(`secret ${name}`, () =>
        this.#delete(name, original, this.#cleanupApi),
      );
      this.#tracked.set(name, owned);
    }
    this.#assertController(owned.controller);
    await this.#api.createSecret(name, values);
    this.#assertController(owned.controller);
  }

  delete(name: string): Promise<void> {
    return this.#delete(name, this.#tracked.get(name), this.#api);
  }

  /** Service fallback must prove named-bundle absence before releasing its Workload. */
  deleteForCleanup(name: string, deadlineAt?: number): Promise<void> {
    return this.#delete(
      name,
      this.#tracked.get(name),
      this.#cleanupApi,
      deadlineAt,
    );
  }

  async #delete(
    name: string,
    owned: OwnedSecret | undefined,
    client: Pick<ApiClient, 'controller' | 'deleteSecret'>,
    deadlineAt?: number,
  ): Promise<void> {
    const controller = owned?.controller ?? client.controller;
    this.#assertController(controller);
    // ApiClient owns deletion plus exact-name list readback under one budget.
    await client.deleteSecret(name, deadlineAt);
    this.#assertController(controller);
    owned?.registration?.complete();
    if (owned) owned.registration = undefined;
  }

  #assertController(controller: ApiClient['controller']): void {
    // Each intent keeps its original scope, including after confirmed absence.
    // Only an explicit new create may register that name on a newer controller.
    for (const client of [this.#api, this.#cleanupApi]) {
      const current = client.controller;
      if (
        current.generation !== controller.generation ||
        current.url !== controller.url
      )
        throw new Error(
          'Named-secret operation changed its original controller incarnation',
        );
    }
  }
}
