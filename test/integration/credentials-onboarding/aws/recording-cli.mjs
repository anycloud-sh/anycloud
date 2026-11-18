#!/usr/bin/env node
// Test-only observation of actual provider responses. Never store the secret key.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const result = spawnSync(process.env.ANYCLOUD_TEST_REAL_AWS, args, {
  env: process.env,
  encoding: 'utf8',
  timeout: 60_000,
  maxBuffer: 1024 * 1024,
});
const after = (flag) => args[args.indexOf(flag) + 1];
if (result.status === 0 && args[0] === 'iam') {
  const recordPath = process.env.ANYCLOUD_TEST_AWS_OWNERSHIP;
  const userName = process.env.ANYCLOUD_TEST_AWS_USER;
  const accountId = process.env.ANYCLOUD_TEST_AWS_ACCOUNT;
  if (after('--user-name') !== userName)
    throw new Error('Unexpected generation fixture user.');
  const record = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    : undefined;
  if (args[1] === 'create-user') {
    if (record)
      throw new Error('Generation fixture already has a creation record.');
    const { User } = JSON.parse(result.stdout);
    const invocationId = JSON.parse(after('--tags')).find(
      (tag) => tag.Key === 'anycloud:generation-id',
    )?.Value;
    if (
      !User?.UserId ||
      User.UserName !== userName ||
      User.Arn?.split(':')[4] !== accountId ||
      !invocationId
    ) {
      throw new Error('Invalid creation-time AWS ownership evidence.');
    }
    fs.writeFileSync(
      recordPath,
      JSON.stringify({
        accountId,
        userName,
        userId: User.UserId,
        invocationId,
        accessKeyIds: [],
        inlinePolicyNames: [],
      }),
      { mode: 0o600, flag: 'wx' },
    );
  } else if (record) {
    if (args[1] === 'create-access-key') {
      const { AccessKey } = JSON.parse(result.stdout);
      if (AccessKey?.UserName !== userName || !AccessKey.AccessKeyId)
        throw new Error('Invalid generated key identity.');
      record.accessKeyIds.push(AccessKey.AccessKeyId);
    } else if (args[1] === 'put-user-policy') {
      record.inlinePolicyNames.push(after('--policy-name'));
    }
    fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  }
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
