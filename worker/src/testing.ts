import worker, { CertificateOwner } from './index.js';

export type Env = Parameters<typeof worker.fetch>[1];

/** Each subdomain's {@link CertificateOwner} over in-memory storage. */
export function certificateOwners(): Env['CERTIFICATE_OWNER'] {
  const stores = new Map<unknown, Map<string, unknown>>();
  return {
    idFromName: (name) => name,
    get: (id) => {
      const store = stores.get(id) ?? new Map<string, unknown>();
      stores.set(id, store);
      const instance = new CertificateOwner({
        storage: {
          get: async (key) => store.get(key),
          put: async (key, value) => void store.set(key, value),
          delete: async (key) => store.delete(key),
        },
      });
      return {
        fetch: (input, init) => instance.fetch(new Request(input, init)),
      };
    },
  };
}
