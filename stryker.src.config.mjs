import harness from './stryker.harness.config.mjs';

// Opt-in src mutant-parity runs (test/mutant-parity/src-parity.mjs). The runner
// passes --mutate line ranges per snapshot and selects specs through
// MUTATION_SPECS in vitest.src-mutation.config.mjs, never Stryker testFiles.
export default {
  ...harness,
  tsconfigFile: 'tsconfig.json',
  vitest: { configFile: 'vitest.src-mutation.config.mjs', related: false },
  mutate: [],
  // ignoreStatic stays false (from the harness): moved module-level constants
  // are part of the move, so their mutants must be compared too.
  reporters: ['progress', 'json'],
  htmlReporter: undefined,
  jsonReporter: { fileName: 'reports/mutation/src/mutation.json' },
};
