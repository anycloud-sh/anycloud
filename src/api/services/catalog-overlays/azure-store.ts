import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomicSync } from '../../../shared/atomic-file.js';
import type { AzureCreds } from '../../../shared/cloud.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { getAnycloudDir } from '../../../shared/utils.js';
import { log } from '../logger.js';
import { normalizeAzureCatalogLocation } from './azure-model.js';

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 8;

export type AzureCatalogOverlayIdentity = Pick<
  AzureCreds,
  'directoryId' | 'subscriptionId'
>;

export interface AzureCatalogOverlayRegionState {
  readonly targetFingerprint: string;
  readonly observedAt: number;
  readonly restrictedTargets: ReadonlySet<string>;
}

interface SerializedRegion {
  readonly region: string;
  readonly targetFingerprint: string;
  readonly observedAt: number;
  readonly restrictedTargets: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createState(
  source: ReadonlyMap<string, AzureCatalogOverlayRegionState>,
): ReadonlyMap<string, AzureCatalogOverlayRegionState> {
  const regions = new Map<string, AzureCatalogOverlayRegionState>();
  for (const [rawRegion, value] of [...source].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const region = normalizeAzureCatalogLocation(rawRegion);
    if (region.length === 0 || regions.has(region)) {
      throw new Error('Invalid Azure catalog overlay cache region');
    }
    regions.set(region, {
      targetFingerprint: value.targetFingerprint,
      observedAt: value.observedAt,
      restrictedTargets: new Set([...value.restrictedTargets].sort()),
    });
  }
  return regions;
}

function parse(
  raw: string,
): ReadonlyMap<string, AzureCatalogOverlayRegionState> {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(parsed.regions)
  ) {
    throw new Error('Unsupported Azure catalog overlay cache format');
  }
  const regions = new Map<string, AzureCatalogOverlayRegionState>();
  for (const value of parsed.regions) {
    if (
      !isRecord(value) ||
      typeof value.region !== 'string' ||
      typeof value.targetFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.targetFingerprint) ||
      typeof value.observedAt !== 'number' ||
      !Number.isFinite(value.observedAt) ||
      value.observedAt < 0 ||
      !Array.isArray(value.restrictedTargets) ||
      !value.restrictedTargets.every((target) => typeof target === 'string')
    ) {
      throw new Error('Invalid Azure catalog overlay cache entry');
    }
    const region = normalizeAzureCatalogLocation(value.region);
    if (region.length === 0 || regions.has(region)) {
      throw new Error('Duplicate Azure catalog overlay cache region');
    }
    regions.set(region, {
      targetFingerprint: value.targetFingerprint,
      observedAt: value.observedAt,
      restrictedTargets: new Set(value.restrictedTargets),
    });
  }
  return createState(regions);
}

function identityDigest(identity: AzureCatalogOverlayIdentity): string {
  return createHash('sha256')
    .update(identity.directoryId.trim().toLowerCase())
    .update('\u0000')
    .update(identity.subscriptionId.trim().toLowerCase())
    .digest('hex');
}

/** Bounded read-through cache following the regular catalog's disk convention. */
export class AzureCatalogOverlayStore {
  private readonly cache = new Map<
    string,
    ReadonlyMap<string, AzureCatalogOverlayRegionState>
  >();

  constructor(private readonly getDirectory?: () => string) {}

  read(
    identity: AzureCatalogOverlayIdentity,
  ): ReadonlyMap<string, AzureCatalogOverlayRegionState> | undefined {
    const key = identityDigest(identity);
    const cached = this.cache.get(key);
    if (cached) {
      this.remember(key, cached);
      return cached;
    }
    const directory = this.getDirectory?.();
    if (!directory) return undefined;
    try {
      const stored = parse(
        readFileSync(this.path(directory, identity), 'utf8'),
      );
      this.remember(key, stored);
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn('read', identity, error);
      }
      return undefined;
    }
  }

  write(
    identity: AzureCatalogOverlayIdentity,
    regions: ReadonlyMap<string, AzureCatalogOverlayRegionState>,
  ): ReadonlyMap<string, AzureCatalogOverlayRegionState> {
    const state = createState(regions);
    this.remember(identityDigest(identity), state);
    const directory = this.getDirectory?.();
    if (!directory) return state;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const serialized = {
        schemaVersion: SCHEMA_VERSION,
        regions: [...state].map(
          ([region, value]): SerializedRegion => ({
            region,
            targetFingerprint: value.targetFingerprint,
            observedAt: value.observedAt,
            restrictedTargets: [...value.restrictedTargets],
          }),
        ),
      };
      writeTextFileAtomicSync(
        this.path(directory, identity),
        JSON.stringify(serialized),
        { mode: 0o600 },
      );
    } catch (error) {
      this.warn('persist', identity, error);
    }
    return state;
  }

  invalidate(identity: AzureCatalogOverlayIdentity, region?: string): void {
    const key = identityDigest(identity);
    if (region === undefined) {
      this.cache.delete(key);
      this.remove(identity);
      return;
    }
    const current = this.read(identity);
    if (!current) return;
    const regions = new Map(current);
    if (!regions.delete(normalizeAzureCatalogLocation(region))) return;
    if (regions.size > 0) this.write(identity, regions);
    else {
      this.cache.delete(key);
      this.remove(identity);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private remember(
    key: string,
    state: ReadonlyMap<string, AzureCatalogOverlayRegionState>,
  ): void {
    this.cache.delete(key);
    this.cache.set(key, state);
    while (this.cache.size > MAX_ACCOUNTS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private remove(identity: AzureCatalogOverlayIdentity): void {
    const directory = this.getDirectory?.();
    if (!directory) return;
    try {
      rmSync(this.path(directory, identity), { force: true });
    } catch (error) {
      this.warn('invalidate', identity, error);
    }
  }

  private path(
    directory: string,
    identity: AzureCatalogOverlayIdentity,
  ): string {
    return join(directory, `${identityDigest(identity)}.json`);
  }

  private warn(
    operation: 'read' | 'persist' | 'invalidate',
    identity: AzureCatalogOverlayIdentity,
    error: unknown,
  ): void {
    log.warn(
      `Failed to ${operation} Azure subscription catalog overlay cache`,
      {
        id: 'system',
        subscriptionId: identity.subscriptionId,
        error: errorMessage(error),
      },
    );
  }
}

export class FileAzureCatalogOverlayStore extends AzureCatalogOverlayStore {
  constructor(directory?: string) {
    super(
      () => directory ?? join(getAnycloudDir(), 'catalog-overlays', 'azure'),
    );
  }
}
