import { DeployError } from './errors.js';
import { inspectImage } from './image-registry.js';
import {
  isPinnedChartReference,
  SYSTEM_RELEASE_CHART_ENV,
} from './system-release.js';

/**
 * An API image's immutable digest and the digest-pinned chart it was built
 * with, read anonymously from its registry: the API's upgrades and the CLI's
 * `cluster create` (RFC 0049 C26 (e)) resolve a release the same way, the
 * CLI before anything is bought.
 */
export async function resolveApiImage(
  reference: string,
): Promise<{ digest: string; chart: string }> {
  const inspection = await inspectImage(reference);
  if (inspection.verdict !== 'ok' || !inspection.amd64Digest) {
    throw new DeployError(
      `Could not resolve the API image ${reference} to an immutable digest (${inspection.verdict})`,
      400,
    );
  }
  const prefix = `${SYSTEM_RELEASE_CHART_ENV}=`;
  const chart = inspection.env
    ?.find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  if (!chart || !isPinnedChartReference(chart)) {
    throw new DeployError(
      `The API image ${reference} names no digest-pinned chart (${SYSTEM_RELEASE_CHART_ENV} is ${chart ? `"${chart}"` : 'unset, or its config could not be read'}); images before 0.1.68 cannot be installed or upgraded to: https://anycloud.sh/platform/hosted-apis#upgrade-a-hosted-api`,
      400,
    );
  }
  return { digest: inspection.amd64Digest, chart };
}
