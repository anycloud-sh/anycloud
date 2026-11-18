import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('ci/aws-account-redaction.sh');

/** Runs the script with a fake `aws` that prints `account` for STS. */
function run(account, ...args) {
  const bin = mkdtempSync(path.join(tmpdir(), 'aws-redaction-'));
  writeFileSync(
    path.join(bin, 'aws'),
    `#!/bin/sh\nprintf '%s\\n' '${account}'\n`,
  );
  chmodSync(path.join(bin, 'aws'), 0o755);
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe('AWS account redaction', () => {
  it('masks a 12-digit account and refuses anything else', () => {
    expect(run('123456789012', 'mask')).toMatchObject({
      status: 0,
      stdout: '::add-mask::123456789012\n',
    });
    for (const account of ['', 'None', '1234']) {
      const result = run(account, 'mask');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    }
  });

  it('scrubs the account and any account in an ARN from files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aws-redaction-files-'));
    const log = path.join(dir, 'api.log');
    writeFileSync(
      log,
      'User: arn:aws:iam::123456789012:user/x denied; account 123456789012; ' +
        'arn:aws:ec2:ap-south-1:210987654321:instance/*\n',
    );
    expect(
      run('123456789012', 'scrub', log, path.join(dir, 'missing')).status,
    ).toBe(0);
    const scrubbed = readFileSync(log, 'utf8');
    expect(scrubbed).not.toMatch(/123456789012|210987654321/);
    expect(scrubbed).toContain('arn:aws:iam::[REDACTED]:user/x');
    execFileSync('rm', ['-rf', dir]);
  });
});
