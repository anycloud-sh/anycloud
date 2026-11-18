import { describe, expect, it } from 'vitest';
import { runScriptInTree } from '../../helpers/run-script-in-tree.mjs';

// Fixture sources are built from these names so that this spec, which the
// check also scans, never contains the call shapes it rejects.
const [parse, toCsv, write, read, regions] = [
  'parseCatalogCSV',
  'entriesToCSV',
  'writeCatalog',
  'readCatalog',
  'getRegionsForVMType',
];

const check = (files) =>
  runScriptInTree('scripts/check-catalog-test-boundaries.mjs', files);

describe('catalog test boundary check', () => {
  it('accepts raw catalog samples in catalog mechanics specs only', () => {
    const result = check({
      'test/unit/shared/catalog.spec.ts': `${parse}('a,b');`,
      'test/unit/shared/catalog/fetch-aws.spec.ts': `${toCsv}(rows);\n${write}(dir, rows);`,
      'test/unit/services/optimizer.spec.ts': `import { ${regions} } from '../../../src/shared/catalog.js';\n${regions}('g5');`,
      'test/unit/services/example.spec.ts': `vi.mocked(${read}).mockReturnValue(undefined);`,
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'test/unit/services/example.spec.ts',
      `${parse}('a,b');`,
      'parseCatalogCSV',
    ],
    ['test/unit/services/example.spec.ts', `${toCsv}(rows);`, 'entriesToCSV'],
    ['test/unit/cli/example.spec.ts', `${write}(dir, rows);`, 'writeCatalog'],
    // queries.spec.ts sits under the mechanics directory but tests runtime
    // placement queries, so it is excluded from the exemption.
    [
      'test/unit/shared/catalog/queries.spec.ts',
      `${parse}('a');`,
      'parseCatalogCSV',
    ],
    [
      'test/unit/services/example.spec.ts',
      `vi.spyOn(catalog, '${read}').mockReturnValue([]);`,
      'mocked readCatalog',
    ],
    [
      'test/unit/services/example.spec.ts',
      `${read}Mock.mockImplementation(() => rows);`,
      'mocked readCatalog',
    ],
    [
      'test/unit/services/optimizer.spec.ts',
      `vi.mocked(${regions}).mockReturnValue(['us-east-1']);`,
      'mocked catalog placement query',
    ],
  ])('rejects %s using %s', (path, source, label) => {
    const result = check({ [path]: `// fixture\n${source}` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:2 ${label}`);
  });

  it('leaves placement queries mockable outside the placement specs', () => {
    expect(
      check({
        'test/unit/services/other.spec.ts': `vi.mocked(${regions}).mockReturnValue(['us-east-1']);`,
      }).status,
    ).toBe(0);
  });
});
