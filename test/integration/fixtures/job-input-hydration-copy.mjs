import {
  CopyObjectCommand,
  PutObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';

const bucket = process.env.AWS_FIXTURE_BUCKET;
const region = process.env.AWS_FIXTURE_REGION;
const owner = process.env.AWS_FIXTURE_ACCOUNT;
if (owner !== undefined && !/^[0-9]{12}$/.test(owner))
  throw new Error('Invalid fixture account');
const shardCount = Number(process.env.AWS_FIXTURE_SHARDS);
const shardBytes = Number(process.env.AWS_FIXTURE_SHARD_BYTES);
if (
  !bucket ||
  !region ||
  !Number.isSafeInteger(shardCount) ||
  !Number.isSafeInteger(shardBytes)
) {
  throw new Error('Invalid fixture configuration');
}

const s3 = new S3Client({ region, maxAttempts: 5 });
if (process.env.AWS_FIXTURE_SEED_FILE) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: 'seed.bin',
      Body: createReadStream(process.env.AWS_FIXTURE_SEED_FILE),
      ContentLength: shardBytes,
      ExpectedBucketOwner: owner,
    }),
  );
}
let next = 0;
let completed = 0;
const workers = Array.from({ length: 32 }, async () => {
  for (;;) {
    const index = next++;
    if (index >= shardCount) return;
    const key = `shards/${String(index).padStart(4, '0')}.bin`;
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/seed.bin`,
        ExpectedBucketOwner: owner,
        ExpectedSourceBucketOwner: owner,
      }),
    );
    completed++;
    if (completed % 128 === 0 || completed === shardCount) {
      console.log(`Copied ${completed}/${shardCount} shards`);
    }
  }
});
await Promise.all(workers);

let objects = 0;
let bytes = 0;
for await (const page of paginateListObjectsV2(
  { client: s3 },
  { Bucket: bucket, ExpectedBucketOwner: owner },
)) {
  for (const object of page.Contents ?? []) {
    objects++;
    bytes += object.Size ?? 0;
  }
}
const expectedBytes = shardBytes * shardCount + shardBytes;
if (objects !== shardCount + 1 || bytes !== expectedBytes) {
  throw new Error(
    `Fixture verification failed: ${objects} objects, ${bytes} bytes; expected ${shardCount + 1}, ${expectedBytes}`,
  );
}
console.log(`Verified ${objects} objects totaling ${bytes} bytes`);
console.log(
  JSON.stringify({ bucket, region, objects, bytes, shardCount, shardBytes }),
);
