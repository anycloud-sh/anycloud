import { defineConfig, mergeConfig } from 'vitest/config';

import unit from './vitest.config.mts';

// src mutant-parity runs keep the ordinary unit setup and take their exact
// spec list from the runner (comma-separated paths or globs).
const specs = (process.env.MUTATION_SPECS ?? '').split(',').filter(Boolean);
if (specs.length === 0)
  throw new Error('Set MUTATION_SPECS to the specs to run.');

export default mergeConfig(unit, defineConfig({ test: { include: specs } }));
