import { Command } from 'commander';
import { newTable } from '../renderers/table.js';
import chalk from 'chalk';
import { getGitHubToken } from '../services/auth.js';
import {
  fetchPackageTags,
  formatGitHubApiError,
  listGitHubPackages,
  type GhcrPackage,
} from '../services/ghcr.js';
import { pickGHCRImage } from '../services/ghcr-picker.js';
import {
  createSpinner,
  exitWithError,
  printInfo,
  printWarning,
  setJsonMode,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';

interface ListedGhcrImage extends GhcrPackage {
  tags?: string[];
}

interface ImagesCommandOptions {
  filter?: string;
  owner?: string;
  tags?: boolean;
  list?: boolean;
  json?: boolean;
  onlyRefs?: boolean;
}

function scopeLabel(image: GhcrPackage): string {
  return image.isOrg ? `org: ${image.owner}` : 'personal';
}

function imageRef(image: GhcrPackage, tag: string): string {
  return `${image.name}:${tag}`;
}

function ghcrImagesToRefs(images: ListedGhcrImage[]): string[] {
  return images.flatMap((image) =>
    (image.tags ?? []).map((tag) => imageRef(image, tag)),
  );
}

function filterGhcrImages(
  images: ListedGhcrImage[],
  filter: string,
): ListedGhcrImage[] {
  const needle = filter.toLowerCase();
  return images.filter(
    (image) =>
      image.name.toLowerCase().includes(needle) ||
      image.owner.toLowerCase().includes(needle) ||
      image.packageName.toLowerCase().includes(needle) ||
      (image.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
  );
}

async function attachTags(
  token: string,
  packages: GhcrPackage[],
): Promise<{ images: ListedGhcrImage[]; warnings: string[] }> {
  const warnings: string[] = [];
  const results = await Promise.allSettled(
    packages.map(async (pkg) => ({
      ...pkg,
      tags: await fetchPackageTags(token, pkg),
    })),
  );

  const images: ListedGhcrImage[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      images.push(result.value);
    } else {
      const pkg = packages[i];
      images.push({ ...pkg, tags: [] });
      warnings.push(
        `Could not list tags for ${pkg.name}: ${formatGitHubApiError(result.reason)}`,
      );
    }
  }

  return { images, warnings };
}

function emitJson(images: ListedGhcrImage[]): void {
  console.log(
    JSON.stringify(
      images.map((image) => ({
        image: image.name,
        owner: image.owner,
        packageName: image.packageName,
        scope: image.isOrg ? 'org' : 'personal',
        tags: image.tags,
        refs: image.tags?.map((tag) => imageRef(image, tag)),
      })),
    ),
  );
}

function emitTable(images: ListedGhcrImage[], includeTags: boolean): void {
  if (images.length === 0) {
    printInfo('No GHCR images found.');
    return;
  }

  printInfo(`GHCR images (${images.length}):`);
  console.log('');

  const table = newTable({
    head: ['Image', 'Scope', 'Tags'].map((h) => chalk.cyan(h)),
    style: { head: [], border: ['dim'] },
    wordWrap: true,
  });

  for (const image of images) {
    table.push([
      image.name,
      scopeLabel(image),
      includeTags
        ? image.tags && image.tags.length > 0
          ? image.tags.join(', ')
          : chalk.dim('-')
        : chalk.dim('not loaded'),
    ]);
  }

  console.log(table.toString());
}

export function createImagesCommand(): Command {
  return new Command('images')
    .alias('imgs')
    .description('🐳 Browse GHCR container images')
    .option('-f, --filter <text>', 'Filter by image, owner, package, or tag')
    .option('--owner <owner>', 'Only packages owned by this GitHub user or org')
    .option('--list', 'List images instead of opening the interactive picker')
    .option('--no-tags', 'List packages only; skip per-package tag lookups')
    .option('--json', 'Emit images as compact JSON')
    .option('--only-refs', 'Emit full image refs, one per line')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud images                 # interactive GHCR picker; prints selected ref
  $ anycloud images --list          # list GHCR packages and tags
  $ anycloud images --only-refs     # one ghcr.io/owner/image:tag per line
  $ anycloud images -f train        # filter by image, owner, package, or tag
  $ anycloud images --json          # compact JSON for scripts
`,
    )
    .action(async (options: ImagesCommandOptions) => {
      try {
        const machineMode = !!(options.json || options.onlyRefs);
        if (machineMode) setJsonMode(true);

        const includeTags = options.onlyRefs || options.tags !== false;
        if (options.onlyRefs && options.tags === false) {
          exitWithError('--only-refs requires tags; remove --no-tags.');
        }

        const token = await getGitHubToken();
        const pickerMode =
          !machineMode &&
          !options.list &&
          !options.filter &&
          !options.owner &&
          options.tags !== false &&
          shouldAllowPrompts();

        if (pickerMode) {
          const picked = await pickGHCRImage();
          if (picked) console.log(picked);
          return;
        }

        const spinner = machineMode
          ? null
          : createSpinner('Loading GHCR packages...').start();
        const result = await listGitHubPackages(token);
        spinner?.stop();

        for (const warning of result.warnings) {
          printWarning(warning);
        }

        let packages = result.packages;
        if (options.owner) {
          const owner = options.owner.toLowerCase();
          packages = packages.filter((pkg) => pkg.owner === owner);
        }

        let images: ListedGhcrImage[];
        if (includeTags) {
          const tagSpinner = machineMode
            ? null
            : createSpinner('Loading GHCR tags...').start();
          const tagged = await attachTags(token, packages);
          tagSpinner?.stop();
          images = tagged.images;
          for (const warning of tagged.warnings) {
            printWarning(warning);
          }
        } else {
          images = packages;
        }

        if (options.filter) {
          images = filterGhcrImages(images, options.filter);
        }

        if (options.onlyRefs) {
          console.log(ghcrImagesToRefs(images).join('\n'));
          return;
        }

        if (options.json) {
          emitJson(images);
          return;
        }

        emitTable(images, includeTags);
      } catch (error) {
        exitWithError(formatGitHubApiError(error));
      }
    });
}
