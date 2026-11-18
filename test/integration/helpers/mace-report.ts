#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface MaceEvent {
  id?: number;
  state?: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

interface MaceReportOptions {
  generatedAt: string;
  cloud: string;
  workloadId: string;
  image: string;
  vmType: string;
  requestedRegion?: string;
  requestedZone?: string;
  diskSizeGb?: number;
  diskTier?: string;
  deliveryPath: string;
}

type JsonObject = Record<string, any>;

interface ProvisioningAttempt {
  events: MaceEvent[];
  outcome?: MaceEvent;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function secondsBetween(
  start: number | null,
  end: number | null,
): number | null {
  if (start === null || end === null || end < start) return null;
  return (end - start) / 1000;
}

function lastEvent(
  events: MaceEvent[],
  state: string,
  atOrBefore: number,
): MaceEvent | undefined {
  return events.findLast(
    (event) =>
      event.state === state && (event.createdAt ?? Infinity) <= atOrBefore,
  );
}

function provisioningAttemptsFromEvents(
  events: MaceEvent[],
): ProvisioningAttempt[] {
  const attempts: ProvisioningAttempt[] = [];

  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.state !== 'provisioning') continue;

    const provisioningEvents: MaceEvent[] = [];
    while (events[index]?.state === 'provisioning') {
      provisioningEvents.push(events[index]!);
      index += 1;
    }

    attempts.push({
      events: provisioningEvents,
      outcome: events[index],
    });
    index -= 1;
  }

  return attempts;
}

/** Build a self-contained phase-level report from status and log-observer data. */
export function buildMaceReport(
  status: JsonObject | null,
  observer: JsonObject | null,
  options: MaceReportOptions,
): JsonObject {
  const inferenceAt = finiteNumber(observer?.firstInferenceLogObservedAtMs);
  const observerArmedAt = finiteNumber(observer?.observerArmedAtMs);
  const events = (Array.isArray(status?.events) ? status.events : [])
    .filter(
      (event: MaceEvent) =>
        typeof event?.state === 'string' &&
        finiteNumber(event.createdAt) !== null,
    )
    .sort(
      (left: MaceEvent, right: MaceEvent) =>
        (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
        (left.id ?? 0) - (right.id ?? 0),
    ) as MaceEvent[];

  // Work backwards from the observed inference marker. This selects the final
  // successful chain even when earlier provisioning or pull attempts retried.
  const markerBoundary = inferenceAt ?? Infinity;
  const starting = lastEvent(events, 'starting', markerBoundary);
  const startingAt = finiteNumber(starting?.createdAt);
  const syncing = lastEvent(events, 'syncing', startingAt ?? markerBoundary);
  const syncingAt = finiteNumber(syncing?.createdAt);
  const downloading = lastEvent(
    events,
    'downloading',
    syncingAt ?? startingAt ?? markerBoundary,
  );
  const downloadingAt = finiteNumber(downloading?.createdAt);
  const initializing = lastEvent(
    events,
    'initializing',
    downloadingAt ?? markerBoundary,
  );
  const initializingAt = finiteNumber(initializing?.createdAt);
  // A durable step can emit an initial provisioning transition followed by an
  // adjacent active-step-replay transition. They are one VM attempt, not two.
  const provisioningAttemptGroups = provisioningAttemptsFromEvents(events);
  const successfulProvisioningAttempt = initializing
    ? provisioningAttemptGroups.findLast(
        (attempt) => attempt.outcome === initializing,
      )
    : undefined;
  const provisioningAt = finiteNumber(
    successfulProvisioningAttempt?.events[0]?.createdAt,
  );

  const retryEvents = events.filter((event) => event.state === 'retrying');
  const capacityRetryEvents = retryEvents.filter((event) => {
    const diagnosis = event.metadata?.diagnosis ?? event.metadata?.errorKind;
    return diagnosis === 'capacity-exhausted';
  });
  const provisioningAttempts = provisioningAttemptGroups.map((attempt) => {
    const firstEvent = attempt.events[0];
    const lastProvisioningEvent = attempt.events.at(-1);
    const outcome = attempt.outcome;
    const startedAt = finiteNumber(firstEvent?.createdAt);
    const endedAt = finiteNumber(outcome?.createdAt);
    return {
      eventId: firstEvent?.id ?? null,
      eventIds: attempt.events.map((event) => event.id ?? null),
      startedAt,
      lastProvisioningEventAt: finiteNumber(lastProvisioningEvent?.createdAt),
      endedAt,
      durationSeconds: secondsBetween(startedAt, endedAt),
      outcome: outcome?.state ?? 'unknown',
      metadata: firstEvent?.metadata ?? null,
      outcomeMetadata: outcome?.metadata ?? null,
    };
  });

  const downloadEndAt = syncingAt ?? startingAt;
  const markerPayload = observer?.marker?.payload ?? {};

  return {
    reportType: 'mace-timing',
    schemaVersion: 2,
    generatedAt: options.generatedAt,
    cloud: options.cloud,
    workloadId: options.workloadId,
    image: options.image,
    infrastructure: {
      vmType: options.vmType,
      region: options.requestedRegion || 'auto',
      zone: options.requestedZone || null,
      diskSizeGb: options.diskSizeGb ?? null,
      diskTier: options.diskTier ?? null,
      spot: false,
    },
    deliveryPath: options.deliveryPath,
    finalState: status?.workload?.state ?? null,
    observedRegion:
      (Array.isArray(status?.vms)
        ? status.vms
            .map((vm: JsonObject) => vm?.region)
            .filter(Boolean)
            .at(-1)
        : null) ?? null,
    vmAttempts: Array.isArray(status?.vms) ? status.vms.length : 0,
    retryEvents: retryEvents.length,
    capacityRetryEvents: capacityRetryEvents.length,
    firstInference: {
      totalSeconds: secondsBetween(observerArmedAt, inferenceAt),
      successfulAttemptSeconds: secondsBetween(provisioningAt, inferenceAt),
      preSuccessfulAttemptSeconds: secondsBetween(
        observerArmedAt,
        provisioningAt,
      ),
      workloadElapsedSeconds: finiteNumber(markerPayload.elapsed_s),
      device: markerPayload.device ?? null,
      energy: finiteNumber(markerPayload.energy),
      phases: {
        provisioningSeconds: secondsBetween(provisioningAt, initializingAt),
        initializingSeconds: secondsBetween(initializingAt, downloadingAt),
        downloadingSeconds: secondsBetween(downloadingAt, downloadEndAt),
        syncingSeconds:
          syncingAt === null ? null : secondsBetween(syncingAt, startingAt),
        startToFirstInferenceSeconds: secondsBetween(startingAt, inferenceAt),
      },
      boundaries: {
        observerArmedAtMs: observerArmedAt,
        successfulProvisioningAtMs: provisioningAt,
        initializingAtMs: initializingAt,
        downloadingAtMs: downloadingAt,
        syncingAtMs: syncingAt,
        startingAtMs: startingAt,
        firstInferenceObservedAtMs: inferenceAt,
      },
    },
    provisioningAttempts,
    eventTimeline: events.map((event) => ({
      id: event.id ?? null,
      state: event.state,
      createdAt: event.createdAt,
      metadata: event.metadata ?? null,
    })),
  };
}

function readJson(path: string): JsonObject | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function numericOption(args: string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

async function main(args: string[]) {
  const command = args[0];
  if (command === 'build') {
    const status = readJson(requiredOption(args, '--status'));
    const observer = readJson(requiredOption(args, '--observer'));
    const report = buildMaceReport(status, observer, {
      generatedAt: option(args, '--generated-at') ?? new Date().toISOString(),
      cloud: requiredOption(args, '--cloud'),
      workloadId: requiredOption(args, '--workload-id'),
      image: requiredOption(args, '--image'),
      vmType: requiredOption(args, '--vm-type'),
      requestedRegion: option(args, '--region'),
      requestedZone: option(args, '--zone'),
      diskSizeGb: numericOption(args, '--disk-size-gb'),
      diskTier: option(args, '--disk-tier'),
      deliveryPath: option(args, '--delivery-path') ?? 'unknown',
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  throw new Error('Usage: mace-report.ts build [options]');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
