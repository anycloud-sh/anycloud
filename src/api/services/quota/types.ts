import type { QuotaStatusEntry } from '../../../shared/api-contract/quota-schemas.js';
import type { AzureQuotaResourceKey } from '../../../shared/quota-resolvers/azure-identity.js';

export interface AzurePendingRequest {
  requestedLimit: number;
  status: string;
  submitTime: Date;
  providerRequestId?: string;
}

export interface AzurePendingReadState {
  requests: AzurePendingRequest[];
  complete: boolean;
}

interface AzureQuotaInfoBase {
  region: string;
  resourceName: string;
  /** Azure's exact raw provider name, retained for request history identity. */
  providerId: string;
  /** Canonical identity used for all internal operations. */
  resourceKey: AzureQuotaResourceKey;
  currentUsage: number;
  limit: number;
  unit: string;
}

export interface ReadOnlyAzureQuotaInfo extends AzureQuotaInfoBase {
  writable: false;
}

export interface WritableAzureQuotaInfo extends AzureQuotaInfoBase {
  writable: true;
  scope: string;
  pending: AzurePendingReadState;
}

export type AzureQuotaInfo = ReadOnlyAzureQuotaInfo | WritableAzureQuotaInfo;

export interface SupportTicketInfo {
  ticketId: string;
  title: string;
  description: string;
  status: string;
  severity: string;
  created: Date;
}

/**
 * The user-facing quota status capability for a cloud.
 * AWS/Azure implement it; reached via the QUOTA_PROVIDERS registry in handler.ts,
 * NOT through the compute gateway — quota is an account-level concern, not a
 * compute-provider capability, so a cloud "supports quota" iff it's registered.
 */
export interface QuotaProvider {
  getQuotaStatus(region?: string): Promise<QuotaStatusEntry[]>;
}
