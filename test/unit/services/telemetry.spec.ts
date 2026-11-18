import { PostHog } from 'posthog-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config.js';
import * as apiIdentity from '../../../src/api/services/api-identity.js';
import type { User } from '../../../src/api/services/entities.js';
import {
  recordEvent,
  recordSystemEvent,
  resetStatusTelemetryDedupeForTests,
  shouldRecordStatusEvent,
  shutdownTelemetry,
  STATUS_TELEMETRY_MAX_KEYS,
  STATUS_TELEMETRY_REPEAT_INTERVAL_MS,
} from '../../../src/api/services/telemetry.js';

const user: User = {
  id: 'gh-test-user',
  username: 'test-user',
  token: 'token',
};
const otherUser: User = {
  id: 'gh-other-user',
  username: 'other-user',
  token: 'other-token',
};

describe('telemetry actor attribution', () => {
  const installationId = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    vi.stubEnv('IS_TEST', 'false');
    vi.stubEnv('ANYCLOUD_DISABLE_USAGE_COLLECTION', '0');
    vi.spyOn(PostHog.prototype, 'capture').mockImplementation(() => undefined);
    vi.spyOn(apiIdentity, 'getApiIdentity').mockReturnValue(installationId);
  });

  afterEach(async () => {
    await shutdownTelemetry();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('attributes user commands to the existing username', () => {
    recordEvent(user, 'exec', { id: 'job-1', actorType: 'system' });

    expect(PostHog.prototype.capture).toHaveBeenCalledExactlyOnceWith({
      distinctId: user.username,
      event: 'exec',
      properties: { id: 'job-1', actorType: 'user' },
    });
  });

  it.each(['api_degraded', 'api_recovered'])(
    'records %s as installation activity without person-profile processing',
    (event) => {
      recordSystemEvent(event, {
        signal: 'event_loop_stall',
        actorType: 'user',
        $process_person_profile: true,
      });

      expect(PostHog.prototype.capture).toHaveBeenCalledExactlyOnceWith({
        distinctId: installationId,
        event,
        properties: {
          version: config.currVersion,
          signal: 'event_loop_stall',
          actorType: 'system',
          $process_person_profile: false,
        },
      });
    },
  );

  it.each([
    ['IS_TEST', 'true'],
    ['ANYCLOUD_DISABLE_USAGE_COLLECTION', '1'],
  ])('suppresses both event types when %s=%s', (key, value) => {
    vi.stubEnv(key, value);

    recordEvent(user, 'exec');
    recordSystemEvent('api_degraded');

    expect(PostHog.prototype.capture).not.toHaveBeenCalled();
    expect(apiIdentity.getApiIdentity).not.toHaveBeenCalled();
  });

  it('keeps capture failures from interrupting user commands or health checks', () => {
    vi.mocked(PostHog.prototype.capture).mockImplementation(() => {
      throw new Error('capture failed');
    });

    expect(() => recordEvent(user, 'exec')).not.toThrow();
    expect(() => recordSystemEvent('api_degraded')).not.toThrow();
  });
});

describe('status telemetry dedupe', () => {
  beforeEach(() => {
    resetStatusTelemetryDedupeForTests();
  });

  it('suppresses repeated status polls for a workload inside the dedupe window', () => {
    const properties = {
      id: 'deploy-1',
      workloadState: 'running',
      status: 'up',
      verbose: false,
    };

    expect(shouldRecordStatusEvent(user, properties, 1_000)).toBe(true);
    expect(shouldRecordStatusEvent(user, properties, 2_000)).toBe(false);
  });

  it('suppresses changed status properties for the same workload inside the dedupe window', () => {
    const properties = {
      id: 'deploy-1',
      workloadState: 'running',
      status: 'up',
      verbose: false,
    };

    expect(shouldRecordStatusEvent(user, properties, 1_000)).toBe(true);
    expect(
      shouldRecordStatusEvent(
        user,
        { ...properties, workloadState: 'completed', status: 'down' },
        2_000,
      ),
    ).toBe(false);
  });

  it('records different workloads independently', () => {
    expect(shouldRecordStatusEvent(user, { id: 'deploy-1' }, 1_000)).toBe(true);
    expect(shouldRecordStatusEvent(user, { id: 'deploy-2' }, 2_000)).toBe(true);
  });

  it('records the same workload independently for different users', () => {
    expect(shouldRecordStatusEvent(user, { id: 'deploy-1' }, 1_000)).toBe(true);
    expect(shouldRecordStatusEvent(otherUser, { id: 'deploy-1' }, 2_000)).toBe(
      true,
    );
    expect(shouldRecordStatusEvent(user, { id: 'deploy-1' }, 3_000)).toBe(
      false,
    );
  });

  it('evicts oldest entries when fresh unique workloads exceed the cache cap', () => {
    for (let i = 0; i < STATUS_TELEMETRY_MAX_KEYS; i++) {
      expect(shouldRecordStatusEvent(user, { id: `deploy-${i}` }, 1_000)).toBe(
        true,
      );
    }

    expect(
      shouldRecordStatusEvent(
        user,
        { id: `deploy-${STATUS_TELEMETRY_MAX_KEYS}` },
        1_000,
      ),
    ).toBe(true);
    expect(shouldRecordStatusEvent(user, { id: 'deploy-0' }, 2_000)).toBe(true);
  });

  it('allows the same status shape again after the dedupe window', () => {
    const properties = {
      id: 'deploy-1',
      workloadState: 'running',
      status: 'up',
      verbose: false,
    };

    expect(shouldRecordStatusEvent(user, properties, 1_000)).toBe(true);
    expect(
      shouldRecordStatusEvent(
        user,
        properties,
        1_000 + STATUS_TELEMETRY_REPEAT_INTERVAL_MS,
      ),
    ).toBe(true);
  });
});
