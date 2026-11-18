import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '../../..');
const helperPath = join(
  projectRoot,
  'test/integration/helpers/azure-quota-parity.sh',
);

let fixtureDir: string;

const writeJson = (name: string, value: unknown): string => {
  const path = join(fixtureDir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const callHelper = (command: string, args: string[]): string =>
  execFileSync(
    'bash',
    ['-c', 'source "$1"; shift; "$@"', 'bash', helperPath, command, ...args],
    { encoding: 'utf-8' },
  ).trim();

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'azure-quota-parity-'));
});

afterEach(() => {
  rmSync(fixtureDir, { force: true, recursive: true });
});

// These are wiring/smoke tests only: the bash functions are thin
// `npx tsx` wrappers around test/integration/helpers/azure-quota-*.ts, so the exact
// selection/canonicalization behavior they call into is covered directly and
// exhaustively in test/unit/integration-helpers/azure-quota-*.spec.ts and
// test/unit/shared/quota-resolvers/azure-public-ip.spec.ts. What's specific
// to this file — and not covered anywhere else — is that the bash wrapper
// correctly forwards arguments and passes the script's stdout back
// unmangled, from both a real region file layout and cold process spawn.
describe('Azure quota E2E provider matching (bash wrapper)', () => {
  it('azure_compute_provider_limit forwards args and returns the script output unmangled (limit 0)', () => {
    const computeUsage = writeJson('compute-usage.json', [
      {
        name: {
          value: 'Standard NCASv3_T4 Family',
          localizedValue: 'Standard NCASv3_T4 Family vCPUs',
        },
        currentValue: 0,
        limit: 0,
        unit: 'Count',
      },
    ]);
    const computeQuota = writeJson('compute-quota.json', []);

    expect(
      callHelper('azure_compute_provider_limit', [
        'azure:standardncasv3_t4family',
        computeUsage,
        computeQuota,
      ]),
    ).toBe('0');
  });

  it('azure_public_ip_selection forwards args and returns the script output unmangled', () => {
    const networkQuota = writeJson('network-quota.json', [
      {
        properties: {
          name: {
            value: 'PublicIPAddresses',
            localizedValue: 'Public IP Addresses',
          },
          limit: { limitObjectType: 'LimitValue', value: 20 },
          unit: 'Count',
        },
      },
      {
        properties: {
          name: {
            value: 'IPv4StandardSkuPublicIpAddresses',
            localizedValue: 'Public IPv4 Addresses - Standard',
          },
          limit: { limitObjectType: 'LimitValue', value: 80 },
          unit: 'Count',
        },
      },
    ]);

    expect(callHelper('azure_public_ip_selection', [networkQuota])).toBe(
      [
        'azure:standardskupublicipaddresses',
        '80',
        'Public IPv4 Addresses - Standard',
        'IPv4StandardSkuPublicIpAddresses',
      ].join('\t'),
    );
  });

  it('propagates a no-match result as a clean empty string, not an error or stray whitespace', () => {
    const networkQuota = writeJson('network-quota.json', [
      {
        properties: {
          name: {
            value: 'IPv4BasicSkuPublicIpAddresses',
            localizedValue: 'Basic IPv4 Public IP Addresses',
          },
          limit: { limitObjectType: 'LimitValue', value: 1000 },
          unit: 'Count',
        },
      },
    ]);

    expect(callHelper('azure_public_ip_selection', [networkQuota])).toBe('');
  });

  it('propagates an ambiguous inventory as a clean empty string', () => {
    const networkQuota = writeJson('network-quota.json', [
      {
        properties: {
          name: {
            value: 'IPv4StandardSkuPublicIpAddresses',
            localizedValue: 'Public IPv4 Addresses - Standard',
          },
          limit: { limitObjectType: 'LimitValue', value: 80 },
          unit: 'Count',
        },
      },
      {
        properties: {
          name: {
            value: 'PublicIPAddressesStandard',
            localizedValue: 'Undocumented Standard public IP alias',
          },
          limit: { limitObjectType: 'LimitValue', value: 20 },
          unit: 'Count',
        },
      },
    ]);

    expect(callHelper('azure_public_ip_selection', [networkQuota])).toBe('');
  });
});

describe('azure-quota-parity.sh syntax', () => {
  it('parses without error', () => {
    expect(() => execFileSync('bash', ['-n', helperPath])).not.toThrow();
  });
});
