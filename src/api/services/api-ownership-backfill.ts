import {
  extractCredentials,
  isCloudType,
  requiresComputeCredentials,
} from '../../shared/cloud-config.js';
import type { CloudConfig, CloudType } from '../../shared/cloud.js';
import {
  apiOwnershipRequiresRegion,
  createApiOwnershipProvider,
  decryptCredential,
} from './cloud-config.js';
import {
  ApiOwnershipTargetStatus,
  type ApiOwnershipBackfillSummary,
  type ApiOwnershipBackfillTarget,
  type ApiOwnershipRepository,
} from './api-ownership-store.js';
import {
  ApiOwnershipBackfillResult,
  ApiOwnershipConflictError,
  type CloudApiOwnership,
} from './gateways/api-ownership.js';
import { pAllSettledLimit } from './gateways/cloud.js';
import { getApiIdentity } from './api-identity.js';
import { log } from './logger.js';
import {
  getApiOwnershipStore,
  getCredentialSecretStore,
} from './persistence.js';
import { redactSecrets } from './redact.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const BACKFILL_BATCH_SIZE = 20;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_RETRY_INTERVAL_MS = 5 * 60 * 1000;

interface CredentialReader {
  getCredentialWithCloudProvider(
    credentialId: string,
  ): Promise<{ encryptedData: string; cloudProvider: CloudType } | null>;
}

export interface ApiOwnershipBackfillDependencies {
  readonly store: ApiOwnershipRepository;
  readonly credentials: CredentialReader;
  readonly apiIdentity: string;
  readonly createProvider: (config: CloudConfig) => CloudApiOwnership | null;
}

export interface ApiOwnershipBackfillBatchResult {
  processed: number;
  persistedResults: number;
  summary: ApiOwnershipBackfillSummary;
}

function redactedErrorMessage(error: unknown): string {
  return redactSecrets(errorMessage(error)).slice(0, 2_000);
}

async function processTarget(
  target: ApiOwnershipBackfillTarget,
  deps: ApiOwnershipBackfillDependencies,
): Promise<void> {
  if (target.endedAt !== null) {
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Completed,
    );
    return;
  }
  if (
    !target.ownerId ||
    !target.userId ||
    !target.cloudProvider ||
    !isCloudType(target.cloudProvider)
  ) {
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Unsupported,
      'Durable owner or cloud provider metadata is unavailable',
    );
    return;
  }
  if (!target.region && apiOwnershipRequiresRegion(target.cloudProvider)) {
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Unsupported,
      `Durable ${target.cloudProvider} region metadata is unavailable`,
    );
    return;
  }

  let credentials: CloudConfig['credentials'];
  if (target.credentialId) {
    const credential = await deps.credentials.getCredentialWithCloudProvider(
      target.credentialId,
    );
    if (!credential) {
      await deps.store.recordTargetResult(
        target.vmRowId,
        ApiOwnershipTargetStatus.Retry,
        `Credential ${target.credentialId} is unavailable`,
      );
      return;
    }
    if (credential.cloudProvider !== target.cloudProvider) {
      await deps.store.recordTargetResult(
        target.vmRowId,
        ApiOwnershipTargetStatus.Conflict,
        `Credential provider ${credential.cloudProvider} does not match ${target.cloudProvider}`,
      );
      return;
    }
    credentials = extractCredentials(
      await decryptCredential(credential.encryptedData),
    );
  } else if (requiresComputeCredentials(target.cloudProvider)) {
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Retry,
      'Compute credential is unavailable',
    );
    return;
  }

  const provider = deps.createProvider({
    cloudProvider: target.cloudProvider,
    credentials,
    region: target.region ?? undefined,
    availabilityZone: target.availabilityZone ?? undefined,
    vmType: target.vmType ?? undefined,
  });
  if (!provider) {
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Unsupported,
      `${target.cloudProvider} cannot mutate ownership metadata on an existing VM`,
    );
    return;
  }

  try {
    const result = await provider.backfillExactVM({
      cloudId: target.cloudId,
      apiIdentity: deps.apiIdentity,
      ownerKind: target.ownerKind,
      ownerId: target.ownerId,
      userId: target.userId,
    });
    if (result === ApiOwnershipBackfillResult.Missing) {
      await deps.store.recordTargetResult(
        target.vmRowId,
        ApiOwnershipTargetStatus.Missing,
        'Provider resource was not found in the scope resolved from durable placement',
      );
      return;
    }
    await deps.store.recordTargetResult(
      target.vmRowId,
      ApiOwnershipTargetStatus.Completed,
    );
  } catch (error) {
    const conflict = error instanceof ApiOwnershipConflictError;
    const message = redactedErrorMessage(error);
    await deps.store.recordTargetResult(
      target.vmRowId,
      conflict
        ? ApiOwnershipTargetStatus.Conflict
        : ApiOwnershipTargetStatus.Retry,
      message,
    );
    log[conflict ? 'error' : 'warn']('API ownership backfill deferred', {
      id: target.ownerId,
      cloudId: target.cloudId,
      provider: target.cloudProvider,
      error: message,
    });
  }
}

export async function runApiOwnershipBackfillBatch(
  dependencies?: ApiOwnershipBackfillDependencies,
): Promise<ApiOwnershipBackfillBatchResult> {
  const deps =
    dependencies ??
    ({
      store: getApiOwnershipStore(),
      credentials: getCredentialSecretStore(),
      apiIdentity: getApiIdentity(),
      createProvider: createApiOwnershipProvider,
    } satisfies ApiOwnershipBackfillDependencies);
  const targets = await deps.store.listActionableTargets(BACKFILL_BATCH_SIZE);
  const results = await pAllSettledLimit(
    targets,
    BACKFILL_CONCURRENCY,
    (target) => processTarget(target, deps),
  );
  let persistedResults = 0;
  for (const [index, result] of results.entries()) {
    // Every fulfilled target awaited its durable status update.
    if (result.status === 'fulfilled') {
      persistedResults++;
      continue;
    }
    const target = targets[index]!;
    const message = redactedErrorMessage(result.reason);
    try {
      await deps.store.recordTargetResult(
        target.vmRowId,
        ApiOwnershipTargetStatus.Retry,
        message,
      );
      persistedResults++;
      log.warn('API ownership backfill deferred', {
        id: target.ownerId,
        cloudId: target.cloudId,
        provider: target.cloudProvider,
        error: message,
      });
    } catch (persistError) {
      log.error('Could not persist API ownership backfill result', {
        id: target.ownerId,
        cloudId: target.cloudId,
        error: redactedErrorMessage(persistError),
      });
    }
  }
  return {
    processed: targets.length,
    persistedResults,
    summary: await deps.store.summarize(),
  };
}

let active = false;
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

function schedule(delayMs: number): void {
  if (!active) return;
  timer = setTimeout(() => {
    timer = null;
    running = runScheduledBatch().finally(() => {
      running = null;
    });
  }, delayMs).unref();
}

async function runScheduledBatch(): Promise<void> {
  try {
    const result = await runApiOwnershipBackfillBatch();
    const actionable = result.summary.pending + result.summary.retry;
    if (!active || actionable === 0) {
      if (result.processed > 0) {
        log.info('API ownership backfill settled', {
          id: 'system',
          ...result.summary,
        });
      }
      return;
    }
    // Drain never-attempted targets only while this batch made durable progress.
    // A positive global pending count can otherwise survive a read-only/full
    // database and turn failed status writes into a zero-delay provider loop.
    schedule(
      result.summary.pending > 0 && result.persistedResults > 0
        ? 0
        : BACKFILL_RETRY_INTERVAL_MS,
    );
  } catch (error) {
    log.error('API ownership backfill failed', {
      id: 'system',
      error: redactedErrorMessage(error),
    });
    schedule(BACKFILL_RETRY_INTERVAL_MS);
  }
}

/**
 * Start a non-blocking backfill whose candidates are exact SQLite-known IDs.
 * A provider may use a filtered inventory lookup to resolve target metadata.
 */
export function startApiOwnershipBackfill(): void {
  if (active) return;
  active = true;
  schedule(0);
}

export function stopApiOwnershipBackfill(): void {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** @internal Exposed only so lifecycle tests can assert no work is in flight. */
export function apiOwnershipBackfillIsRunning(): boolean {
  return running !== null;
}
