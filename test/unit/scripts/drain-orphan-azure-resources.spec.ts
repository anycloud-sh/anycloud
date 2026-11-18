import { describe, expect, it } from 'vitest';
import {
  assertAzureDeletionScope,
  parseAzureDrainArgs,
} from '../../../scripts/drain-orphan-azure-resources.js';

describe('Azure orphan drain deletion guard', () => {
  it('allows an unscoped dry run', () => {
    const args = parseAzureDrainArgs([]);

    expect(args).toEqual({ delete: false });
    expect(() => assertAzureDeletionScope(args)).not.toThrow();
  });

  it('requires both exact resource-group and name-prefix scopes for deletion', () => {
    expect(() =>
      assertAzureDeletionScope(parseAzureDrainArgs(['--delete'])),
    ).toThrow(/--resource-group.*--name-prefix/);
    expect(() =>
      assertAzureDeletionScope(
        parseAzureDrainArgs(['--delete', '--resource-group', 'anycloud-owned']),
      ),
    ).toThrow(/--resource-group.*--name-prefix/);
  });

  it('accepts deletion only when both scopes are explicit', () => {
    const args = parseAzureDrainArgs([
      '--delete',
      '--resource-group',
      'anycloud-owned',
      '--name-prefix',
      'job-123-',
    ]);

    expect(args).toEqual({
      delete: true,
      resourceGroup: 'anycloud-owned',
      namePrefix: 'job-123-',
    });
    expect(() => assertAzureDeletionScope(args)).not.toThrow();
  });

  it('rejects missing flag values and unknown arguments', () => {
    expect(() => parseAzureDrainArgs(['--resource-group'])).toThrow(
      /requires a non-empty value/,
    );
    expect(() => parseAzureDrainArgs(['--all'])).toThrow(/Unknown argument/);
  });
});
