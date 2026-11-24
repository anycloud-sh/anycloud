import { parseFamiliarName } from '@swimlane/docker-reference';
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/i;

function digestQualifiedImageReference(image: string, digest: string): string {
  if (!SHA256_DIGEST.test(digest)) {
    throw new Error(`Invalid image digest: ${digest}`);
  }
  const ref = parseFamiliarName(image);
  if (!ref.domain || !ref.repository) {
    throw new Error(`Invalid image reference: ${image}`);
  }
  return `${ref.domain}/${ref.repository}@${digest.toLowerCase()}`;
}

/**
 * Resolve the exact image reference a substrate should run. When submit-time
 * inspection resolved a platform digest, runtime execution stays pinned to it
 * instead of following a mutable tag.
 */
export function resolveWorkloadImage(workload: {
  image: string;
  imageDigest?: string | null;
}): string {
  if (workload.image.includes('@')) return workload.image;
  const digest = workload.imageDigest;
  return digest
    ? digestQualifiedImageReference(workload.image, digest)
    : workload.image;
}

/** Whether the pull logs in to GHCR with the workload's token. Test APIs skip
 * it unless an e2e cell opts in to the customer path. */
export function pullNeedsRegistryAuth(
  props: { githubToken?: string | null; registryUsername?: string | null },
  image: string,
): boolean {
  return (
    !!props.githubToken &&
    !!props.registryUsername &&
    (process.env.IS_TEST !== 'true' ||
      process.env.ANYCLOUD_E2E_GHCR_AUTH === 'true') &&
    image.includes('ghcr.io')
  );
}
