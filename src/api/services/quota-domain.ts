import type {
  QuotaStatusQuery,
  QuotaStatusEntry,
  QuotaStatusResponse,
} from '../../shared/api-contract/quota-schemas.js';
import type { User } from './entities.js';
import type { CloudType } from '../../shared/cloud.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

export interface QuotaDomain {
  status(
    actor: User,
    query: QuotaStatusQuery,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<QuotaStatusResponse>;
  canceled(actor: User): Promise<QuotaStatusResponse>;
}

export interface QuotaDomainDependencies {
  getCanceledStatus(
    actor: Pick<User, 'id' | 'username'>,
  ): Promise<QuotaStatusEntry[]>;
  getStatus(
    actor: Pick<User, 'id' | 'username'>,
    cloud: CloudType,
    credentialName: string | undefined,
    region: string | undefined,
    options: {
      providerWaitMs?: number;
      failOpenProviderStatus?: boolean;
    },
  ): Promise<QuotaStatusEntry[]>;
  recordEvent(
    actor: Pick<User, 'username'>,
    event: string,
    properties?: Record<string, unknown>,
  ): void;
  now(): number;
}

export function createQuotaDomain(
  dependencies: QuotaDomainDependencies,
): QuotaDomain {
  return {
    async status(actor, query, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let entryCount: number | undefined;
      try {
        signal?.throwIfAborted();
        const entries = await dependencies.getStatus(
          actor,
          query.cloud,
          query.credentialName,
          query.region,
          {
            ...(query.waitMs !== undefined && {
              providerWaitMs: query.waitMs,
              failOpenProviderStatus: true,
            }),
          },
        );
        signal?.throwIfAborted();
        entryCount = entries.length;
        return { entries };
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'quota_status', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          ...(failureMessage && { error: failureMessage }),
          cloud: query.cloud,
          region: query.region,
          hasCredentialName: true,
          ...(query.waitMs !== undefined && { waitMs: query.waitMs }),
          ...(entryCount !== undefined && { entryCount }),
        });
      }
    },
    async canceled(actor) {
      return { entries: await dependencies.getCanceledStatus(actor) };
    },
  };
}
