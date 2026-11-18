import type { CloudType } from '../../shared/cloud.js';
import type {
  CandidateRegion,
  CandidateRegionAvailability,
} from './gateways/cloud.js';

/**
 * An immutable, account-scoped augmentation of the published machine catalog.
 * A snapshot may rank a target, but it must not invent structural targets that
 * are absent from the published catalog.
 */
export interface CatalogOverlaySnapshot {
  readonly observedAt: number;
  assessCandidate(
    candidate: CandidateRegion,
  ): CandidateRegionAvailability | undefined;
}

/**
 * Optional provider role for clouds with an expensive account-specific catalog
 * view. Reads are synchronous; refreshes happen independently of placement.
 */
export interface CatalogOverlayProvider {
  readonly cloud: CloudType;
  read(): CatalogOverlaySnapshot | undefined;
  refresh(reason: string): Promise<void>;
  invalidate(reason: string, region?: string): void;
}
