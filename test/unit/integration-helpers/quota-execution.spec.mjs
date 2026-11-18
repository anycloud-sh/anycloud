import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseShell,
  shellCommands,
} from '../../../scripts/repository-policy/shell.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = readFileSync(
  join(root, 'test/integration/quota.test.sh'),
  'utf8',
);
// Load the real functions and retry budget without executing the script's API
// startup or account setup. All provider boundaries below are shell shims.
const definitions = parseShell(source)
  .namedChildren.filter(
    (node) =>
      node.type === 'function_definition' ||
      (node.type === 'variable_assignment' &&
        node.text.startsWith('AZURE_PARITY_THROTTLE_')),
  )
  .map((node) => node.text)
  .join('\n');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('mandatory Azure quota parity', () => {
  it('registers both provider credentials without optional execution flags', () => {
    // Preserve each whole statement, including any surrounding conditional, so
    // a stale guard cannot silently omit the Azure credential setup.
    const setup = parseShell(source)
      .namedChildren.filter(
        (node) =>
          node.type !== 'function_definition' &&
          shellCommands(node.text).some((words) =>
            words.join(' ').includes('cli credentials new'),
          ),
      )
      .map((node) => node.text)
      .join('\n');
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
        set -e
        source "$1/test/integration/helpers/common.sh"
        unset AZURE_QUOTA_CHECKS REQUIRE_AZURE_QUOTA_CHECKS
        cli() { printf '%s\n' "$3"; }
        ${setup}
        `,
        'fixture',
        root,
      ],
      { cwd: root, encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'aws-test',
      'azure-test',
    ]);
  });

  it.each([
    ['TooManyRequests', 3],
    ['AuthorizationFailed', 1],
  ])('fails on %s after %s oracle attempts', (failure, attempts) => {
    const directory = mkdtempSync(join(tmpdir(), 'quota-execution-'));
    directories.push(directory);
    const calls = join(directory, 'calls');
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      set -e
      source "$1/test/integration/helpers/common.sh"
      ${definitions}
      ANYCLOUD_DIR_TEST=$2
      AZURE_QUOTA_PARITY_REGIONS=eastus
      AZURE_SUBSCRIPTION_ID=fixture
      setup_azure_cli_for_parity() { :; }
      sleep() { :; }
      run_scoped_quota_status() {
        printf '%s' '[{"cloud":"Azure","kind":"current","resourceKey":"azure:compute:vcpus","currentLimit":8}]' > "$4"
      }
      QUOTA_TEST_CALLS=$3
      QUOTA_TEST_FAILURE=$4
      az() { echo attempt >> "$QUOTA_TEST_CALLS"; echo "$QUOTA_TEST_FAILURE" >&2; return 42; }
      run_azure_quota_parity
      echo "unexpected success"
    `,
        'fixture',
        root,
        directory,
        calls,
        failure,
      ],
      { cwd: root, encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Azure REST quota parity read failed');
    expect(result.stdout).not.toContain('unexpected success');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(
      attempts,
    );
  });
});

describe('AWS quota parity', () => {
  // Service Quotas allows 5 GetServiceQuota/s per account and region, shared
  // with the API's own reads and every parallel CI run; one ListServiceQuotas
  // per region reads every EC2 quota from its separate 10/s bucket.
  const parity = (quotas) => {
    const directory = mkdtempSync(join(tmpdir(), 'quota-execution-'));
    directories.push(directory);
    const calls = join(directory, 'calls');
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      set -e
      source "$1/test/integration/helpers/common.sh"
      ${definitions}
      ANYCLOUD_DIR_TEST=$2
      AWS_QUOTA_PARITY_REGIONS='us-east-2 us-west-2'
      run_scoped_quota_status() {
        printf '%s' '[
          {"cloud":"AWS","kind":"current","resourceKey":"aws:l-1216c47a","currentLimit":64},
          {"cloud":"AWS","kind":"current","resourceKey":"aws:l-34b43a08","currentLimit":32},
          {"cloud":"AWS","kind":"current","resourceKey":"aws:l-db2e81ba","currentLimit":0}
        ]' > "$4"
      }
      QUOTA_TEST_CALLS=$3
      QUOTA_TEST_QUOTAS=$4
      aws() {
        echo "$AWS_RETRY_MODE $AWS_MAX_ATTEMPTS $*" >> "$QUOTA_TEST_CALLS"
        printf '%s' "$QUOTA_TEST_QUOTAS"
      }
      run_aws_quota_parity
    `,
        'fixture',
        root,
        directory,
        calls,
        JSON.stringify({ Quotas: quotas }),
      ],
      { cwd: root, encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    return {
      ...result,
      calls: readFileSync(calls, 'utf8').trim().split('\n'),
    };
  };
  const quotas = [
    { QuotaCode: 'L-1216C47A', Value: 64.0 },
    { QuotaCode: 'L-34B43A08', Value: 32.0 },
    { QuotaCode: 'L-DB2E81BA', Value: 0.0 },
  ];

  it('reads each region with one adaptive-retry ListServiceQuotas', () => {
    const result = parity(quotas);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AWS quota parity OK (6 rows total)');
    expect(result.calls).toEqual(
      ['us-east-2', 'us-west-2'].map(
        (region) =>
          `adaptive 10 service-quotas list-service-quotas --service-code ec2 --region ${region} --output json`,
      ),
    );
  });

  it('fails when the provider lists no value for a reported quota', () => {
    const result = parity(quotas.slice(1));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'AWS Service Quotas list has no value for us-east-2 L-1216C47A',
    );
  });
});
