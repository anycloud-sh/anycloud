import { describe, it, expect } from 'vitest';
import { runScriptInTree } from '../../helpers/run-script-in-tree.mjs';

const checkWith = (files: Record<string, string>) =>
  runScriptInTree('scripts/check-cloudtype-boundaries.mjs', files);

describe('check-cloudtype-boundaries', () => {
  it('passes a tree with no provider-name branching', () => {
    expect(checkWith({ 'src/clean.ts': 'export const x = 1;\n' }).status).toBe(
      0,
    );
  });

  it('flags a CloudType branch in a non-allowlisted file', () => {
    const result = checkWith({
      'src/feature.ts':
        'import { CloudType } from "./types";\n' +
        'export const v = provider === CloudType.AWS;\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/feature.ts');
  });

  it('flags a dotless Record<CloudType ...> mapped type too', () => {
    expect(
      checkWith({
        'src/feature.ts': 'export type M = Record<CloudType, number>;\n',
      }).status,
    ).toBe(1);
  });

  it('exempts allowlisted files', () => {
    expect(
      checkWith({
        'src/shared/providers.ts': 'export const v = CloudType.AWS;\n',
      }).status,
    ).toBe(0);
  });

  it('exempts shared quota resolver adapters', () => {
    expect(
      checkWith({
        'src/shared/quota-resolvers/aws.ts':
          'export const v = CloudType.AWS;\n',
      }).status,
    ).toBe(0);
  });

  it('exempts the canonical credential onboarding boundary', () => {
    expect(
      checkWith({
        'src/cli/services/credential-onboarding/acquisition.ts':
          'export const v = CloudType.AWS;\n',
      }).status,
    ).toBe(0);
  });

  it('honors an inline cloudtype-boundary-ok exception above the line', () => {
    expect(
      checkWith({
        'src/feature.ts':
          '// cloudtype-boundary-ok: legacy shim\n' +
          'export const v = provider === CloudType.AWS;\n',
      }).status,
    ).toBe(0);
  });
});
