import { Resolver } from 'node:dns/promises';

import { CloudFailureDiagnosis } from '../../shared/cloud.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { sleep } from '../../shared/utils.js';
import {
  classifyStepFailure,
  FailureDisposition,
  type StepFailureClassification,
} from './provisioning-failure.js';

// Owner decision: the API must reach the authorities directly on
// port 53. When neither answers, fail clearly instead of waiting out 60s.
const UNREACHABLE_CODES = new Set(['ETIMEOUT', 'ECONNREFUSED']);
const UNREACHABLE_ROUNDS = 3;

/** The API's own network blocks port 53, so no retry or new VM can succeed. */
export class DNSAuthoritiesUnreachableError extends Error {
  constructor(hostname: string, authorities: string[]) {
    super(
      `DNS publication failed for ${hostname}: the API cannot reach the authoritative DNS servers ${authorities.join(' and ')} on port 53; allow outbound DNS to them`,
    );
  }
}

/** Fail the Service outright: a fresh VM cannot fix the API's network. */
export function classifyDNSPublicationFailure(
  error: unknown,
): StepFailureClassification | undefined {
  if (!(error instanceof DNSAuthoritiesUnreachableError)) return undefined;
  return classifyStepFailure(
    CloudFailureDiagnosis.InvalidRequest,
    FailureDisposition.TerminalFailed,
  );
}

/**
 * A record ID proves ownership, not publication. Query the delegated servers
 * directly so a premature recursive lookup cannot cache NXDOMAIN.
 */
export async function waitForDNSPublication(hostname: string): Promise<void> {
  const resolvers: Resolver[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const cancel = () => resolvers.forEach((resolver) => resolver.cancel());
  controller.signal.addEventListener('abort', cancel, { once: true });
  const resolver = (address?: string): Resolver => {
    const result = new Resolver({ timeout: 2_000, tries: 1 });
    if (address) result.setServers([address]);
    resolvers.push(result);
    return result;
  };
  let lastError: unknown;
  let answered = false;
  let unreachableRounds = 0;
  try {
    const discovery = resolver();
    const names = [...new Set(await discovery.resolveNs('anycloud.sh'))];
    if (names.length < 2)
      throw new Error('DNS publication requires both delegated authorities');
    const authorities = await Promise.all(
      names.map(async (name) => {
        const address = (await discovery.resolve4(name))[0];
        if (!address)
          throw new Error(`DNS authority ${name} has no IPv4 address`);
        return { name, resolver: resolver(address) };
      }),
    );
    while (!controller.signal.aborted) {
      const observations = await Promise.allSettled(
        authorities.map(async ({ name, resolver }) => {
          try {
            const [addresses] = await Promise.all([
              resolver.resolve4(hostname),
              // A proxied hostname may legitimately have IPv6 disabled. NODATA
              // is acceptable; NXDOMAIN must never be treated as published.
              resolver.resolve6(hostname).catch((error: unknown) => {
                if (
                  error instanceof Error &&
                  'code' in error &&
                  error.code === 'ENODATA'
                )
                  return [];
                throw error;
              }),
            ]);
            if (addresses.length === 0) throw new Error('empty A answer');
          } catch (error) {
            throw Object.assign(new Error(`${name}: ${errorMessage(error)}`), {
              cause: error,
            });
          }
        }),
      );
      const failures = observations.filter(
        (observation) => observation.status === 'rejected',
      );
      if (failures.length === 0 && !controller.signal.aborted) return;
      if (controller.signal.aborted) break;
      answered ||=
        failures.length < authorities.length ||
        failures.some(
          (failure) =>
            !UNREACHABLE_CODES.has(
              (failure.reason as { cause?: { code?: string } }).cause?.code ??
                '',
            ),
        );
      if (!answered && ++unreachableRounds >= UNREACHABLE_ROUNDS)
        throw new DNSAuthoritiesUnreachableError(hostname, names);
      lastError = Object.assign(
        new Error(
          failures.map((failure) => errorMessage(failure.reason)).join('; '),
        ),
        { errors: failures.map((failure) => failure.reason) },
      );
      await sleep(1_000, controller.signal);
    }
  } catch (error) {
    if (error instanceof DNSAuthoritiesUnreachableError) throw error;
    if (!controller.signal.aborted || lastError === undefined)
      lastError = error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cancel);
    cancel();
  }
  throw Object.assign(
    new Error(
      `DNS publication ${controller.signal.aborted ? 'timed out after 60s' : 'failed'} for ${hostname}: ${errorMessage(lastError ?? controller.signal.reason)}`,
    ),
    { cause: lastError ?? controller.signal.reason },
  );
}
