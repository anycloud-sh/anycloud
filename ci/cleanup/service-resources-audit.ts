import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { CloudType } from '../../src/shared/cloud.js';
import {
  ArtifactStore,
  Redactor,
} from '../../test/integration/e2e/internal/artifacts.js';
import { Environment } from '../../test/integration/e2e/internal/environment.js';
import { FixtureFiles } from '../../test/integration/e2e/internal/files.js';
import { ProcessRunner } from '../../test/integration/e2e/internal/process.js';
import {
  ProviderProfiles,
  type VmProfile,
} from '../../test/integration/e2e/internal/profiles.js';
import { TargetHttpClient } from '../../test/integration/e2e/internal/transports/http.js';
import {
  PublicCloudVmHostPresenceProbe,
  awsZone,
  type VmHostLocation,
  type VmReservationPresenceObservation,
} from '../../test/integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import {
  ServiceDnsProbe,
  ServiceDnsTransport,
} from '../../test/integration/e2e/internal/transports/service-dns.js';

const providerSchema = z.enum(['aws', 'gcp', 'lambda']);
const locationSchema = z.strictObject({
  cloudId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u),
  region: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)+$/u),
  availabilityZone: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/u)
    .nullable(),
});
const scopeSchema = z
  .strictObject({
    provider: providerSchema,
    workloadId: z.string().regex(/^[a-z](?:[a-z0-9-]{0,60}[a-z0-9])?$/u),
    originalDnsRecordId: z.string().regex(/^[a-f0-9]{32}$/u),
    originalProfileRowId: z.string().min(1).max(128).nullable(),
    hosts: z.array(locationSchema).max(10),
    reservations: z.array(locationSchema).max(10),
  })
  .superRefine((scope, context) => {
    const locations = [...scope.hosts, ...scope.reservations];
    const key = (location: VmHostLocation) => JSON.stringify(location);
    if (
      locations.length === 0 ||
      new Set(locations.map(key)).size !== locations.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Audit scope must have distinct original identities',
      });
    if (scope.provider === 'gcp' && scope.reservations.length > 0)
      context.addIssue({
        code: 'custom',
        message: 'GCP reservations are not supported by this audit',
      });
    if (scope.provider === 'lambda') {
      if (scope.reservations.length > 0)
        context.addIssue({
          code: 'custom',
          message: 'Lambda reservations are not supported by this audit',
        });
      if (!/^[a-f0-9]{64}$/u.test(scope.originalProfileRowId ?? ''))
        context.addIssue({
          code: 'custom',
          message: 'Lambda requires the original typed credential hash',
        });
      if (
        new Set(scope.hosts.map((host) => host.cloudId)).size !==
        scope.hosts.length
      )
        context.addIssue({
          code: 'custom',
          message: 'Lambda audit scope repeats an original native identity',
        });
    }
    for (const reservation of scope.reservations)
      if (
        reservation.cloudId.length > 64 ||
        !reservation.cloudId.startsWith(`${scope.workloadId}-`) ||
        !/^(?:0|[1-9][0-9]*)$/u.test(
          reservation.cloudId.slice(scope.workloadId.length + 1),
        )
      )
        context.addIssue({
          code: 'custom',
          message: 'Reservation does not belong to the original Workload',
        });
    for (const location of locations) {
      if (scope.provider === 'aws') {
        if (!/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/u.test(location.region))
          context.addIssue({
            code: 'custom',
            message: 'AWS original region is malformed',
          });
        awsZone(location.region, location.availabilityZone);
      } else if (
        scope.provider === 'gcp' &&
        (!/^[a-z]+(?:-[a-z]+)+[0-9]+$/u.test(location.region) ||
          !/^[a-z]$/u.test(location.availabilityZone ?? ''))
      )
        context.addIssue({
          code: 'custom',
          message: 'GCP original placement is malformed',
        });
      else if (
        scope.provider === 'lambda' &&
        (!/^[a-z]+(?:-[a-z]+)+-[0-9]+$/u.test(location.region) ||
          location.availabilityZone !== null)
      )
        context.addIssue({
          code: 'custom',
          message:
            'Lambda original region or null availability zone is malformed',
        });
    }
    for (const host of scope.hosts)
      if (
        scope.provider === 'aws'
          ? !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u.test(host.cloudId)
          : scope.provider === 'lambda'
            ? !/^[a-f0-9]{32}$/u.test(host.cloudId)
            : !host.cloudId.startsWith(`${scope.workloadId}-`) ||
              !/^(?:0|[1-9][0-9]*)$/u.test(
                host.cloudId.slice(scope.workloadId.length + 1),
              )
      )
        context.addIssue({
          code: 'custom',
          message: 'Native identity does not match the declared provider scope',
        });
  });
const manifestSchema = z.strictObject({
  version: z.literal(1),
  originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  originalRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  scopes: z.array(scopeSchema).min(1).max(5),
});
export function parseServiceAuditSelection(
  raw: unknown,
  provider: unknown,
  forceCleanup: unknown = 'false',
  maceOnly: unknown = 'false',
) {
  if (forceCleanup !== 'false' || maceOnly !== 'false')
    throw new Error(
      'Read-only Service audits cannot be combined with provisioning modes',
    );
  const selectedProvider = providerSchema.parse(provider);
  const manifest = manifestSchema.parse(raw);
  const scopes = manifest.scopes.filter(
    (scope) => scope.provider === selectedProvider,
  );
  if (
    scopes.length === 0 ||
    new Set(scopes.map((scope) => scope.workloadId)).size !== scopes.length
  )
    throw new Error('Audit must select distinct Workloads for its provider');
  if (selectedProvider === 'lambda') {
    const hostIds = scopes.flatMap((scope) =>
      scope.hosts.map((host) => host.cloudId),
    );
    if (new Set(hostIds).size !== hostIds.length)
      throw new Error(
        'Lambda audit scopes must have distinct native identities',
      );
  }
  return { ...manifest, provider: selectedProvider, scopes };
}

/** Validate every selected scope before the first native or DNS request. */
export function assertServiceAuditProfile(
  scopes: readonly unknown[],
  profile: VmProfile | undefined,
): void {
  for (const scope of scopes.map((value) => scopeSchema.parse(value))) {
    if (scope.provider !== 'lambda') continue;
    const credential = profile?.credential;
    if (
      profile?.provider !== CloudType.Lambda ||
      profile.slug !== 'lambda' ||
      profile.credentialName !== 'lambda-test' ||
      credential?.cloudProvider !== CloudType.Lambda ||
      !credential.apiKey.trim()
    )
      throw new Error('Original Lambda credential is unavailable');
    // CloudCredential.id hashes the complete typed JSON, not the API key alone.
    const profileRowId = createHash('sha256')
      .update(JSON.stringify(credential))
      .digest('hex');
    if (profileRowId !== scope.originalProfileRowId)
      throw new Error(
        `Lambda original credential does not match Workload ${scope.workloadId}`,
      );
  }
}

interface AuditPorts {
  readonly native: Pick<
    PublicCloudVmHostPresenceProbe,
    'observe' | 'observeReservations'
  >;
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly profile?: VmProfile;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly retain: (record: unknown) => Promise<void>;
}

/** Two bounded, read-only observations; this cannot release a Workload or repair its historical result. */
export async function auditServiceScope(rawScope: unknown, ports: AuditPorts) {
  const scope = scopeSchema.parse(rawScope);
  const startedAt = ports.now();
  const deadlineAt = startedAt + 120_000;
  const provider = {
    aws: CloudType.AWS,
    gcp: CloudType.GCP,
    lambda: CloudType.Lambda,
  }[scope.provider];
  const hostname = `${scope.workloadId}.anycloud.sh`;
  const record = {
    kind: 'service-external-resource-audit',
    startedAt,
    scope,
    persistedWorkloadState: 'not observed by this read-only audit',
    historicalOutcome: 'unchanged',
    originalProfileRowMatches: scope.provider === 'lambda' ? false : undefined,
    native: [] as {
      round: number;
      observedAt: number;
      location: VmHostLocation;
      observation: Awaited<ReturnType<AuditPorts['native']['observe']>>;
    }[],
    reservations: [] as {
      round: number;
      observation: VmReservationPresenceObservation;
    }[],
    dns: [] as {
      round: number;
      observedAt: number;
      observation: Awaited<ReturnType<AuditPorts['dns']['observe']>>;
    }[],
    failures: [] as { round: number; operation: string; message: string }[],
    completedAt: null as number | null,
    externalResourcesAbsent: false,
  };
  const checkBudget = () => {
    ports.signal.throwIfAborted();
    if (ports.now() >= deadlineAt)
      throw new Error('Service audit deadline expired');
  };
  await ports.retain(record);
  if (scope.provider === 'lambda') {
    try {
      assertServiceAuditProfile([scope], ports.profile);
      record.originalProfileRowMatches = true;
    } catch (error) {
      record.failures.push({
        round: 0,
        operation: 'original credential',
        message:
          error instanceof Error
            ? error.message
            : 'Original credential unavailable',
      });
      record.completedAt = ports.now();
      await ports.retain(record);
      return record;
    }
  }
  for (const round of [1, 2]) {
    try {
      checkBudget();
      if (round === 2) {
        if (deadlineAt - ports.now() < 10_000)
          throw new Error('Service audit has no remaining stability window');
        await ports.wait(10_000);
        checkBudget();
      }
    } catch (error) {
      record.failures.push({
        round,
        operation: 'budget',
        message: error instanceof Error ? error.message : 'Audit interrupted',
      });
      break;
    }
    for (const location of scope.hosts) {
      try {
        checkBudget();
        const observation = await ports.native.observe(location, {
          deadlineAt,
          signal: ports.signal,
        });
        if (
          observation.cloudId !== location.cloudId ||
          observation.provider !== provider
        )
          throw new Error('Audit received a foreign native identity');
        record.native.push({
          round,
          observedAt: ports.now(),
          location,
          observation,
        });
        checkBudget();
      } catch (error) {
        record.failures.push({
          round,
          operation: 'native',
          message:
            error instanceof Error
              ? error.message
              : 'Native observation failed',
        });
      }
      await ports.retain(record);
    }
    if (scope.reservations.length > 0) {
      try {
        checkBudget();
        const retainPartial = (
          observation: VmReservationPresenceObservation,
        ) => {
          if (
            observation.kind !== 'exact-attempt-current-presence' ||
            observation.provider !== provider ||
            observation.credentialName !== `${scope.provider}-test` ||
            !Number.isSafeInteger(observation.observedAt) ||
            observation.observedAt < startedAt ||
            observation.observedAt > ports.now() ||
            new Set(
              observation.attempts.map((attempt) =>
                JSON.stringify([
                  attempt.attemptId,
                  attempt.region,
                  attempt.availabilityZone,
                ]),
              ),
            ).size !== scope.reservations.length ||
            observation.attempts.length !== scope.reservations.length ||
            observation.attempts.some(
              (attempt) =>
                !scope.reservations.some(
                  (original) =>
                    original.cloudId === attempt.attemptId &&
                    original.region === attempt.region &&
                    original.availabilityZone === attempt.availabilityZone,
                ),
            )
          )
            throw new Error('Audit received a foreign reservation identity');
          record.reservations.push({
            round,
            observation: structuredClone(observation),
          });
        };
        const observation = await ports.native.observeReservations(
          scope.reservations,
          {
            deadlineAt,
            signal: ports.signal,
            onPartialObservation: retainPartial,
          },
        );
        retainPartial(observation);
        checkBudget();
      } catch (error) {
        record.failures.push({
          round,
          operation: 'reservation',
          message:
            error instanceof Error
              ? error.message
              : 'Reservation observation failed',
        });
      }
      await ports.retain(record);
    }
    try {
      checkBudget();
      const observation = await ports.dns.observe(hostname, deadlineAt);
      if (
        observation.hostname !== hostname ||
        observation.authorities.length === 0 ||
        new Set(observation.authorities).size !==
          observation.authorities.length ||
        JSON.stringify([...observation.authorities].sort()) !==
          JSON.stringify(
            observation.answers.map((answer) => answer.authority).sort(),
          )
      )
        throw new Error(
          'Audit received a foreign DNS identity or incomplete authority coverage',
        );
      record.dns.push({ round, observedAt: ports.now(), observation });
      checkBudget();
    } catch (error) {
      record.failures.push({
        round,
        operation: 'dns',
        message:
          error instanceof Error ? error.message : 'DNS observation failed',
      });
    }
    await ports.retain(record);
  }
  if (record.failures.length === 0) {
    try {
      checkBudget();
    } catch (error) {
      record.failures.push({
        round: 2,
        operation: 'budget',
        message: error instanceof Error ? error.message : 'Audit interrupted',
      });
    }
  }
  const finalHosts = record.native.filter((entry) => entry.round === 2);
  const finalReservations = record.reservations
    .filter((entry) => entry.round === 2)
    .at(-1)?.observation;
  const finalDns = record.dns.at(-1);
  record.externalResourcesAbsent =
    record.failures.length === 0 &&
    finalHosts.length === scope.hosts.length &&
    finalHosts.every((entry) => entry.observation.presence === 'absent') &&
    (scope.reservations.length === 0 ||
      (!!finalReservations?.inventory?.complete &&
        finalReservations.attempts.every(
          (attempt) =>
            attempt.presence === 'absent' && attempt.instanceIds.length === 0,
        ))) &&
    finalDns?.round === 2 &&
    finalDns.observation.answers.every(
      (answer) => answer.presence === 'absent',
    );
  record.completedAt = ports.now();
  await ports.retain(record);
  return record;
}

export async function runServiceResourcesAudit(): Promise<void> {
  const selection = parseServiceAuditSelection(
    JSON.parse(process.env.SERVICE_CLEANUP_AUDIT ?? ''),
    process.env.SERVICE_CLEANUP_AUDIT_PROVIDER,
    process.env.SERVICE_CLEANUP_AUDIT_FORCE,
    process.env.SERVICE_CLEANUP_AUDIT_MACE_ONLY,
  );
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(process.env.GITHUB_SHA);
  const output = process.env.SERVICE_CLEANUP_AUDIT_OUTPUT;
  if (!output) throw new Error('Service audit output directory is required');
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(output, redactor);
  const signal = AbortSignal.timeout(300_000);
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'service-cleanup-audit-'),
  );
  const failures: { operation: string; error: unknown }[] = [];
  let externalResourcesAbsent = true;
  let privateFilesRemoved = false;
  try {
    await artifacts.initialize({
      kind: 'service-external-resource-audit',
      sourceSha: revision,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      nodeVersion: process.version,
      originalSourceSha: selection.originalSourceSha,
      originalRunId: selection.originalRunId,
      provider: selection.provider,
      profileName: `${selection.provider}-test`,
      scopes: selection.scopes,
    });
    const profile = new ProviderProfiles(
      new Environment(process.env, redactor),
    ).gpuServe(selection.provider);
    assertServiceAuditProfile(selection.scopes, profile);
    const targetHttp = new TargetHttpClient(
      artifacts,
      redactor,
      signal,
      'service-audit',
    );
    const native = new PublicCloudVmHostPresenceProbe(
      profile,
      new ProcessRunner(artifacts, signal, process.cwd()),
      new FixtureFiles(temporary),
      selection.provider === 'lambda'
        ? targetHttp
        : {
            get: async () => {
              throw new Error(
                'AWS/GCP audit does not permit another provider HTTP transport',
              );
            },
          },
    );
    const dns = new ServiceDnsProbe(new ServiceDnsTransport(signal));
    for (const scope of selection.scopes) {
      let snapshot = 0;
      const record = await auditServiceScope(scope, {
        native,
        dns,
        profile,
        signal,
        now: Date.now,
        wait: (milliseconds) => delay(milliseconds, undefined, { signal }),
        retain: async (value) => {
          await artifacts.json(
            `service-audit-${scope.workloadId}-${++snapshot}`,
            value,
          );
        },
      });
      externalResourcesAbsent &&= record.externalResourcesAbsent;
    }
  } catch (error) {
    failures.push({ operation: 'observation or retention', error });
  }
  try {
    await rm(temporary, { force: true, recursive: true });
    privateFilesRemoved = true;
  } catch (error) {
    failures.push({ operation: 'private credential files removal', error });
  }
  try {
    await artifacts.json('outcome', {
      sourceSha: revision,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      completedAt: Date.now(),
      externalResourcesAbsent: failures.length === 0 && externalResourcesAbsent,
      privateFilesRemoved,
      failures: failures.map(({ operation, error }) => ({
        operation,
        message:
          error instanceof Error ? error.message : 'Audit operation failed',
      })),
    });
  } catch (error) {
    failures.push({ operation: 'outcome retention', error });
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures.map(({ error }) => error),
      'Service audit failed',
    );
  if (!externalResourcesAbsent) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runServiceResourcesAudit().catch(() => {
    // Input/schema errors and provider exceptions may include arbitrary bodies.
    console.error(
      'Service external-resource audit did not complete; inspect its retained sanitized record',
    );
    process.exitCode = 1;
  });
}
