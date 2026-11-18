import type { CredentialManager } from '../credentials.js';
import type { VmProfile } from '../profiles.js';
import type {
  PublicCloudServeTargetTransport,
  ServeBackingHost,
  ServeEndpointProbe,
  ServeHostAbsence,
  ServeDnsAbsenceObservation,
} from '../targets/serve-types.js';
import type { ServiceDnsProbe } from './service-dns.js';
import { probeFailure, type TargetHttpClient } from './http.js';
import type { PublicCloudVmHostPresenceProbe } from './public-cloud-vm-host-presence.js';

interface ServePresenceFactory {
  create(profile: VmProfile): PublicCloudVmHostPresenceProbe;
}

/** Unreachable is a legitimate observation while DNS and the VM come up. */
const UNREACHABLE_STATUS = 0;

export class PublicCloudServeTransport
  implements PublicCloudServeTargetTransport
{
  readonly #credentials: Pick<CredentialManager, 'save'>;
  readonly #http: Pick<TargetHttpClient, 'get'>;
  readonly #dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly #presence: Pick<PublicCloudVmHostPresenceProbe, 'observe'>;
  readonly #profile: VmProfile;
  #savedCredential: Promise<void> | undefined;

  constructor(dependencies: {
    readonly credentials: Pick<CredentialManager, 'save'>;
    readonly http: Pick<TargetHttpClient, 'get'>;
    readonly dns: Pick<ServiceDnsProbe, 'observe'>;
    readonly presence: Pick<PublicCloudVmHostPresenceProbe, 'observe'>;
    readonly profile: VmProfile;
  }) {
    this.#credentials = dependencies.credentials;
    this.#http = dependencies.http;
    this.#dns = dependencies.dns;
    this.#presence = dependencies.presence;
    this.#profile = dependencies.profile;
  }

  ensureCredential(): Promise<void> {
    this.#savedCredential ??= this.#credentials.save(
      this.#profile.credentialName,
      this.#profile.credential,
    );
    return this.#savedCredential;
  }

  async observeEndpoint(url: string): Promise<ServeEndpointProbe> {
    try {
      const response = await this.#http.get(
        `${this.#profile.slug}-serve-endpoint`,
        new URL(url),
        { timeoutMs: 30_000, redirect: 'error' },
      );
      return {
        responseBody:
          typeof response.body === 'string'
            ? response.body
            : (JSON.stringify(response.body) ?? ''),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        error: probeFailure(error),
        responseBody: '',
        statusCode: UNREACHABLE_STATUS,
      };
    }
  }

  async observeHosts(
    hosts: readonly ServeBackingHost[],
    deadlineAt: number = Date.now() + 30_000,
  ): Promise<readonly ServeHostAbsence[]> {
    const observations: ServeHostAbsence[] = [];
    for (const host of hosts) {
      const observation = await this.#presence.observe(host, { deadlineAt });
      observations.push({
        cloudId: observation.cloudId,
        diagnostic: observation.diagnostic,
        presence: observation.presence,
      });
    }
    return observations;
  }

  observeDns(
    hostname: string,
    deadlineAt?: number,
  ): Promise<ServeDnsAbsenceObservation> {
    return this.#dns.observe(hostname, deadlineAt);
  }
}

export class PublicCloudServeTransportFactory {
  readonly #credentials: Pick<CredentialManager, 'save'>;
  readonly #http: Pick<TargetHttpClient, 'get'>;
  readonly #dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly #presence: ServePresenceFactory;

  constructor(
    credentials: Pick<CredentialManager, 'save'>,
    http: Pick<TargetHttpClient, 'get'>,
    presence: ServePresenceFactory,
    dns: Pick<ServiceDnsProbe, 'observe'>,
  ) {
    this.#credentials = credentials;
    this.#http = http;
    this.#presence = presence;
    this.#dns = dns;
  }

  create(profile: VmProfile): PublicCloudServeTransport {
    return new PublicCloudServeTransport({
      credentials: this.#credentials,
      http: this.#http,
      dns: this.#dns,
      presence: this.#presence.create(profile),
      profile,
    });
  }
}
