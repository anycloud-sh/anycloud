#!/usr/bin/env node
/**
 * Base-image canary
 *
 * Fails the build LOUDLY if a base image anycloud depends on has been silently
 * removed by its upstream owner. No VM is ever provisioned — resolve calls only,
 * so the canary is fast and free.
 *
 * The acute risk this exists for: anycloud now defaults Azure GPU deploys to
 * HARDCODED, competitor-owned (dstack) community-gallery images — cuda/grid at
 * 0.14 plus the proprietary-modules cuda-0.10 for Volta-and-older GPUs (V100).
 * When dstack retires one the image id 404s and those Azure GPU deploys fail
 * terminally. This canary imports those exact constants and resolves them
 * against a real Azure region so we hear about it from CI, not from a customer.
 *
 * Priorities:
 *   1) MUST        — dstack Azure community-gallery images resolve AND expose at
 *                    least one available version. Missing => hard failure.
 *   2) SHOULD      — warn (not fail) if a NEWER dstack-cuda/grid definition than
 *                    our pinned 0.14 exists, so we can bump + re-validate.
 *   3) BEST-EFFORT — AWS Deep Learning AMI + GCP Deep Learning VM image resolve.
 *                    Cloud-conditional: skipped (logged) when that cloud's
 *                    credential isn't configured, so the canary still runs on an
 *                    Azure-only credential set.
 *
 * Credentials are read from the environment exactly as ci/cleanup/azure.ts does
 * (Azure) and as the gateways expect (AWS/GCP):
 *   Azure (required): AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID,
 *                     AZURE_CLIENT_SECRET
 *   AWS   (optional): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
 *                     AWS_SESSION_TOKEN
 *   GCP   (optional): GCP_PROJECT_ID, GCP_PRIVATE_KEY, GCP_CLIENT_EMAIL
 *
 * Region overrides (must be inside the image's replication set / have the image):
 *   AC_CANARY_AZURE_LOCATION   (default: eastus)
 *   AC_CANARY_AWS_REGION       (default: AWS_REGION or us-east-1)
 *
 * Usage: npx tsx ci/canary/base-image-canary.ts
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { ClientSecretCredential } from '@azure/identity';

import { isAzureNotFound } from '../../src/api/services/gateways/azure';
import {
  AZURE_CUDA_COMMUNITY_IMAGE_ID,
  AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
  AZURE_GRID_COMMUNITY_IMAGE_ID,
} from '../../src/shared/catalog/azure-gpu-map';
import { createAwsBaseImageResolver } from '../../src/api/services/gateways/aws';
import { createGcpBaseImageResolver } from '../../src/api/services/gateways/gcp';
import { armClientOptions } from '../../src/api/services/azure-client-options';
import { createAwsEc2Client } from '../../src/api/services/provider-clients/aws';
import { createGcpImagesClient } from '../../src/api/services/provider-clients/gcp';
import { GpuRuntime } from '../../src/shared/cloud';

/** Loud, human-obvious status markers (kept emoji-free for CI log grepping). */
const MARK = {
  fail: '[FAIL]',
  pass: '[PASS]',
  warn: '[WARN]',
  skip: '[SKIP]',
  info: '[INFO]',
} as const;

/** Accumulates outcomes so one broken image doesn't short-circuit the others. */
const failures: string[] = [];
const warnings: string[] = [];

function recordFailure(message: string): void {
  failures.push(message);
  console.error(`${MARK.fail} ${message}`);
}

function recordWarning(message: string): void {
  warnings.push(message);
  console.warn(`${MARK.warn} ${message}`);
}

interface ParsedCommunityImage {
  /** Full pinned id, for messages. */
  imageId: string;
  /** e.g. dstack-ebac134d-04b9-4c2b-8b6c-ad3e73904aa7 */
  publicGalleryName: string;
  /** e.g. dstack-cuda-0.14 */
  galleryImageName: string;
  /** e.g. dstack-cuda */
  imageNamePrefix: string;
  /** e.g. 0.14 */
  pinnedVersion: string;
}

/**
 * Split `/CommunityGalleries/<gallery>/Images/<image>` into the pieces the Azure
 * SDK's communityGalleryImages/* operations take, and pull the pinned version
 * suffix out of the image-definition name so we can spot drift.
 */
function parseCommunityGalleryImageId(imageId: string): ParsedCommunityImage {
  const match = imageId.match(
    /\/CommunityGalleries\/([^/]+)\/Images\/([^/]+)/i,
  );
  if (!match) {
    throw new Error(
      `Cannot parse Azure community-gallery image id (unexpected shape): ${imageId}`,
    );
  }
  const [, publicGalleryName, galleryImageName] = match;

  // Definition names look like `dstack-cuda-0.14` — split the trailing numeric
  // version off the prefix. If there's no numeric suffix, drift detection is a
  // no-op for this image but the existence check still runs.
  const versionMatch = galleryImageName.match(/^(.+?)-(\d[\d.]*)$/);
  const imageNamePrefix = versionMatch ? versionMatch[1] : galleryImageName;
  const pinnedVersion = versionMatch ? versionMatch[2] : '';

  return {
    imageId,
    publicGalleryName,
    galleryImageName,
    imageNamePrefix,
    pinnedVersion,
  };
}

/** Numeric, part-wise version compare: -1 (a<b), 0 (a==b), 1 (a>b). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isNotFoundError(error: unknown): boolean {
  if (isAzureNotFound(error)) return true;
  const err = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  return (
    /NotFound/i.test(code) ||
    /not\s*found|could not be found|does not exist/i.test(message)
  );
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * PRIORITY 1 (MUST) + PRIORITY 2 (SHOULD): resolve each hardcoded dstack Azure
 * community-gallery image against a real region and assert it has >=1 version;
 * warn if a newer pinned definition exists.
 */
async function checkAzureDstackImages(): Promise<void> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const directoryId = process.env.AZURE_TENANT_ID;
  const applicationId = process.env.AZURE_CLIENT_ID;
  const secret = process.env.AZURE_CLIENT_SECRET;

  if (!subscriptionId || !directoryId || !applicationId || !secret) {
    // Azure is the whole point of this canary — missing creds is a hard failure,
    // not a skip. (AWS/GCP below are the ones that skip.)
    recordFailure(
      'Azure credentials not found in environment — cannot verify the dstack ' +
        'community-gallery images. Set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, ' +
        'AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.',
    );
    return;
  }

  const location = process.env.AC_CANARY_AZURE_LOCATION || 'eastus';

  // Same auth pattern the Azure gateway uses (azure.ts initializeAzure):
  // ClientSecretCredential(directoryId, applicationId, secret) -> ARM client.
  const credential = new ClientSecretCredential(
    directoryId,
    applicationId,
    secret,
  );
  const computeClient = new ComputeManagementClient(
    credential,
    subscriptionId,
    armClientOptions(),
  );

  // driftCheck=false for the 0.10 proprietary-modules image: it is a permanent,
  // non-versioned pin in dstack (used for Volta-and-older GPUs like V100), so a
  // newer dstack-cuda definition (0.14+) always exists — drift-warning on it
  // would be noise every run. We still assert it exists and has >=1 version.
  const pinnedImages: { parsed: ParsedCommunityImage; driftCheck: boolean }[] =
    [
      {
        parsed: parseCommunityGalleryImageId(AZURE_CUDA_COMMUNITY_IMAGE_ID),
        driftCheck: true,
      },
      {
        parsed: parseCommunityGalleryImageId(AZURE_GRID_COMMUNITY_IMAGE_ID),
        driftCheck: true,
      },
      {
        parsed: parseCommunityGalleryImageId(
          AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
        ),
        driftCheck: false,
      },
    ];

  for (const { parsed: image, driftCheck } of pinnedImages) {
    console.log(
      `${MARK.info} Resolving dstack image ${image.galleryImageName} in ` +
        `${location} (gallery ${image.publicGalleryName})...`,
    );

    // --- Existence: the image definition must resolve (else it's been retired) ---
    let definitionResolved = false;
    try {
      const definition = await computeClient.communityGalleryImages.get(
        location,
        image.publicGalleryName,
        image.galleryImageName,
      );
      definitionResolved = true;
      const os = definition.osType ? ` osType=${definition.osType}` : '';
      const eol = definition.endOfLifeDate
        ? ` endOfLife=${new Date(definition.endOfLifeDate).toISOString()}`
        : '';
      console.log(
        `${MARK.info} definition resolved: ${definition.name ?? image.galleryImageName}${os}${eol}`,
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        recordFailure(
          `dstack Azure image ${image.imageId} is GONE — bump the pin or the ` +
            `gallery/version was retired (404 in ${location}).`,
        );
      } else {
        recordFailure(
          `dstack Azure image ${image.imageId} could not be resolved in ` +
            `${location}: ${errorSummary(error)}`,
        );
      }
      continue;
    }

    // --- At least one available version (a definition with 0 versions is a dud) ---
    try {
      const versions: string[] = [];
      for await (const version of computeClient.communityGalleryImageVersions.list(
        location,
        image.publicGalleryName,
        image.galleryImageName,
      )) {
        if (version.name) versions.push(version.name);
        if (versions.length >= 10) break; // enough to prove non-empty
      }

      if (versions.length === 0) {
        recordFailure(
          `dstack Azure image ${image.imageId} resolved but has NO available ` +
            `versions in ${location} — treat as GONE (unbootable).`,
        );
        continue;
      }

      console.log(
        `${MARK.pass} ${image.galleryImageName}: definition + ${versions.length}` +
          `${versions.length >= 10 ? '+' : ''} version(s) [${versions.slice(0, 5).join(', ')}]`,
      );
    } catch (error) {
      recordFailure(
        `dstack Azure image ${image.imageId} version listing failed in ` +
          `${location}: ${errorSummary(error)}`,
      );
      continue;
    }

    // --- Drift (SHOULD): is a newer pinned definition published in the gallery? ---
    if (driftCheck && definitionResolved && image.pinnedVersion) {
      try {
        let newest = image.pinnedVersion;
        for await (const definition of computeClient.communityGalleryImages.list(
          location,
          image.publicGalleryName,
        )) {
          const name = definition.name;
          if (!name) continue;
          const m = name.match(
            new RegExp(`^${escapeRegExp(image.imageNamePrefix)}-(\\d[\\d.]*)$`),
          );
          if (!m) continue;
          if (compareVersions(m[1], newest) > 0) newest = m[1];
        }

        if (compareVersions(newest, image.pinnedVersion) > 0) {
          recordWarning(
            `dstack published a newer ${image.imageNamePrefix} definition ` +
              `(${newest}) than our pinned ${image.pinnedVersion}. Bump ` +
              `AZURE_*_COMMUNITY_IMAGE_ID in src/shared/catalog/azure-gpu-map.ts ` +
              `and re-validate ` +
              `before dstack retires ${image.pinnedVersion}.`,
          );
        }
      } catch (error) {
        // Drift is advisory — never fail the build on it.
        recordWarning(
          `Could not check ${image.imageNamePrefix} drift in ${location}: ` +
            `${errorSummary(error)}`,
        );
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PRIORITY 3 (BEST-EFFORT): AWS Deep Learning Base OSS Nvidia Driver GPU AMI.
 * Reuses the gateway's own resolver (aws.ts resolveAmi) so the canary tracks
 * whatever name/filter the gateway actually deploys with. Skips if unconfigured.
 */
async function checkAwsDlami(): Promise<void> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    console.log(
      `${MARK.skip} AWS DLAMI: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not ` +
        `set — skipping (canary continues Azure-only).`,
    );
    return;
  }

  const region =
    process.env.AC_CANARY_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  const credentials = {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };

  try {
    const resolver = createAwsBaseImageResolver(
      createAwsEc2Client(credentials, { region, maxAttempts: 10 }),
      region,
    );
    // DescribeImages is quota-independent and free — never provisions anything.
    const { imageId: amiId } = await resolver.resolveBaseImage({
      gpuRuntime: GpuRuntime.Cuda,
    });
    if (!amiId) {
      recordFailure(
        `AWS Deep Learning GPU AMI resolved to an empty id in ${region}.`,
      );
      return;
    }
    console.log(
      `${MARK.pass} AWS Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu ` +
        `24.04) -> ${amiId} in ${region}`,
    );
  } catch (error) {
    recordFailure(
      `AWS Deep Learning GPU AMI resolver failed in ${region} — the image may ` +
        `have been removed/renamed, or the resolver may be broken: ` +
        errorSummary(error),
    );
  }
}

/**
 * PRIORITY 3 (BEST-EFFORT): GCP Deep Learning VM image family. Reuses the
 * production base-image resolver so the canary hits the exact family/project
 * the gateway deploys with. Skips if unconfigured.
 */
async function checkGcpDlvm(): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  const privateKey = process.env.GCP_PRIVATE_KEY;
  const clientEmail = process.env.GCP_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    console.log(
      `${MARK.skip} GCP DLVM: GCP_PROJECT_ID / GCP_PRIVATE_KEY / ` +
        `GCP_CLIENT_EMAIL not all set — skipping (canary continues Azure-only).`,
    );
    return;
  }

  try {
    const resolver = createGcpBaseImageResolver(
      createGcpImagesClient({ projectId, privateKey, clientEmail }),
    );
    // getFromFamily on a global public image family is region-agnostic and free.
    const image = await resolver.resolveBaseImage({
      gpuRuntime: GpuRuntime.Cuda,
    });
    const ref = image.imageId;
    if (!ref) {
      recordFailure(
        'GCP Deep Learning VM resolver returned an empty image reference.',
      );
      return;
    }
    console.log(
      `${MARK.pass} GCP Deep Learning VM family ${image.project}/${image.family} ` +
        `-> ${image.imageName ?? ref}`,
    );
  } catch (error) {
    recordFailure(
      `GCP Deep Learning VM image resolver failed — the selected family may ` +
        `have been removed: ${errorSummary(error)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('=== anycloud base-image canary ===');
  console.log(
    'Resolve-only checks (no VM is provisioned). A failure means a base image ' +
      'anycloud depends on has been silently removed by its owner.\n',
  );

  // Priority 1 + 2 (the must-have) first, then best-effort clouds.
  await checkAzureDstackImages();
  await checkAwsDlami();
  await checkGcpDlvm();

  console.log('\n=== summary ===');
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ${MARK.warn} ${w}`);
  }
  if (failures.length > 0) {
    console.error(`\n${MARK.fail} ${failures.length} check(s) FAILED:`);
    for (const f of failures) console.error(`  ${MARK.fail} ${f}`);
    console.error(
      '\nA base image anycloud depends on is gone. Fix the pin / gallery / ' +
        'family before this breaks live deploys.',
    );
    process.exit(1);
  }

  console.log(
    `${MARK.pass} All resolved base images are present.` +
      (warnings.length > 0 ? ' (see warnings above)' : ''),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(
    `${MARK.fail} base-image canary crashed: ${errorSummary(error)}`,
  );
  console.error(error);
  process.exit(1);
});
