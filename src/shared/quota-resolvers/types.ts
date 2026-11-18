import { CloudType } from '../cloud.js';

type QuotaResourceKind = 'vm-family' | 'regional-aggregate' | 'network';
type QuotaResourceUnit = 'vcpus' | 'count';

export interface QuotaTargetSpec {
  cloud: CloudType;
  vmType: string;
  region?: string;
  spot: boolean;
  includePublicIpQuota?: boolean;
}

export interface QuotaResource {
  /** Stable AnyCloud-owned key used to merge provider/local quota rows. */
  key: string;
  /** Cloud-native quota id/name when it is known exactly (for example AWS). */
  providerId?: string;
  name: string;
  kind: QuotaResourceKind;
  unit: QuotaResourceUnit;
  required: number | undefined;
}

export interface QuotaResourceResolveOptions {
  /**
   * Canonical provider-observed identity for the VM-family resource. Used when
   * a credentialed provider API can return a stronger source of truth than the
   * static catalog/fallback parser.
   */
  resourceKey?: string;
}

export interface QuotaResolver {
  resolve(
    input: QuotaTargetSpec,
    options?: QuotaResourceResolveOptions,
  ): QuotaResource[];
  canonicalResourceKey?(resourceKey: string): string | null;
  resourceKeyFromName?(resourceName: string): string | null;
  spotFromResourceKey?(resourceKey: string): boolean | undefined;
  spotFromResourceName?(resourceName: string): boolean | undefined;
}
