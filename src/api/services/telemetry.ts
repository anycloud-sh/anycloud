import { isLocalOwnerId } from './api-authentication.js';
import { PostHog } from 'posthog-node';
import type { User } from './entities.js';
import config from '../config.js';
import { getApiIdentity } from './api-identity.js';

const POSTHOG_HOST = 'https://us.i.posthog.com';
export const STATUS_TELEMETRY_REPEAT_INTERVAL_MS = 15 * 60 * 1000;
export const STATUS_TELEMETRY_MAX_KEYS = 5000;

let client: PostHog | null = null;
const lastStatusTelemetryByCacheKey = new Map<string, number>();

function isDisabled(): boolean {
  return (
    process.env.ANYCLOUD_DISABLE_USAGE_COLLECTION === '1' ||
    process.env.IS_TEST === 'true'
  );
}

function getClient(): PostHog | null {
  if (isDisabled()) return null;
  if (!client) {
    client = new PostHog(config.posthogApiKey, { host: POSTHOG_HOST });
  }
  return client;
}

/** A local API's owner signs in to no GitHub account; its id is unique per install. */
function distinctIdOf(user: Pick<User, 'id' | 'username'>): string {
  return isLocalOwnerId(user.id) ? user.id : user.username;
}

/**
 * Record a usage event. Fire-and-forget — never throws.
 */
export function recordEvent(
  user: Pick<User, 'id' | 'username'>,
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    const ph = getClient();
    if (!ph) return;

    ph.capture({
      distinctId: distinctIdOf(user),
      event,
      properties: {
        ...properties,
        actorType: 'user',
      },
    });
  } catch {
    // Telemetry must never break the API
  }
}

/**
 * Record an event raised by the API itself rather than by a user action. The
 * API's stable identity groups events by installation without creating a person
 * profile. User-activity insights must still exclude system events: personless
 * events can contribute to unique-user counts. The running version lets health
 * measurements line up with releases.
 */
export function recordSystemEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    const ph = getClient();
    if (!ph) return;

    ph.capture({
      distinctId: getApiIdentity(),
      event,
      properties: {
        version: config.currVersion,
        ...properties,
        actorType: 'system',
        $process_person_profile: false,
      },
    });
  } catch {
    // Telemetry must never break the API
  }
}

function statusTelemetryWorkloadId(
  properties: Record<string, unknown>,
): string {
  return typeof properties.id === 'string' && properties.id
    ? properties.id
    : 'unknown';
}

function statusTelemetryCacheKey(
  user: User,
  properties: Record<string, unknown>,
): string {
  return `${distinctIdOf(user)}:${statusTelemetryWorkloadId(properties)}`;
}

function pruneStatusTelemetryCache(now: number): void {
  if (lastStatusTelemetryByCacheKey.size <= STATUS_TELEMETRY_MAX_KEYS) {
    return;
  }

  const staleBefore = now - STATUS_TELEMETRY_REPEAT_INTERVAL_MS;
  for (const [cacheKey, lastRecordedAt] of lastStatusTelemetryByCacheKey) {
    if (lastRecordedAt < staleBefore) {
      lastStatusTelemetryByCacheKey.delete(cacheKey);
    }
  }

  while (lastStatusTelemetryByCacheKey.size > STATUS_TELEMETRY_MAX_KEYS) {
    const oldestCacheKey = lastStatusTelemetryByCacheKey.keys().next().value;
    if (oldestCacheKey === undefined) {
      return;
    }
    lastStatusTelemetryByCacheKey.delete(oldestCacheKey);
  }
}

export function shouldRecordStatusEvent(
  user: User,
  properties: Record<string, unknown> = {},
  now = Date.now(),
): boolean {
  const cacheKey = statusTelemetryCacheKey(user, properties);
  const lastRecordedAt = lastStatusTelemetryByCacheKey.get(cacheKey);
  if (
    lastRecordedAt !== undefined &&
    now - lastRecordedAt < STATUS_TELEMETRY_REPEAT_INTERVAL_MS
  ) {
    return false;
  }

  lastStatusTelemetryByCacheKey.delete(cacheKey);
  lastStatusTelemetryByCacheKey.set(cacheKey, now);
  pruneStatusTelemetryCache(now);
  return true;
}

export function resetStatusTelemetryDedupeForTests(): void {
  lastStatusTelemetryByCacheKey.clear();
}

export function recordStatusEvent(
  user: User,
  properties?: Record<string, unknown>,
): void {
  if (!shouldRecordStatusEvent(user, properties)) return;
  recordEvent(user, 'status', properties);
}

/**
 * Flush pending events. Call on server shutdown.
 */
export async function shutdownTelemetry(): Promise<void> {
  try {
    if (client) {
      await client.shutdown();
      client = null;
    }
  } catch {
    // Best-effort
  }
}
