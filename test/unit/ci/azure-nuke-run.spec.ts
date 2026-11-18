import { describe, expect, it } from 'vitest';

import {
  hasNukeWorkloadPrefix,
  hasServeWorkloadPrefix,
  isAnycloudRegionalResourceGroup,
  serveCleanupPrefixFromEnv,
  storageAccountNameForSubscription,
  validateNukeCleanupPrefix,
  validateServeCleanupPrefix,
} from '../../../ci/cleanup/azure-nuke-run';

describe('azure nuke-run cleanup guards', () => {
  it('accepts only specific nuke run prefixes', () => {
    expect(validateNukeCleanupPrefix('nuke-7949206131-')).toBe(
      'nuke-7949206131-',
    );
    expect(validateNukeCleanupPrefix('  nuke-abc_123-  ')).toBe(
      'nuke-abc_123-',
    );
  });

  it.each([
    undefined,
    '',
    'nuke-',
    'nuke--',
    'nuke-7949206131',
    'anycloud-',
    'nuke-7949206131-*',
    'nuke-7949206131-;rm -rf /',
  ])('rejects unsafe cleanup prefix %s', (prefix) => {
    expect(() => validateNukeCleanupPrefix(prefix)).toThrow(
      /specific nuke run prefix/,
    );
  });

  it('matches only anycloud_deployment tags with the exact run prefix', () => {
    expect(
      hasNukeWorkloadPrefix(
        { anycloud_deployment: 'nuke-7949206131-42' },
        'nuke-7949206131-',
      ),
    ).toBe(true);
    expect(
      hasNukeWorkloadPrefix(
        { anycloud_deployment: 'nuke-7949206132-42' },
        'nuke-7949206131-',
      ),
    ).toBe(false);
    expect(hasNukeWorkloadPrefix({}, 'nuke-7949206131-')).toBe(false);
    expect(hasNukeWorkloadPrefix(undefined, 'nuke-7949206131-')).toBe(false);
  });

  it('accepts only specific serve run prefixes', () => {
    expect(validateServeCleanupPrefix('serve-7949206131-')).toBe(
      'serve-7949206131-',
    );
    expect(validateServeCleanupPrefix('  serve-abc_123-  ')).toBe(
      'serve-abc_123-',
    );
  });

  it.each([
    undefined,
    '',
    'serve-',
    'serve--',
    'serve-7949206131',
    'nuke-7949206131-',
    'serve-7949206131-*',
    'serve-7949206131-;rm -rf /',
  ])('rejects unsafe serve cleanup prefix %s', (prefix) => {
    expect(() => validateServeCleanupPrefix(prefix)).toThrow(
      /specific serve run prefix/,
    );
  });

  it('derives a serve cleanup prefix from GitHub run env', () => {
    expect(
      serveCleanupPrefixFromEnv({
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_RUN_ID: '12345678901',
      }),
    ).toBe('serve-3456789012-');
    expect(serveCleanupPrefixFromEnv({ TEST_RUN: 'local123' })).toBe(
      'serve-local123-',
    );
  });

  it('matches serve resources only when they belong to anycloud-test', () => {
    expect(
      hasServeWorkloadPrefix(
        {
          anycloud_deployment: 'serve-7949206131-azure-gpu',
          anycloud_user: 'anycloud-test',
        },
        'serve-7949206131-',
      ),
    ).toBe(true);
    expect(
      hasServeWorkloadPrefix(
        {
          anycloud_deployment: 'serve-7949206131-azure-gpu',
          anycloud_user: 'real-user',
        },
        'serve-7949206131-',
      ),
    ).toBe(false);
    expect(
      hasServeWorkloadPrefix(
        {
          anycloud_deployment: 'serve-7949206132-azure-gpu',
          anycloud_user: 'anycloud-test',
        },
        'serve-7949206131-',
      ),
    ).toBe(false);
  });

  it('scopes resource-group scanning to anycloud regional groups', () => {
    expect(isAnycloudRegionalResourceGroup('anycloud-northcentralus')).toBe(
      true,
    );
    expect(isAnycloudRegionalResourceGroup('anycloud-storage')).toBe(false);
    expect(isAnycloudRegionalResourceGroup('prod-anycloud-eastus')).toBe(false);
    expect(isAnycloudRegionalResourceGroup(undefined)).toBe(false);
  });

  it('derives the shared Azure storage account name like the gateway', () => {
    expect(
      storageAccountNameForSubscription('12345678-aaaa-bbbb-cccc-eeeeeeeeeeee'),
    ).toBe('anycloud12345678');
  });
});
