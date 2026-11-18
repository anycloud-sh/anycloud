/**
 * Fixed host boundary shared by the Local gateway and the CI setup that
 * provisions its SmolVM service, runner artifact, and filesystem storage.
 */
const host = '127.0.0.1';
const port = 18089;

/**
 * The filesystem bucket root. CI moves it to a directory the runner shares
 * with its Docker daemon at the same absolute path, because the API container
 * and the runner's SmolVM service must see the same files.
 */
function bucketHostPath(): string {
  const root = process.env.ANYCLOUD_TEST_LOCAL_BUCKET_ROOT;
  if (!root) return '/var/lib/anycloud-test/local/buckets';
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(root))
    throw new Error(
      'ANYCLOUD_TEST_LOCAL_BUCKET_ROOT must be an absolute path of plain characters',
    );
  return root;
}

export const LOCAL_SMOLVM_CONTRACT = Object.freeze({
  supportedVersion: '1.9.0',
  host,
  port,
  baseUrl: `http://${host}:${port}`,
  runnerVersion: 'anycloud-local-runner-cow-v2',
  runnerSidecarPath: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
  bucketHostPath: bucketHostPath(),
} as const);
