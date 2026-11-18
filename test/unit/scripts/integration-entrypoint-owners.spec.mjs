import { describe, expect, test } from 'vitest';

import { parseIntegrationEntrypointOwners } from '../../../scripts/repository-policy/integration-entrypoint-owners.mjs';

function registry(overrides = {}) {
  const values = {
    destructiveBackstopTests: "['test/integration/nuke.test.sh']",
    integrationUtilities: "['test/integration/helpers/probe.ts']",
    shellIntegrationTests:
      '[...shellNativeQualificationTests, ...destructiveBackstopTests]',
    shellNativeQualificationTests: "['test/integration/binary.test.sh']",
    ...overrides,
  };
  return Object.entries(values)
    .map(([name, value]) => `export const ${name} = ${value};`)
    .join('\n');
}

describe('integration entrypoint owner data parser', () => {
  test('reads the four literal owner arrays without executing the module', () => {
    expect(parseIntegrationEntrypointOwners(registry())).toMatchObject({
      errors: [],
      shellNativeQualificationTests: ['test/integration/binary.test.sh'],
      shellIntegrationTests: [
        'test/integration/binary.test.sh',
        'test/integration/nuke.test.sh',
      ],
    });
  });

  test.each([
    [
      'computed entry',
      { shellNativeQualificationTests: '[process.env.LEGACY_SOURCE]' },
      'literal paths',
    ],
    [
      'unknown spread',
      { shellNativeQualificationTests: '[...candidateControlled]' },
      'literal paths',
    ],
    [
      'duplicate path',
      {
        shellNativeQualificationTests:
          "['test/integration/binary.test.sh', 'test/integration/binary.test.sh']",
      },
      'duplicate paths',
    ],
    [
      'fabricated aggregate',
      { shellIntegrationTests: "['test/integration/binary.test.sh']" },
      'exactly compose',
    ],
  ])('rejects a %s', (_label, override, message) => {
    expect(
      parseIntegrationEntrypointOwners(registry(override)).errors,
    ).toContainEqual(expect.stringContaining(message));
  });

  test('rejects a missing named owner array', () => {
    const source = registry().replace(
      /export const integrationUtilities = .*;\n?/u,
      '',
    );
    expect(parseIntegrationEntrypointOwners(source).errors).toContain(
      'integrationUtilities is missing from the entrypoint owner registry',
    );
  });
});
