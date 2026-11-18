import type { ApiClient } from './api.js';
import type { CloudCredentialInput } from './types.js';

export class CredentialManager {
  readonly #api: Pick<ApiClient, 'saveCredential'>;

  constructor(api: Pick<ApiClient, 'saveCredential'>) {
    this.#api = api;
  }

  async save(name: string, credential: CloudCredentialInput): Promise<void> {
    await this.#api.saveCredential(name, credential);
  }
}
