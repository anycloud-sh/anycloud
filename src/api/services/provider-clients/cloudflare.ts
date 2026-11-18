import { S3Client } from '@aws-sdk/client-s3';

type R2Credentials = NonNullable<
  NonNullable<ConstructorParameters<typeof S3Client>[0]>['credentials']
>;

/** Cloudflare R2 speaks S3: one region, "auto", at the account's endpoint. */
export function createR2S3Client(
  credentials: R2Credentials,
  endpoint: string,
): S3Client {
  // Some HTTP intermediaries do not forward 100 Continue, leaving large
  // uploads waiting for a handshake while R2 waits for their request body.
  return new S3Client({
    region: 'auto',
    endpoint,
    expectContinueHeader: false,
    credentials,
  });
}
