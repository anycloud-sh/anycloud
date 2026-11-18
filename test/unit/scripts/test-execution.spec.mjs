import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runFixture(configuration, source) {
  mkdirSync(join(root, '.context'), { recursive: true });
  const directory = mkdtempSync(join(root, '.context/test-execution-'));
  directories.push(directory);
  const fixture = join(directory, 'fixture.spec.ts');
  const config = join(directory, 'vitest.config.mjs');
  writeFileSync(fixture, `import { test, expect } from 'vitest';\n${source}\n`);
  // Keep the real execution policy while isolating the probe from database,
  // cloud, and fixture setup. Every test below runs in a separate Vitest process.
  writeFileSync(
    config,
    `
    import config from ${JSON.stringify(join(root, configuration))};
    export default { ...config, test: { ...config.test,
      globalSetup: [], setupFiles: [], include: [${JSON.stringify(fixture)}],
      exclude: [], maxWorkers: 1,
    }};
  `,
  );
  return spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', config],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
}

describe.each(['vitest.config.mts', 'vitest.e2e.config.mts'])(
  '%s execution policy',
  (configuration) => {
    it.each([
      ['early return', 'test("unavailable", () => { return; });'],
      [
        'swallowed provider error',
        'test("unavailable", () => { try { throw new Error("BILLING_DISABLED"); } catch { console.warn("unavailable"); } });',
      ],
      [
        'helper returns without asserting',
        'const check = () => {}; test("unavailable", () => check());',
      ],
      [
        'empty assertion loop',
        'test("unavailable", () => { for (const value of []) expect(value).toBe(true); });',
      ],
    ])('fails an assertion-free %s', (_name, source) => {
      const result = runFixture(configuration, source);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'expected any number of assertion',
      );
    });

    it('accepts completed assertions in helpers', () => {
      const result = runFixture(
        configuration,
        'const check = () => expect(1 + 1).toBe(2); test("executes", () => check());',
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    });

    it('accepts a return after asserting the selected outcome', () => {
      const result = runFixture(
        configuration,
        'test.each([true, false])("outcome %s", (invalid) => { if (invalid) { expect(invalid).toBe(true); return; } expect(invalid).toBe(false); });',
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    });

    it('rejects focusing a subset of the suite', () => {
      const result = runFixture(
        configuration,
        'test.only("focused", () => expect(1).toBe(1)); test("omitted", () => expect(2).toBe(2));',
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('only');
    });

    it('rejects a selected file with no tests', () => {
      const result = runFixture(configuration, '');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('No test suite found');
    });
  },
);
