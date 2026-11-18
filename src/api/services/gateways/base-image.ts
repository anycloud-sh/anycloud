import type { CloudType, GpuRuntime } from '../../../shared/cloud.js';

interface BaseImageResolutionRequest {
  readonly gpuRuntime?: GpuRuntime | null;
  /** Optional hardware context when image compatibility depends on the SKU. */
  readonly vmType?: string;
  /** A CPU VM Job host: Ubuntu minimal rather than server. */
  readonly minimal?: boolean;
}

export interface ResolvedBaseImage {
  readonly imageId: string;
}

interface CloudBaseImageResolverPublic<TResult extends ResolvedBaseImage> {
  readonly type: CloudType;
  resolveBaseImage(request: BaseImageResolutionRequest): Promise<TResult>;
}

const cloudBaseImageResolverBrand: unique symbol = Symbol(
  'CloudBaseImageResolver',
);

export type CloudBaseImageResolver<
  TResult extends ResolvedBaseImage = ResolvedBaseImage,
> = CloudBaseImageResolverPublic<TResult> & {
  readonly [cloudBaseImageResolverBrand]: true;
};

export interface CloudBaseImageResolverOps<TResult extends ResolvedBaseImage> {
  readonly type: CloudType;
  rawResolveBaseImage(request: BaseImageResolutionRequest): Promise<TResult>;
}

/** Construct the branded, provider-neutral base-image lookup capability. */
export function createCloudBaseImageResolver<TResult extends ResolvedBaseImage>(
  ops: CloudBaseImageResolverOps<TResult>,
): CloudBaseImageResolver<TResult> {
  const resolver: CloudBaseImageResolverPublic<TResult> = {
    type: ops.type,
    resolveBaseImage: (request) => ops.rawResolveBaseImage(request),
  };
  Object.defineProperty(resolver, cloudBaseImageResolverBrand, {
    value: true,
    enumerable: false,
  });
  return resolver as CloudBaseImageResolver<TResult>;
}
