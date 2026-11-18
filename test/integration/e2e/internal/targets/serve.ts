import type { PublicCloudServeAdapter } from './public-cloud-serve.js';
import type { VmProvider } from '../profiles.js';

interface PublicCloudServeAdapterFactory {
  create(provider: VmProvider): PublicCloudServeAdapter;
  createGpu(provider: VmProvider): PublicCloudServeAdapter;
}

/**
 * Resolves one adapter per Serve target and reuses it, so a contract cannot
 * accidentally submit through one adapter and observe through another.
 */
export class ServeTargetFactory {
  readonly #adapters = new Map<VmProvider, PublicCloudServeAdapter>();
  readonly #gpuAdapters = new Map<VmProvider, PublicCloudServeAdapter>();
  readonly #factory: PublicCloudServeAdapterFactory;

  constructor(factory: PublicCloudServeAdapterFactory) {
    this.#factory = factory;
  }

  adapter(provider: VmProvider): PublicCloudServeAdapter {
    const existing = this.#adapters.get(provider);
    if (existing) return existing;
    const adapter = this.#factory.create(provider);
    if (adapter.profile.provider !== provider) {
      throw new Error(`Serve target factory returned a ${provider} mismatch`);
    }
    this.#adapters.set(provider, adapter);
    return adapter;
  }

  gpuAdapter(provider: VmProvider): PublicCloudServeAdapter {
    const existing = this.#gpuAdapters.get(provider);
    if (existing) return existing;
    const adapter = this.#factory.createGpu(provider);
    if (
      adapter.profile.provider !== provider ||
      adapter.profile.gpus !== 'all'
    ) {
      throw new Error(
        `GPU Serve target factory returned a ${provider} profile mismatch`,
      );
    }
    this.#gpuAdapters.set(provider, adapter);
    return adapter;
  }
}
