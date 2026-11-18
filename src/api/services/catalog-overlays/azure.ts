import type { ResourceSku } from '@azure/arm-compute';
import type { AzureConnectionCreds } from '../../../shared/cloud.js';
import { CloudType } from '../../../shared/cloud.js';
import {
  getCatalogDiskSource,
  readCatalog,
  type CatalogIndexes,
} from '../../../shared/catalog/index.js';
import {
  ConcurrencyLimiter,
  singleFlight,
  TemporalGate,
} from '../../../shared/utils.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  retryAfterMs,
  type RetryAfterHeaders,
} from '../../../shared/retry-after.js';
import {
  CandidateRegionAvailability,
  pAllSettledLimit,
  type CandidateRegion,
} from '../gateways/cloud.js';
import type {
  CatalogOverlayProvider,
  CatalogOverlaySnapshot,
} from '../catalog-overlay.js';
import { armClientOptions } from '../azure-client-options.js';
import { log } from '../logger.js';
import {
  createAzureCredential,
  createAzureComputeManagementClient,
} from '../provider-clients/azure.js';
import {
  azureCatalogTargetKey,
  buildAzureCatalogDefinition,
  buildAzureCatalogRegionObservation,
  createAzureSkuAvailabilityIndex,
  indexAzureResourceSku,
  normalizeAzureCatalogLocation,
  type AzureCatalogDefinition,
  type AzureCatalogRegion,
  type AzureCatalogRegionObservation,
} from './azure-model.js';
import {
  AzureCatalogOverlayStore,
  FileAzureCatalogOverlayStore,
  type AzureCatalogOverlayIdentity,
  type AzureCatalogOverlayRegionState,
} from './azure-store.js';

// This is a failed-side-effect retry gate, not a data TTL. Successful regional
// observations remain valid until explicitly invalidated or their catalog
// target set changes.
export const AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS = 60_000;
/** Maximum regional SKU reads active across all subscriptions in this process. */
export const AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY = 4;

export interface AzureCatalogOverlaySource {
  readonly revision: string;
  readonly catalog: Pick<CatalogIndexes, 'typesPerRegion'>;
}

interface RevisionedAzureCatalogDefinition {
  readonly revision: string;
  readonly definition: AzureCatalogDefinition;
}

interface AzureCatalogOverlayRefreshContext {
  readonly key: string;
  readonly account: string;
  readonly catalogRevision: string;
  readonly invalidatedRegions: Set<string>;
  readonly regions: Map<string, AzureCatalogOverlayRegionState>;
  invalidatedAll: boolean;
}

export type AzureCatalogRegionReader = (
  region: AzureCatalogRegion,
) => Promise<AzureCatalogRegionObservation>;

type AzureCatalogRegionReaderFactory = (
  credentials: AzureConnectionCreds,
) => AzureCatalogRegionReader;

function defaultCatalogSource(): AzureCatalogOverlaySource | undefined {
  // cloudtype-boundary-ok: this Azure adapter augments Azure's catalog only.
  const before = getCatalogDiskSource(CloudType.Azure);
  if (!before) return undefined;
  const catalog = readCatalog(CloudType.Azure);
  const after = getCatalogDiskSource(CloudType.Azure);
  if (!catalog || !after || before.revision !== after.revision)
    return undefined;
  return { revision: after.revision, catalog };
}

function azureResourceSkuLocationFilter(region: string): string {
  const normalized = normalizeAzureCatalogLocation(region).replace(/'/g, "''");
  return `location eq '${normalized}'`;
}

/** Collect exactly one server-filtered region without retaining SDK objects. */
export async function collectAzureCatalogRegionObservation(
  listResourceSkus: (options: { filter: string }) => AsyncIterable<ResourceSku>,
  catalogRegion: AzureCatalogRegion,
  observedAt = Date.now(),
): Promise<AzureCatalogRegionObservation> {
  const index = createAzureSkuAvailabilityIndex();
  for await (const sku of listResourceSkus({
    filter: azureResourceSkuLocationFilter(catalogRegion.region),
  })) {
    indexAzureResourceSku(index, sku);
  }
  return buildAzureCatalogRegionObservation(catalogRegion, index, observedAt);
}

function createAzureCatalogRegionReader(
  credentials: AzureConnectionCreds,
): AzureCatalogRegionReader {
  const credential = createAzureCredential(credentials);
  const client = createAzureComputeManagementClient(
    credential,
    credentials.subscriptionId,
    armClientOptions(),
  );
  return (catalogRegion) =>
    collectAzureCatalogRegionObservation(
      (options) => client.resourceSkus.list(options),
      catalogRegion,
    );
}

function isSystemicAzureCatalogAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = candidate.statusCode ?? candidate.status;
  if (status === 401 || status === 403) return true;

  if (
    typeof candidate.name === 'string' &&
    /^(?:AuthenticationError|AuthenticationRequiredError)$/i.test(
      candidate.name,
    )
  ) {
    return true;
  }

  const code = candidate.code ?? candidate.name;
  if (
    typeof code === 'string' &&
    /^(?:AuthorizationFailed|InvalidAuthenticationToken(?:Tenant)?|ExpiredAuthenticationToken)$/i.test(
      code,
    )
  ) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /AADSTS(?:700016|7000215|7000222|700038|90002|900023)\b|invalid_client/i.test(
      candidate.message,
    )
  );
}

function isAzureCatalogThrottleError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status = candidate.statusCode ?? candidate.status;
  if (status === 429 || status === '429') return true;
  const code = candidate.code ?? candidate.name;
  return (
    typeof code === 'string' &&
    /^(?:TooManyRequests|SubscriptionRequestsThrottled)$/i.test(code)
  );
}

function overlayIdentity(
  credentials: AzureConnectionCreds,
): AzureCatalogOverlayIdentity {
  return {
    directoryId: credentials.directoryId,
    subscriptionId: credentials.subscriptionId,
  };
}

function accountKey(identity: AzureCatalogOverlayIdentity): string {
  return `${identity.directoryId.trim().toLowerCase()}\u0000${identity.subscriptionId.trim().toLowerCase()}`;
}

function inFlightKey(account: string, catalogRevision: string): string {
  return `${account}\u0000${catalogRevision}`;
}

function failureGateKey(
  account: string,
  catalogRevision: string,
  region: string,
): string {
  return `${account}\u0000${catalogRevision}\u0000${region}`;
}

export interface AzureCatalogOverlayCoordinatorOptions {
  createRegionReader?: AzureCatalogRegionReaderFactory;
  getCatalogSource?: () => AzureCatalogOverlaySource | undefined;
  store?: AzureCatalogOverlayStore;
  now?: () => number;
}

/** Process-wide owner of Azure overlay refresh coordination. */
export class AzureCatalogOverlayCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly activeRefreshes = new Map<
    string,
    AzureCatalogOverlayRefreshContext
  >();
  private readonly regionReads = new ConcurrencyLimiter(
    AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
  );
  private readonly failureGate: TemporalGate<string>;
  private readonly throttleGate: TemporalGate<string>;
  private readonly createRegionReader: AzureCatalogRegionReaderFactory;
  private readonly getCatalogSource: () =>
    | AzureCatalogOverlaySource
    | undefined;
  private readonly store: AzureCatalogOverlayStore;
  private readonly now: () => number;
  private catalogDefinition: RevisionedAzureCatalogDefinition | undefined;

  constructor(options: AzureCatalogOverlayCoordinatorOptions = {}) {
    // cloudtype-boundary-ok: this coordinator implements Azure's provider role.
    this.createRegionReader =
      options.createRegionReader ?? createAzureCatalogRegionReader;
    this.getCatalogSource = options.getCatalogSource ?? defaultCatalogSource;
    this.store = options.store ?? new AzureCatalogOverlayStore();
    this.now = options.now ?? (() => Date.now());
    this.failureGate = new TemporalGate(this.now);
    this.throttleGate = new TemporalGate(this.now);
  }

  createProvider(credentials: AzureConnectionCreds): CatalogOverlayProvider {
    return {
      cloud: CloudType.Azure,
      read: () => this.read(credentials),
      refresh: (reason) => this.refresh(credentials, reason),
      invalidate: (reason, region) =>
        this.invalidate(credentials, reason, region),
    };
  }

  private currentCatalog(): RevisionedAzureCatalogDefinition | undefined {
    const source = this.getCatalogSource();
    if (!source) return undefined;
    if (this.catalogDefinition?.revision === source.revision) {
      return this.catalogDefinition;
    }

    this.catalogDefinition = {
      revision: source.revision,
      definition: buildAzureCatalogDefinition(source.catalog),
    };
    for (const refresh of this.activeRefreshes.values()) {
      refresh.invalidatedAll = true;
    }
    this.failureGate.clear();
    return this.catalogDefinition;
  }

  private read(
    credentials: AzureConnectionCreds,
  ): CatalogOverlaySnapshot | undefined {
    const catalog = this.currentCatalog();
    if (!catalog) return undefined;
    const identity = overlayIdentity(credentials);
    const account = accountKey(identity);
    const stored = this.store.read(identity);
    const observedRegions = this.compatibleRegions(catalog, stored);
    const active = this.activeRefreshes.get(
      inFlightKey(account, catalog.revision),
    );
    if (active && !active.invalidatedAll) {
      for (const [region, state] of active.regions) {
        observedRegions.set(region, state);
      }
    }
    if (observedRegions.size === 0) return undefined;

    // A returned snapshot stays immutable even as later regions finish.
    const observedAt = Math.max(
      ...[...observedRegions.values()].map((region) => region.observedAt),
    );
    return {
      observedAt,
      assessCandidate: (candidate: CandidateRegion) => {
        const region = normalizeAzureCatalogLocation(candidate.region);
        const catalogRegion = catalog.definition.regions.get(region);
        const target = azureCatalogTargetKey(candidate.vmType, region);
        if (!catalogRegion?.targetKeys.has(target)) return undefined;

        const observed = observedRegions.get(region);
        if (!observed) return CandidateRegionAvailability.Unknown;
        return observed.restrictedTargets.has(target)
          ? CandidateRegionAvailability.Unknown
          : CandidateRegionAvailability.Verified;
      },
    };
  }

  private refresh(
    credentials: AzureConnectionCreds,
    reason: string,
  ): Promise<void> {
    const catalog = this.currentCatalog();
    if (!catalog) return Promise.resolve();

    const identity = overlayIdentity(credentials);
    const account = accountKey(identity);
    const key = inFlightKey(account, catalog.revision);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    return singleFlight(this.inFlight, key, async () => {
      const refresh: AzureCatalogOverlayRefreshContext = {
        key,
        account,
        catalogRevision: catalog.revision,
        invalidatedRegions: new Set(),
        regions: new Map(),
        invalidatedAll: false,
      };
      this.activeRefreshes.set(key, refresh);
      try {
        const observed = this.compatibleRegions(
          catalog,
          this.store.read(identity),
        );
        if (this.throttleGate.isClosed(account)) return;
        const missing: AzureCatalogRegion[] = [];
        for (const catalogRegion of catalog.definition.regions.values()) {
          const gateKey = failureGateKey(
            account,
            catalog.revision,
            catalogRegion.region,
          );
          if (
            observed.has(catalogRegion.region) ||
            this.failureGate.isClosed(gateKey)
          ) {
            continue;
          }
          missing.push(catalogRegion);
        }
        if (missing.length === 0) return;

        await this.refreshRegions(
          credentials,
          reason,
          account,
          catalog,
          refresh,
          missing,
        );
      } finally {
        if (this.activeRefreshes.get(key) === refresh) {
          this.activeRefreshes.delete(key);
        }
      }
    });
  }

  private async refreshRegions(
    credentials: AzureConnectionCreds,
    reason: string,
    account: string,
    catalog: RevisionedAzureCatalogDefinition,
    refresh: AzureCatalogOverlayRefreshContext,
    missing: AzureCatalogRegion[],
  ): Promise<void> {
    const subscriptionId = credentials.subscriptionId;
    const startedAt = Date.now();
    let reader: AzureCatalogRegionReader;
    try {
      reader = this.createRegionReader(credentials);
    } catch (error) {
      this.closeFailureGates(account, refresh, missing);
      throw error;
    }

    let haltNewRequestsError: unknown;
    let throttleRetryAfterMs: number | undefined;
    let requests = 0;
    const settled = await pAllSettledLimit(
      missing,
      AZURE_CATALOG_OVERLAY_REGION_CONCURRENCY,
      (job) =>
        this.regionReads.run(async () => {
          // This refresh may have waited behind another subscription. Recheck
          // its state only after it owns a process-wide read slot.
          if (!this.isRefreshCurrent(refresh, job.region)) {
            throw new Error('Azure catalog overlay state was replaced');
          }
          if (haltNewRequestsError !== undefined) {
            throw haltNewRequestsError;
          }
          requests += 1;
          try {
            const observation = await reader(job);
            if (
              normalizeAzureCatalogLocation(observation.region) !== job.region
            ) {
              throw new Error(
                `Azure Resource SKUs returned an observation for ${observation.region} while refreshing ${job.region}`,
              );
            }
            if (this.isRefreshCurrent(refresh, job.region)) {
              refresh.regions.set(job.region, {
                targetFingerprint: job.targetFingerprint,
                observedAt: observation.observedAt,
                restrictedTargets: new Set(
                  observation.restrictedTargets.filter((target) =>
                    job.targetKeys.has(target),
                  ),
                ),
              });
            }
            return observation;
          } catch (error) {
            if (isAzureCatalogThrottleError(error)) {
              const waitMs =
                retryAfterMs(
                  (error as { response?: { headers?: RetryAfterHeaders } })
                    .response?.headers,
                  this.now(),
                ) ?? AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS;
              throttleRetryAfterMs = Math.max(
                throttleRetryAfterMs ?? 0,
                waitMs,
              );
              haltNewRequestsError = error;
            } else if (isSystemicAzureCatalogAuthError(error)) {
              haltNewRequestsError = error;
            }
            throw error;
          }
        }),
    );

    if (throttleRetryAfterMs !== undefined) {
      this.throttleGate.closeFor(account, throttleRetryAfterMs);
    }

    const successful: AzureCatalogRegionObservation[] = [];
    const failures: unknown[] = [];
    settled.forEach((result, index) => {
      const job = missing[index]!;
      const gateKey = failureGateKey(account, catalog.revision, job.region);
      if (result.status === 'fulfilled') {
        successful.push(result.value);
        if (this.isRefreshCurrent(refresh, job.region)) {
          this.failureGate.reset(gateKey);
        }
      } else {
        failures.push(result.reason);
        if (this.isRefreshCurrent(refresh, job.region)) {
          this.failureGate.closeFor(
            gateKey,
            AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS,
          );
        }
      }
    });

    let observedRegions = 0;
    if (this.isRefreshActive(refresh) && refresh.regions.size > 0) {
      const regions = this.compatibleRegions(
        catalog,
        this.store.read(overlayIdentity(credentials)),
      );
      for (const [region, state] of refresh.regions) regions.set(region, state);
      observedRegions = this.store.write(
        overlayIdentity(credentials),
        regions,
      ).size;
    }

    if (successful.length > 0) {
      log.info('Azure subscription catalog overlay regions refreshed', {
        id: 'system',
        subscriptionId,
        reason,
        attemptedRegions: missing.length,
        requestedRegions: requests,
        refreshedRegions: successful.length,
        observedRegions,
        catalogRegions: catalog.definition.regions.size,
        catalogTargets: successful.reduce(
          (sum, observation) => sum + observation.catalogTargets,
          0,
        ),
        restrictedTargets: successful.reduce(
          (sum, observation) => sum + observation.restrictedTargets.length,
          0,
        ),
        totalEntries: successful.reduce(
          (sum, observation) => sum + observation.totalEntries,
          0,
        ),
        vmEntries: successful.reduce(
          (sum, observation) => sum + observation.vmEntries,
          0,
        ),
        durationMs: Date.now() - startedAt,
      });
    }
    if (failures.length > 0) {
      log.warn('Some Azure subscription catalog overlay regions failed', {
        id: 'system',
        subscriptionId,
        reason,
        attemptedRegions: missing.length,
        requestedRegions: requests,
        failedRegions: failures.length,
        error: errorMessage(failures[0]),
      });
    }
    if (successful.length === 0 && failures.length > 0) {
      throw failures[0];
    }
  }

  private invalidate(
    credentials: AzureConnectionCreds,
    reason: string,
    requestedRegion?: string,
  ): void {
    const identity = overlayIdentity(credentials);
    const account = accountKey(identity);
    const subscriptionId = credentials.subscriptionId;
    const region =
      requestedRegion === undefined
        ? undefined
        : normalizeAzureCatalogLocation(requestedRegion);

    for (const refresh of this.activeRefreshes.values()) {
      if (refresh.account !== account) continue;
      if (region === undefined) {
        refresh.invalidatedAll = true;
        refresh.regions.clear();
      } else {
        refresh.invalidatedRegions.add(region);
        refresh.regions.delete(region);
      }
    }
    this.resetFailureGates(account, region);
    this.store.invalidate(identity, region);

    log.debug('Azure subscription catalog overlay invalidated', {
      id: 'system',
      subscriptionId,
      reason,
      region: requestedRegion,
    });
  }

  private compatibleRegions(
    catalog: RevisionedAzureCatalogDefinition,
    stored: ReadonlyMap<string, AzureCatalogOverlayRegionState> | undefined,
  ): Map<string, AzureCatalogOverlayRegionState> {
    const compatible = new Map<string, AzureCatalogOverlayRegionState>();
    if (!stored) return compatible;
    for (const [region, state] of stored) {
      const catalogRegion = catalog.definition.regions.get(region);
      if (
        !catalogRegion ||
        state.targetFingerprint !== catalogRegion.targetFingerprint
      ) {
        continue;
      }
      compatible.set(region, state);
    }
    return compatible;
  }

  private closeFailureGates(
    account: string,
    refresh: AzureCatalogOverlayRefreshContext,
    missing: readonly AzureCatalogRegion[],
  ): void {
    for (const catalogRegion of missing) {
      if (!this.isRefreshCurrent(refresh, catalogRegion.region)) continue;
      const key = failureGateKey(
        account,
        refresh.catalogRevision,
        catalogRegion.region,
      );
      this.failureGate.closeFor(
        key,
        AZURE_CATALOG_OVERLAY_MIN_REFRESH_INTERVAL_MS,
      );
    }
  }

  private resetFailureGates(account: string, region?: string): void {
    const catalog = this.catalogDefinition;
    if (!catalog) return;
    if (region !== undefined) {
      this.failureGate.reset(failureGateKey(account, catalog.revision, region));
      return;
    }
    for (const catalogRegion of catalog.definition.regions.values()) {
      this.failureGate.reset(
        failureGateKey(account, catalog.revision, catalogRegion.region),
      );
    }
  }

  private isRefreshCurrent(
    refresh: AzureCatalogOverlayRefreshContext,
    region: string,
  ): boolean {
    return (
      this.isRefreshActive(refresh) && !refresh.invalidatedRegions.has(region)
    );
  }

  private isRefreshActive(refresh: AzureCatalogOverlayRefreshContext): boolean {
    return (
      this.activeRefreshes.get(refresh.key) === refresh &&
      !refresh.invalidatedAll
    );
  }

  reset(): void {
    for (const refresh of this.activeRefreshes.values()) {
      refresh.invalidatedAll = true;
    }
    this.activeRefreshes.clear();
    this.inFlight.clear();
    this.store.clearCache();
    this.failureGate.clear();
    this.throttleGate.clear();
    this.catalogDefinition = undefined;
  }
}

const azureCatalogOverlayCoordinator = new AzureCatalogOverlayCoordinator({
  store: new FileAzureCatalogOverlayStore(),
});

export function createAzureCatalogOverlayProvider(
  credentials: AzureConnectionCreds,
): CatalogOverlayProvider {
  return azureCatalogOverlayCoordinator.createProvider(credentials);
}
