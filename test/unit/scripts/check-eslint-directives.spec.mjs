import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  inspectEslintDirectiveSource,
  inspectRepositoryEslintDirectives,
} from '../../../scripts/check-eslint-directives.mjs';

const protectedRule = 'local/environment-access-ownership';
const exception = {
  file: 'src/api/example.ts',
  line: 1,
  rule: protectedRule,
  reason: 'Bootstrap reads this exact value before dependency composition.',
};

function inspect(source, options = {}) {
  return inspectEslintDirectiveSource('src/api/example.ts', source, {
    protectedRules: [
      protectedRule,
      'local/protected-rule-disable-policy',
      'no-restricted-imports',
      '@typescript-eslint/no-restricted-imports',
    ],
    exceptions: [exception],
    ...options,
  });
}

describe('independent ESLint directive policy', () => {
  it('ignores mutation sandboxes while still checking reviewed source', () => {
    const root = mkdtempSync(join(tmpdir(), 'anycloud-eslint-directives-'));
    try {
      const sandbox = join(root, '.stryker-tmp', 'sandbox-review');
      mkdirSync(sandbox, { recursive: true });
      mkdirSync(join(root, 'src'));
      writeFileSync(join(sandbox, 'generated.ts'), 'export const value = ;');
      writeFileSync(
        join(root, 'src', 'example.ts'),
        '/* eslint-disable */\nexport const value = 1;',
      );
      expect(inspectRepositoryEslintDirectives(root)).toEqual([
        {
          file: 'src/example.ts',
          line: 1,
          message: expect.stringContaining('file-wide'),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts ordinary narrow ESLint exceptions', () => {
    expect(
      inspect(
        '// eslint-disable-next-line no-control-regex\nconst control = /[\\x00]/;',
      ),
    ).toEqual([]);
  });

  it('accepts an exact centrally reviewed protected exception', () => {
    expect(
      inspect(
        `// eslint-disable-next-line ${protectedRule} -- ${exception.reason}\nconst value = process.env.BOOTSTRAP_VALUE;`,
      ),
    ).toEqual([]);
  });

  it('ignores directive text inside strings', () => {
    expect(
      inspect(
        "const fixture = 'eslint-disable local/environment-access-ownership';",
      ),
    ).toEqual([]);
  });

  it.each([
    '/* eslint-disable */\nconst value = process.env.SECRET;',
    `/* eslint-disable ${protectedRule} */\nconst value = process.env.SECRET;`,
    `const value = process.env.SECRET; // eslint-disable-line ${protectedRule}`,
    `// eslint-disable-next-line ${protectedRule}, no-restricted-imports -- Broad exception.\nconst value = process.env.SECRET;`,
    '// eslint-disable-next-line -- Broad exception.\nconst value = process.env.SECRET;',
  ])('rejects broad disable form %#', (source) => {
    expect(inspect(source)).toHaveLength(1);
  });

  it('rejects the watchdog self-disable exploit', () => {
    const violations = inspect(
      `/* eslint-disable local/protected-rule-disable-policy */\n/* eslint-disable ${protectedRule} */\nexport const secret = process.env.SECRET;`,
    );

    expect(violations).toHaveLength(2);
    expect(violations[0].message).toContain('cannot disable itself');
  });

  it('requires a fully qualified protected rule name', () => {
    const [violation] = inspect(
      `// eslint-disable-next-line environment-access-ownership -- ${exception.reason}\nconst value = process.env.BOOTSTRAP_VALUE;`,
    );
    expect(violation.message).toContain(`exact rule name ${protectedRule}`);
  });

  it('rejects an unapproved TypeScript-qualified import-rule exception', () => {
    const [violation] = inspect(
      '// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Bypass the Azure SDK boundary.\nimport { ClientSecretCredential } from "@azure/identity";',
    );

    expect(violation.message).toContain('central repository-policy');
  });

  it('requires the exact centrally reviewed rationale and location', () => {
    const wrongReason = inspect(
      `// eslint-disable-next-line ${protectedRule} -- A newly invented reason.\nconst value = process.env.BOOTSTRAP_VALUE;`,
    );
    const wrongLine = inspect(
      `\n// eslint-disable-next-line ${protectedRule} -- ${exception.reason}\nconst value = process.env.BOOTSTRAP_VALUE;`,
    );

    expect(wrongReason[0].message).toContain('central repository-policy');
    expect(wrongLine[0].message).toContain('central repository-policy');
  });

  it.each([
    `/* eslint ${protectedRule}: "off" */\nconst value = process.env.SECRET;`,
    `/* eslint "${protectedRule}": "off" */\nconst value = process.env.SECRET;`,
    `/* eslint { "${protectedRule}": "off" } */\nconst value = process.env.SECRET;`,
  ])('rejects inline rule configuration form %#', (source) => {
    const [violation] = inspect(source);
    expect(violation.message).toContain('configuration is forbidden');
  });
});
