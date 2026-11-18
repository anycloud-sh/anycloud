import {
  ensureCatalogBootstrapped,
  getCatalogs,
} from '../../shared/catalog/index.js';
import { log } from './logger.js';
import { CatalogUnavailableError } from '../../shared/errors.js';
import { type CloudType } from '../../shared/cloud.js';

function catalogUnavailableMessage(cloud: CloudType): string {
  return `Catalog for ${cloud} is temporarily unavailable; retry shortly.`;
}

export async function ensureCatalogReady(cloud: CloudType): Promise<void> {
  try {
    await ensureCatalogBootstrapped(cloud);
  } catch {
    throw new CatalogUnavailableError(catalogUnavailableMessage(cloud));
  }
}

export function isCatalogUnavailableError(
  err: unknown,
): err is CatalogUnavailableError {
  return err instanceof CatalogUnavailableError;
}

export const CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000; // 1 hour
export async function refreshCatalogs(): Promise<void> {
  const errors = await getCatalogs();
  for (const [cloud, error] of Object.entries(errors)) {
    log.warn(`Catalog refresh failed for ${cloud}, keeping existing data`, {
      id: 'system',
      error,
    });
  }
  if (Object.keys(errors).length === 0) {
    log.info('All catalogs refreshed', { id: 'system' });
  }
}
