/**
 * GCS buckets the credentials-onboarding E2E creates to prove an imported key
 * works (`anycloud-onb-smoke-<n>-<hex>`). A refused key leaves them behind, so
 * the CI sweep removes any older than an hour. Buckets are project-global.
 */

import { Storage } from '@google-cloud/storage';
import type { GCPCreds } from '../../src/shared/cloud.js';
import type { ResourceSweepResult } from '../../src/api/services/gateways/resource-sweeper';

const PREFIX = 'anycloud-onb-smoke-';
export const ONBOARDING_SMOKE_BUCKET_MIN_AGE_MS = 60 * 60 * 1000;
const NAME = /^anycloud-onb-smoke-\d+-[0-9a-f]{8,}$/u;

/** Exactly the smoke names, only older than the floor; unknown creation time is never swept. */
export function selectOnboardingSmokeBuckets(
  buckets: Array<{ name: string; timeCreated: string | null | undefined }>,
  now: number,
  minAgeMs = ONBOARDING_SMOKE_BUCKET_MIN_AGE_MS,
): string[] {
  return buckets
    .filter(
      (bucket) =>
        NAME.test(bucket.name) &&
        !!bucket.timeCreated &&
        now - Date.parse(bucket.timeCreated) >= minAgeMs,
    )
    .map((bucket) => bucket.name);
}

export async function sweepOnboardingSmokeBuckets(
  credentials: GCPCreds,
): Promise<ResourceSweepResult> {
  const result: ResourceSweepResult = {
    vmIds: [],
    otherResources: [],
    errors: [],
  };
  const fail = (resourceId: string, error: unknown) =>
    result.errors.push({
      resourceType: 'bucket',
      resourceId,
      error: (error as Error).message,
    });
  const storage = new Storage({
    projectId: credentials.projectId,
    credentials: {
      private_key: credentials.privateKey,
      client_email: credentials.clientEmail,
    },
  });
  let names: string[] = [];
  try {
    const [buckets] = await storage.getBuckets({ prefix: PREFIX });
    names = selectOnboardingSmokeBuckets(
      buckets.map((b) => ({
        name: b.name,
        timeCreated: b.metadata.timeCreated,
      })),
      Date.now(),
    );
  } catch (error) {
    fail(`${PREFIX}*`, error);
  }
  for (const name of names) {
    try {
      await storage.bucket(name).deleteFiles({ force: true });
      await storage.bucket(name).delete();
      result.otherResources.push({ type: 'bucket', id: name });
    } catch (error) {
      fail(name, error);
    }
  }
  return result;
}
