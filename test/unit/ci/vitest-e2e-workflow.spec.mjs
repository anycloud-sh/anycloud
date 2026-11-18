import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

const integration = loadYaml(
  readFileSync('.github/workflows/integration.yml', 'utf8'),
);

describe('Integration Vitest cells', () => {
  it('requires every Vitest E2E cell and bounds each one', () => {
    const job = integration.jobs['vitest-e2e'];
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.strategy['fail-fast']).toBe(false);
    const include = job.strategy.matrix.include;
    expect(include.length).toBeGreaterThan(0);
    for (const cell of include) {
      expect(typeof cell.timeout_minutes, cell.test).toBe('number');
    }
  });

  it('requires the no-provision and local-smolvm cells too', () => {
    for (const name of ['e2e-noprovision', 'local-smolvm']) {
      const job = integration.jobs[name];
      expect(job['continue-on-error'], name).toBeUndefined();
    }
  });
});
