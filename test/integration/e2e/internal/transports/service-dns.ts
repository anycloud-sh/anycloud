import { Resolver } from 'node:dns/promises';

import type { ServeDnsAbsenceObservation } from '../targets/serve-types.js';

interface DnsAuthority {
  readonly authority: string;
  readonly address: string;
}

/** Bounded wire queries, independent of HTTP reachability and resolver caches. */
export class ServiceDnsTransport {
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  async authorities(deadlineAt: number): Promise<readonly DnsAuthority[]> {
    return this.#query(deadlineAt, async (resolver) => {
      const names = await resolver.resolveNs('anycloud.sh');
      return Promise.all(
        [...new Set(names)].map(async (authority) => {
          const addresses = await resolver.resolve4(authority);
          const address = addresses[0];
          if (!address)
            throw new Error(`DNS authority ${authority} has no IPv4 address`);
          return { authority, address };
        }),
      );
    });
  }

  addressesAt(
    hostname: string,
    authority: DnsAuthority,
    deadlineAt: number,
  ): Promise<readonly string[]> {
    return this.#query(deadlineAt, async (resolver) => {
      resolver.setServers([authority.address]);
      return resolver.resolve4(hostname);
    });
  }

  async #query<T>(
    deadlineAt: number,
    query: (resolver: Resolver) => Promise<T>,
  ): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new Error('Service DNS observation deadline expired');
    const signal = AbortSignal.any([
      this.#signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
    ]);
    signal.throwIfAborted();
    const resolver = new Resolver({ timeout: 3_000, tries: 2 });
    const cancel = (): void => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await query(resolver);
      signal.throwIfAborted();
      return result;
    } finally {
      resolver.cancel();
      signal.removeEventListener('abort', cancel);
    }
  }
}

/** Only an exact negative A answer from every authority proves DNS absence. */
export class ServiceDnsProbe {
  readonly #transport: Pick<ServiceDnsTransport, 'authorities' | 'addressesAt'>;

  constructor(
    transport: Pick<ServiceDnsTransport, 'authorities' | 'addressesAt'>,
  ) {
    this.#transport = transport;
  }

  async observe(
    hostname: string,
    deadlineAt: number = Date.now() + 30_000,
  ): Promise<ServeDnsAbsenceObservation> {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.anycloud\.sh$/u.test(hostname)) {
      throw new Error(
        'Service DNS observation requires its exact anycloud.sh hostname',
      );
    }
    const authorities = await this.#transport.authorities(deadlineAt);
    if (
      authorities.length === 0 ||
      new Set(authorities.map((server) => server.authority)).size !==
        authorities.length
    ) {
      throw new Error(
        'Service DNS observation requires distinct delegated authorities',
      );
    }
    const answers = await Promise.all(
      authorities.map(async (authority) => {
        try {
          const addresses = await this.#transport.addressesAt(
            hostname,
            authority,
            deadlineAt,
          );
          return {
            ...authority,
            diagnostic:
              addresses.length > 0
                ? `A ${addresses.join(', ')}`
                : 'empty A answer without a negative DNS result',
            presence:
              addresses.length > 0
                ? ('present' as const)
                : ('unknown' as const),
          };
        } catch (error) {
          // resolve4 speaks DNS; getaddrinfo/HTTP failure and NODATA are not NXDOMAIN.
          const absent =
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOTFOUND' &&
            'syscall' in error &&
            error.syscall === 'queryA' &&
            'hostname' in error &&
            error.hostname === hostname;
          return {
            ...authority,
            diagnostic: error instanceof Error ? error.message : String(error),
            presence: absent ? ('absent' as const) : ('unknown' as const),
          };
        }
      }),
    );
    return {
      hostname,
      authorities: authorities.map((server) => server.authority),
      answers,
    };
  }
}
