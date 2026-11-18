import {
  ensureCatalogsBootstrapped,
  needsCatalogBootstrap,
} from '../../shared/catalog/index.js';
import { createSpinner } from './output.js';

/**
 * Bootstrap catalog CSVs on first run, with a dedicated spinner so the user
 * understands the one-time download isn't part of their query. No-op when
 * catalogs are already on disk (the common case).
 */
export async function bootstrapCatalogsWithUI(): Promise<void> {
  if (!needsCatalogBootstrap()) return;
  const spinner = createSpinner(
    'First run: downloading pricing catalog...',
  ).start();
  try {
    await ensureCatalogsBootstrapped();
    spinner.succeed('Pricing catalog ready');
  } catch (err) {
    spinner.fail('Failed to download pricing catalog');
    throw err;
  }
}
