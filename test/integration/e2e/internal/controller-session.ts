export interface ControllerEndpointSnapshot {
  readonly fixtureProcess: boolean;
  readonly generation: number;
  readonly url: string;
}

export interface ControllerEndpointSource {
  snapshot(): ControllerEndpointSnapshot | undefined;
}

function normalizedUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/u, '');
  if (!trimmed) throw new Error('Controller endpoint URL cannot be empty');
  return trimmed;
}

/**
 * One endpoint-scoped controller binding shared by the owning API and CLI
 * clients. A fixture-owned process may replace its incarnation while keeping
 * the same client-visible endpoint; callers cannot accidentally retain a
 * process-specific client after the generation changes.
 */
export class ControllerEndpoint implements ControllerEndpointSource {
  #attached = false;
  #canonicalUrl: string | undefined;
  #fixtureProcess = false;
  #generation = 0;

  constructor(initialUrl?: string) {
    if (initialUrl) {
      this.#canonicalUrl = normalizedUrl(initialUrl);
      this.#attached = true;
    }
  }

  snapshot(): ControllerEndpointSnapshot | undefined {
    if (!this.#attached || !this.#canonicalUrl) return undefined;
    return {
      fixtureProcess: this.#fixtureProcess,
      generation: this.#generation,
      url: this.#canonicalUrl,
    };
  }

  attach(url: string): ControllerEndpointSnapshot {
    const nextUrl = normalizedUrl(url);
    if (this.#canonicalUrl && this.#canonicalUrl !== nextUrl) {
      throw new Error(
        `Controller replacement changed endpoint from ${this.#canonicalUrl} to ${nextUrl}`,
      );
    }
    this.#canonicalUrl = nextUrl;
    this.#attached = true;
    this.#fixtureProcess = true;
    this.#generation += 1;
    return {
      fixtureProcess: this.#fixtureProcess,
      generation: this.#generation,
      url: nextUrl,
    };
  }

  detach(): void {
    this.#attached = false;
  }
}

/**
 * The environment a CLI subprocess needs to reach the controller, derived in
 * one place so the URL and the fixture-process marker cannot be projected
 * separately. Passing API_URL while omitting IS_TEST is how the CLI Docker
 * preflight rejected the fixture-owned API; a transport that spreads
 * this object cannot repeat that.
 */
export function controllerCliEnvironment(
  source: ControllerEndpointSource,
): Readonly<{ API_URL?: string; IS_TEST?: 'true' }> {
  const endpoint = source.snapshot();
  if (!endpoint) return {};
  return endpoint.fixtureProcess
    ? { API_URL: endpoint.url, IS_TEST: 'true' }
    : { API_URL: endpoint.url };
}

export function controllerEndpointSource(
  endpoint: string | undefined | ControllerEndpointSource,
): ControllerEndpointSource {
  return typeof endpoint === 'object'
    ? endpoint
    : new ControllerEndpoint(endpoint);
}
