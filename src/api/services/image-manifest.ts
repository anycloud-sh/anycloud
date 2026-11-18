import { archMismatchMessage } from '../../shared/error-formatter.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import {
  ImageInspectionFailureReason,
  ImageVerdict,
} from '../../shared/image.js';
import type { ImageInspection } from '../../shared/image-registry.js';

/** Refuse an image the registry definitively reports missing, private or not amd64. */
export function assertImageAccessible(
  image: string,
  { verdict, failureReason }: ImageInspection,
): void {
  if (verdict === ImageVerdict.NoAmd64) {
    throw new InvalidAnycloudConfigError(archMismatchMessage(image));
  }
  if (verdict === ImageVerdict.NotFound) {
    throw new InvalidAnycloudConfigError(
      `Image "${image}" not found — check the reference and that it's pushed.`,
    );
  }
  if (verdict === ImageVerdict.Unauthorized) {
    throw new InvalidAnycloudConfigError(
      failureReason === ImageInspectionFailureReason.GhcrTokenExchangeFailed
        ? `Can't access image "${image}". To sign in again, run \`anycloud login\` (\`anycloud login <api-url>\` on a hosted API), and verify that the token can read this GHCR package.`
        : `Can't access image "${image}". For a private GHCR image, run \`anycloud login\` (\`anycloud login <api-url>\` on a hosted API); other private registries aren't supported.`,
    );
  }
}
