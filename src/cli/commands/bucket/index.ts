import { Command } from 'commander';
import { createBucketCreateCommand } from './create.js';
import { createBucketDeleteCommand } from './delete.js';
import { createBucketUploadCommand } from './upload.js';
import { createBucketDownloadCommand } from './download.js';
import { createBucketExistsCommand } from './exists.js';
import { createBucketRmCommand } from './rm.js';
import { createBucketListCommand } from './list.js';

export function createBucketCommand(): Command {
  const bucket = new Command('bucket').description(
    '🪣  Create, inspect, delete, upload, and download files for cloud buckets',
  );

  bucket.addCommand(createBucketCreateCommand());
  bucket.addCommand(createBucketDeleteCommand());
  bucket.addCommand(createBucketExistsCommand());
  bucket.addCommand(createBucketListCommand());
  bucket.addCommand(createBucketUploadCommand());
  bucket.addCommand(createBucketDownloadCommand());
  bucket.addCommand(createBucketRmCommand());

  return bucket;
}
