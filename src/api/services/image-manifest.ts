import { archMismatchMessage } from '../../shared/error-formatter.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import {
  type ImageArchitecture,
  ImageInspectionFailureReason,
  ImageVerdict,
} from '../../shared/image.js';
import type { ImageInspection } from '../../shared/image-registry.js';

/** Refuse an image the registry definitively reports missing, private or without the VM's build. */
export function assertImageAccessible(
  image: string,
  { verdict, failureReason }: ImageInspection,
  architecture: ImageArchitecture,
): void {
  if (verdict === ImageVerdict.NoPlatform) {
    throw new InvalidAnycloudConfigError(
      archMismatchMessage(image, architecture),
    );
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
        : privateImageMessage(image),
    );
  }
}

/** A private image the registry refused without a GitHub sign-in to pull with. */
export function privateImageMessage(image: string): string {
  return `Can't access image "${image}". For a private GHCR image, run \`anycloud login\` (\`anycloud login <api-url>\` on a hosted API): a GitHub App sign-in or a service token pulls only public images. Other private registries aren't supported.`;
}
